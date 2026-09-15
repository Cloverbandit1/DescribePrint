/**
 * Allos CAD Core entry for Print Control's CadReshapeHandoff.
 *
 * Print Control pauses and emits the handoff (remaining height H, current Z).
 * CAD generates OpenSCAD/mesh for the unprinted upper only. The printed stump
 * below Z stays as-is — already-solid plastic cannot be reshaped.
 * Resume stays manual. This module does not send gcode or call resume.
 */
import { defaultColorRegion } from "./color-regions";
import { compileOpenScad, withTempDir } from "./compile";
import { shouldUseFixture } from "./fixtures";
import { createJob, getJob, toGenerateResult } from "./jobs";
import {
  completeChat,
  normalizeCadPlan,
  parseCadPlan,
  toUserFacingLlmError,
  type CadPlan,
} from "./llm";
import { getLlmConfig, getPlanModel, isLocalOpenAiBaseUrl, isSmartPipelineEnabled } from "./llm-config";
import {
  CAD_RESHAPE_INSTRUCTION,
  RESUME_IS_MANUAL,
  buildCadReshapeHandoff,
  buildReslicePlanStub,
  suggestedCadNextStep,
  type CadReshapeHandoff,
  type ReslicePlanStub,
} from "./machine/reshape-plan";
import { checkMesh, hasHardMeshFailure } from "./mesh-check";
import { sitMeshOnBed } from "./mesh-transform";
import { defaultPrinter, type PrinterId } from "./printers";
import { extractScadParams, formatPrinterConstraints, formatScadParams } from "./printability";
import { sanitizeOpenScad } from "./sanitize";
import { parseStl, writeBinaryStl } from "./stl";
import { colorRegionsFromObjects, meshesTo3mf, objectsFromRegions } from "./threemf";
import type { GenerateResult, StatusEvent } from "./types";

export type StatusSink = (event: StatusEvent) => void;

const MAX_RESHAPE_COMPILE_ATTEMPTS = 3;

export const CAD_RESHAPE_LIMITS = {
  cannotReshapePrintedPlastic: true,
  onlyAboveZ: true,
  resumeIsManual: true,
} as const;

export type CadReshapeParseOk = { ok: true; handoff: CadReshapeHandoff };
export type CadReshapeParseErr = { ok: false; error: string };
export type CadReshapeParseResult = CadReshapeParseOk | CadReshapeParseErr;

export type StumpFootprintMm = {
  x: number;
  y: number;
  holeMm?: number;
};

export type CadResliceFeed = ReslicePlanStub & {
  /** CAD-side attachment — Print Control's ReslicePlanStub has no job/mesh field. */
  cad: {
    jobId: string;
    language: "openscad";
    scadUrl: string;
    stlUrl: string;
    threemfUrl: string;
    remainingHeightMm: number | null;
    currentZ: number | null;
    sitOnCutPlane: true;
  };
};

export type CadReshapeUpperInput = {
  handoff: CadReshapeHandoff | unknown;
  prompt?: string | null;
  previousCode?: string | null;
  previousPrompt?: string | null;
  previousJobId?: string | null;
  fixture?: boolean;
  /** CAD-side only — not on CadReshapeHandoff. */
  stumpFootprintMm?: StumpFootprintMm;
  reslice?: ReslicePlanStub;
};

export type CadReshapeUpperResult = GenerateResult & {
  cadHandoff: CadReshapeHandoff;
  resliceFeed: CadResliceFeed;
  limits: typeof CAD_RESHAPE_LIMITS;
};

function emit(sink: StatusSink | undefined, event: StatusEvent) {
  sink?.(event);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asFiniteNumber(value);
}

function asPrinterId(value: unknown): PrinterId {
  return value === "bambu-lab-p2s" ? value : defaultPrinter().id;
}

