import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assemblyFromParts,
  emptyAssembly,
  hasNamedPartColors,
  objectsFromAssemblyParts,
  partsFromIslands,
  partsFromObjects,
  type AssemblyInfo,
} from "./assembly";
import {
  colorRegionsNote,
  defaultColorRegion,
  mergeColorRegionSources,
  withSelectedFilament,
  type ColorRegion,
} from "./color-regions";
import {
  applyRegionPaint,
  isRegionPaintOnly,
  mergePaintIntoRegions,
  paintThreeMfObjects,
  parseRegionPaintIntents,
  regionPaintNote,
  UNSPLIT_COLOR_NOTE,
} from "./region-paint";
import { printPresetSummary, type PrintPresetSummary } from "./printers";
import { boundingBoxMm, checkMesh, hasHardMeshFailure, splitSolidComponents } from "./mesh-check";
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
import { designateMachineForSize } from "./alternate-machines";
import { completeExistingSolid, completionNote, regionLabelsNote } from "./image-complete";
import { buildImageSolidFromUpload, imageSolidStubScad, photoPlateHeadline, type ImageImportOptions } from "./image-import";
import {
  decodeImageReliefField,
  formatImageReliefNote,
  imageReliefHostSizeMm,
  wantsImageRelief,
} from "./relief-image";
import { noneSubjectIdentify } from "./image-subject";
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
import { formatPrettyUpNote, inferCadPrettyUp } from "./pretty-up";
import { formatLatticeNote, inferCadLattice } from "./lattice";
import { attachImageMotif, formatReliefNote, inferCadReliefs, standaloneImageReliefScad } from "./relief";
import { cadKnowledgeFromPrompt, formatKnowledgeNote } from "./knowledge";
import {
  applyChoicesToGenerateFields,
  formatDesignOptionsNote,
  resolveDesignOptions,
} from "./design-options";
import { parseMeshEditIntent, type MeshEditIntent } from "./mesh-edit";
import {
  rotateMeshesZ,
  scaleMeshesToMaxMm,
  scaleMeshesUniform,
  sitMeshOnBed,
  sitMeshesOnBed,
  translateMesh,
} from "./mesh-transform";
import { extractOpenScadAssemblyBodies, extractOpenScadColorBodies, mergeScadBodiesWithRegions, scadWithOnlyBody } from "./openscad-colors";
import { hasPrintInPlaceJoints, type CadJoint } from "./joints";
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

function sitObjectsAsGroup(objects: ThreeMfObject[]): ThreeMfObject[] {
  if (objects.length === 0) return objects;
  const combined = { triangles: objects.flatMap((object) => object.mesh.triangles) };
  const box = boundingBoxMm(combined);
  if (!Number.isFinite(box.min[2]) || Math.abs(box.min[2]) < 1e-6) return objects;
  return objects.map((object) => ({ ...object, mesh: translateMesh(object.mesh, [0, 0, -box.min[2]]) }));
}

function assemblyFromExportObjects(
  objects: ThreeMfObject[],
  opts: { code?: string | null; prompt?: string | null; joints?: CadJoint[] | null } = {},
): AssemblyInfo {
  if (objects.length < 2) return emptyAssembly();
  const parts = partsFromObjects(objects, opts);
  return assemblyFromParts(parts, {
    ...opts,
    namedColors: hasNamedPartColors(colorRegionsFromObjects(objects)),
  });
}

async function compileAssemblyObjects(
  code: string,
  regions: ColorRegion[],
  dir: string,
): Promise<ThreeMfObject[]> {
  const bodies = extractOpenScadAssemblyBodies(code);
  if (bodies.length < 2) return [];
  const paired = mergeScadBodiesWithRegions(bodies, regions);
  const objects: ThreeMfObject[] = [];
  for (const item of paired) {
    try {
      const compiled = await compileOpenScad(scadWithOnlyBody(code, item.renderStatement), dir);
      const mesh = parseStl(compiled.stl);
      if (mesh.triangles.length === 0) continue;
      objects.push({
        name: item.name,
        mesh,
        colorHex: item.region.colorHex,
        colorName: item.region.colorName,
        filament: item.region.filament,
        extruder: item.region.amsSlot,
      });
    } catch {
      // Isolate compile failed — fall back to mesh islands.
    }
  }
  return objects.length >= 2 ? objects : [];
}

