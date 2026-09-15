/**
 * Style2Fab-adjacent pretty-up / restyle stub.
 *
 * Heuristic CSG only: fillets/chamfers as primitives, decorative ribs/panels,
 * optional motif via the existing relief path. Not neural style transfer.
 * Functional regions (through-holes, PIP joints, mating faces, #11 walls)
 * stay intact — we refuse edits that would fuse joints or close holes.
 */
import { wantsMotion, type CadJoint } from "./joints";
import { printRules } from "./printability";
import { inferCadReliefs, type CadRelief } from "./relief";

export const PRETTY_UP_STYLES = ["fillet", "chamfer", "ribs", "panels", "steampunk", "motif"] as const;
export type PrettyUpStyle = (typeof PRETTY_UP_STYLES)[number];

export const PRETTY_UP_OP_KINDS = ["fillet", "chamfer", "rib", "panel", "motif"] as const;
export type PrettyUpOpKind = (typeof PRETTY_UP_OP_KINDS)[number];

export const PRETTY_UP_ROLES = [
  "hole",
  "joint",
  "mating-face",
  "wall",
  "clearance",
  "fillet",
  "chamfer",
  "rib",
  "panel",
  "motif",
] as const;
export type PrettyUpRole = (typeof PRETTY_UP_ROLES)[number];

export type PrettyUpRegion = {
  kind: "functional" | "decorative";
  role: PrettyUpRole;
  note: string;
};

export type PrettyUpOp = {
  kind: PrettyUpOpKind;
  mm: number;
  region?: string;
  notes?: string;
};

export type CadPrettyUp = {
  applied: boolean;
  refused: boolean;
  refuse_reason?: string;
  style: PrettyUpStyle;
  ops: PrettyUpOp[];
  functional_regions: PrettyUpRegion[];
  decorative_regions: PrettyUpRegion[];
  notes?: string;
};

export type PrettyUpContext = {
  prompt: string;
  previousPrompt?: string | null;
  previousCode?: string | null;
  holes?: Array<{ d: number; through?: boolean; purpose?: string }>;
  joints?: CadJoint[];
  sizeMm?: [number, number, number] | null;
  reliefs?: CadRelief[];
};

/** Visible, printable edge break (2× 0.4 mm nozzle). */
export const MIN_PRETTY_MM = 0.8;
/** Default fillet / chamfer — rounds the look without eating a 5 mm hole. */
export const DEFAULT_EDGE_MM = 2;
/** Decorative rib / panel thickness — #11 wall, not a knife edge. */
export const DEFAULT_RIB_MM = 1.6;
/** Raised decorative height (ribs, rivets, panels). */
export const DEFAULT_DECOR_H_MM = 1.2;
export const MAX_EDGE_MM = 4;
export const MAX_DECOR_H_MM = 2;

export const CUBE_FILLET_PROMPT = "20mm cube with 5mm hole, round the edges";
export const CUBE_STEAMPUNK_PROMPT = "20mm cube with 5mm hole, make it look steampunk";
export const CUBE_RIBS_PROMPT = "20mm cube with 5mm hole, add decorative ribs";

const PRETTY_WORD =
  /\b(pretty(?:\s+(?:it|this|that|the\s+\w+))?(?:\s|-)?up|restyle|restyling|stylize|stylise|steampunk|victorian|ornate|decorative\s+(?:ribs?|panels?|trim)|round(?:\s+the)?\s+edges|fillets?|chamfers?|bevel(?:ed|s)?(?:\s+the\s+edges)?|look(?:s)?\s+nicer)\b/i;

const FILLET_WORD = /\b(round(?:\s+the)?\s+edges|fillets?|soften(?:\s+the)?\s+corners)\b/i;
const CHAMFER_WORD = /\b(chamfers?|bevel(?:ed|s)?(?:\s+(?:the\s+)?edges)?)\b/i;
const RIB_WORD = /\b(decorative\s+ribs?|add(?:\s+some)?\s+ribs?|ribs?\s+on)\b/i;
const PANEL_WORD = /\b(decorative\s+panels?|add(?:\s+some)?\s+panels?)\b/i;
const STEAMPUNK_WORD = /\b(steampunk|victorian|ornate|brass\s+gear)\b/i;
const MOTIF_WORD = /\b(crest|logo|emboss|motif)\b/i;