function asOptionalLayer(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** Strict identity + known measurement fields. Unknown extras (autoResume, sendGcode, …) are dropped. */
export function parseCadReshapeHandoff(value: unknown): CadReshapeParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "CadReshapeHandoff must be an object." };
  }
  const row = value as Record<string, unknown>;
  if (row.owner !== "allos-cad-core") {
    return { ok: false, error: 'CadReshapeHandoff.owner must be "allos-cad-core".' };
  }
  if (row.from !== "allos-print-control") {
    return { ok: false, error: 'CadReshapeHandoff.from must be "allos-print-control".' };
  }
  if (row.kind !== "redesign-unprinted-upper") {
    return { ok: false, error: 'CadReshapeHandoff.kind must be "redesign-unprinted-upper".' };
  }
  if (row.instruction !== CAD_RESHAPE_INSTRUCTION) {
    return { ok: false, error: `CadReshapeHandoff.instruction must be "${CAD_RESHAPE_INSTRUCTION}".` };
  }

  const currentZ = asNullableNumber(row.currentZ);
  const remainingHeightMm = asNullableNumber(row.remainingHeightMm);
  const remainingLayers = asNullableNumber(row.remainingLayers);
  if (row.currentZ !== undefined && currentZ === undefined) {
    return { ok: false, error: "CadReshapeHandoff.currentZ must be a finite number or null." };
  }
  if (row.remainingHeightMm !== undefined && remainingHeightMm === undefined) {
    return { ok: false, error: "CadReshapeHandoff.remainingHeightMm must be a finite number or null." };
  }
  if (row.remainingLayers !== undefined && remainingLayers === undefined) {
    return { ok: false, error: "CadReshapeHandoff.remainingLayers must be a finite number or null." };
  }

  const printerId = asPrinterId(row.printerId);
  const suggested =
    typeof row.suggestedNextStep === "string" && row.suggestedNextStep.trim()
      ? row.suggestedNextStep.trim()
      : suggestedCadNextStep(currentZ ?? null, remainingHeightMm ?? null);

  return {
    ok: true,
    handoff: {
      owner: "allos-cad-core",
      from: "allos-print-control",
      kind: "redesign-unprinted-upper",
      instruction: CAD_RESHAPE_INSTRUCTION,
      currentZ: currentZ ?? null,
      remainingHeightMm: remainingHeightMm ?? null,
      remainingLayers: remainingLayers ?? null,
      layer: asOptionalLayer(row.layer),
      totalLayers: asOptionalLayer(row.totalLayers),
      printerId,
      suggestedNextStep: suggested,
    },
  };
}

export function isCadReshapeHandoff(value: unknown): value is CadReshapeHandoff {
  return parseCadReshapeHandoff(value).ok;
}

export function reshapeUpperNotes(handoff: CadReshapeHandoff): string[] {
  const zBit = handoff.currentZ != null ? `${handoff.currentZ.toFixed(2)} mm` : "unknown Z";
  const hBit =
    handoff.remainingHeightMm != null ? `${handoff.remainingHeightMm.toFixed(2)} mm` : "unknown remaining height";
  return [
    `Cannot reshape already-printed plastic. Only the unprinted upper above Z (${zBit}) is redesigned.`,
    `This mesh is the remaining upper only (${hBit}). It sits on the cut plane (z=0 here) so it can mate with the stump and feed the reslice stub.`,
    `${RESUME_IS_MANUAL}. Print Control does not auto-resume.`,
  ];
}

