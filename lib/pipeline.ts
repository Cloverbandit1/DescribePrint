import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  colorRegionsNote,
  defaultColorRegion,
  isDefaultOnlyRegions,
  mergeColorRegionSources,
  withSelectedFilament,
  type ColorRegion,
} from "./color-regions";
import { printPresetSummary, type PrintPresetSummary } from "./printers";
import { checkMesh, hasHardMeshFailure } from "./mesh-check";
import { compileOpenScad, withTempDir } from "./compile";
import { createJob, getJob, toGenerateResult, type StoredJob } from "./jobs";
import {
  defaultFixture,
  isLikelyEdit,
  matchConversationFixture,
  matchFixture,
  shouldUseFixture,
} from "./fixtures";
import { importedMeshStubScad, parseImportedMesh } from "./import-mesh";
import { runCadReshapeUpper } from "./cad-reshape";
import { buildImageSolidFromUpload, imageSolidStubScad, type ImageImportOptions } from "./image-import";
import { getLlmConfig, getPlanModel, isLocalOpenAiBaseUrl, isSmartPipelineEnabled } from "./llm-config";
import {
  buildPlanPrompt,
  buildUserPrompt,
  completeChat,
  importedMeshSystemPrompt,
  normalizeCadPlan,
  parseCadPlan,
  planSystemPrompt,
  systemPrompt,
  toUserFacingLlmError,
  type CadPlan,
  type ImportedMeshContext,
} from "./llm";
import {
  buildImportedMeshWrapper,
  canBuildDeterministicImportWrap,
  formatHoleSpecForPrompt,
  importedWrapErrors,
  parseImportHoleSpec,
  type ImportHoleSpec,
} from "./import-hole";
import { parseMeshEditIntent, type MeshEditIntent } from "./mesh-edit";
import {
  rotateMeshesZ,
  scaleMeshesToMaxMm,
  scaleMeshesUniform,
  sitMeshOnBed,
  sitMeshesOnBed,
} from "./mesh-transform";
import { extractOpenScadColorBodies, mergeScadBodiesWithRegions, scadWithOnlyBody } from "./openscad-colors";
import { hasPrintInPlaceJoints } from "./joints";
import { formatPrintabilityFeedback, shouldRetryPrintability, wantsNewDesign } from "./printability";
import { IMPORTED_MESH_FILENAME, sanitizeOpenScad } from "./sanitize";
import { parseStl, writeBinaryStl } from "./stl";
import {
  colorRegionsFromObjects,
  meshesTo3mf,
  objectsFromRegions,
  parse3mfDocument,
  type ThreeMfObject,
} from "./threemf";
import { describeSizeHint } from "./units";
import {
  DEFAULT_WEARABLE_CATEGORY,
  describeWearableSize,
  inferWearableCategory,
  isWearableCategoryId,
  parseWearableCategoryFromPrompt,
  wearableChartNote,
  wearableScaleFactor,
} from "./wearable-sizes";
import type {
  GenerateRequest,
  GenerateResult,
  Mesh,
  PartSource,
  PlateEditMode,
  StatusEvent,
  WearableCategoryId,
  WearableSizeId,
} from "./types";

export type StatusSink = (event: StatusEvent) => void;

/** First compile plus this many smart repair attempts. */
export const MAX_COMPILE_RETRIES = 2;
export const MAX_COMPILE_ATTEMPTS = 1 + MAX_COMPILE_RETRIES;

const IMPORT_LIMITS_NOTE =
  "Imported mesh is on the plate in millimeters. Size presets and scale/rotate/sit-on-bed edit the real triangles. Adding holes or features wraps the import in OpenSCAD (partial — not full mesh sculpt).";

function emit(sink: StatusSink | undefined, event: StatusEvent) {
  sink?.(event);
}

function requestSizeNote(request: GenerateRequest): string {
  return describeSizeHint(request.sizeHint, request.units ?? "mm");
}

function meshContext(mesh: Mesh, fileName: string, report = checkMesh(mesh)): ImportedMeshContext {
  return {
    fileName,
    sizeMm: report.boundingBoxMm.size,
    minMm: report.boundingBoxMm.min,
    maxMm: report.boundingBoxMm.max,
    triangleCount: report.triangleCount,
    volumeMm3: report.volumeMm3,
  };
}

