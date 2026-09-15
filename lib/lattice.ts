/**
 * Generative lattice / lightweighting stub.
 *
 * Heuristic infill-as-geometry: OpenSCAD-feasible honeycomb, cubic grid,
 * diagonal, or gyroid-ish voids inside a solid shell. Not FEA / MechStyle
 * topology optimization. Functional holes, PIP joints, and mating faces
 * stay uncut. One piece first unless the user asked for multi-part.
 */
import { wantsMotion, type CadJoint } from "./joints";
import { printRules } from "./printability";

export const LATTICE_PATTERNS = ["honeycomb", "cubic", "gyroid", "diagonal"] as const;
export type LatticePattern = (typeof LATTICE_PATTERNS)[number];

export const LATTICE_ROLES = ["hole", "joint", "mating-face", "wall", "shell", "lattice"] as const;
export type LatticeRole = (typeof LATTICE_ROLES)[number];

export type LatticeRegion = {
  kind: "functional" | "lattice";
  role: LatticeRole;
  note: string;
};

export type CadLattice = {
  applied: boolean;
  refused: boolean;
  refuse_reason?: string;
  pattern: LatticePattern;
  shell_mm: number;
  cell_mm: number;
  strut_mm: number;
  keep_holes: boolean;
  keep_joints: boolean;
  keep_mating: boolean;
  one_piece: true;
  fea: false;
  functional_regions: LatticeRegion[];
  notes?: string;
};

export type LatticeContext = {
  prompt: string;
  previousPrompt?: string | null;
  previousCode?: string | null;
  holes?: Array<{ d: number; through?: boolean; purpose?: string }>;
  joints?: CadJoint[];
  sizeMm?: [number, number, number] | null;
};

export const PHONE_HONEYCOMB_PROMPT = "lightweight phone stand with honeycomb";
export const CUBE_HONEYCOMB_PROMPT = "lightweight 20mm cube with honeycomb";
export const CUBE_GYROID_PROMPT = "20mm cube with 5mm hole, gyroid lattice";

const LATTICE_WORD =
  /\b(lattice|honeycomb|gyroid|lightweight(?:ing)?|light[-\s]?weight|lighten(?:ed|ing)?|make (?:it|this|the \w+) lighter|infill[-\s]?as[-\s]?geometry|cubic grid|diagonal lattice|internal (?:lattice|honeycomb|grid))\b/i;

const HONEYCOMB_WORD = /\bhoneycomb\b/i;
const GYROID_WORD = /\bgyroid(?:[-\s]?ish|[-\s]?style)?\b/i;
const CUBIC_WORD = /\b(cubic(?:\s+grid)?|grid lattice|voxel)\b/i;
const DIAGONAL_WORD = /\bdiagonal(?:\s+lattice)?\b/i;

const LATTICE_THROUGH_HOLE =
  /\b(lattice|honeycomb|gyroid|grid)\b.{0,40}\b(through|into|across)\b.{0,24}\b(holes?|bores?|joints?|mating)\b|\b(through|into)\b.{0,16}\b(the\s+)?(holes?|bores?|joints?|mating faces?)\b.{0,24}\b(lattice|honeycomb|gyroid)\b/i;
const CLOSE_HOLE =
  /\b(close|fill|plug|seal|cover|block|cap)\b.{0,40}\b(holes?|bores?|through[- ]holes?)\b|\b(holes?|bores?|through[- ]holes?)\b.{0,24}\b(closed|filled|plugged|sealed)\b/i;
const FUSE_JOINT =
  /\b(fuse|weld|fill(?:\s+in)?|close|seal|join together|make (?:it |that )?(?:one|a) (?:solid|piece)|union (?:the )?(?:joint|gap|clearance|hinge|pin|ball|snap))\b/i;