const FUSE_JOINT =
  /\b(fuse|weld|fill(?:\s+in)?|close|seal|join together|make (?:it |that )?(?:one|a) (?:solid|piece)|union (?:the )?(?:joint|gap|clearance|hinge|pin|ball|snap)|fill the gaps?)\b/i;
const CLOSE_HOLE =
  /\b(close|fill|plug|seal|cover|block|cap)\b.{0,40}\b(holes?|bores?|through[- ]holes?)\b|\b(holes?|bores?|through[- ]holes?)\b.{0,24}\b(closed|filled|plugged|sealed)\b/i;

const JOINT_CODE =
  /module\s+(box_body|hinge_pin|rotor_and_pin|ball_and_stem|snap_hook)\s*\(/;
const HOLE_CODE = /hole_d\s*=\s*(\d+(?:\.\d+)?)/;

export function promptHasPrettyUp(prompt: string): boolean {
  return PRETTY_WORD.test(prompt);
}

export function isPrettyUpStyle(value: string | undefined | null): value is PrettyUpStyle {
  return Boolean(value && (PRETTY_UP_STYLES as readonly string[]).includes(value));
}

export function inferPrettyUpStyle(prompt: string): PrettyUpStyle | undefined {
  if (!promptHasPrettyUp(prompt)) return undefined;
  if (STEAMPUNK_WORD.test(prompt)) return "steampunk";
  if (CHAMFER_WORD.test(prompt)) return "chamfer";
  if (FILLET_WORD.test(prompt)) return "fillet";
  if (RIB_WORD.test(prompt)) return "ribs";
  if (PANEL_WORD.test(prompt)) return "panels";
  if (MOTIF_WORD.test(prompt)) return "motif";
  return "fillet";
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function combinedText(ctx: PrettyUpContext): string {
  return [ctx.previousPrompt, ctx.prompt].filter(Boolean).join(" ");
}

export function previousHasPrintInPlace(ctx: PrettyUpContext): boolean {
  if (ctx.joints?.some((joint) => joint.intent === "print-in-place")) return true;
  if (JOINT_CODE.test(ctx.previousCode ?? "")) return true;
  const text = combinedText(ctx);
  return wantsMotion(text) && /\b(print[-\s]?in[-\s]?place|\bpip\b|hinge|pin joint|ball joint|snap[- ]?fit)\b/i.test(text);
}

export function previousHoleDiameterMm(ctx: PrettyUpContext): number | undefined {
  const planned = ctx.holes?.find((hole) => hole.d > 0)?.d;
  if (planned) return planned;
  const fromCode = ctx.previousCode?.match(HOLE_CODE);
  if (fromCode) {
    const n = Number(fromCode[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromPrompt = combinedText(ctx).match(/(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/i);
  if (fromPrompt) {
    const n = Number(fromPrompt[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function statedEdgeMm(prompt: string): number | undefined {
  const labeled = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:fillet|chamfer|radius|round|bevel)/i);
  if (!labeled) return undefined;
  const n = Number(labeled[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function clampPrettyExtentMm(
  requested: number | undefined,
  kind: PrettyUpOpKind,
  sizeMm?: [number, number, number] | null,
  holeMm?: number,
): number {
  const rules = printRules();
  const fallback = kind === "fillet" || kind === "chamfer" ? DEFAULT_EDGE_MM : DEFAULT_DECOR_H_MM;
  const raw = requested && requested > 0 ? requested : fallback;
  let maxSafe = kind === "fillet" || kind === "chamfer" ? MAX_EDGE_MM : MAX_DECOR_H_MM;
  if (sizeMm) {
    const minFace = Math.min(...sizeMm.filter((n) => n > 0));
    maxSafe = Math.min(maxSafe, Math.max(MIN_PRETTY_MM, minFace * 0.2));
    if (holeMm && holeMm > 0 && (kind === "fillet" || kind === "chamfer")) {
      const remain = (minFace - holeMm) / 2 - rules.minWallMm;
      if (remain >= MIN_PRETTY_MM) maxSafe = Math.min(maxSafe, remain);
    }
  }
  return round1(clamp(raw, MIN_PRETTY_MM, maxSafe));
}

export function prettyUpWouldFuseJoints(prompt: string, ctx: PrettyUpContext = { prompt }): boolean {
  if (!FUSE_JOINT.test(prompt)) return false;
  return (
    previousHasPrintInPlace(ctx) ||
    wantsMotion(combinedText(ctx)) ||
    /\b(joints?|hinge|pin|ball|snap|gap|clearance)\b/i.test(prompt)
  );
}

export function prettyUpWouldCloseHoles(prompt: string, ctx: PrettyUpContext = { prompt }): boolean {
  if (!CLOSE_HOLE.test(prompt)) return false;
  return previousHoleDiameterMm(ctx) !== undefined || /\bholes?\b/i.test(combinedText(ctx));
}

export function prettyUpRefusalReason(ctx: PrettyUpContext): string | undefined {
  if (prettyUpWouldFuseJoints(ctx.prompt, ctx)) {
    return "Pretty-up refused: would fuse print-in-place joint clearances. Functional hinge/pin/ball/snap gaps stay open.";
  }
  if (prettyUpWouldCloseHoles(ctx.prompt, ctx)) {
    return "Pretty-up refused: would close a planned through-hole. Functional bores stay open.";
  }
  return undefined;
}

function functionalRegions(ctx: PrettyUpContext): PrettyUpRegion[] {
  const regions: PrettyUpRegion[] = [];
  const holeMm = previousHoleDiameterMm(ctx);
  if (holeMm !== undefined) {
    regions.push({
      kind: "functional",
      role: "hole",
      note: `Keep the ${holeMm} mm through-hole (cutter still overshoots). Do not fill or shrink it for style.`,
    });
  }
  if (previousHasPrintInPlace(ctx) || (ctx.joints?.length ?? 0) > 0) {
    const types = ctx.joints?.map((joint) => joint.type).join("/") || "print-in-place";
    regions.push({
      kind: "functional",
      role: "joint",
      note: `Keep ${types} members as separate solids with documented radial/axial gaps.`,
    });
    regions.push({
      kind: "functional",
      role: "mating-face",
      note: "Leave mating / knuckle / socket faces undecorated so the joint still moves.",
    });
    regions.push({
      kind: "functional",
      role: "clearance",
      note: "Do not union decorative stock into the joint gap.",
    });
  }
  regions.push({
    kind: "functional",
    role: "wall",
    note: `Walls stay ≥ ${printRules().minWallMm} mm (4× 0.4 mm nozzle, #11). Decorative stock is extra, not a thinner shell.`,
  });
  return regions;
}

function opsForStyle(style: PrettyUpStyle, prompt: string, ctx: PrettyUpContext): PrettyUpOp[] {
  const holeMm = previousHoleDiameterMm(ctx);
  const stated = statedEdgeMm(prompt);
  if (style === "chamfer") {
    const mm = clampPrettyExtentMm(stated, "chamfer", ctx.sizeMm, holeMm);
    return [{ kind: "chamfer", mm, notes: "Primitive edge bevel; keep holes and joint gaps." }];
  }
  if (style === "fillet") {
    const mm = clampPrettyExtentMm(stated, "fillet", ctx.sizeMm, holeMm);
    return [{ kind: "fillet", mm, notes: "Primitive corner rounds (hull of cylinders), not minkowski()." }];
  }
  if (style === "ribs") {
    return [
      {
        kind: "rib",
        mm: DEFAULT_RIB_MM,
        notes: `1.6 mm decorative ribs, ${DEFAULT_DECOR_H_MM} mm proud, offset from holes.`,
      },
    ];
  }
  if (style === "panels") {
    return [{ kind: "panel", mm: DEFAULT_DECOR_H_MM, notes: "Thin raised panels on non-mating faces." }];
  }
  if (style === "steampunk") {
    return [
      { kind: "rib", mm: DEFAULT_RIB_MM, notes: "Steampunk ribs on non-functional faces." },
      { kind: "motif", mm: DEFAULT_DECOR_H_MM, notes: "Disc / rivet primitives (reuse relief discs when useful)." },
    ];
  }
  return [{ kind: "motif", mm: DEFAULT_DECOR_H_MM, notes: "Decorative motif via existing emboss/relief path." }];
}

function decorativeRegions(style: PrettyUpStyle, ops: PrettyUpOp[]): PrettyUpRegion[] {
  return ops.map((op) => ({
    kind: "decorative" as const,
    role: op.kind === "rib" ? "rib" : op.kind === "panel" ? "panel" : op.kind === "motif" ? "motif" : op.kind,
    note: op.notes ?? `${op.kind} ${op.mm} mm (decorative only).`,
  }));
}

function hostSizeFromContext(ctx: PrettyUpContext): [number, number, number] | undefined {
  if (ctx.sizeMm) return ctx.sizeMm;
  const fromPrompt = combinedText(ctx).match(/(\d+(?:\.\d+)?)\s*mm\s+cube/i);
  if (fromPrompt) {
    const n = Number(fromPrompt[1]);
    if (Number.isFinite(n) && n > 0) return [n, n, n];
  }
  const fromCode = ctx.previousCode?.match(/\bsize\s*=\s*(\d+(?:\.\d+)?)/);
  if (fromCode) {
    const n = Number(fromCode[1]);
    if (Number.isFinite(n) && n > 0) return [n, n, n];
  }
  return undefined;
}

/**
 * Plan-time pretty-up. Separate from structural edits (new holes, size, joints).
 * Returns undefined when the prompt is not a restyle request.
 */
export function inferCadPrettyUp(ctx: PrettyUpContext): CadPrettyUp | undefined {
  const sized = { ...ctx, sizeMm: ctx.sizeMm ?? hostSizeFromContext(ctx) };
  const refuse = prettyUpRefusalReason(sized);
  const style = inferPrettyUpStyle(ctx.prompt) ?? (refuse ? "fillet" : undefined);
  if (!style) return undefined;
  const functional = functionalRegions(sized);
  if (refuse) {
    return {
      applied: false,
      refused: true,
      refuse_reason: refuse,
      style,
      ops: [],
      functional_regions: functional,
      decorative_regions: [],
      notes: `${refuse} Heuristic CSG pretty-up only — not neural Style2Fab.`,
    };
  }
  const pip = previousHasPrintInPlace(sized);
  const ops = opsForStyle(style, ctx.prompt, sized);
  if (pip) {
    return {
      applied: false,
      refused: false,
      style,
      ops,
      functional_regions: functional,
      decorative_regions: decorativeRegions(style, ops),
      notes:
        "Pretty-up planned but skipped on print-in-place members so joint clearances stay open. Decorative CSG is for the host body only — not a fused restyle. Not neural Style2Fab.",
    };
  }
  return {
    applied: true,
    refused: false,
    style,
    ops,
    functional_regions: functional,
    decorative_regions: decorativeRegions(style, ops),
    notes: `Pretty-up stub: ${style} CSG on decorative regions only. Functional holes/joints/walls preserved. Not neural Style2Fab.`,
  };
}

function parseStyle(raw: unknown): PrettyUpStyle | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!text) return undefined;
  if (/\bsteampunk|victorian|ornate\b/.test(text)) return "steampunk";
  if (/\bchamfer|bevel\b/.test(text)) return "chamfer";
  if (/\bfillet|round\b/.test(text)) return "fillet";
  if (/\bribs?\b/.test(text)) return "ribs";
  if (/\bpanels?\b/.test(text)) return "panels";
  if (/\bmotif|crest|logo\b/.test(text)) return "motif";
  return isPrettyUpStyle(text) ? text : undefined;
}

function parseOpKind(raw: unknown): PrettyUpOpKind | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (text === "fillet" || text === "chamfer" || text === "rib" || text === "panel" || text === "motif") {
    return text;
  }
  if (/\bribs?\b/.test(text)) return "rib";
  if (/\bpanels?\b/.test(text)) return "panel";
  return undefined;
}

function parseRegion(raw: unknown): PrettyUpRegion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const roleRaw = asString(rec.role) ?? asString(rec.name) ?? asString(rec.kind);
  const role = PRETTY_UP_ROLES.find((item) => item === roleRaw) ?? (roleRaw === "holes" ? "hole" : undefined);
  if (!role) return undefined;
  const kind = rec.kind === "decorative" || role === "fillet" || role === "chamfer" || role === "rib" || role === "panel" || role === "motif"
    ? "decorative"
    : "functional";
  return {
    kind: rec.kind === "functional" ? "functional" : rec.kind === "decorative" ? "decorative" : kind,
    role,
    note: asString(rec.note) ?? asString(rec.notes) ?? `${role} region`,
  };
}

export function parseCadPrettyUp(raw: unknown): CadPrettyUp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const style = parseStyle(rec.style ?? rec.kind ?? rec.look) ?? "fillet";
  const opsRaw = Array.isArray(rec.ops) ? rec.ops : Array.isArray(rec.operations) ? rec.operations : [];
  const ops = opsRaw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const op = item as Record<string, unknown>;
    const kind = parseOpKind(op.kind ?? op.type ?? op.name);
    if (!kind) return [];
    const mm = asFiniteNumber(op.mm) ?? asFiniteNumber(op.extent_mm) ?? DEFAULT_EDGE_MM;
    return [{ kind, mm, region: asString(op.region), notes: asString(op.notes) }];
  });
  const functional = (Array.isArray(rec.functional_regions) ? rec.functional_regions : [])
    .map(parseRegion)
    .filter((region): region is PrettyUpRegion => Boolean(region));
  const decorative = (Array.isArray(rec.decorative_regions) ? rec.decorative_regions : [])
    .map(parseRegion)
    .filter((region): region is PrettyUpRegion => Boolean(region));
  return {
    applied: rec.applied !== false && rec.refused !== true,
    refused: rec.refused === true,
    refuse_reason: asString(rec.refuse_reason) ?? asString(rec.reason),
    style,
    ops,
    functional_regions: functional,
    decorative_regions: decorative,
    notes: asString(rec.notes),
  };
}

export function normalizeCadPrettyUp(
  pretty: CadPrettyUp | undefined,
  ctx: PrettyUpContext,
): CadPrettyUp | undefined {
  if (!promptHasPrettyUp(ctx.prompt)) return undefined;
  const inferred = inferCadPrettyUp(ctx);
  if (!inferred) return undefined;
  if (inferred.refused) return inferred;
  if (!pretty) return inferred;
  const holeMm = previousHoleDiameterMm(ctx);
  const ops = (pretty.ops.length ? pretty.ops : inferred.ops).map((op) => ({
    ...op,
    mm: clampPrettyExtentMm(op.mm, op.kind, ctx.sizeMm ?? hostSizeFromContext(ctx), holeMm),
  }));
  return {
    ...inferred,
    style: pretty.style ?? inferred.style,
    ops,
    functional_regions: inferred.functional_regions.length ? inferred.functional_regions : pretty.functional_regions,
    decorative_regions: inferred.decorative_regions.length ? inferred.decorative_regions : pretty.decorative_regions,
    notes: inferred.notes,
  };
}

export function formatPrettyUpConstraints(): string {
  const wall = printRules().minWallMm;
  return [
    `Pretty-up / restyle (only when the user asks to pretty-up, restyle, fillet, chamfer, add decorative ribs/panels, or make it look steampunk):`,
    `- Honest CSG stub — not neural Style2Fab / image style transfer. Fillet = hull of cylinders; chamfer = inset-cube hull; ribs/panels/rivets = extra cubes/cylinders.`,
    `- Separate from structural edits. Do not add/remove holes, joints, or change overall size unless they also asked.`,
    `- Functional preserve: keep planned through-holes, PIP joint gaps, mating faces, and walls ≥ ${wall} mm (#11). Decorative stock stays off those regions.`,
    `- Refuse pretty-up that would fuse print-in-place joints or close through-holes. Leave the working CSG and say so in plan notes.`,
    `- Mark functional vs decorative regions in plan notes. Motif emboss may reuse the existing relief path.`,
  ].join("\n");
}

export function formatPrettyUpNote(pretty?: CadPrettyUp | null): string {
  if (!pretty) return "";
  if (pretty.refused) {
    return pretty.refuse_reason ?? pretty.notes ?? "Pretty-up refused to protect functional regions.";
  }
  const functional = pretty.functional_regions.map((region) => region.role).join(", ") || "walls";
  const decorative = pretty.decorative_regions.map((region) => `${region.role}`).join(", ") || pretty.style;
  const status = pretty.applied ? "applied" : "planned (skipped on PIP members)";
  return `Pretty-up stub (${status}): ${pretty.style} on decorative [${decorative}]. Functional preserve: ${functional}. Not neural Style2Fab.`;
}

export function formatPrettyUpPromptHint(pretty?: CadPrettyUp | null): string {
  if (!pretty) return "";
  if (pretty.refused) {
    return [
      `Pretty-up was refused. Do not fuse joints or close holes. Keep the current functional CSG.`,
      pretty.refuse_reason ?? "",
      JSON.stringify({
        refused: true,
        functional_regions: pretty.functional_regions,
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Pretty-up is stylistic CSG only (fillets/chamfers as primitives, decorative ribs/panels, optional relief motif).`,
    `Do not remove planned holes/joints/clearances. Do not thin walls below ${printRules().minWallMm} mm.`,
    `If this is print-in-place, decorate the host body only — never union moving members.`,
    JSON.stringify(pretty),
  ].join("\n");
}

export function prettyUpReliefs(ctx: PrettyUpContext): CadRelief[] {
  const pretty = inferCadPrettyUp(ctx);
  if (!pretty || pretty.refused || !pretty.applied) return [];
  if (pretty.style !== "steampunk" && pretty.style !== "motif") return ctx.reliefs ?? inferCadReliefs(ctx.prompt, ctx.sizeMm);
  const existing = ctx.reliefs?.length ? ctx.reliefs : inferCadReliefs(ctx.prompt, ctx.sizeMm);
  return existing;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

export function cubePrettyFilletScad(size = 20, hole = 5, fillet = DEFAULT_EDGE_MM): string {
  const r = clampPrettyExtentMm(fillet, "fillet", [size, size, size], hole);
  return `// Fixture: pretty-up fillet cube (mm) — keep through-hole
// Functional: ${hole} mm through-hole, walls ≥ 1.6 mm. Decorative: ${r} mm corner rounds.
$fn = 48;
size = ${fmt(size)};
hole_d = ${fmt(hole)};
fillet_r = ${fmt(r)};

module rounded_box() {
  // Primitive fillets: hull of vertical cylinders — not minkowski / Style2Fab.
  hull() {
    translate([fillet_r, fillet_r, 0]) cylinder(h = size, r = fillet_r);
    translate([size - fillet_r, fillet_r, 0]) cylinder(h = size, r = fillet_r);
    translate([fillet_r, size - fillet_r, 0]) cylinder(h = size, r = fillet_r);
    translate([size - fillet_r, size - fillet_r, 0]) cylinder(h = size, r = fillet_r);
  }
}

difference() {
  rounded_box();
  // functional through-hole — do not close
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
`;
}

export function cubePrettyChamferScad(size = 20, hole = 5, chamfer = DEFAULT_EDGE_MM): string {
  const c = clampPrettyExtentMm(chamfer, "chamfer", [size, size, size], hole);
  return `// Fixture: pretty-up chamfer cube (mm) — keep through-hole
// Functional: ${hole} mm through-hole. Decorative: ${c} mm vertical-edge bevels.
$fn = 48;
size = ${fmt(size)};
hole_d = ${fmt(hole)};
chamfer = ${fmt(c)};

module chamfered_box() {
  // Primitive chamfer: hull of inset cubes — not minkowski().
  hull() {
    translate([chamfer, 0, 0]) cube([size - 2 * chamfer, size, size]);
    translate([0, chamfer, 0]) cube([size, size - 2 * chamfer, size]);
  }
}

difference() {
  chamfered_box();
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
`;
}

export function cubePrettyRibsScad(size = 20, hole = 5): string {
  const rib = DEFAULT_RIB_MM;
  const h = DEFAULT_DECOR_H_MM;
  const inset = Math.max(2.4, hole / 2 + printRules().minWallMm);
  return `// Fixture: pretty-up decorative ribs (mm) — keep through-hole
// Functional: ${hole} mm through-hole. Decorative: ${rib} mm ribs, offset from the bore.
$fn = 48;
size = ${fmt(size)};
hole_d = ${fmt(hole)};
rib_t = ${fmt(rib)};
rib_h = ${fmt(h)};
rib_inset = ${fmt(inset)};

module host() {
  cube(size, center = false);
}

module decorative_ribs() {
  // +X face, flanking the Z through-hole
  translate([size, rib_inset, 2]) cube([rib_h, rib_t, size - 4]);
  translate([size, size - rib_inset - rib_t, 2]) cube([rib_h, rib_t, size - 4]);
  // +Y face
  translate([rib_inset, size, 2]) cube([rib_t, rib_h, size - 4]);
  translate([size - rib_inset - rib_t, size, 2]) cube([rib_t, rib_h, size - 4]);
}

difference() {
  union() {
    host();
    decorative_ribs();
  }
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
`;
}

export function cubePrettySteampunkScad(size = 20, hole = 5): string {
  const rib = DEFAULT_RIB_MM;
  const h = DEFAULT_DECOR_H_MM;
  const inset = Math.max(2.4, hole / 2 + printRules().minWallMm);
  const disc = Math.min(10, size * 0.45);
  return `// Fixture: pretty-up steampunk cube (mm) — keep through-hole
// Functional: ${hole} mm through-hole, walls ≥ 1.6 mm.
// Decorative: ribs, rivets, disc motif (relief-adjacent primitives). Not neural Style2Fab.
$fn = 48;
size = ${fmt(size)};
hole_d = ${fmt(hole)};
rib_t = ${fmt(rib)};
rib_h = ${fmt(h)};
rib_inset = ${fmt(inset)};
disc_d = ${fmt(disc)};
rivet_d = 2.4;
rivet_h = ${fmt(h)};

module host() {
  cube(size, center = false);
}

module decorative_ribs() {
  translate([size, rib_inset, 2]) cube([rib_h, rib_t, size - 4]);
  translate([size, size - rib_inset - rib_t, 2]) cube([rib_h, rib_t, size - 4]);
}

module steampunk_disc() {
  // +X face disc — away from the Z bore
  translate([size, size / 2, size / 2])
    rotate([0, 90, 0])
      cylinder(h = rib_h, d = disc_d);
}

module rivets() {
  translate([2.5, 2.5, size]) cylinder(h = rivet_h, d = rivet_d);
  translate([size - 2.5, 2.5, size]) cylinder(h = rivet_h, d = rivet_d);
  translate([2.5, size - 2.5, size]) cylinder(h = rivet_h, d = rivet_d);
  translate([size - 2.5, size - 2.5, size]) cylinder(h = rivet_h, d = rivet_d);
}

difference() {
  union() {
    host();
    decorative_ribs();
    steampunk_disc();
    rivets();
  }
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
`;
}

export function isCubePrettyFilletPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bcube\b/.test(text) && FILLET_WORD.test(text);
}

export function isCubePrettyChamferPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bcube\b/.test(text) && CHAMFER_WORD.test(text);
}

export function isCubePrettySteampunkPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (/\bcube\b/.test(text) || /\bhole\b/.test(text)) && STEAMPUNK_WORD.test(text);
}

export function isCubePrettyRibsPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (/\bcube\b/.test(text) || /\bhole\b/.test(text)) && RIB_WORD.test(text);
}

export function isPrettyUpFollowUp(prompt: string): boolean {
  return promptHasPrettyUp(prompt);
}

export function prettyUpFixtureScad(
  style: PrettyUpStyle,
  size = 20,
  hole = 5,
  edgeMm?: number,
): string {
  if (style === "chamfer") return cubePrettyChamferScad(size, hole, edgeMm ?? DEFAULT_EDGE_MM);
  if (style === "steampunk") return cubePrettySteampunkScad(size, hole);
  if (style === "ribs" || style === "panels") return cubePrettyRibsScad(size, hole);
  return cubePrettyFilletScad(size, hole, edgeMm ?? DEFAULT_EDGE_MM);
}

/** Decorative CSG to union onto an imported host (bbox-local). Hole is differenced after. */
export function importedPrettyUpExtrasScad(
  pretty: CadPrettyUp,
  box: { min: [number, number, number]; size: [number, number, number] },
): string {
  if (!pretty.applied || pretty.refused || !pretty.ops.length) return "";
  const [minx, miny, minz] = box.min;
  const [sx, sy, sz] = box.size;
  const lines: string[] = [];
  for (const op of pretty.ops) {
    if (op.kind === "rib" || op.kind === "panel") {
      const t = DEFAULT_RIB_MM;
      const h = Math.min(op.mm, MAX_DECOR_H_MM);
      const inset = Math.max(2.4, Math.min(sx, sy) * 0.2);
      lines.push(`// decorative ${op.kind} — offset from functional faces`);
      lines.push(
        `translate([${fmt(minx + sx)}, ${fmt(miny + inset)}, ${fmt(minz + 2)}]) cube([${fmt(h)}, ${fmt(t)}, ${fmt(Math.max(4, sz - 4))}]);`,
      );
      lines.push(
        `translate([${fmt(minx + inset)}, ${fmt(miny + sy)}, ${fmt(minz + 2)}]) cube([${fmt(t)}, ${fmt(h)}, ${fmt(Math.max(4, sz - 4))}]);`,
      );
    } else if (op.kind === "motif") {
      const d = Math.min(10, Math.min(sy, sz) * 0.45);
      const h = Math.min(op.mm, MAX_DECOR_H_MM);
      lines.push(`// decorative disc motif (relief-adjacent)`);
      lines.push(
        `translate([${fmt(minx + sx)}, ${fmt(miny + sy / 2)}, ${fmt(minz + sz / 2)}]) rotate([0, 90, 0]) cylinder(h = ${fmt(h)}, d = ${fmt(d)});`,
      );
    } else if (op.kind === "fillet") {
      const r = Math.min(op.mm, Math.min(sx, sy) * 0.15);
      lines.push(`// decorative corner nubs — imported STL cannot be hull-filleted honestly`);
      lines.push(
        `translate([${fmt(minx)}, ${fmt(miny)}, ${fmt(minz)}]) cylinder(h = ${fmt(sz)}, r = ${fmt(r)});`,
      );
      lines.push(
        `translate([${fmt(minx + sx)}, ${fmt(miny)}, ${fmt(minz)}]) cylinder(h = ${fmt(sz)}, r = ${fmt(r)});`,
      );
      lines.push(
        `translate([${fmt(minx)}, ${fmt(miny + sy)}, ${fmt(minz)}]) cylinder(h = ${fmt(sz)}, r = ${fmt(r)});`,
      );
      lines.push(
        `translate([${fmt(minx + sx)}, ${fmt(miny + sy)}, ${fmt(minz)}]) cylinder(h = ${fmt(sz)}, r = ${fmt(r)});`,
      );
    } else if (op.kind === "chamfer") {
      const c = Math.min(op.mm, 2);
      lines.push(`// decorative chamfer cuts at vertical edges — do not close holes`);
      lines.push(
        `// (applied as later difference children alongside the functional hole)`,
      );
      void c;
    }
  }
  return lines.filter(Boolean).join("\n  ");
}

export function importedPrettyUpChamferCutters(
  pretty: CadPrettyUp,
  box: { min: [number, number, number]; size: [number, number, number] },
): string {
  if (!pretty.applied || pretty.refused) return "";
  const chamfer = pretty.ops.find((op) => op.kind === "chamfer");
  if (!chamfer) return "";
  const [minx, miny, minz] = box.min;
  const [sx, sy, sz] = box.size;
  const c = Math.min(chamfer.mm, 2);
  const h = sz + 2;
  return [
    `translate([${fmt(minx)}, ${fmt(miny)}, ${fmt(minz - 1)}]) rotate([0, 0, 45]) cube([${fmt(c * 1.6)}, ${fmt(c * 1.6)}, ${fmt(h)}], center = true);`,
    `translate([${fmt(minx + sx)}, ${fmt(miny)}, ${fmt(minz - 1)}]) rotate([0, 0, 45]) cube([${fmt(c * 1.6)}, ${fmt(c * 1.6)}, ${fmt(h)}], center = true);`,
    `translate([${fmt(minx)}, ${fmt(miny + sy)}, ${fmt(minz - 1)}]) rotate([0, 0, 45]) cube([${fmt(c * 1.6)}, ${fmt(c * 1.6)}, ${fmt(h)}], center = true);`,
    `translate([${fmt(minx + sx)}, ${fmt(miny + sy)}, ${fmt(minz - 1)}]) rotate([0, 0, 45]) cube([${fmt(c * 1.6)}, ${fmt(c * 1.6)}, ${fmt(h)}], center = true);`,
  ].join("\n  ");
}