function withMeshes(objects: ThreeMfObject[], meshes: Mesh[]): ThreeMfObject[] {
  return objects.map((object, index) => ({ ...object, mesh: meshes[index] ?? object.mesh }));
}

function presetFromRequest(filament?: string | null): PrintPresetSummary {
  return printPresetSummary(filament);
}

function stampPresetFilament(objects: ThreeMfObject[], preset: PrintPresetSummary): ThreeMfObject[] {
  const regions = withSelectedFilament(colorRegionsFromObjects(objects), preset.material);
  return objects.map((object, index) => ({
    ...object,
    filament: regions[index]?.filament ?? object.filament ?? preset.material,
  }));
}

async function artifactsFromObjects(
  objects: ThreeMfObject[],
  code: string,
  name = "DescribePrint",
  printPreset: PrintPresetSummary = printPresetSummary("pla"),
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  code: string;
  colorRegions: ColorRegion[];
}> {
  const seated = stampPresetFilament(
    withMeshes(objects, sitMeshesOnBed(objects.map((object) => object.mesh))),
    printPreset,
  );
  const combined = { triangles: seated.flatMap((object) => object.mesh.triangles) };
  const report = checkMesh(combined);
  if (hasHardMeshFailure(report)) {
    const summary = report.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    throw new Error(`Mesh check failed: ${summary}`);
  }
  const stl = writeBinaryStl(combined, name);
  const threemf = await meshesTo3mf(seated, name, printPreset);
  return { stl, threemf, report, code, colorRegions: colorRegionsFromObjects(seated) };
}

async function artifactsFromMesh(
  mesh: Mesh,
  code: string,
  name = "DescribePrint",
  regions: ColorRegion[] = [defaultColorRegion()],
  printPreset: PrintPresetSummary = printPresetSummary("pla"),
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  code: string;
  colorRegions: ColorRegion[];
}> {
  return artifactsFromObjects(
    objectsFromRegions([mesh], withSelectedFilament(regions, printPreset.material), name, printPreset.material),
    code,
    name,
    printPreset,
  );
}

async function objectsFromJob(job: StoredJob): Promise<ThreeMfObject[]> {
  try {
    const parsed = await parse3mfDocument(job.threemf);
    if (parsed.objects.length) return parsed.objects;
  } catch {
    // fall through to the combined STL
  }
  return objectsFromRegions(
    [parseStl(job.stl)],
    job.colorRegions?.length ? job.colorRegions : [defaultColorRegion()],
    job.fileName ?? "DescribePrint",
  );
}

async function compileColorObjects(
  code: string,
  regions: ColorRegion[],
  dir: string,
): Promise<ThreeMfObject[]> {
  const bodies = extractOpenScadColorBodies(code);
  if (bodies.length < 2) return [];
  const paired = mergeScadBodiesWithRegions(bodies, regions);
  const objects: ThreeMfObject[] = [];
  for (const item of paired) {
    try {
      const compiled = await compileOpenScad(scadWithOnlyBody(code, item.renderStatement), dir);
      const mesh = parseStl(compiled.stl);
      if (mesh.triangles.length === 0) continue;
      objects.push({
        name: item.region.name,
        mesh,
        colorHex: item.region.colorHex,
        colorName: item.region.colorName,
        filament: item.region.filament,
        extruder: item.region.amsSlot,
      });
    } catch {
      // Isolate compile failed — keep going; we may still fall back to one object.
    }
  }
  return objects.length >= 2 ? objects : [];
}

async function planFromLlm(request: GenerateRequest): Promise<CadPlan | null> {
  const sizeNote = requestSizeNote(request);
  try {
    const raw = await completeChat(
      [
        { role: "system", content: planSystemPrompt() },
        {
          role: "user",
          content: buildPlanPrompt({
            prompt: request.prompt,
            sizeNote,
            previousCode: request.previousCode ?? undefined,
            previousPrompt: request.previousPrompt ?? undefined,
          }),
        },
      ],
      { model: getPlanModel(), temperature: 0.1 },
    );
    const parsed = parseCadPlan(raw);
    return parsed
      ? normalizeCadPlan(parsed, {
          prompt: request.prompt,
          previousCode: request.previousCode,
        })
      : null;
  } catch (err) {
    throw toUserFacingLlmError(err);
  }
}