const JOINT_CODE =
  /module\s+(box_body|hinge_pin|rotor_and_pin|ball_and_stem|snap_hook)\s*\(/;
const HOLE_CODE = /hole_d\s*=\s*(\d+(?:\.\d+)?)/;
const CABLE_CODE = /cable\s*=\s*(\d+(?:\.\d+)?)/;

export function promptHasLattice(prompt: string): boolean {
  return LATTICE_WORD.test(prompt);
}

export function isLatticePattern(value: string | undefined | null): value is LatticePattern {
  return Boolean(value && (LATTICE_PATTERNS as readonly string[]).includes(value));
}

export function inferLatticePattern(prompt: string): LatticePattern | undefined {
  if (!promptHasLattice(prompt)) return undefined;
  if (HONEYCOMB_WORD.test(prompt)) return "honeycomb";
  if (GYROID_WORD.test(prompt)) return "gyroid";
  if (CUBIC_WORD.test(prompt)) return "cubic";
  if (DIAGONAL_WORD.test(prompt)) return "diagonal";
  return "honeycomb";
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

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

function combinedText(ctx: LatticeContext): string {
  return [ctx.previousPrompt, ctx.prompt].filter(Boolean).join(" ");
}

export function previousHasPrintInPlace(ctx: LatticeContext): boolean {
  if (ctx.joints?.some((joint) => joint.intent === "print-in-place")) return true;
  if (JOINT_CODE.test(ctx.previousCode ?? "")) return true;
  const text = combinedText(ctx);
  return wantsMotion(text) && /\b(print[-\s]?in[-\s]?place|\bpip\b|hinge|pin joint|ball joint|snap[- ]?fit)\b/i.test(text);
}

export function previousHoleDiameterMm(ctx: LatticeContext): number | undefined {
  const planned = ctx.holes?.find((hole) => hole.d > 0)?.d;
  if (planned) return planned;
  const fromCode = ctx.previousCode?.match(HOLE_CODE);
  if (fromCode) {
    const n = Number(fromCode[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cable = ctx.previousCode?.match(CABLE_CODE);
  if (cable) {
    const n = Number(cable[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromPrompt = combinedText(ctx).match(/(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/i);
  if (fromPrompt) {
    const n = Number(fromPrompt[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (/\bcable\b/i.test(combinedText(ctx))) return 14;
  return undefined;
}

function statedShellMm(prompt: string): number | undefined {
  const named = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:shell|wall|skin)\b/i);
  if (!named) return undefined;
  const n = Number(named[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function statedCellMm(prompt: string): number | undefined {
  const named = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:cells?|hex|grid)\b/i);
  if (!named) return undefined;
  const n = Number(named[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function nozzleAwareShellMm(requested?: number): number {
  const rules = printRules();
  const floor = rules.minWallMm;
  const raw = requested && requested > 0 ? requested : floor;
  return round1(Math.max(floor, raw));
}

export function clampLatticeCellMm(
  requested: number | undefined,
  sizeMm?: [number, number, number] | null,
  shellMm = nozzleAwareShellMm(),
): number {
  const minInner = sizeMm ? Math.min(...sizeMm.filter((n) => n > 0)) - 2 * shellMm : 16;
  const maxCell = Number.isFinite(minInner) ? Math.max(4, minInner * 0.55) : 12;
  const raw = requested && requested > 0 ? requested : Math.min(8, maxCell);
  return round1(clamp(raw, 4, Math.min(16, maxCell)));
}

export function clampLatticeStrutMm(requested?: number): number {
  const rules = printRules();
  const floor = rules.minWallMm;
  const raw = requested && requested > 0 ? requested : floor;
  return round1(clamp(raw, floor, 4));
}

export function innerVolumeFitsLattice(
  sizeMm?: [number, number, number] | null,
  shellMm = nozzleAwareShellMm(),
  strutMm = clampLatticeStrutMm(),
): boolean {
  if (!sizeMm) return true;
  const inner = sizeMm.filter((n) => n > 0).map((n) => n - 2 * shellMm);
  if (!inner.length) return true;
  return Math.min(...inner) >= strutMm + 2;
}

export function latticeWouldCutHoles(prompt: string, ctx: LatticeContext = { prompt }): boolean {
  if (!LATTICE_THROUGH_HOLE.test(prompt) && !CLOSE_HOLE.test(prompt)) return false;
  return previousHoleDiameterMm(ctx) !== undefined || /\b(holes?|bores?|cable)\b/i.test(combinedText(ctx));
}

export function latticeWouldCutJoints(prompt: string, ctx: LatticeContext = { prompt }): boolean {
  if (previousHasPrintInPlace(ctx)) return true;
  if (!FUSE_JOINT.test(prompt) && !LATTICE_THROUGH_HOLE.test(prompt)) return false;
  return wantsMotion(combinedText(ctx)) || /\b(joints?|hinge|pin|ball|snap|mating)\b/i.test(prompt);
}

export function latticeRefusalReason(ctx: LatticeContext): string | undefined {
  if (latticeWouldCutJoints(ctx.prompt, ctx)) {
    return "Lattice refused: would cut through print-in-place joint members or mating faces. Functional hinge/pin/ball/snap gaps stay solid and open.";
  }
  if (latticeWouldCutHoles(ctx.prompt, ctx)) {
    return "Lattice refused: would lattice through a functional hole or plug the bore. Keepers stay around holes/joints.";
  }
  const shell = nozzleAwareShellMm(statedShellMm(ctx.prompt));
  const strut = clampLatticeStrutMm();
  if (!innerVolumeFitsLattice(ctx.sizeMm ?? hostSizeFromContext(ctx), shell, strut)) {
    return "Lattice refused: remaining inner volume is thinner than a printable shell + strut. Keep the solid or thicken the part first.";
  }
  return undefined;
}

function hostSizeFromContext(ctx: LatticeContext): [number, number, number] | undefined {
  if (ctx.sizeMm) return ctx.sizeMm;
  const cube = combinedText(ctx).match(/(\d+(?:\.\d+)?)\s*mm\s+cube/i);
  if (cube) {
    const n = Number(cube[1]);
    if (Number.isFinite(n) && n > 0) return [n, n, n];
  }
  const fromCode = ctx.previousCode?.match(/\bsize\s*=\s*(\d+(?:\.\d+)?)/);
  if (fromCode) {
    const n = Number(fromCode[1]);
    if (Number.isFinite(n) && n > 0) return [n, n, n];
  }
  if (/\bphone stand\b|\biphone\b/i.test(combinedText(ctx))) return [76, 78, 12];
  return undefined;
}

function functionalRegions(ctx: LatticeContext, shellMm: number): LatticeRegion[] {
  const regions: LatticeRegion[] = [
    {
      kind: "functional",
      role: "shell",
      note: `Keep a printable outer shell ≥ ${shellMm} mm (4× ${printRules().nozzleMm} mm nozzle). Lattice only the interior.`,
    },
    {
      kind: "functional",
      role: "wall",
      note: `Struts and remaining walls stay ≥ ${printRules().minWallMm} mm. Heuristic pattern — not FEA.`,
    },
  ];
  const holeMm = previousHoleDiameterMm(ctx);
  if (holeMm !== undefined) {
    regions.push({
      kind: "functional",
      role: "hole",
      note: `Keep the ${holeMm} mm functional bore (cable/fastener). Do not lattice through it or close it.`,
    });
  }
  if (previousHasPrintInPlace(ctx) || (ctx.joints?.length ?? 0) > 0) {
    const types = ctx.joints?.map((joint) => joint.type).join("/") || "print-in-place";
    regions.push({
      kind: "functional",
      role: "joint",
      note: `Do not lattice ${types} members or their documented radial/axial gaps.`,
    });
    regions.push({
      kind: "functional",
      role: "mating-face",
      note: "Leave mating / knuckle / socket faces solid so the joint still moves.",
    });
  }
  return regions;
}

/**
 * Plan-time lattice. Returns undefined when the prompt is not a lightweight request.
 */
export function inferCadLattice(ctx: LatticeContext): CadLattice | undefined {
  const sized = { ...ctx, sizeMm: ctx.sizeMm ?? hostSizeFromContext(ctx) };
  const pattern = inferLatticePattern(ctx.prompt);
  if (!pattern) return undefined;
  const shell_mm = nozzleAwareShellMm(statedShellMm(ctx.prompt));
  const strut_mm = clampLatticeStrutMm();
  const cell_mm = clampLatticeCellMm(statedCellMm(ctx.prompt), sized.sizeMm, shell_mm);
  const functional = functionalRegions(sized, shell_mm);
  const refuse = latticeRefusalReason(sized);
  if (refuse) {
    return {
      applied: false,
      refused: true,
      refuse_reason: refuse,
      pattern,
      shell_mm,
      cell_mm,
      strut_mm,
      keep_holes: true,
      keep_joints: true,
      keep_mating: true,
      one_piece: true,
      fea: false,
      functional_regions: functional,
      notes: `${refuse} Heuristic lattice stub only — not MechStyle FEA.`,
    };
  }
  return {
    applied: true,
    refused: false,
    pattern,
    shell_mm,
    cell_mm,
    strut_mm,
    keep_holes: true,
    keep_joints: true,
    keep_mating: true,
    one_piece: true,
    fea: false,
    functional_regions: functional,
    notes: `Lattice stub: ${pattern} interior, ${shell_mm} mm shell, ${cell_mm} mm cells, ${strut_mm} mm struts. Functional holes/joints/mating faces preserved. Heuristic pattern — not FEA / MechStyle.`,
  };
}

function parsePattern(raw: unknown): LatticePattern | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!text) return undefined;
  if (/\bhoneycomb\b/.test(text)) return "honeycomb";
  if (/\bgyroid\b/.test(text)) return "gyroid";
  if (/\bcubic|grid|voxel\b/.test(text)) return "cubic";
  if (/\bdiagonal\b/.test(text)) return "diagonal";
  return isLatticePattern(text) ? text : undefined;
}

function parseRegion(raw: unknown): LatticeRegion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const roleRaw = asString(rec.role) ?? asString(rec.name);
  const role = LATTICE_ROLES.find((item) => item === roleRaw);
  if (!role) return undefined;
  return {
    kind: rec.kind === "lattice" ? "lattice" : "functional",
    role,
    note: asString(rec.note) ?? asString(rec.notes) ?? `${role} region`,
  };
}

export function parseCadLattice(raw: unknown): CadLattice | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const pattern = parsePattern(rec.pattern ?? rec.kind ?? rec.style) ?? "honeycomb";
  const functional = (Array.isArray(rec.functional_regions) ? rec.functional_regions : [])
    .map(parseRegion)
    .filter((region): region is LatticeRegion => Boolean(region));
  return {
    applied: rec.applied !== false && rec.refused !== true,
    refused: rec.refused === true,
    refuse_reason: asString(rec.refuse_reason) ?? asString(rec.reason),
    pattern,
    shell_mm: asFiniteNumber(rec.shell_mm) ?? asFiniteNumber(rec.shell) ?? nozzleAwareShellMm(),
    cell_mm: asFiniteNumber(rec.cell_mm) ?? asFiniteNumber(rec.cell) ?? 8,
    strut_mm: asFiniteNumber(rec.strut_mm) ?? asFiniteNumber(rec.strut) ?? clampLatticeStrutMm(),
    keep_holes: rec.keep_holes !== false,
    keep_joints: rec.keep_joints !== false,
    keep_mating: rec.keep_mating !== false,
    one_piece: true,
    fea: false,
    functional_regions: functional,
    notes: asString(rec.notes),
  };
}

export function normalizeCadLattice(
  lattice: CadLattice | undefined,
  ctx: LatticeContext,
): CadLattice | undefined {
  if (!promptHasLattice(ctx.prompt)) return undefined;
  const inferred = inferCadLattice(ctx);
  if (!inferred) return undefined;
  if (inferred.refused) return inferred;
  if (!lattice) return inferred;
  return {
    ...inferred,
    pattern: lattice.pattern ?? inferred.pattern,
    shell_mm: nozzleAwareShellMm(lattice.shell_mm),
    cell_mm: clampLatticeCellMm(lattice.cell_mm, ctx.sizeMm ?? hostSizeFromContext(ctx), inferred.shell_mm),
    strut_mm: clampLatticeStrutMm(lattice.strut_mm),
    functional_regions: inferred.functional_regions.length ? inferred.functional_regions : lattice.functional_regions,
    notes: inferred.notes,
  };
}

export function formatLatticeConstraints(): string {
  const wall = printRules().minWallMm;
  return [
    `Generative lattice / lightweighting (only when the user asks to lighten, lattice, honeycomb, gyroid, cubic grid, or diagonal lattice):`,
    `- Honest CSG stub — heuristic infill-as-geometry, not FEA / MechStyle topology optimization.`,
    `- Apply the pattern to the INTERNAL volume only. Keep a printable outer shell ≥ ${wall} mm (4× nozzle). Struts ≥ ${wall} mm.`,
    `- OpenSCAD-feasible patterns: honeycomb (hex prism voids), cubic grid, simple gyroid-ish (offset hex layers), or diagonal cylinders.`,
    `- Do not lattice through functional holes, PIP joints, or mating faces. Re-cut bores after the lattice so keepers stay around holes.`,
    `- One piece first unless they asked for a multi-part kit. Omit lattice unless they asked.`,
  ].join("\n");
}

export function formatLatticeNote(lattice?: CadLattice | null): string {
  if (!lattice) return "";
  if (lattice.refused) {
    return lattice.refuse_reason ?? lattice.notes ?? "Lattice refused to protect functional regions.";
  }
  const functional = lattice.functional_regions.map((region) => region.role).join(", ") || "shell, holes";
  return `Lattice stub (${lattice.applied ? "applied" : "planned"}): ${lattice.pattern} interior, ${lattice.shell_mm} mm shell, ${lattice.cell_mm} mm cells. Functional preserve: ${functional}. Heuristic pattern — not FEA / MechStyle.`;
}

export function formatLatticePromptHint(lattice?: CadLattice | null): string {
  if (!lattice) return "";
  if (lattice.refused) {
    return [
      `Lattice was refused. Do not cut through holes, joints, or mating faces. Keep the current functional CSG.`,
      lattice.refuse_reason ?? "",
      JSON.stringify({
        refused: true,
        functional_regions: lattice.functional_regions,
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Lattice is heuristic infill-as-geometry (honeycomb / cubic / gyroid-ish / diagonal). Not FEA.`,
    `Keep a ${lattice.shell_mm} mm outer shell. Do not lattice through holes/joints/mating faces. One piece first.`,
    `Difference hex/cube/cylinder voids from the inset interior, then re-cut functional bores.`,
    JSON.stringify(lattice),
  ].join("\n");
}

function latticeVoidModule(pattern: LatticePattern): string {
  if (pattern === "cubic") {
    return `module lattice_voids(sx, sy, sz) {
  pitch = cell_mm + strut_mm;
  void = cell_mm;
  for (x = [0 : pitch : sx + pitch])
    for (y = [0 : pitch : sy + pitch])
      for (z = [0 : pitch : sz + pitch])
        translate([x, y, z]) cube(void, center = false);
}`;
  }
  if (pattern === "diagonal") {
    return `module lattice_voids(sx, sy, sz) {
  pitch = cell_mm + strut_mm;
  d = max(cell_mm - strut_mm, 2.4);
  for (x = [-sz : pitch : sx + sz])
    for (z = [0 : pitch : sz + pitch])
      translate([x, -1, z]) rotate([0, 45, 0]) cylinder(h = sy + sz + 4, d = d);
  for (y = [-sz : pitch : sy + sz])
    for (z = [pitch / 2 : pitch : sz + pitch])
      translate([-1, y, z]) rotate([0, 0, 45]) rotate([0, 90, 0]) cylinder(h = sx + sz + 4, d = d);
}`;
  }
  if (pattern === "gyroid") {
    return `module lattice_voids(sx, sy, sz) {
  // Gyroid-ish: hex layers offset each step — not a TPMS field.
  pitch_x = cell_mm + strut_mm;
  pitch_y = pitch_x * 0.866;
  layer = max(strut_mm + 1.2, cell_mm * 0.55);
  for (iz = [0 : 1 : floor(sz / layer) + 1]) {
    odd = iz % 2;
    for (iy = [0 : 1 : floor(sy / pitch_y) + 2])
      for (ix = [0 : 1 : floor(sx / pitch_x) + 2])
        translate([
          (ix + (iy % 2) * 0.5 + odd * 0.25) * pitch_x,
          iy * pitch_y,
          iz * layer
        ])
          rotate([0, 0, 30])
            cylinder(h = layer * 0.72, d = cell_mm, $fn = 6);
  }
}`;
  }
  return `module lattice_voids(sx, sy, sz) {
  pitch_x = cell_mm + strut_mm;
  pitch_y = pitch_x * 0.866;
  for (iy = [0 : 1 : floor(sy / pitch_y) + 2])
    for (ix = [0 : 1 : floor(sx / pitch_x) + 2])
      translate([(ix + (iy % 2) * 0.5) * pitch_x, iy * pitch_y, -1])
        rotate([0, 0, 30])
          cylinder(h = sz + 2, d = cell_mm, $fn = 6);
}`;
}

function latticeCutterCall(sx = "size", sy = "size", sz = "size"): string {
  return `intersection() {
    translate([shell_mm, shell_mm, shell_mm])
      cube([${sx} - 2 * shell_mm, ${sy} - 2 * shell_mm, ${sz} - 2 * shell_mm]);
    lattice_voids(${sx}, ${sy}, ${sz});
  }`;
}

export function cubeLatticeScad(
  pattern: LatticePattern = "honeycomb",
  size = 20,
  hole?: number,
  shellMm = nozzleAwareShellMm(),
  cellMm?: number,
): string {
  const shell = nozzleAwareShellMm(shellMm);
  const strut = clampLatticeStrutMm();
  const cell = clampLatticeCellMm(cellMm, [size, size, size], shell);
  const holeLine = hole && hole > 0 ? `hole_d = ${fmt(hole)};` : "";
  const holeKeeper =
    hole && hole > 0
      ? `  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d + 2 * shell_mm);`
      : "";
  const holeCut =
    hole && hole > 0
      ? `  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);`
      : "";
  const cutter = hole && hole > 0
    ? `difference() {
    ${latticeCutterCall()}
${holeKeeper}
  }`
    : latticeCutterCall();
  return `// Fixture: ${pattern} lattice cube (mm) — solid shell, interior pattern
// Heuristic infill-as-geometry. Not FEA / MechStyle. Shell ≥ ${shell} mm.
$fn = 24;
size = ${fmt(size)};
shell_mm = ${fmt(shell)};
cell_mm = ${fmt(cell)};
strut_mm = ${fmt(strut)};
${holeLine}

${latticeVoidModule(pattern)}

module host() {
  cube(size, center = false);
}

difference() {
  host();
  ${cutter}
${holeCut}
}
`;
}

export function phoneStandHoneycombScad(tilt = 60): string {
  const shell = nozzleAwareShellMm();
  const strut = clampLatticeStrutMm();
  const cell = 8;
  return `// Fixture: lightweight phone stand with honeycomb (mm)
// Interior honeycomb in a thickened base/back; solid lip + cable slot.
// Heuristic pattern — not FEA / MechStyle. Shell ≥ ${shell} mm. One piece.
$fn = 24;
phone_w = 76;
tilt = ${fmt(tilt)};
base_d = 78;
base_t = 12;
back_h = 90;
back_t = 12;
lip = 10;
cable = 14;
shell_mm = ${fmt(shell)};
cell_mm = ${fmt(cell)};
strut_mm = ${fmt(strut)};

${latticeVoidModule("honeycomb")}

module latticed_box(sx, sy, sz) {
  difference() {
    cube([sx, sy, sz]);
    intersection() {
      translate([shell_mm, shell_mm, shell_mm])
        cube([sx - 2 * shell_mm, sy - 2 * shell_mm, sz - 2 * shell_mm]);
      lattice_voids(sx, sy, sz);
    }
  }
}

module cable_keeper() {
  translate([phone_w / 2 - cable / 2 - shell_mm, -1, -1])
    cube([cable + 2 * shell_mm, 18 + shell_mm, base_t + 2]);
}

module stand_body() {
  union() {
    difference() {
      latticed_box(phone_w, base_d, base_t);
      cable_keeper();
    }
    translate([0, 16, base_t])
      rotate([-tilt, 0, 0])
        latticed_box(phone_w, back_t, back_h);
    translate([0, 10, base_t])
      cube([phone_w, lip, 12]);
  }
}

difference() {
  stand_body();
  translate([phone_w / 2 - cable / 2, -1, -1])
    cube([cable, 16, 20]);
}
`;
}

export function latticeFixtureScad(
  pattern: LatticePattern,
  kind: "cube" | "phone-stand",
  size = 20,
  hole?: number,
  tilt = 60,
): string {
  if (kind === "phone-stand") return phoneStandHoneycombScad(tilt);
  return cubeLatticeScad(pattern, size, hole);
}

export function isPhoneStandLatticePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return promptHasLattice(text) && (/\bphone stand\b/.test(text) || (/\bphone\b/.test(text) && /\bstand\b/.test(text)) || /\biphone\b/.test(text));
}

export function isCubeLatticePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return promptHasLattice(text) && /\bcube\b/.test(text);
}

export function isLatticeFollowUp(prompt: string): boolean {
  return promptHasLattice(prompt);
}

export function latticeFixtureId(pattern: LatticePattern, kind: "cube" | "phone-stand"): string {
  if (kind === "phone-stand") return "phone-stand-honeycomb";
  return `cube-lattice-${pattern}`;
}

export function latticeFixtureTitle(pattern: LatticePattern, kind: "cube" | "phone-stand"): string {
  if (kind === "phone-stand") return "Lightweight phone stand (honeycomb)";
  return `Cube with ${pattern} lattice`;
}

/** Inset-bbox lattice voids for an imported host. Hole keepers stay around bores. */
export function importedLatticeCutters(
  lattice: CadLattice,
  box: { min: [number, number, number]; size: [number, number, number] },
  holeMm?: number,
): string {
  if (!lattice.applied || lattice.refused) return "";
  const [minx, miny, minz] = box.min;
  const [sx, sy, sz] = box.size;
  const innerX = Math.max(0.8, sx - 2 * lattice.shell_mm);
  const innerY = Math.max(0.8, sy - 2 * lattice.shell_mm);
  const innerZ = Math.max(0.8, sz - 2 * lattice.shell_mm);
  if (innerX < lattice.strut_mm + 2 || innerY < lattice.strut_mm + 2 || innerZ < lattice.strut_mm + 2) {
    return "";
  }
  const keeper =
    holeMm && holeMm > 0
      ? `difference() {
    intersection() {
      translate([${fmt(minx + lattice.shell_mm)}, ${fmt(miny + lattice.shell_mm)}, ${fmt(minz + lattice.shell_mm)}])
        cube([${fmt(innerX)}, ${fmt(innerY)}, ${fmt(innerZ)}]);
      translate([${fmt(minx)}, ${fmt(miny)}, ${fmt(minz)}])
        lattice_voids(${fmt(sx)}, ${fmt(sy)}, ${fmt(sz)});
    }
    translate([${fmt(minx + sx / 2)}, ${fmt(miny + sy / 2)}, ${fmt(minz - 1)}])
      cylinder(h = ${fmt(sz + 2)}, d = ${fmt(holeMm + 2 * lattice.shell_mm)});
  }`
      : `intersection() {
    translate([${fmt(minx + lattice.shell_mm)}, ${fmt(miny + lattice.shell_mm)}, ${fmt(minz + lattice.shell_mm)}])
      cube([${fmt(innerX)}, ${fmt(innerY)}, ${fmt(innerZ)}]);
    translate([${fmt(minx)}, ${fmt(miny)}, ${fmt(minz)}])
      lattice_voids(${fmt(sx)}, ${fmt(sy)}, ${fmt(sz)});
  }`;
  return keeper;
}

export function importedLatticeModules(lattice: CadLattice): string {
  if (!lattice.applied || lattice.refused) return "";
  return [
    `shell_mm = ${fmt(lattice.shell_mm)};`,
    `cell_mm = ${fmt(lattice.cell_mm)};`,
    `strut_mm = ${fmt(lattice.strut_mm)};`,
    latticeVoidModule(lattice.pattern),
  ].join("\n");
}
