import { writeFile } from "node:fs/promises";
import path from "node:path";
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
import { parseMeshEditIntent, type MeshEditIntent } from "./mesh-edit";
import { rotateMeshZ, scaleMeshToMaxMm, scaleMeshUniform, sitMeshOnBed } from "./mesh-transform";
import { formatPrintabilityFeedback, shouldRetryPrintability, wantsNewDesign } from "./printability";
import { IMPORTED_MESH_FILENAME, sanitizeOpenScad } from "./sanitize";
import { parseStl, writeBinaryStl } from "./stl";
import { meshTo3mf } from "./threemf";
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

async function artifactsFromMesh(
  mesh: Mesh,
  code: string,
  name = "DescribePrint",
): Promise<{ stl: Buffer; threemf: Buffer; report: ReturnType<typeof checkMesh>; code: string }> {
  const seated = sitMeshOnBed(mesh);
  const report = checkMesh(seated);
  if (hasHardMeshFailure(report)) {
    const summary = report.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    throw new Error(`Mesh check failed: ${summary}`);
  }
  const stl = writeBinaryStl(seated, name);
  const threemf = await meshTo3mf(seated, name);
  return { stl, threemf, report, code };
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

function heuristicImportedWrapper(intent: MeshEditIntent, mesh: Mesh): string {
  const report = checkMesh(mesh);
  const [sx, sy, sz] = report.boundingBoxMm.size;
  const [minx, miny] = report.boundingBoxMm.min;
  const cx = minx + sx / 2;
  const cy = miny + sy / 2;
  const hole = intent.holeMm && intent.holeMm > 0 ? intent.holeMm : 5;
  const lines = [
    "// DescribePrint imported-mesh wrapper (mm)",
    "$fn = 64;",
    `hole_d = ${hole};`,
    `tab_w = 12;`,
    `tab_d = 16;`,
    `tab_h = 3;`,
  ];

  if (intent.addTab && intent.holeMm) {
    lines.push(`union() {
  difference() {
    import("${IMPORTED_MESH_FILENAME}", convexity = 10);
    translate([${cx.toFixed(3)}, ${cy.toFixed(3)}, -1])
      cylinder(h = ${sz + 2}, d = hole_d);
  }
  translate([${(minx + sx).toFixed(3)}, ${(cy - 8).toFixed(3)}, 0])
    cube([tab_w, tab_d, tab_h]);
}`);
  } else if (intent.addTab) {
    lines.push(`union() {
  import("${IMPORTED_MESH_FILENAME}", convexity = 10);
  translate([${(minx + sx).toFixed(3)}, ${(cy - 8).toFixed(3)}, 0])
    cube([tab_w, tab_d, tab_h]);
}`);
  } else if (intent.holeMm) {
    lines.push(`difference() {
  import("${IMPORTED_MESH_FILENAME}", convexity = 10);
  translate([${cx.toFixed(3)}, ${cy.toFixed(3)}, -1])
    cylinder(h = ${sz + 2}, d = hole_d);
}`);
  } else {
    lines.push(`import("${IMPORTED_MESH_FILENAME}", convexity = 10);`);
  }
  return lines.join("\n");
}

async function compileAndCheck(
  code: string,
  importedStl?: Buffer,
): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
}> {
  return withTempDir(async (dir) => {
    if (importedStl) {
      await writeFile(path.join(dir, IMPORTED_MESH_FILENAME), importedStl);
    }
    const compiled = await compileOpenScad(code, dir);
    const mesh = parseStl(compiled.stl);
    const report = checkMesh(mesh);
    if (hasHardMeshFailure(report)) {
      const summary = report.issues
        .filter((i) => i.severity === "error")
        .map((i) => i.message)
        .join("; ");
      throw new Error(`Mesh check failed: ${summary}`);
    }
    const threemf = await meshTo3mf(mesh, "DescribePrint");
    return { stl: compiled.stl, threemf, report };
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

function applyIntentTransforms(
  mesh: Mesh,
  intent: MeshEditIntent,
  currentSize: WearableSizeId | null,
  currentCategory: WearableCategoryId | null,
): { mesh: Mesh; wearableSize: WearableSizeId | null; wearableCategory: WearableCategoryId } {
  let next = mesh;
  let wearableSize = currentSize;
  const wearableCategory = intent.wearableCategory ?? currentCategory ?? DEFAULT_WEARABLE_CATEGORY;
  if (intent.wearableSize) {
    next = scaleMeshUniform(
      next,
      wearableScaleFactor(currentSize, intent.wearableSize, currentCategory, wearableCategory),
    );
    wearableSize = intent.wearableSize;
  }
  if (Math.abs(intent.scale - 1) > 1e-9) {
    next = scaleMeshUniform(next, intent.scale);
  }
  if (intent.targetMaxMm) {
    next = scaleMeshToMaxMm(next, intent.targetMaxMm);
  }
  if (intent.rotateZDeg !== null) {
    next = rotateMeshZ(next, intent.rotateZDeg);
  }
  if (intent.sitOnBed) {
    next = sitMeshOnBed(next);
  }
  return { mesh: next, wearableSize, wearableCategory };
}

function applyWearableToCompiled(
  stl: Buffer,
  wearableSize: WearableSizeId | null | undefined,
  wearableCategory: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): Mesh {
  let mesh = parseStl(stl);
  if (wearableSize && wearableSize !== "M") {
    mesh = scaleMeshUniform(mesh, wearableScaleFactor("M", wearableSize, wearableCategory, wearableCategory));
  }
  return sitMeshOnBed(mesh);
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

export async function runImportPipeline(
  input: { buffer: Buffer; fileName?: string },
  sink?: StatusSink,
): Promise<GenerateResult> {
  emit(sink, { step: "import", message: "Reading STL/3MF…" });
  const imported = await parseImportedMesh(input.buffer, input.fileName);
  emit(sink, { step: "mesh-check", message: "Checking imported mesh printability…" });
  emit(sink, { step: "export", message: "Writing STL and 3MF…" });
  const seated = sitMeshOnBed(imported.mesh);
  const code = importedMeshStubScad({
    fileName: imported.fileName,
    sizeMm: checkMesh(seated).boundingBoxMm.size,
    triangleCount: seated.triangles.length,
  });
  const artifacts = await artifactsFromMesh(seated, code, imported.fileName);
  const wearableCategory = inferWearableCategory(imported.fileName);
  const notes = [IMPORT_LIMITS_NOTE, wearableChartNote(), describeWearableSize(null, wearableCategory)];
  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: true,
    retried: false,
    source: "imported-mesh",
    fileName: imported.fileName,
    wearableSize: null,
    wearableCategory,
    nativeSizeMm: artifacts.report.boundingBoxMm.size,
    editMode: "import",
    notes,
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

  const wearableCategory = resolveWearableCategory(request, previous);
  const intent = parseMeshEditIntent(prompt, request.wearableSize, wearableCategory);
  if (intent.kind === "new-design") {
    return runOpenscadGenerate({ ...request, previousCode: null, previousPrompt: null, previousJobId: null, previousSource: null }, sink);
  }

  emit(sink, { step: "import", message: "Loading the imported mesh…" });
  let mesh = parseStl(previous.stl);
  const transformed = applyIntentTransforms(mesh, intent, previous.wearableSize, previous.wearableCategory);
  mesh = transformed.mesh;
  const wearableSize = transformed.wearableSize;
  const fileName = previous.fileName ?? "imported.stl";
  const notes = [
    IMPORT_LIMITS_NOTE,
    wearableChartNote(),
    describeWearableSize(wearableSize, transformed.wearableCategory),
    ...intent.notes,
  ];

  if (intent.kind === "transform") {
    emit(sink, { step: "transform", message: "Scaling / orienting the imported mesh…" });
    const code = importedMeshStubScad({
      fileName,
      sizeMm: checkMesh(mesh).boundingBoxMm.size,
      triangleCount: mesh.triangles.length,
      wearableSize,
      wearableCategory: transformed.wearableCategory,
    });
    const artifacts = await artifactsFromMesh(mesh, code, fileName);
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
    });
    emit(sink, { step: "done", message: "Updated the imported mesh on the plate." });
    return toGenerateResult(job);
  }

  const useFixture = shouldUseFixture(request.fixture);
  const importedStl = writeBinaryStl(mesh, fileName);
  const importedCtx = meshContext(mesh, fileName);
  let retried = false;
  let lastCode = useFixture
    ? heuristicImportedWrapper(intent, mesh)
    : await codeFromLlm({ ...request, prompt }, undefined, null, importedCtx);

  if (useFixture) {
    emit(sink, { step: "codegen", message: "Using a fixture wrapper around the imported mesh…" });
  } else {
    emit(sink, { step: "codegen", message: "Asking local AI to wrap the imported mesh…" });
  }

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating imported-mesh wrapper…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source, { allowImportedMesh: true });
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }
    emit(sink, { step: "compile", message: "Compiling OpenSCAD wrapper → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileAndCheck(sanitized.code, importedStl);
    return { code: sanitized.code, ...compiled };
  };

  let artifacts: Awaited<ReturnType<typeof attempt>> | undefined;
  for (let attemptNo = 1; attemptNo <= MAX_COMPILE_ATTEMPTS; attemptNo++) {
    try {
      artifacts = await attempt(lastCode, attemptNo);
      if (
        !useFixture &&
        attemptNo < MAX_COMPILE_ATTEMPTS &&
        shouldRetryPrintability(artifacts.report)
      ) {
        retried = true;
        const feedback = formatPrintabilityFeedback(artifacts.report);
        emit(sink, {
          step: "retry",
          message: `Printability issues — retrying wrapper (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
          attempt: attemptNo + 1,
        });
        lastCode = await codeFromLlm(request, { code: artifacts.code, error: feedback }, null, importedCtx);
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
        message: `Compile failed — retrying wrapper (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
        attempt: attemptNo + 1,
      });
      lastCode = await codeFromLlm(request, { code: lastCode, error: message }, null, importedCtx);
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

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating generated code…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source);
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }

    emit(sink, { step: "compile", message: "Compiling OpenSCAD → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileAndCheck(sanitized.code);
    if (wearableSize && wearableSize !== "M") {
      emit(sink, { step: "transform", message: `Applying wearable size ${wearableSize}…` });
      const scaled = applyWearableToCompiled(compiled.stl, wearableSize, wearableCategory);
      const rebuilt = await artifactsFromMesh(scaled, sanitized.code);
      return { ...rebuilt, nativeSizeMm: compiled.report.boundingBoxMm.size };
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
        shouldRetryPrintability(artifacts.report)
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
    const transformed = applyIntentTransforms(
      parseStl(previous.stl),
      intent,
      previous.wearableSize,
      previous.wearableCategory,
    );
    const notes = [wearableChartNote(), describeWearableSize(transformed.wearableSize, transformed.wearableCategory)];
    const source: PartSource = previous.source;
    const code =
      source === "imported-mesh"
        ? importedMeshStubScad({
            fileName: previous.fileName ?? "imported.stl",
            sizeMm: checkMesh(transformed.mesh).boundingBoxMm.size,
            triangleCount: transformed.mesh.triangles.length,
            wearableSize: transformed.wearableSize,
            wearableCategory: transformed.wearableCategory,
          })
        : previous.scad;
    const artifacts = await artifactsFromMesh(transformed.mesh, code, previous.fileName ?? "DescribePrint");
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
    });
    emit(sink, { step: "done", message: "Applied wearable size." });
    return toGenerateResult(job);
  }

  return runOpenscadGenerate({ ...request, prompt: prompt || "printable part" }, sink);
}

export type { PlateEditMode };