async function codeFromLlm(
  request: GenerateRequest,
  previous?: { code: string; error: string },
  plan?: CadPlan | null,
  imported?: ImportedMeshContext,
  wrapHint?: { holeSpecNote?: string; suggestedWrap?: string },
): Promise<string> {
  const sizeNote = requestSizeNote(request);
  try {
    return await completeChat([
      { role: "system", content: imported ? importedMeshSystemPrompt() : systemPrompt() },
      {
        role: "user",
        content: buildUserPrompt({
          prompt: request.prompt,
          sizeNote,
          previousCode: previous?.code ?? request.previousCode ?? undefined,
          previousError: previous?.error,
          previousPrompt: request.previousPrompt ?? undefined,
          plan: imported ? undefined : plan,
          importedMesh: imported,
          holeSpecNote: wrapHint?.holeSpecNote,
          suggestedWrap: wrapHint?.suggestedWrap,
        }),
      },
    ]);
  } catch (err) {
    throw toUserFacingLlmError(err);
  }
}

function codeFromFixture(request: GenerateRequest): { code: string; usedFixture: true } {
  const match =
    matchConversationFixture(
      request.prompt,
      request.previousPrompt,
      request.previousCode,
      request.sizeHint,
      request.units ?? "mm",
    ) ??
    matchFixture(request.prompt, request.sizeHint, request.units ?? "mm") ??
    defaultFixture();
  return { code: match.code, usedFixture: true };
}

function importedWrapHint(hole: ImportHoleSpec | null, mesh: Mesh, addTab: boolean) {
  const box = checkMesh(mesh).boundingBoxMm;
  return {
    holeSpecNote: hole ? formatHoleSpecForPrompt(hole, box) : undefined,
    suggestedWrap: hole || addTab ? buildImportedMeshWrapper({ mesh, hole, addTab }) : undefined,
  };
}

async function compileAndCheck(
  code: string,
  importedStl?: Buffer,
  opts: { sitOnBed?: boolean; colorRegions?: ColorRegion[]; printPreset?: PrintPresetSummary } = {},
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  colorRegions: ColorRegion[];
  splitColorObjects: boolean;
}> {
  return withTempDir(async (dir) => {
    if (importedStl) {
      await writeFile(path.join(dir, IMPORTED_MESH_FILENAME), importedStl);
    }
    const compiled = await compileOpenScad(code, dir);
    let mesh = parseStl(compiled.stl);
    const printPreset = opts.printPreset ?? printPresetSummary("pla");
    const regions = withSelectedFilament(
      opts.colorRegions?.length ? opts.colorRegions : [defaultColorRegion()],
      printPreset.material,
    );
    const colorObjects = importedStl ? [] : await compileColorObjects(code, regions, dir);
    if (opts.sitOnBed) {
      mesh = sitMeshOnBed(mesh);
    }
    const exportObjects = stampPresetFilament(
      colorObjects.length
        ? withMeshes(colorObjects, sitMeshesOnBed(colorObjects.map((object) => object.mesh)))
        : objectsFromRegions([mesh], regions, "DescribePrint", printPreset.material),
      printPreset,
    );
    const report = checkMesh(mesh);
    if (hasHardMeshFailure(report)) {
      const summary = report.issues
        .filter((i) => i.severity === "error")
        .map((i) => i.message)
        .join("; ");
      throw new Error(`Mesh check failed: ${summary}`);
    }
    const stl = opts.sitOnBed ? writeBinaryStl(mesh, "DescribePrint") : compiled.stl;
    const threemf = await meshesTo3mf(exportObjects, "DescribePrint", printPreset);
    return {
      stl,
      threemf,
      report,
      colorRegions: colorRegionsFromObjects(exportObjects),
      splitColorObjects: colorObjects.length >= 2,
    };
  });
}

function resolveWearableCategory(request: GenerateRequest, previous?: StoredJob): WearableCategoryId {
  if (isWearableCategoryId(request.wearableCategory)) return request.wearableCategory;
  return (
    parseWearableCategoryFromPrompt(request.prompt ?? "") ??
    (previous?.fileName ? parseWearableCategoryFromPrompt(previous.fileName) : null) ??
    previous?.wearableCategory ??
    DEFAULT_WEARABLE_CATEGORY
  );
}