async function artifactsFromObjects(
  objects: ThreeMfObject[],
  code: string,
  name = "DescribePrint",
  printPreset: PrintPresetSummary = printPresetSummary("pla"),
  opts: { prompt?: string | null; joints?: CadJoint[] | null; sitAsGroup?: boolean } = {},
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  code: string;
  colorRegions: ColorRegion[];
  assembly: AssemblyInfo;
}> {
  const seated = stampPresetFilament(
    opts.sitAsGroup
      ? sitObjectsAsGroup(objects)
      : withMeshes(objects, sitMeshesOnBed(objects.map((object) => object.mesh))),
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
  return {
    stl,
    threemf,
    report,
    code,
    colorRegions: colorRegionsFromObjects(seated),
    assembly: assemblyFromExportObjects(seated, { code, prompt: opts.prompt, joints: opts.joints }),
  };
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
  assembly: AssemblyInfo;
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

function importedWrapHint(
  hole: ImportHoleSpec | null,
  mesh: Mesh,
  addTab: boolean,
  prompt?: string,
) {
  const box = checkMesh(mesh).boundingBoxMm;
  const reliefs = prompt ? inferCadReliefs(prompt, box.size) : [];
  const prettyUp = prompt
    ? inferCadPrettyUp({
        prompt,
        holes: hole ? [{ d: hole.diameterMm, through: hole.through }] : undefined,
        sizeMm: box.size,
        reliefs,
      })
    : undefined;
  const lattice = prompt
    ? inferCadLattice({
        prompt,
        holes: hole ? [{ d: hole.diameterMm, through: hole.through }] : undefined,
        sizeMm: box.size,
      })
    : undefined;
  return {
    holeSpecNote: hole ? formatHoleSpecForPrompt(hole, box) : undefined,
    suggestedWrap:
      hole || addTab || reliefs.length || prettyUp?.applied || lattice?.applied
        ? buildImportedMeshWrapper({ mesh, hole, addTab, reliefs, prettyUp, lattice, prompt })
        : undefined,
  };
}

async function compileAndCheck(
  code: string,
  importedStl?: Buffer,
  opts: {
    sitOnBed?: boolean;
    colorRegions?: ColorRegion[];
    printPreset?: PrintPresetSummary;
    prompt?: string | null;
    joints?: CadJoint[] | null;
  } = {},
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  colorRegions: ColorRegion[];
  splitColorObjects: boolean;
  assembly: AssemblyInfo;
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
    let exportObjects: ThreeMfObject[];
    if (colorObjects.length >= 2) {
      exportObjects = withMeshes(colorObjects, sitMeshesOnBed(colorObjects.map((object) => object.mesh)));
    } else {
      const moduleObjects = importedStl ? [] : await compileAssemblyObjects(code, regions, dir);
      if (moduleObjects.length >= 2) {
        exportObjects = opts.sitOnBed ? sitObjectsAsGroup(moduleObjects) : moduleObjects;
      } else {
        const islands = splitSolidComponents(mesh);
        if (islands.length >= 2) {
          exportObjects = objectsFromAssemblyParts(
            partsFromIslands(islands, { code, prompt: opts.prompt, joints: opts.joints }),
          );
        } else {
          exportObjects = objectsFromRegions([mesh], regions, "DescribePrint", printPreset.material);
        }
      }
    }
    exportObjects = stampPresetFilament(exportObjects, printPreset);
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
      assembly: assemblyFromExportObjects(exportObjects, {
        code,
        prompt: opts.prompt,
        joints: opts.joints,
      }),
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
  input: {
    buffer: Buffer;
    fileName?: string;
    options?: ImageImportOptions;
    filament?: string | null;
    previousJobId?: string | null;
    previousPrompt?: string | null;
  },
  sink?: StatusSink,
): Promise<GenerateResult> {
  const prompt = [input.options?.prompt, input.previousPrompt].filter(Boolean).join(" — ");
  const previous = input.previousJobId ? getJob(input.previousJobId) : undefined;
  if (
    wantsImageRelief({
      prompt,
      fileName: input.fileName,
      hasPreviousPart: Boolean(previous),
    })
  ) {
    return runImageReliefImport(input, previous, prompt, sink);
  }

  emit(sink, { step: "image", message: "Reading the photo…" });
  const options = input.options ?? { repair: true, keepWear: false, targetMaxMm: null };
  emit(sink, {
    step: "planning",
    message: options.repair
      ? "Inferring luminance-depth backside and repairing cracks…"
      : "Inferring luminance-depth backside (keeping wear)…",
  });
  const built = buildImageSolidFromUpload(input.buffer, input.fileName, options);
  if (built.fragment.looksLikeFragment) {
    emit(sink, {
      step: "planning",
      message: built.fragment.restoredMissingVolume
        ? "Identified a fragment vs the intended whole — restoring missing volume…"
        : "Identified a fragment vs the intended whole — keeping the photographed wear…",
    });
  }
  if (built.completion.applied) {
    emit(sink, {
      step: "planning",
      message: "Matching the photographed partial and completing a parametric body…",
    });
  }
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
    fragment: built.fragment,
    subject: built.subject,
    completion: built.completion,
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
    assembly: artifacts.assembly,
    imageImport: built.meta,
    machineDesignation: built.designation,
    printPreset,
  });
  emit(sink, {
    step: "done",
    message: built.designation.exceedsCurrentPrinter
      ? "Photo solid is on the plate — current printer is too small."
      : `${photoPlateHeadline(built.meta)}.`,
  });
  return toGenerateResult(job);
}

