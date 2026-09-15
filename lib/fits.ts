/**
 * Tolerance / fit wizard for the describe → OpenSCAD path.
 *
 * Pick snap, press, sliding/loose, wearable, or hinge. Grades S/M/L map to
 * documented radial/axial clearances for the selected printer/material
 * (default Bambu Lab P2S, 0.4 mm nozzle). Explicit mm overrides the grade.
 *
 * Reuses joints.ts PIP / snap / multi-part numbers instead of forking them.
 * Walls stay ≥ 1.6 mm (4× nozzle). Not a full ISO fit library.
 */
import {
  GENERAL_FIT_MM,
  jointClearance,
  snapBeamThicknessMm,
  type CadJoint,
} from "./joints";
import { defaultPrinter, normalizeFilamentId, type FilamentId, type PrinterProfile } from "./printers";

function minWallMm(printer: PrinterProfile = defaultPrinter()): number {
  return Math.max(1.6, printer.nozzleMm * 4);
}

function minHoleMm(): number {
  return 2.5;
}

export const FIT_KINDS = ["snap", "press", "sliding", "wearable", "hinge"] as const;
export type FitKind = (typeof FIT_KINDS)[number];

export const FIT_GRADES = ["S", "M", "L"] as const;
export type FitGrade = (typeof FIT_GRADES)[number];

export type CadFit = {
  kind: FitKind;
  grade: FitGrade;
  /** Per-side gap (mm). bore_d = shaft_d + 2 × radial_mm. */
  radial_mm: number;
  /** End-play / axial gap (mm). */
  axial_mm: number;
  /** bore_d − shaft_d (mm). */
  diameter_delta_mm: number;
  /** Set when the user named an explicit mm clearance. */
  override_mm?: number;
  material: FilamentId;
  notes?: string;
};

export type FitClearanceRow = {
  kind: FitKind;
  grade: FitGrade;
  radialMm: number;
  axialMm: number;
  diameterDeltaMm: number;
  notes: string;
};

export type FitContext = {
  prompt: string;
  previousPrompt?: string | null;
  filament?: string | null;
  printer?: PrinterProfile;
  joints?: CadJoint[];
  holes?: Array<{ d: number; purpose?: string; through?: boolean }>;
  sizeMm?: [number, number, number] | null;
};

export const PRESS_FIT_CUBE_PROMPT = "20mm cube with press-fit 8mm pin hole";

const ASKS_FIT =
  /\b(?:what|which|pick|choose|select)\s+(?:a\s+)?(?:fit|tolerance|clearance)\b|\bfit\s*(?:wizard|options?|choice|grade)\b|\b(?:how\s+tight|how\s+loose)\b|\btolerance\s*(?:wizard|fit)?\b|\bmating\s+(?:fit|clearance)\b/i;

const KIND_PATTERNS: Array<{ kind: FitKind; re: RegExp }> = [
  { kind: "snap", re: /\bsnap(?:\s|-)?(?:fit|joint|hook|clip)?\b/i },
  { kind: "press", re: /\bpress(?:\s|-)?fit\b|\btight\s+fit\b|\binterference\s+fit\b|\bfriction\s+fit\b/i },
  { kind: "sliding", re: /\b(?:sliding|loose|running|slip)\s+fit\b|\bloose[-\s]?fit\b|\bclearance\s+fit\b/i },
  { kind: "wearable", re: /\bwearable\s+fit\b|\bcomfort\s+fit\b|\bsnug\s+fit\b|\bskin\s+(?:gap|clearance|fit)\b|\bease\s+fit\b/i },
  { kind: "hinge", re: /\bhinge\s+fit\b/i },
];

const SHAFT_MM =
  /(\d+(?:\.\d+)?)\s*mm\s+(?:pin|shaft|dowel|screw|bolt|rod|peg)\b|(?:pin|shaft|dowel|screw|bolt|rod|peg)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*mm\b/i;
const HOLE_MM = /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore|id)\b/i;
const EXPLICIT_MM =
  /(\d+(?:\.\d+)?)\s*mm\s+(?:per[-\s]?side\s+)?(?:radial\s+)?(?:clearance|gap)\b|\b(?:radial(?:_mm)?|clearance(?:_mm)?)\s*[:=]\s*(\d+(?:\.\d+)?)|\bclearance\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*mm\b/i;