function applyIntentToMeshes(
  meshes: Mesh[],
  intent: MeshEditIntent,
  currentSize: WearableSizeId | null,
  currentCategory: WearableCategoryId | null,
): { meshes: Mesh[]; wearableSize: WearableSizeId | null; wearableCategory: WearableCategoryId } {
  let next = meshes;
  let wearableSize = currentSize;
  const wearableCategory = intent.wearableCategory ?? currentCategory ?? DEFAULT_WEARABLE_CATEGORY;
  if (intent.wearableSize) {
    next = scaleMeshesUniform(
      next,
      wearableScaleFactor(currentSize, intent.wearableSize, currentCategory, wearableCategory),
    );
    wearableSize = intent.wearableSize;
  }
  if (Math.abs(intent.scale - 1) > 1e-9) {
    next = scaleMeshesUniform(next, intent.scale);
  }
  if (intent.targetMaxMm) {
    next = scaleMeshesToMaxMm(next, intent.targetMaxMm);
  }
  if (intent.rotateZDeg !== null) {
    next = rotateMeshesZ(next, intent.rotateZDeg);
  }
  if (intent.sitOnBed) {
    next = sitMeshesOnBed(next);
  }
  return { meshes: next, wearableSize, wearableCategory };
}

function applyWearableToObjects(
  objects: ThreeMfObject[],
  wearableSize: WearableSizeId | null | undefined,
  wearableCategory: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): ThreeMfObject[] {
  let meshes = objects.map((object) => object.mesh);
  if (wearableSize && wearableSize !== "M") {
    meshes = scaleMeshesUniform(meshes, wearableScaleFactor("M", wearableSize, wearableCategory, wearableCategory));
  }
  return withMeshes(objects, sitMeshesOnBed(meshes));
}

function looksLikeImportedFollowUp(request: GenerateRequest): boolean {
  if (request.previousSource === "imported-mesh") return true;
  if (!request.previousJobId) return false;
  return getJob(request.previousJobId)?.source === "imported-mesh";
}

function resolvePreviousJob(request: GenerateRequest): StoredJob | undefined {
  if (!request.previousJobId) return undefined;
  return getJob(request.previousJobId);
}

export async function runImageImportPipeline(
  input: { buffer: Buffer; fileName?: string; options?: ImageImportOptions; filament?: string | null },
  sink?: StatusSink,
): Promise<GenerateResult> {
  emit(sink, { step: "image", message: "Reading the photo…" });
  const options = input.options ?? { repair: true, keepWear: false, targetMaxMm: null };
  emit(sink, {
    step: "planning",
    message: options.repair
      ? "Inferring a printable solid and repairing cracks…"
      : "Inferring a printable solid (keeping wear)…",
  });
  const built = buildImageSolidFromUpload(input.buffer, input.fileName, options);
  emit(sink, { step: "mesh-check", message: "Checking the solid against the P2S bed…" });
  emit(sink, { step: "export", message: "Writing STL and 3MF…" });
  const code = imageSolidStubScad({
    fileName: built.fileName,
    sizeMm: checkMesh(built.mesh).boundingBoxMm.size,
    triangleCount: built.mesh.triangles.length,
    format: built.format,
    repairApplied: built.repairApplied,
    keepWear: built.keepWear,
    designation: built.designation,
  });
  const printPreset = presetFromRequest(input.filament);
  const artifacts = await artifactsFromMesh(built.mesh, code, built.fileName, undefined, printPreset);
  const wearableCategory = inferWearableCategory(built.fileName);
  const notes = [...built.notes, wearableChartNote(), describeWearableSize(null, wearableCategory)];
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: true,
    retried: false,
    source: "imported-mesh",
    fileName: built.fileName,
    wearableSize: null,
    wearableCategory,
    nativeSizeMm: artifacts.report.boundingBoxMm.size,
    editMode: "image-import",
    notes,
    colorRegions: artifacts.colorRegions,
    imageImport: built.meta,
    machineDesignation: built.designation,
    printPreset,
  });
  emit(sink, {
    step: "done",
    message: built.designation.exceedsCurrentPrinter
      ? "Photo solid is on the plate — current printer is too small."
      : "Photo solid is on the plate.",
  });
  return toGenerateResult(job);
}