async function runImageReliefImport(
  input: {
    buffer: Buffer;
    fileName?: string;
    options?: ImageImportOptions;
    filament?: string | null;
  },
  previous: StoredJob | undefined,
  prompt: string,
  sink?: StatusSink,
): Promise<GenerateResult> {
  emit(sink, { step: "image", message: "Reading the logo as a silhouette relief…" });
  const field = decodeImageReliefField(input.buffer, input.fileName);
  const printPreset = presetFromRequest(input.filament);
  const reliefPrompt = prompt.trim() || "emboss this logo on the front";

  if (previous) {
    emit(sink, { step: "import", message: "Applying the image relief to the part on the plate…" });
    const previousObjects = await objectsFromJob(previous);
    const mesh = { triangles: previousObjects.flatMap((object) => object.mesh.triangles) };
    const box = checkMesh(mesh).boundingBoxMm;
    const reliefs = attachImageMotif(inferCadReliefs(reliefPrompt, box.size), field, reliefPrompt, box.size);
    const fileName = previous.fileName ?? "imported.stl";
    const importedStl = writeBinaryStl(mesh, fileName);
    const code = buildImportedMeshWrapper({ mesh, reliefs, prompt: reliefPrompt });
    emit(sink, { step: "compile", message: "Compiling image relief wrap → STL…" });
    const compiled = await compileAndCheck(code, importedStl, {
      sitOnBed: true,
      printPreset,
      prompt: reliefPrompt,
    });
    const notes = [
      IMPORT_LIMITS_NOTE,
      wearableChartNote(),
      describeWearableSize(previous.wearableSize, previous.wearableCategory ?? DEFAULT_WEARABLE_CATEGORY),
      formatReliefNote(reliefs),
      formatImageReliefNote(field, reliefs[0]?.kind ?? "emboss"),
    ];
    const job = createJob({
      stl: compiled.stl,
      threemf: compiled.threemf,
      scad: code,
      report: compiled.report,
      usedFixture: true,
      retried: false,
      source: "imported-mesh",
      fileName,
      wearableSize: previous.wearableSize,
      wearableCategory: previous.wearableCategory,
      nativeSizeMm: previous.nativeSizeMm,
      editMode: "describe-wrapper",
      notes,
      colorRegions: compiled.colorRegions,
      assembly: compiled.assembly,
      printPreset,
      imageImport: previous.imageImport ?? null,
      machineDesignation: previous.machineDesignation ?? null,
    });
    emit(sink, { step: "done", message: "Image relief is on the plate (silhouette / heightfield stub)." });
    return toGenerateResult(job);
  }

  const sizeMm = imageReliefHostSizeMm(reliefPrompt);
  const reliefs = attachImageMotif(inferCadReliefs(reliefPrompt, sizeMm), field, reliefPrompt, sizeMm);
  const code = standaloneImageReliefScad(reliefs, sizeMm, reliefPrompt);
  emit(sink, { step: "compile", message: "Compiling image relief on a host solid…" });
  const compiled = await compileAndCheck(code, undefined, {
    sitOnBed: true,
    printPreset,
    prompt: reliefPrompt,
  });
  const wearableCategory = inferWearableCategory(reliefPrompt, input.fileName);
  const notes = [
    formatReliefNote(reliefs),
    formatImageReliefNote(field, reliefs[0]?.kind ?? "emboss"),
    wearableChartNote(),
    describeWearableSize(null, wearableCategory),
  ];
  const job = createJob({
    stl: compiled.stl,
    threemf: compiled.threemf,
    scad: code,
    report: compiled.report,
    usedFixture: true,
    retried: false,
    source: "openscad",
    fileName: input.fileName ?? "logo-relief.scad",
    wearableSize: null,
    wearableCategory,
    nativeSizeMm: compiled.report.boundingBoxMm.size,
    editMode: "create",
    notes,
    colorRegions: compiled.colorRegions,
    assembly: compiled.assembly,
    printPreset,
  });
  emit(sink, { step: "done", message: "Image relief is on the plate (silhouette / heightfield stub)." });
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
  if (hasNamedPartColors(artifacts.colorRegions)) {
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
    assembly: artifacts.assembly,
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

  if (intent.kind === "complete-body") {
    return runCompleteBodyEdit(request, previous, prompt, printPreset, wearableCategory, intent, sink);
  }

  if (isRegionPaintOnly(prompt)) {
    return runRegionPaintEdit(request, previous, sink);
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
  if (hasNamedPartColors(colorRegionsFromObjects(objects))) {
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
      assembly: artifacts.assembly,
      printPreset,
      imageImport: previous.imageImport ?? null,
      machineDesignation: previous.machineDesignation ?? null,
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
  const reliefs = inferCadReliefs(prompt, box.sizeMm);
  const prettyUp = inferCadPrettyUp({
    prompt,
    previousPrompt: request.previousPrompt,
    previousCode: request.previousCode,
    holes: hole ? [{ d: hole.diameterMm, through: hole.through }] : undefined,
    sizeMm: box.sizeMm,
    reliefs,
  });
  const lattice = inferCadLattice({
    prompt,
    previousPrompt: request.previousPrompt,
    previousCode: request.previousCode,
    holes: hole ? [{ d: hole.diameterMm, through: hole.through }] : undefined,
    sizeMm: box.sizeMm,
  });
  const deterministic = canBuildDeterministicImportWrap(prompt, hole, intent.addTab, reliefs, prettyUp, lattice);
  const wrapHint = importedWrapHint(hole, mesh, intent.addTab, prompt);
  const engineered = wrapHint.suggestedWrap ?? buildImportedMeshWrapper({ mesh, hole, addTab: intent.addTab, reliefs, prettyUp, lattice, prompt });
  if (hole) notes.push(...hole.notes);
  if (reliefs.length) notes.push(formatReliefNote(reliefs));
  const prettyNote = formatPrettyUpNote(prettyUp);
  if (prettyNote) notes.push(prettyNote);
  const latticeNote = formatLatticeNote(lattice);
  if (latticeNote) notes.push(latticeNote);
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
    const wrapErrors = importedWrapErrors(sanitized.code, {
      requireHoleDifference: Boolean(hole),
      allowUnionedRelief:
        reliefs.some((relief) => relief.kind === "emboss") ||
        intent.addTab ||
        Boolean(prettyUp?.applied && prettyUp.ops.some((op) => op.kind !== "chamfer")),
    });
    if (wrapErrors.length) {
      throw new Error(wrapErrors.join("; "));
    }
    emit(sink, { step: "compile", message: "Compiling OpenSCAD wrapper → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileAndCheck(sanitized.code, importedStl, {
      sitOnBed: true,
      printPreset,
      prompt: request.prompt,
    });
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
    assembly: artifacts.assembly,
    printPreset,
    imageImport: previous.imageImport ?? null,
    machineDesignation: previous.machineDesignation ?? null,
  });
  emit(sink, { step: "done", message: "Updated the imported mesh on the plate." });
  return toGenerateResult(job);
}

async function runCompleteBodyEdit(
  _request: GenerateRequest,
  previous: StoredJob,
  prompt: string,
  printPreset: PrintPresetSummary,
  wearableCategory: WearableCategoryId,
  intent: MeshEditIntent,
  sink?: StatusSink,
): Promise<GenerateResult> {
  emit(sink, { step: "planning", message: "Matching the plate solid and completing a parametric body…" });
  const previousObjects = await objectsFromJob(previous);
  const combined = { triangles: previousObjects.flatMap((object) => object.mesh.triangles) };
  const prior = previous.imageImport;
  const subject = prior?.subject ?? noneSubjectIdentify();
  if (prior?.completion?.applied) {
    const notes = [
      ...intent.notes,
      "Match-and-complete already applied — the plate already has a completed figure.",
      prior.completion.note || completionNote(prior.completion),
      regionLabelsNote(prior.completion),
      wearableChartNote(),
      describeWearableSize(previous.wearableSize, wearableCategory),
    ].filter(Boolean);
    emit(sink, { step: "done", message: `${photoPlateHeadline(prior)}.` });
    return toGenerateResult({
      ...previous,
      notes,
    });
  }
  const completed = completeExistingSolid(combined, subject.class === "none" ? { ...subject, class: "head", confidence: 0.64, source: "chat" } : subject, {
    prompt,
  });
  const designation = designateMachineForSize(checkMesh(completed.mesh).boundingBoxMm.size);
  const imageImport = prior
    ? { ...prior, subject: subject.class === "none" ? { ...subject, class: "head" as const, confidence: 0.64, source: "chat" as const } : subject, completion: completed.completion }
    : null;
  const fileName = previous.fileName ?? "imported.stl";
  const code = prior
    ? imageSolidStubScad({
        fileName,
        sizeMm: checkMesh(completed.mesh).boundingBoxMm.size,
        triangleCount: completed.mesh.triangles.length,
        format: prior.format,
        repairApplied: prior.repairApplied,
        keepWear: prior.keepWear,
        designation,
        fragment: prior.fragment,
        subject: imageImport?.subject,
        completion: completed.completion,
      })
    : importedMeshStubScad({
        fileName,
        sizeMm: checkMesh(completed.mesh).boundingBoxMm.size,
        triangleCount: completed.mesh.triangles.length,
      });
  const notes = [
    completionNote(completed.completion),
    regionLabelsNote(completed.completion),
    ...intent.notes,
    wearableChartNote(),
    describeWearableSize(previous.wearableSize, wearableCategory),
  ].filter(Boolean);
  if (designation.message) notes.push(designation.message);
  emit(sink, { step: "mesh-check", message: "Checking the completed solid against the P2S bed…" });
  emit(sink, { step: "export", message: "Writing STL and 3MF…" });
  const artifacts = await artifactsFromMesh(completed.mesh, code, fileName, undefined, printPreset);
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: true,
    retried: false,
    source: "imported-mesh",
    fileName,
    wearableSize: previous.wearableSize,
    wearableCategory,
    nativeSizeMm: artifacts.report.boundingBoxMm.size,
    editMode: prior ? "image-import" : "transform",
    notes,
    colorRegions: artifacts.colorRegions,
    assembly: artifacts.assembly,
    printPreset,
    imageImport,
    machineDesignation: designation,
  });
  emit(sink, { step: "done", message: imageImport ? `${photoPlateHeadline(imageImport)}.` : "Completed a matching body on the plate." });
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

  const previousJob = resolvePreviousJob(request);
  const colorRegions = withSelectedFilament(
    mergePaintIntoRegions(
      prompt,
      previousJob?.colorRegions,
      mergeColorRegionSources(prompt, plan?.color_regions),
    ),
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
    const compiled = await compileAndCheck(sanitized.code, undefined, {
      colorRegions,
      printPreset,
      prompt,
      joints: plan?.joints,
    });
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
  const reliefNote = formatReliefNote(plan?.reliefs ?? inferCadReliefs(prompt));
  if (reliefNote) notes.push(reliefNote);
  const prettyUp = plan?.pretty_up ?? inferCadPrettyUp({
    prompt,
    previousPrompt: request.previousPrompt,
    previousCode: request.previousCode,
    holes: plan?.holes,
    joints: plan?.joints,
    reliefs: plan?.reliefs,
  });
  const prettyNote = formatPrettyUpNote(prettyUp);
  if (prettyNote) notes.push(prettyNote);
  const lattice = plan?.lattice ?? inferCadLattice({
    prompt,
    previousPrompt: request.previousPrompt,
    previousCode: request.previousCode,
    holes: plan?.holes,
    joints: plan?.joints,
  });
  const latticeNote = formatLatticeNote(lattice);
  if (latticeNote) notes.push(latticeNote);
  const knowledge = plan?.knowledge ?? cadKnowledgeFromPrompt(prompt);
  const knowledgeNote = formatKnowledgeNote(knowledge);
  if (knowledgeNote) notes.push(knowledgeNote);
  const exportedRegions = artifacts.colorRegions ?? colorRegions;
  if (hasNamedPartColors(exportedRegions)) {
    notes.push(colorRegionsNote(exportedRegions));
    if (!artifacts.splitColorObjects && colorRegions.length > 1) {
      notes.push(UNSPLIT_COLOR_NOTE);
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
    assembly: artifacts.assembly,
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

function attachDesignOptions(
  result: GenerateResult,
  request: GenerateRequest,
  plan?: CadPlan | null,
): GenerateResult {
  const previous = resolvePreviousJob(request);
  const resolved = resolveDesignOptions({
    prompt: request.prompt,
    previousPrompt: request.previousPrompt,
    choices: request.choices,
    wearableSize: request.wearableSize,
    filament: request.filament,
    colorRegions: result.colorRegions ?? previous?.colorRegions,
    plan,
  });
  const notes = [...(result.notes ?? [])];
  const optionNote = formatDesignOptionsNote(resolved);
  if (optionNote && !notes.includes(optionNote)) notes.push(optionNote);
  return {
    ...result,
    notes,
    needs_user_choice: resolved.needs_user_choice,
    options: resolved.options,
    appliedChoices: resolved.applied,
  };
}

function withAppliedChoices(request: GenerateRequest): GenerateRequest {
  const applied = applyChoicesToGenerateFields({
    prompt: request.prompt,
    choices: request.choices,
    wearableSize: request.wearableSize,
    filament: request.filament,
  });
  return {
    ...request,
    prompt: applied.prompt,
    choices: applied.choices,
    wearableSize: applied.wearableSize,
    filament: applied.filament,
  };
}

export async function runGeneratePipeline(
  request: GenerateRequest,
  sink?: StatusSink,
): Promise<GenerateResult> {
  const resolvedRequest = withAppliedChoices(request);
  const result = await runGeneratePipelineCore(resolvedRequest, sink);
  return attachDesignOptions(result, resolvedRequest);
}

async function runGeneratePipelineCore(
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
  if (previous && prompt && isRegionPaintOnly(prompt)) {
    return runRegionPaintEdit(request, previous, sink);
  }
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
    if (hasNamedPartColors(colorRegionsFromObjects(objects))) {
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
      assembly: artifacts.assembly,
      printPreset,
    });
    emit(sink, { step: "done", message: "Applied wearable size." });
    return toGenerateResult(job);
  }

  return runOpenscadGenerate({ ...request, prompt: prompt || "printable part" }, sink);
}

async function runRegionPaintEdit(
  request: GenerateRequest,
  previous: StoredJob,
  sink?: StatusSink,
): Promise<GenerateResult> {
  const prompt = request.prompt?.trim() ?? "";
  const printPreset = presetFromRequest(request.filament);
  emit(sink, { step: "transform", message: "Painting named color regions…" });
  const previousObjects = await objectsFromJob(previous);
  const before =
    previous.colorRegions?.length ? previous.colorRegions : colorRegionsFromObjects(previousObjects);
  const intents = parseRegionPaintIntents(prompt);
  const nextRegions = applyRegionPaint(before, intents);
  const objects = paintThreeMfObjects(previousObjects, nextRegions);
  const notes = [
    regionPaintNote({ before, after: nextRegions, objectCount: objects.length }),
    colorRegionsNote(nextRegions),
  ];
  if (objects.length < 2 && nextRegions.length > 1) {
    notes.push(UNSPLIT_COLOR_NOTE);
  }
  const artifacts = await artifactsFromObjects(
    objects,
    previous.scad,
    previous.fileName ?? "DescribePrint",
    printPreset,
  );
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: true,
    retried: false,
    source: previous.source,
    fileName: previous.fileName,
    wearableSize: previous.wearableSize,
    wearableCategory: previous.wearableCategory,
    nativeSizeMm: previous.nativeSizeMm,
    editMode: previous.editMode === "image-import" ? "image-import" : "transform",
    notes,
    colorRegions: artifacts.colorRegions,
    assembly: artifacts.assembly,
    printPreset,
    imageImport: previous.imageImport ?? null,
    machineDesignation: previous.machineDesignation ?? null,
  });
  emit(sink, { step: "done", message: "Recolored named regions. 3MF objects updated — not live AMS." });
  return toGenerateResult(job);
}

export type { PlateEditMode };