const GRADE_S = /\b(?:fit\s+)?grade\s+s\b|\bfit\s+s\b|\btight(?:est)?\s+(?:press|snap|sliding|grade)\b/i;
const GRADE_L = /\b(?:fit\s+)?grade\s+l\b|\bfit\s+l\b|\b(?:loose|easy)\s+(?:press|snap|sliding|grade|fit)\b/i;
const GRADE_M = /\b(?:fit\s+)?grade\s+m\b|\bfit\s+m\b|\bmedium\s+fit\b/i;

/** Extra per-side mm for stringy / shrinky / flexible filaments on P2S. */
const MATERIAL_RADIAL_DELTA: Record<FilamentId, number> = {
  pla: 0,
  petg: 0.05,
  pa: 0.05,
  abs: 0.05,
  tpu: 0.1,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function combinedText(ctx: FitContext): string {
  return [ctx.previousPrompt, ctx.prompt].filter((part) => part && part.trim()).join("\n");
}

export function isFitKind(value: string | undefined | null): value is FitKind {
  return Boolean(value && (FIT_KINDS as readonly string[]).includes(value));
}

export function isFitGrade(value: string | undefined | null): value is FitGrade {
  return value === "S" || value === "M" || value === "L";
}

export function materialFitDeltaMm(filament?: string | null): number {
  const id = normalizeFilamentId(filament) ?? defaultPrinter().defaultFilament;
  return MATERIAL_RADIAL_DELTA[id];
}

export function parseFitKind(value: unknown): FitKind | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isFitKind(key)) return key;
  if (key.includes("snap") || key.includes("clip")) return "snap";
  if (key.includes("press") || key.includes("tight") || key.includes("interference")) return "press";
  if (key.includes("slid") || key.includes("loose") || key.includes("running") || key.includes("slip")) {
    return "sliding";
  }
  if (key.includes("wearable") || key.includes("comfort") || key.includes("skin") || key.includes("ease")) {
    return "wearable";
  }
  if (key.includes("hinge") || key.includes("knuckle")) return "hinge";
  return undefined;
}

export function parseFitGrade(value: unknown): FitGrade | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toUpperCase();
  if (isFitGrade(key)) return key;
  const lower = value.trim().toLowerCase();
  if (lower === "small" || lower === "tight" || lower === "snug") return "S";
  if (lower === "medium" || lower === "standard") return "M";
  if (lower === "large" || lower === "loose" || lower === "easy") return "L";
  return undefined;
}

export function inferFitKind(prompt: string): FitKind | null {
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(prompt)) return kind;
  }
  return null;
}

export function inferFitGrade(prompt: string): FitGrade | null {
  if (GRADE_S.test(prompt)) return "S";
  if (GRADE_L.test(prompt)) return "L";
  if (GRADE_M.test(prompt)) return "M";
  return null;
}