export function inferStumpFootprintMm(input: {
  previousCode?: string | null;
  previousPrompt?: string | null;
  stumpFootprintMm?: StumpFootprintMm;
  nativeSizeMm?: [number, number, number];
}): StumpFootprintMm {
  if (input.stumpFootprintMm && input.stumpFootprintMm.x > 0 && input.stumpFootprintMm.y > 0) {
    return {
      x: input.stumpFootprintMm.x,
      y: input.stumpFootprintMm.y,
      holeMm: input.stumpFootprintMm.holeMm,
    };
  }
  const params = extractScadParams(input.previousCode);
  const hole = params.hole_d ?? params.hole;
  const holeMm = hole != null && hole > 0 ? hole : undefined;
  if (params.size && params.size > 0) return { x: params.size, y: params.size, holeMm };
  if (params.body_w && params.body_d && params.body_w > 0 && params.body_d > 0) {
    return { x: params.body_w, y: params.body_d, holeMm };
  }
  if (params.phone_w && params.phone_w > 0) {
    return { x: params.phone_w, y: params.base_d && params.base_d > 0 ? params.base_d : params.phone_w, holeMm };
  }
  if (params.d && params.d > 0) return { x: params.d, y: params.d, holeMm };
  if (input.nativeSizeMm && input.nativeSizeMm[0] > 0 && input.nativeSizeMm[1] > 0) {
    return { x: input.nativeSizeMm[0], y: input.nativeSizeMm[1], holeMm };
  }
  const cube = input.previousCode?.match(/cube\s*\(\s*(\d+(?:\.\d+)?)/);
  if (cube) {
    const n = Number(cube[1]);
    if (Number.isFinite(n) && n > 0) return { x: n, y: n, holeMm };
  }
  const fromPrompt = input.previousPrompt?.match(/(\d+(?:\.\d+)?)\s*mm/);
  if (fromPrompt) {
    const n = Number(fromPrompt[1]);
    if (Number.isFinite(n) && n > 0) return { x: n, y: n, holeMm };
  }
  return { x: 20, y: 20, holeMm };
}

function wantsHoleRemoved(prompt: string): boolean {
  return /\b(remove|without|no)\b/.test(prompt) && /\bhole\b/.test(prompt);
}

function wantsCylinderUpper(prompt: string): boolean {
  return /\b(cylinder|dome|cap|rounded)\b/i.test(prompt);
}

function holeFromPrompt(prompt: string): number | undefined {
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/i) ?? prompt.match(/hole[^\d]{0,16}(\d+(?:\.\d+)?)/i);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Deterministic OpenSCAD for the remaining upper. z=0 is the cut plane (mates with the stump). */
export function reshapeUpperFixtureScad(input: {
  handoff: CadReshapeHandoff;
  prompt?: string | null;
  previousCode?: string | null;
  previousPrompt?: string | null;
  stumpFootprintMm?: StumpFootprintMm;
  nativeSizeMm?: [number, number, number];
}): string {
  const remaining = input.handoff.remainingHeightMm;
  if (remaining == null || !(remaining > 0)) {
    throw new Error(
      "CAD reshape upper needs remainingHeightMm > 0. CadReshapeHandoff has no layerHeightMm — cannot invent remaining height from remainingLayers alone.",
    );
  }
  const currentZ = input.handoff.currentZ;
  const prompt = input.prompt?.trim() ?? "";
  const footprint = inferStumpFootprintMm({
    previousCode: input.previousCode,
    previousPrompt: input.previousPrompt,
    stumpFootprintMm: input.stumpFootprintMm,
    nativeSizeMm: input.nativeSizeMm,
  });
  const promptedHole = holeFromPrompt(prompt);
  const keepHole = !wantsHoleRemoved(prompt.toLowerCase()) && (promptedHole ?? footprint.holeMm);
  const hole = promptedHole ?? footprint.holeMm ?? 5;
  const x = round3(footprint.x);
  const y = round3(footprint.y);
  const h = round3(remaining);
  const zComment = currentZ != null ? `${round3(currentZ)}` : "null";
  const header = `// Fixture: remaining unprinted upper (cut-plane mate)
// Printed stump below current_z is NOT in this mesh and cannot be reshaped.
// z=0 is the cut plane — this solid mates with the stump and prints as remaining layers.
$fn = 64;
current_z = ${zComment};
remaining_h = ${h};
size_x = ${x};
size_y = ${y};
`;

  if (wantsCylinderUpper(prompt)) {
    const d = round3(Math.min(x, y));
    return `${header}cylinder_d = ${d};

translate([size_x / 2, size_y / 2, 0])
  cylinder(h = remaining_h, d = cylinder_d);
`;
  }

  if (keepHole) {
    return `${header}hole_d = ${round3(hole)};

difference() {
  cube([size_x, size_y, remaining_h], center = false);
  translate([size_x / 2, size_y / 2, -1])
    cylinder(h = remaining_h + 2, d = hole_d);
}
`;
  }

  return `${header}
cube([size_x, size_y, remaining_h], center = false);
`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function reshapeUpperSystemPrompt(): string {
  return `You are a CAD assistant that writes OpenSCAD for an emergency remaining-layer reshape.

Reply with ONLY OpenSCAD code (no markdown unless fenced as \`\`\`openscad). No commentary.

Hard limits
- You CANNOT reshape already-printed plastic. The stump below current Z already exists on the bed.
- Generate ONLY the unprinted upper: a single manifold solid of height remaining_h.
- Sit that solid on z=0. In this mesh, z=0 is the cut plane (the top of the printed stump), not the printer bed origin.
- Do not emit the stump. Do not start the solid at world current_z. Do not add a sacrificial base under the cut plane.
- XY must mate with the stump footprint so the first remaining layer lands on printed plastic.
- Resume is manual. Do not invent pause/resume/gcode APIs.

Units and printability
- Millimeters. 1 unit = 1 mm.
- Walls >= 1.6 mm. Through-holes >= 2.5 mm unless the user asks smaller; cutters overshoot 0.2–1 mm.
- $fn = 64. Prefer cube(), cylinder(), sphere(), hull(), difference(), union().
- Name parameters at the top (remaining_h, current_z, size_x, size_y, …).
- Never use import(), include, use <>, or surface().

${formatPrinterConstraints()}
`;
}

export function reshapeUpperPlanSystemPrompt(): string {
  return `You are a CAD planner for an emergency remaining-layer reshape. Reply with ONLY compact JSON (no markdown).

Schema:
{"object":string,"one_piece":true,"units":"mm","overall_mm":{"x":n,"y":n,"z":n},"features":[{"name":string,"kind":string,"dims_mm":{"…":n}}],"holes":[{"d":n,"purpose":string,"through":true}],"min_wall_mm":n,"clearance_mm":n,"sit_on_z0":true}

Rules:
- overall_mm.z MUST equal remaining_h (the unprinted height). sit_on_z0 true — z=0 is the cut plane.
- one_piece true. Do not include the already-printed stump.
- Mate XY to the stump footprint. Millimeters only.
- No pause/resume/gcode. Keep the JSON short. No OpenSCAD in this pass.

${formatPrinterConstraints()}
`;
}

export function buildReshapeUpperUserPrompt(input: {
  prompt: string;
  handoff: CadReshapeHandoff;
  footprint: StumpFootprintMm;
  previousCode?: string | null;
  previousPrompt?: string | null;
  plan?: CadPlan | null;
  previousError?: string;
}): string {
  const zBit = input.handoff.currentZ != null ? `${input.handoff.currentZ.toFixed(2)} mm` : "unknown";
  const hBit =
    input.handoff.remainingHeightMm != null ? `${input.handoff.remainingHeightMm.toFixed(2)} mm` : "unknown";
  const parts = [
    input.previousError
      ? `The previous OpenSCAD failed. Repair it. Reply with ONLY corrected OpenSCAD.\nError:\n${input.previousError.slice(0, 2500)}`
      : "Redesign the unprinted upper only as OpenSCAD.",
    `Instruction: ${CAD_RESHAPE_INSTRUCTION}`,
    `currentZ (already-printed stump, world): ${zBit}`,
    `remainingHeightMm (this mesh height): ${hBit}`,
    `remainingLayers: ${input.handoff.remainingLayers ?? "unknown"}`,
    `Stump footprint to mate (XY mm): ${input.footprint.x.toFixed(2)} × ${input.footprint.y.toFixed(2)}`,
    `User request:\n${input.prompt.trim() || CAD_RESHAPE_INSTRUCTION}`,
  ];
  if (input.plan) {
    parts.push(`Design plan (follow these features; keep overall_mm.z = remaining height):\n${JSON.stringify(input.plan)}`);
  }
  if (input.previousPrompt) {
    parts.push(`Earlier description of the full part (stump context only):\n${input.previousPrompt.slice(0, 2000)}`);
  }
  if (input.previousCode) {
    const params = extractScadParams(input.previousCode);
    const paramNote = formatScadParams(params);
    if (paramNote) parts.push(`Named parameters from the original part (mate XY; do not rebuild the stump): ${paramNote}`);
    parts.push(`Original OpenSCAD (context — do not include geometry below the cut plane):\n${input.previousCode.slice(0, 4000)}`);
  }
  parts.push(input.handoff.suggestedNextStep);
  return parts.join("\n\n");
}

function clampPlanToRemainingHeight(plan: CadPlan, remainingHeightMm: number): CadPlan {
  const overall = plan.overall_mm
    ? { ...plan.overall_mm, z: remainingHeightMm }
    : { x: 20, y: 20, z: remainingHeightMm };
  return { ...plan, one_piece: true, sit_on_z0: true, overall_mm: overall };
}

export function cadFeedForReslice(
  handoff: CadReshapeHandoff,
  result: GenerateResult,
  reslice?: ReslicePlanStub,
): CadResliceFeed {
  const stub = reslice ?? buildReslicePlanStub(undefined, handoff.printerId);
  return {
    ...stub,
    sendGcode: false,
    cad: {
      jobId: result.jobId,
      language: "openscad",
      scadUrl: result.scadUrl,
      stlUrl: result.stlUrl,
      threemfUrl: result.threemfUrl,
      remainingHeightMm: handoff.remainingHeightMm,
      currentZ: handoff.currentZ,
      sitOnCutPlane: true,
    },
  };
}

async function compileUpper(code: string): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
  colorRegions: ReturnType<typeof colorRegionsFromObjects>;
}> {
  return withTempDir(async (dir) => {
    const compiled = await compileOpenScad(code, dir);
    const mesh = sitMeshOnBed(parseStl(compiled.stl));
    const report = checkMesh(mesh);
    if (hasHardMeshFailure(report)) {
      const summary = report.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("; ");
      throw new Error(`Mesh check failed: ${summary}`);
    }
    const regions = [defaultColorRegion()];
    const objects = objectsFromRegions([mesh], regions, "reshape-upper");
    const stl = writeBinaryStl(mesh, "DescribePrint");
    const threemf = await meshesTo3mf(objects, "DescribePrint");
    return { stl, threemf, report, colorRegions: colorRegionsFromObjects(objects) };
  });
}

async function codeFromLlm(
  input: {
    prompt: string;
    handoff: CadReshapeHandoff;
    footprint: StumpFootprintMm;
    previousCode?: string | null;
    previousPrompt?: string | null;
  },
  previous?: { code: string; error: string },
  plan?: CadPlan | null,
): Promise<string> {
  try {
    return await completeChat([
      { role: "system", content: reshapeUpperSystemPrompt() },
      {
        role: "user",
        content: buildReshapeUpperUserPrompt({
          prompt: input.prompt,
          handoff: input.handoff,
          footprint: input.footprint,
          previousCode: previous?.code ?? input.previousCode,
          previousPrompt: input.previousPrompt,
          plan,
          previousError: previous?.error,
        }),
      },
    ]);
  } catch (err) {
    throw toUserFacingLlmError(err);
  }
}

/**
 * CAD Core entry: consume CadReshapeHandoff, emit remaining-upper OpenSCAD/mesh
 * that Print Control can feed into its existing reslice stub.
 */
export async function runCadReshapeUpper(
  input: CadReshapeUpperInput,
  sink?: StatusSink,
): Promise<CadReshapeUpperResult> {
  const parsed = parseCadReshapeHandoff(input.handoff);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const handoff = parsed.handoff;
  if (handoff.remainingHeightMm == null || !(handoff.remainingHeightMm > 0)) {
    throw new Error(
      "CAD reshape upper needs remainingHeightMm > 0 from Print Control. CadReshapeHandoff has no layerHeightMm — cannot invent remaining height from remainingLayers alone.",
    );
  }

  const previous = input.previousJobId ? getJob(input.previousJobId) : undefined;
  const footprint = inferStumpFootprintMm({
    previousCode: input.previousCode ?? previous?.scad,
    previousPrompt: input.previousPrompt,
    stumpFootprintMm: input.stumpFootprintMm,
    nativeSizeMm: previous?.nativeSizeMm,
  });
  const prompt = input.prompt?.trim() || CAD_RESHAPE_INSTRUCTION;
  const useFixture = shouldUseFixture(input.fixture);
  const notes = reshapeUpperNotes(handoff);
  if (handoff.currentZ == null) {
    notes.push("currentZ was null on the handoff — the upper sits on the cut plane, but mating world Z is unknown.");
  }
  notes.push(
    "CadReshapeHandoff has no previousCode / stumpFootprintMm / layerHeightMm. CAD infers XY from the last part when present.",
  );

  emit(sink, { step: "planning", message: "Reading the remaining-layer handoff…" });

  let code = "";
  let plan: CadPlan | null = null;
  let retried = false;

  if (useFixture) {
    emit(sink, { step: "codegen", message: "Using the fixture / heuristic OpenSCAD path (no live API)…" });
    code = reshapeUpperFixtureScad({
      handoff,
      prompt,
      previousCode: input.previousCode ?? previous?.scad,
      previousPrompt: input.previousPrompt,
      stumpFootprintMm: input.stumpFootprintMm,
      nativeSizeMm: previous?.nativeSizeMm,
    });
  } else {
    if (isSmartPipelineEnabled()) {
      emit(sink, { step: "planning", message: "Planning the unprinted upper above Z…" });
      try {
        const raw = await completeChat(
          [
            { role: "system", content: reshapeUpperPlanSystemPrompt() },
            {
              role: "user",
              content: buildReshapeUpperUserPrompt({
                prompt,
                handoff,
                footprint,
                previousCode: input.previousCode ?? previous?.scad,
                previousPrompt: input.previousPrompt,
              }),
            },
          ],
          { model: getPlanModel(), temperature: 0.1 },
        );
        const parsedPlan = parseCadPlan(raw);
        plan = parsedPlan
          ? clampPlanToRemainingHeight(
              normalizeCadPlan(parsedPlan, { prompt, previousCode: input.previousCode }),
              handoff.remainingHeightMm,
            )
          : null;
      } catch (err) {
        throw toUserFacingLlmError(err);
      }
    }
    const local = isLocalOpenAiBaseUrl(getLlmConfig().baseUrl);
    emit(sink, {
      step: "codegen",
      message: local ? "Asking local AI for the remaining upper…" : "Asking the model for the remaining upper…",
    });
    code = await codeFromLlm(
      {
        prompt,
        handoff,
        footprint,
        previousCode: input.previousCode ?? previous?.scad,
        previousPrompt: input.previousPrompt,
      },
      undefined,
      plan,
    );
  }

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating remaining-upper OpenSCAD…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source);
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }
    emit(sink, { step: "compile", message: "Compiling remaining upper → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const compiled = await compileUpper(sanitized.code);
    return { code: sanitized.code, ...compiled };
  };

  let artifacts: Awaited<ReturnType<typeof attempt>> | undefined;
  let lastCode = code;
  for (let attemptNo = 1; attemptNo <= MAX_RESHAPE_COMPILE_ATTEMPTS; attemptNo++) {
    try {
      artifacts = await attempt(lastCode, attemptNo);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (useFixture || attemptNo === MAX_RESHAPE_COMPILE_ATTEMPTS) {
        throw err;
      }
      retried = true;
      emit(sink, {
        step: "retry",
        message: `Compile failed — retrying remaining upper (${attemptNo + 1}/${MAX_RESHAPE_COMPILE_ATTEMPTS})…`,
        attempt: attemptNo + 1,
      });
      lastCode = await codeFromLlm(
        {
          prompt,
          handoff,
          footprint,
          previousCode: input.previousCode ?? previous?.scad,
          previousPrompt: input.previousPrompt,
        },
        { code: lastCode, error: message },
        plan,
      );
    }
  }

  if (!artifacts) {
    throw new Error("CAD reshape upper failed.");
  }

  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture: useFixture,
    retried,
    source: "openscad",
    fileName: null,
    wearableSize: null,
    wearableCategory: previous?.wearableCategory ?? null,
    nativeSizeMm: artifacts.report.boundingBoxMm.size,
    editMode: "reshape-upper",
    notes,
    colorRegions: artifacts.colorRegions,
  });
  const generate = toGenerateResult(job);
  emit(sink, { step: "done", message: "Remaining upper is ready. Resume is manual." });
  return {
    ...generate,
    cadHandoff: handoff,
    resliceFeed: cadFeedForReslice(handoff, generate, input.reslice),
    limits: CAD_RESHAPE_LIMITS,
  };
}

export { buildCadReshapeHandoff, CAD_RESHAPE_INSTRUCTION, RESUME_IS_MANUAL };
export type { CadReshapeHandoff, ReslicePlanStub };