export async function runImportPipeline(
  input: { buffer: Buffer; fileName?: string; filament?: string | null },
  sink?: StatusSink,
): Promise<GenerateResult> {
  emit(sink, { step: "import", message: "Reading STL/3MF…" });
  const imported = await parseImportedMesh(input.buffer, input.fileName);
  emit(sink, { step: "mesh-check", message: "Checking imported mesh printability…" });
  emit(sink, { step: "export", message: "Writing STL and 3MF…" });
  const seated = sitMeshesOnBed(imported.objects.map((object) => object.mesh));
  const objects = withMeshes(imported.objects, seated);
  const combined = { triangles: seated.flatMap((mesh) => mesh.triangles) };
  const code = importedMeshStubScad({
    fileName: imported.fileName,
    sizeMm: checkMesh(combined).boundingBoxMm.size,
    triangleCount: combined.triangles.length,
  });
  const printPreset = presetFromRequest(input.filament);
  const artifacts = await artifactsFromObjects(objects, code, imported.fileName, printPreset);
  const wearableCategory = inferWearableCategory(imported.fileName);
  const notes = [IMPORT_LIMITS_NOTE, wearableChartNote(), describeWearableSize(null, wearableCategory)];
  if (!isDefaultOnlyRegions(artifacts.colorRegions)) {
    notes.push(colorRegionsNote(artifacts.colorRegions));
  }
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: true,
    retried: false,
    source: "imported-mesh",
    fileName: imported.fileName,
    printPreset,
    wearableSize: null,
    wearableCategory,
    nativeSizeMm: artifacts.report.boundingBoxMm.size,
    editMode: "import",
    notes,
    colorRegions: artifacts.colorRegions,
  });
  emit(sink, { step: "done", message: "Imported mesh is on the plate." });
  return toGenerateResult(job);
}