export function parseExplicitClearanceMm(prompt: string): number | undefined {
  const match = prompt.match(EXPLICIT_MM);
  if (!match) return undefined;
  const n = Number(match[1] ?? match[2] ?? match[3]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseShaftMm(prompt: string): number | undefined {
  const match = prompt.match(SHAFT_MM);
  if (!match) return undefined;
  const n = Number(match[1] ?? match[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseHoleNominalMm(prompt: string): number | undefined {
  const match = prompt.match(HOLE_MM);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function promptAsksFitChoice(prompt: string): boolean {
  return ASKS_FIT.test(prompt);
}

export function promptHasFit(prompt: string): boolean {
  return Boolean(inferFitKind(prompt) || parseExplicitClearanceMm(prompt) || promptAsksFitChoice(prompt));
}

/**
 * Documented P2S / 0.4 mm PLA-class table (before material delta).
 * Snap M and hinge S/L reuse joints.ts. Sliding M/L reuse hinge PIP / kit.
 */
export function fitTableRow(
  kind: FitKind,
  grade: FitGrade,
  printer: PrinterProfile = defaultPrinter(),
): FitClearanceRow {
  const snap = jointClearance("snap", "print-in-place", printer);
  const hingePip = jointClearance("hinge", "print-in-place", printer);
  const hingeKit = jointClearance("hinge", "multi-part", printer);
  const beam = snapBeamThicknessMm(printer);

  if (kind === "snap") {
    const radialMm = grade === "S" ? 0.2 : grade === "L" ? 0.4 : snap.radialMm;
    const axialMm = grade === "S" ? 0.4 : grade === "L" ? 0.6 : snap.axialMm;
    return {
      kind,
      grade,
      radialMm,
      axialMm,
      diameterDeltaMm: round2(radialMm * 2),
      notes: `Cantilever snap: ${beam} mm beam (4× nozzle), ${radialMm} mm/side. Reuses joints.ts Medium.`,
    };
  }

  if (kind === "hinge") {
    const radialMm =
      grade === "S" ? hingePip.radialMm : grade === "L" ? hingeKit.radialMm : round2((hingePip.radialMm + hingeKit.radialMm) / 2);
    const axialMm =
      grade === "S" ? hingePip.axialMm : grade === "L" ? hingeKit.axialMm : round2((hingePip.axialMm + hingeKit.axialMm) / 2);
    return {
      kind,
      grade,
      radialMm,
      axialMm,
      diameterDeltaMm: round2(radialMm * 2),
      notes: "Hinge/pin numbers from joints.ts: S = PIP, L = multi-part, M = midpoint.",
    };
  }

  if (kind === "sliding") {
    const radialMm = grade === "S" ? GENERAL_FIT_MM : grade === "L" ? hingeKit.radialMm : hingePip.radialMm;
    const axialMm = grade === "S" ? 0.4 : grade === "L" ? hingeKit.axialMm : hingePip.axialMm;
    return {
      kind,
      grade,
      radialMm,
      axialMm,
      diameterDeltaMm: round2(radialMm * 2),
      notes: "Sliding/loose: S = general 0.3 mm fit, M/L reuse hinge PIP / kit from joints.ts.",
    };
  }

  if (kind === "wearable") {
    const radialMm = grade === "S" ? 0.5 : grade === "L" ? 2 : 1;
    const axialMm = grade === "S" ? 0.6 : grade === "L" ? 2.4 : 1.2;
    return {
      kind,
      grade,
      radialMm,
      axialMm,
      diameterDeltaMm: round2(radialMm * 2),
      notes: "Wearable ease around a body/part — not the S–XL clothing chart.",
    };
  }

  const radialMm = grade === "S" ? 0.1 : grade === "L" ? GENERAL_FIT_MM : 0.2;
  const axialMm = grade === "S" ? 0.15 : grade === "L" ? 0.35 : 0.25;
  return {
    kind,
    grade,
    radialMm,
    axialMm,
    diameterDeltaMm: round2(radialMm * 2),
    notes: "Press: printable tight band (no FDM interference). L matches printRules.clearanceMm.",
  };
}

export function defaultFitTable(printer: PrinterProfile = defaultPrinter()): FitClearanceRow[] {
  const out: FitClearanceRow[] = [];
  for (const kind of FIT_KINDS) {
    for (const grade of FIT_GRADES) {
      out.push(fitTableRow(kind, grade, printer));
    }
  }
  return out;
}

export function resolveFitClearance(
  kind: FitKind,
  grade: FitGrade,
  opts: { filament?: string | null; overrideMm?: number; printer?: PrinterProfile } = {},
): CadFit {
  const printer = opts.printer ?? defaultPrinter();
  const material = normalizeFilamentId(opts.filament) ?? printer.defaultFilament;
  const row = fitTableRow(kind, grade, printer);
  const delta = materialFitDeltaMm(material);
  let radial = row.radialMm + delta;
  let axial = row.axialMm + delta;
  let override_mm: number | undefined;
  if (opts.overrideMm !== undefined && opts.overrideMm > 0) {
    radial = opts.overrideMm;
    axial = round2(Math.max(opts.overrideMm, opts.overrideMm * 1.2));
    override_mm = opts.overrideMm;
  }
  radial = round2(Math.max(0.05, radial));
  axial = round2(Math.max(radial, axial));
  return {
    kind,
    grade,
    radial_mm: radial,
    axial_mm: axial,
    diameter_delta_mm: round2(radial * 2),
    override_mm,
    material,
    notes: override_mm
      ? `Explicit ${override_mm} mm/side override on ${kind} ${grade} (${material.toUpperCase()}).`
      : `${row.notes} ${material.toUpperCase()} delta ${delta.toFixed(2)} mm.`,
  };
}

export function parseCadFit(raw: unknown): CadFit | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const kind = parseFitKind(rec.kind ?? rec.type ?? rec.fit);
  if (!kind) return undefined;
  const grade = parseFitGrade(rec.grade ?? rec.size) ?? "M";
  const override = asFiniteNumber(rec.override_mm) ?? asFiniteNumber(rec.clearance_mm);
  const parsed = resolveFitClearance(kind, grade, {
    filament: asString(rec.material) ?? asString(rec.filament),
    overrideMm: override && override > 0 ? override : undefined,
  });
  const radial = asFiniteNumber(rec.radial_mm) ?? parsed.radial_mm;
  const axial = asFiniteNumber(rec.axial_mm) ?? parsed.axial_mm;
  return {
    ...parsed,
    radial_mm: radial > 0 ? radial : parsed.radial_mm,
    axial_mm: axial > 0 ? axial : parsed.axial_mm,
    diameter_delta_mm: round2((radial > 0 ? radial : parsed.radial_mm) * 2),
    notes: asString(rec.notes) ?? parsed.notes,
  };
}

export function inferCadFit(ctx: FitContext): CadFit | undefined {
  const text = combinedText(ctx);
  const kind = inferFitKind(text);
  const override = parseExplicitClearanceMm(text);
  if (!kind && override === undefined) return undefined;
  const grade = inferFitGrade(text) ?? "M";
  return resolveFitClearance(kind ?? "press", grade, {
    filament: ctx.filament,
    overrideMm: override,
    printer: ctx.printer,
  });
}

export function normalizeCadFit(fit: CadFit | undefined, ctx: FitContext): CadFit | undefined {
  const inferred = inferCadFit(ctx);
  if (!inferred) return undefined;
  if (!fit) return inferred;
  return resolveFitClearance(inferred.kind, inferred.grade, {
    filament: ctx.filament ?? fit.material,
    overrideMm: inferred.override_mm ?? fit.override_mm,
    printer: ctx.printer,
  });
}

export function finishedHoleMm(nominalMm: number, fit: CadFit): number {
  return round2(nominalMm + fit.diameter_delta_mm);
}

export function clampHoleForWalls(
  holeMm: number,
  hostMm: number | [number, number, number] | null | undefined,
  wallMm = minWallMm(),
): number {
  const span = Array.isArray(hostMm) ? Math.min(hostMm[0], hostMm[1]) : hostMm;
  if (!span || !Number.isFinite(span) || span <= 0) return holeMm;
  const maxHole = round2(span - 2 * wallMm);
  if (maxHole < minHoleMm()) return holeMm;
  return holeMm > maxHole ? maxHole : holeMm;
}

export function applyFitToHoles(
  holes: Array<{ d: number; purpose?: string; through?: boolean }>,
  fit: CadFit | undefined,
  ctx: FitContext,
): Array<{ d: number; purpose?: string; through?: boolean }> {
  if (!fit) return holes;
  const text = combinedText(ctx);
  const shaft = parseShaftMm(text);
  const holeNominal = parseHoleNominalMm(text);
  const nominal = shaft ?? holeNominal;
  if (nominal === undefined && !holes.length) return holes;

  const wall = minWallMm(ctx.printer ?? defaultPrinter());
  const applyOne = (d: number, purpose?: string, through?: boolean) => {
    const finished = clampHoleForWalls(finishedHoleMm(d, fit), ctx.sizeMm, wall);
    const lifted = finished < minHoleMm() ? minHoleMm() : finished;
    return {
      d: lifted,
      purpose: purpose ?? `${fit.kind} ${fit.grade}`,
      through: through !== false,
    };
  };

  if (nominal !== undefined) {
    if (!holes.length) return [applyOne(nominal)];
    return holes.map((hole) => applyOne(nominal, hole.purpose, hole.through));
  }
  return holes.map((hole) => applyOne(hole.d, hole.purpose, hole.through));
}

export function applyFitToJoints(joints: CadJoint[], fit: CadFit | undefined): CadJoint[] {
  if (!fit || !joints.length) return joints;
  const touchesSnap = fit.kind === "snap";
  const touchesHinge = fit.kind === "hinge" || fit.kind === "sliding";
  if (!touchesSnap && !touchesHinge) return joints;
  return joints.map((joint) => {
    const same =
      (touchesSnap && joint.type === "snap") ||
      (touchesHinge && (joint.type === "hinge" || joint.type === "pin"));
    if (!same) return joint;
    return {
      ...joint,
      radial_mm: fit.radial_mm,
      axial_mm: fit.axial_mm,
      notes: joint.notes ?? fit.notes,
    };
  });
}

export function applyFitToMatingFeatures(
  features: Array<{ name: string; kind?: string; dims_mm?: Record<string, number>; notes?: string }>,
  fit: CadFit | undefined,
): Array<{ name: string; kind?: string; dims_mm?: Record<string, number>; notes?: string }> {
  if (!fit) return features;
  const boreKeys = /^(d|id|bore|hole)$/i;
  const wallKeys = /wall|thick|^t$/i;
  const minWall = minWallMm();
  return features.map((feature) => {
    const kind = (feature.kind ?? feature.name).toLowerCase();
    const isMating = /\b(bore|hole|socket|catch|sleeve|id)\b/.test(kind);
    if (!isMating || !feature.dims_mm) return feature;
    const dims_mm = { ...feature.dims_mm };
    for (const [key, value] of Object.entries(dims_mm)) {
      if (wallKeys.test(key)) {
        if (value < minWall) dims_mm[key] = minWall;
        continue;
      }
      if (!boreKeys.test(key)) continue;
      dims_mm[key] = finishedHoleMm(value, fit);
    }
    return {
      ...feature,
      dims_mm,
      notes: feature.notes ?? `${fit.kind} ${fit.grade} ${fit.radial_mm} mm/side`,
    };
  });
}

export function formatFitConstraints(printer: PrinterProfile = defaultPrinter()): string {
  const pressM = resolveFitClearance("press", "M", { printer });
  const snapM = resolveFitClearance("snap", "M", { printer });
  const slideM = resolveFitClearance("sliding", "M", { printer });
  const wall = minWallMm(printer);
  return [
    `Fit wizard (only when the user names a snap / press / sliding / wearable / hinge fit, a grade, or an explicit mm clearance):`,
    `- Grades S/M/L are documented radial/axial mm/side. Explicit mm overrides the grade. Default printer ${printer.name}, ${printer.nozzleMm} mm nozzle.`,
    `- Press M ${pressM.radial_mm} mm/side, snap M ${snapM.radial_mm} mm/side (joints.ts), sliding M ${slideM.radial_mm} mm/side (hinge PIP). Wearable is body ease, not the S–XL clothing chart.`,
    `- Holes / pins / snaps / mating bores: finished hole = shaft + 2×radial. Snap beam stays ${snapBeamThicknessMm(printer)} mm. Walls stay ≥ ${wall} mm.`,
    `- Do not invent a fit for an ordinary sized hole. PETG/PA/ABS add 0.05 mm/side, TPU 0.10 mm/side.`,
  ].join("\n");
}

export function formatFitTableMarkdown(printer: PrinterProfile = defaultPrinter()): string {
  const rows = defaultFitTable(printer).map((row) => {
    return `| ${row.kind} | ${row.grade} | ${row.radialMm.toFixed(2)} | ${row.diameterDeltaMm.toFixed(2)} | ${row.axialMm.toFixed(2)} |`;
  });
  return [
    `| Kind | Grade | Radial mm/side | Diameter Δ mm | Axial mm |`,
    `| --- | --- | ---: | ---: | ---: |`,
    ...rows,
  ].join("\n");
}

export function formatFitNote(fit?: CadFit | null): string {
  if (!fit) return "";
  const override = fit.override_mm !== undefined ? ` explicit ${fit.override_mm} mm` : "";
  return `Fit wizard: ${fit.kind} ${fit.grade}${override} → ${fit.radial_mm} mm/side radial, ${fit.axial_mm} mm axial (Δ ${fit.diameter_delta_mm} mm) on ${fit.material.toUpperCase()}. Walls stay ≥ ${minWallMm()} mm.`;
}

export function formatFitPromptHint(fit?: CadFit | null): string {
  if (!fit) return "";
  return [
    `Fit wizard: apply ${fit.kind} ${fit.grade} clearances.`,
    `radial_mm = ${fit.radial_mm}, axial_mm = ${fit.axial_mm}, bore_d = shaft_d + ${fit.diameter_delta_mm}.`,
    `Name hole_d / pin_d / radial_mm at the top. Snap beam ≥ ${snapBeamThicknessMm()} mm. Walls ≥ ${minWallMm()} mm.`,
    `Do not design unprintable interference. Do not thin walls to make a fit.`,
  ].join("\n");
}

export function isPressFitCubePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return text.includes("cube") && /\bpress(?:\s|-)?fit\b/.test(text) && /\b(pin|shaft|hole|bore)\b/.test(text);
}