async function runImportedMeshEdit(
  request: GenerateRequest,
  previous: StoredJob,
  sink?: StatusSink,
): Promise<GenerateResult> {
  const prompt = request.prompt?.trim() || (request.wearableSize ? `Apply wearable size ${request.wearableSize}` : "");
  if (!prompt) {
    throw new Error("Describe an edit, or pick a wearable size.");
  }

  const printPreset = presetFromRequest(request.filament);
  const wearableCategory = resolveWearableCategory(request, previous);
  const intent = parseMeshEditIntent(prompt, request.wearableSize, wearableCategory);
  if (intent.kind === "new-design") {
    return runOpenscadGenerate({ ...request, previousCode: null, previousPrompt: null, previousJobId: null, previousSource: null }, sink);
  }

  emit(sink, { step: "import", message: "Loading the imported mesh…" });
  const previousObjects = await objectsFromJob(previous);
  const transformed = applyIntentToMeshes(
    previousObjects.map((object) => object.mesh),
    intent,
    previous.wearableSize,
    previous.wearableCategory,
  );
  const objects = withMeshes(previousObjects, transformed.meshes);
  const mesh = { triangles: objects.flatMap((object) => object.mesh.triangles) };
  const wearableSize = transformed.wearableSize;
  const fileName = previous.fileName ?? "imported.stl";
  const notes = [
    IMPORT_LIMITS_NOTE,
    wearableChartNote(),
    describeWearableSize(wearableSize, transformed.wearableCategory),
    ...intent.notes,
  ];
  if (!isDefaultOnlyRegions(colorRegionsFromObjects(objects))) {
    notes.push(colorRegionsNote(colorRegionsFromObjects(objects)));
  }

  if (intent.kind === "transform") {
    emit(sink, { step: "transform", message: "Scaling / orienting the imported mesh…" });
    const code = importedMeshStubScad({
      fileName,
      sizeMm: checkMesh(mesh).boundingBoxMm.size,
      triangleCount: mesh.triangles.length,
      wearableSize,
      wearableCategory: transformed.wearableCategory,
    });
    const artifacts = await artifactsFromObjects(objects, code, fileName, printPreset);
    const job = createJob({
      stl: artifacts.stl,
      threemf: artifacts.threemf,
      scad: artifacts.code,
      report: artifacts.report,
      usedFixture: true,
      retried: false,
      source: "imported-mesh",
      fileName,
      wearableSize,
      wearableCategory: transformed.wearableCategory,
      nativeSizeMm: previous.nativeSizeMm,
      editMode: "transform",
      notes,
      colorRegions: artifacts.colorRegions,
      printPreset,
    });
    emit(sink, { step: "done", message: "Updated the imported mesh on the plate." });
    return toGenerateResult(job);
  }

  const useFixture = shouldUseFixture(request.fixture);
  const importedStl = writeBinaryStl(mesh, fileName);
  const importedCtx = meshContext(mesh, fileName);
  const box = importedCtx;
  const hole = parseImportHoleSpec(prompt, {
    min: box.minMm,
    max: box.maxMm,
    size: box.sizeMm,
  }, intent.holeMm);
  const deterministic = canBuildDeterministicImportWrap(prompt, hole, intent.addTab);
  const wrapHint = importedWrapHint(hole, mesh, intent.addTab);
  const engineered = wrapHint.suggestedWrap ?? buildImportedMeshWrapper({ mesh, hole, addTab: intent.addTab });
  if (hole) notes.push(...hole.notes);
  if ((previous.colorRegions?.length ?? 0) > 1) {
    notes.push(
      "Hole wrap compiles one OpenSCAD solid, so previous 3MF color objects were flattened. Describe colors again to re-split filaments.",
    );
  }

  let retried = false;
  let lastCode = engineered;
  if (useFixture || deterministic) {
    emit(sink, { step: "codegen", message: "Using an engineering difference() wrap around the imported mesh…" });
  } else {
    emit(sink, { step: "codegen", message: "Asking local AI to wrap the imported mesh…" });
    lastCode = await codeFromLlm({ ...request, prompt }, undefined, null, importedCtx, wrapHint);
  }

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating imported-mesh wrapper…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source, { allowImportedMesh: true });
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }
    const wrapErrors = importedWrapErrors(sanitized.code, { requireHoleDifference: Boolean(hole) });
    if (wrapErrors.length) {
      throw new Error(wrapErrors.join("; "));
    }
    emit(sink, { step: "compile", message: "Compiling OpenSCAD wrapper → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileAndCheck(sanitized.code, importedStl, { sitOnBed: true, printPreset });
    return { code: sanitized.code, ...compiled };
  };

  let artifacts: Awaited<ReturnType<typeof attempt>> | undefined;
  for (let attemptNo = 1; attemptNo <= MAX_COMPILE_ATTEMPTS; attemptNo++) {
    try {
      artifacts = await attempt(lastCode, attemptNo);
      if (
        !useFixture &&
        !deterministic &&
        attemptNo < MAX_COMPILE_ATTEMPTS &&
        shouldRetryPrintability(artifacts.report, undefined, { importedWrap: true })
      ) {
        retried = true;
        const feedback = formatPrintabilityFeedback(artifacts.report);
        emit(sink, {
          step: "retry",
          message: `Printability issues — retrying wrapper (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
          attempt: attemptNo + 1,
        });
        lastCode = await codeFromLlm(
          request,
          { code: artifacts.code, error: feedback },
          null,
          importedCtx,
          wrapHint,
        );
        continue;
      }
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (useFixture || attemptNo === MAX_COMPILE_ATTEMPTS) {
        throw err;
      }
      if (deterministic && /must keep import|inverted|floating cylinder|must difference/i.test(message)) {
        lastCode = engineered;
        if (attemptNo === 1) {
          retried = true;
          continue;
        }
        throw err;
      }
      retried = true;
      emit(sink, {
        step: "retry",
        message: `Compile failed — retrying wrapper (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
        attempt: attemptNo + 1,
      });
      lastCode = await codeFromLlm(request, { code: lastCode, error: message }, null, importedCtx, wrapHint);
    }
  }

  if (!artifacts) {
    throw new Error("Imported-mesh edit failed");
  }

  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: useFixture,
    retried,
    source: "imported-mesh",
    fileName,
    wearableSize,
    wearableCategory: transformed.wearableCategory,
    nativeSizeMm: previous.nativeSizeMm,
    editMode: "describe-wrapper",
    notes,
    colorRegions: artifacts.colorRegions ?? [defaultColorRegion()],
    printPreset,
  });
  emit(sink, { step: "done", message: "Updated the imported mesh on the plate." });
  return toGenerateResult(job);
}

async function runOpenscadGenerate(
  request: GenerateRequest,
  sink?: StatusSink,
): Promise<GenerateResult> {
  const prompt = request.prompt?.trim();
  if (!prompt) {
    throw new Error("Describe what to print first.");
  }

  const useFixture = shouldUseFixture(request.fixture);
  const usedFixture = useFixture;
  let retried = false;
  let code = "";
  let plan: CadPlan | null = null;
  const wearableSize = request.wearableSize ?? null;
  const wearableCategory = resolveWearableCategory(request);
  const printPreset = presetFromRequest(request.filament);

  emit(sink, { step: "planning", message: "Understanding your description…" });

  if (useFixture) {
    emit(sink, { step: "codegen", message: "Using the fixture / heuristic OpenSCAD path (no live API)…" });
    code = codeFromFixture(request).code;
  } else {
    const local = isLocalOpenAiBaseUrl(getLlmConfig().baseUrl);
    if (isSmartPipelineEnabled()) {
      emit(sink, {
        step: "planning",
        message: "Planning printable features and dimensions…",
      });
      plan = await planFromLlm(request);
      emit(sink, {
        step: "codegen",
        message: local
          ? "Asking local AI for OpenSCAD from the plan…"
          : "Asking the model for OpenSCAD from the plan…",
      });
    } else {
      emit(sink, {
        step: "codegen",
        message: local ? "Asking local AI for OpenSCAD…" : "Asking the model for OpenSCAD…",
      });
    }
    code = await codeFromLlm(request, undefined, plan);
  }

  const colorRegions = withSelectedFilament(
    mergeColorRegionSources(prompt, plan?.color_regions),
    printPreset.material,
  );

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating generated code…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source);
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }

    emit(sink, { step: "compile", message: "Compiling OpenSCAD → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileAndCheck(sanitized.code, undefined, { colorRegions, printPreset });
    if (wearableSize && wearableSize !== "M") {
      emit(sink, { step: "transform", message: `Applying wearable size ${wearableSize}…` });
      const parsed = await parse3mfDocument(compiled.threemf);
      const objects = applyWearableToObjects(
        parsed.objects.length ? parsed.objects : objectsFromRegions([parseStl(compiled.stl)], colorRegions),
        wearableSize,
        wearableCategory,
      );
      const rebuilt = await artifactsFromObjects(objects, sanitized.code, "DescribePrint", printPreset);
      return { ...rebuilt, nativeSizeMm: compiled.report.boundingBoxMm.size, splitColorObjects: compiled.splitColorObjects };
    }
    return { code: sanitized.code, nativeSizeMm: compiled.report.boundingBoxMm.size, ...compiled };
  };

  let artifacts: Awaited<ReturnType<typeof attempt>> | undefined;
  let lastCode = code;
  for (let attemptNo = 1; attemptNo <= MAX_COMPILE_ATTEMPTS; attemptNo++) {
    try {
      artifacts = await attempt(lastCode, attemptNo);
      if (
        !useFixture &&
        attemptNo < MAX_COMPILE_ATTEMPTS &&
        shouldRetryPrintability(artifacts.report, undefined, {
          allowDisconnected: hasPrintInPlaceJoints(plan),
        })
      ) {
        retried = true;
        const feedback = formatPrintabilityFeedback(artifacts.report);
        emit(sink, {
          step: "retry",
          message: `Printability issues — retrying with mesh feedback (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
          attempt: attemptNo + 1,
        });
        lastCode = await codeFromLlm(request, { code: artifacts.code, error: feedback }, plan);
        continue;
      }
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (useFixture || attemptNo === MAX_COMPILE_ATTEMPTS) {
        throw err;
      }
      retried = true;
      emit(sink, {
        step: "retry",
        message: `Compile failed — retrying with compiler feedback (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
        attempt: attemptNo + 1,
      });
      lastCode = await codeFromLlm(request, { code: lastCode, error: message }, plan);
    }
  }

  if (!artifacts) {
    throw new Error("Generation failed");
  }

  const notes = wearableSize ? [wearableChartNote(), describeWearableSize(wearableSize, wearableCategory)] : [];
  const exportedRegions = artifacts.colorRegions ?? colorRegions;
  if (!isDefaultOnlyRegions(exportedRegions)) {
    notes.push(colorRegionsNote(exportedRegions));
    if (!artifacts.splitColorObjects && colorRegions.length > 1) {
      notes.push(
        "OpenSCAD compiled as one mesh, so this 3MF has a single colored object. Named region_* modules or color() groups are needed to split filament bodies.",
      );
    }
  }
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture,
    retried,
    source: "openscad",
    fileName: null,
    wearableSize,
    wearableCategory,
    nativeSizeMm: artifacts.nativeSizeMm ?? artifacts.report.boundingBoxMm.size,
    editMode: wearableSize && wearableSize !== "M" ? "transform" : "create",
    notes,
    colorRegions: exportedRegions,
    printPreset,
  });

  emit(sink, { step: "done", message: "Ready to preview and download." });
  return toGenerateResult(job);
}

function shouldTreatAsImportedEdit(request: GenerateRequest, previous?: StoredJob): boolean {
  if (!looksLikeImportedFollowUp(request) && previous?.source !== "imported-mesh") return false;
  const prompt = request.prompt ?? "";
  if (wantsNewDesign(prompt)) return false;
  const fresh = matchFixture(prompt, request.sizeHint, request.units ?? "mm");
  if (fresh && !isLikelyEdit(prompt)) return false;
  return true;
}

export async function runGeneratePipeline(
  request: GenerateRequest,
  sink?: StatusSink,
): Promise<GenerateResult> {
  if (request.cadHandoff) {
    return runCadReshapeUpper(
      {
        handoff: request.cadHandoff,
        prompt: request.prompt,
        previousCode: request.previousCode,
        previousPrompt: request.previousPrompt,
        previousJobId: request.previousJobId,
        fixture: request.fixture,
      },
      sink,
    );
  }

  const prompt = request.prompt?.trim() ?? "";
  if (!prompt && !request.wearableSize) {
    throw new Error("Describe what to print first.");
  }

  const previous = resolvePreviousJob(request);
  if (shouldTreatAsImportedEdit({ ...request, prompt: prompt || `Apply wearable size ${request.wearableSize}` }, previous)) {
    if (!previous) {
      throw new Error("Imported part expired. Import the STL/3MF again.");
    }
    return runImportedMeshEdit(
      {
        ...request,
        prompt: prompt || `Apply wearable size ${request.wearableSize}`,
      },
      previous,
      sink,
    );
  }

  if (previous && request.wearableSize && (!prompt || /^apply wearable size\b/i.test(prompt))) {
    emit(sink, { step: "transform", message: `Applying wearable size ${request.wearableSize}…` });
    const wearableCategory = resolveWearableCategory(request, previous);
    const intent = parseMeshEditIntent(
      prompt || `Apply wearable size ${request.wearableSize}`,
      request.wearableSize,
      wearableCategory,
    );
    const previousObjects = await objectsFromJob(previous);
    const transformed = applyIntentToMeshes(
      previousObjects.map((object) => object.mesh),
      intent,
      previous.wearableSize,
      previous.wearableCategory,
    );
    const objects = withMeshes(previousObjects, transformed.meshes);
    const mesh = { triangles: objects.flatMap((object) => object.mesh.triangles) };
    const notes = [wearableChartNote(), describeWearableSize(transformed.wearableSize, transformed.wearableCategory)];
    if (!isDefaultOnlyRegions(colorRegionsFromObjects(objects))) {
      notes.push(colorRegionsNote(colorRegionsFromObjects(objects)));
    }
    const source: PartSource = previous.source;
    const code =
      source === "imported-mesh"
        ? importedMeshStubScad({
            fileName: previous.fileName ?? "imported.stl",
            sizeMm: checkMesh(mesh).boundingBoxMm.size,
            triangleCount: mesh.triangles.length,
            wearableSize: transformed.wearableSize,
            wearableCategory: transformed.wearableCategory,
          })
        : previous.scad;
    const printPreset = presetFromRequest(request.filament);
    const artifacts = await artifactsFromObjects(objects, code, previous.fileName ?? "DescribePrint", printPreset);
    const job = createJob({
      stl: artifacts.stl,
      threemf: artifacts.threemf,
      scad: artifacts.code,
      report: artifacts.report,
      usedFixture: true,
      retried: false,
      source,
      fileName: previous.fileName,
      wearableSize: transformed.wearableSize,
      wearableCategory: transformed.wearableCategory,
      nativeSizeMm: previous.nativeSizeMm,
      editMode: "transform",
      notes,
      colorRegions: artifacts.colorRegions,
      printPreset,
    });
    emit(sink, { step: "done", message: "Applied wearable size." });
    return toGenerateResult(job);
  }

  return runOpenscadGenerate({ ...request, prompt: prompt || "printable part" }, sink);
}

export type { PlateEditMode };
