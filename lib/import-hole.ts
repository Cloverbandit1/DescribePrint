import { boundingBoxMm } from "./mesh-check";
import { printRules } from "./printability";
import {
  inferCadReliefs,
  promptHasRelief,
  reliefMotifScad,
  type CadRelief,
} from "./relief";
import { IMPORTED_MESH_FILENAME } from "./sanitize";
import type { BoundingBoxMm, Mesh } from "./types";

export type HoleAxis = "x" | "y" | "z";
export type HoleFace = "left" | "right" | "front" | "back" | "top" | "base";

export type ImportHoleSpec = {
  diameterMm: number;
  through: boolean;
  axis: HoleAxis;
  /** Hole center in mesh coordinates (mm). */
  centerMm: [number, number, number];
  /** Blind-hole entry face; ignored for through-holes. */
  entryFace: HoleFace;
  depthMm: number;
  overshootMm: number;
  notes: string[];
};

export type ImportedWrapDiagnosis = {
  hasImport: boolean;
  hasDifference: boolean;
  invertedDifference: boolean;
  floatingCutter: boolean;
  fromScratch: boolean;
};

const OVERSHOOT_MM = 1;
const DEFAULT_HOLE_MM = 5;
const TAB_W = 12;
const TAB_D = 16;
const TAB_H = 3;

const HOLE_WORD = /\b(holes?|bores?|through-holes?)\b/i;
const BLIND = /\b(blind|pocket|stopped|partial(?:ly)?(?:\s+through)?)\b/i;
const COMPLEX_WRAP =
  /\b(slot|slit|fillet|chamfer|thicken|remesh|boolean)\b/i;

/** Hole/tab/relief wraps we can emit as deterministic CSG — no LLM rewrite. */
export function canBuildDeterministicImportWrap(
  prompt: string,
  hole: ImportHoleSpec | null,
  addTab: boolean,
  reliefs?: CadRelief[] | null,
): boolean {
  if (COMPLEX_WRAP.test(prompt)) return false;
  return hole !== null || addTab || Boolean(reliefs?.length) || promptHasRelief(prompt);
}

function numberAt(source: string, re: RegExp): number | null {
  const match = source.match(re);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function stripComments(code: string): string {
  return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Largest face normal; Z wins ties so the plate-stable face is preferred. */
export function defaultThroughAxis(sizeMm: [number, number, number]): HoleAxis {
  const [sx, sy, sz] = sizeMm;
  const faces: { axis: HoleAxis; area: number; tie: number }[] = [
    { axis: "z", area: sx * sy, tie: 0 },
    { axis: "y", area: sx * sz, tie: 1 },
    { axis: "x", area: sy * sz, tie: 2 },
  ];
  faces.sort((a, b) => b.area - a.area || a.tie - b.tie);
  return faces[0]?.axis ?? "z";
}

function axisFromPrompt(text: string): HoleAxis | null {
  if (/\bthrough the (?:front|back)\b/i.test(text) || /\balong y\b|\by[- ]axis\b/i.test(text)) return "y";
  if (/\bthrough the (?:left|right|side)\b/i.test(text) || /\balong x\b|\bx[- ]axis\b/i.test(text)) return "x";
  if (/\bthrough the (?:top|bottom|plate|bed)\b/i.test(text) || /\balong z\b|\bz[- ]axis\b|\bvertical\b/i.test(text)) {
    return "z";
  }
  if (/\bhorizontal\b/i.test(text)) return "y";
  if (/\b(?:front|back)\b/i.test(text) && HOLE_WORD.test(text)) return "y";
  if (/\b(?:left|right|side)\b/i.test(text) && HOLE_WORD.test(text)) return "x";
  return null;
}

function entryFaceFromPrompt(text: string, axis: HoleAxis): HoleFace {
  if (/\bfrom the (?:top|above)\b/i.test(text)) return "top";
  if (/\bfrom the (?:base|bottom|plate|bed)\b/i.test(text)) return "base";
  if (/\bfrom the (?:front|face)\b/i.test(text)) return "front";
  if (/\bfrom the (?:back|rear)\b/i.test(text)) return "back";
  if (/\bfrom the left\b/i.test(text)) return "left";
  if (/\bfrom the right\b/i.test(text)) return "right";
  if (axis === "x") return /\bright\b/i.test(text) ? "right" : "left";
  if (axis === "y") return /\bback\b/i.test(text) ? "back" : "front";
  return /\bbase|bottom|plate|bed\b/i.test(text) ? "base" : "top";
}

function applyFaceOffset(
  center: [number, number, number],
  box: BoundingBoxMm,
  face: HoleFace,
  offsetMm: number,
  axis: HoleAxis,
): [number, number, number] {
  const [minx, miny, minz] = box.min;
  const [maxx, maxy, maxz] = box.max;
  const next: [number, number, number] = [...center];
  const clampOffAxis = (dim: 0 | 1 | 2, value: number) => {
    if ((dim === 0 && axis === "x") || (dim === 1 && axis === "y") || (dim === 2 && axis === "z")) {
      return;
    }
    next[dim] = value;
  };
  switch (face) {
    case "left":
      clampOffAxis(0, minx + offsetMm);
      break;
    case "right":
      clampOffAxis(0, maxx - offsetMm);
      break;
    case "back":
      clampOffAxis(1, miny + offsetMm);
      break;
    case "front":
      clampOffAxis(1, maxy - offsetMm);
      break;
    case "base":
      clampOffAxis(2, minz + offsetMm);
      break;
    case "top":
      clampOffAxis(2, maxz - offsetMm);
      break;
    default:
      break;
  }
  return next;
}

function inPlaneExtents(size: [number, number, number], axis: HoleAxis): [number, number] {
  if (axis === "x") return [size[1], size[2]];
  if (axis === "y") return [size[0], size[2]];
  return [size[0], size[1]];
}

function axisLength(size: [number, number, number], axis: HoleAxis): number {
  return axis === "x" ? size[0] : axis === "y" ? size[1] : size[2];
}

export function parseImportHoleSpec(
  prompt: string,
  box: BoundingBoxMm,
  holeMm?: number | null,
): ImportHoleSpec | null {
  const text = prompt.trim();
  const stated =
    holeMm ??
    numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore|id)\b/i) ??
    numberAt(text, /(?:hole|bore)\s+(?:of\s+)?(\d+(?:\.\d+)?)/i);
  const mentionsHole = HOLE_WORD.test(text) || stated !== null;
  if (!mentionsHole) return null;

  const rules = printRules();
  const notes: string[] = [];
  let diameterMm = stated ?? DEFAULT_HOLE_MM;
  if (stated === null) {
    notes.push(`No hole size given — using ${DEFAULT_HOLE_MM} mm.`);
  }
  if (diameterMm < rules.minHoleMm && !stated) {
    diameterMm = rules.minHoleMm;
  }

  const through = !BLIND.test(text);
  const inferredAxis = axisFromPrompt(text);
  const axis = inferredAxis ?? defaultThroughAxis(box.size);
  if (!inferredAxis) {
    notes.push(`Default ${through ? "through-cut" : "blind hole"} on the largest/stable face (axis ${axis.toUpperCase()}).`);
  }

  const [minx, miny, minz] = box.min;
  const [sx, sy, sz] = box.size;
  let centerMm: [number, number, number] = [minx + sx / 2, miny + sy / 2, minz + sz / 2];

  const fromMatch = text.match(
    /(\d+(?:\.\d+)?)\s*mm\s+from the (base|bottom|plate|bed|top|left|right|front|back|rear)\b/i,
  );
  if (fromMatch) {
    const offset = Number(fromMatch[1]);
    const raw = (fromMatch[2] ?? "base").toLowerCase();
    const face: HoleFace =
      raw === "bottom" || raw === "plate" || raw === "bed"
        ? "base"
        : raw === "rear"
          ? "back"
          : (raw as HoleFace);
    if (Number.isFinite(offset) && offset >= 0) {
      centerMm = applyFaceOffset(centerMm, box, face, offset, axis);
      notes.push(`Placed ${offset} mm from the ${face}.`);
    }
  } else if (/\bcenter(?:ed|ing)?\b/i.test(text) || /\bmiddle\b/i.test(text)) {
    notes.push("Centered on the cut face.");
  }

  const [faceA, faceB] = inPlaneExtents(box.size, axis);
  const maxDiameter = Math.min(faceA, faceB) - 2 * rules.minWallMm;
  if (maxDiameter >= rules.minHoleMm && diameterMm > maxDiameter) {
    notes.push(
      `Clamped hole from ${diameterMm} mm to ${maxDiameter.toFixed(1)} mm so walls stay ≥ ${rules.minWallMm} mm.`,
    );
    diameterMm = Math.round(maxDiameter * 10) / 10;
  }

  const span = axisLength(box.size, axis);
  const statedDepth =
    numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:deep|depth)\b/i) ??
    numberAt(text, /(?:depth|deep(?:th)?)\s+(?:of\s+)?(\d+(?:\.\d+)?)/i);
  let depthMm = statedDepth ?? Math.max(rules.minWallMm, span * 0.5);
  const maxBlind = Math.max(rules.minFeatureMm, span - rules.minWallMm);
  if (!through && depthMm > maxBlind) {
    depthMm = maxBlind;
    notes.push(`Blind depth limited to ${depthMm.toFixed(1)} mm so the far wall stays printable.`);
  }
  if (through) {
    notes.push(`Through-hole ${diameterMm} mm along ${axis.toUpperCase()} (cutter overshoots ${OVERSHOOT_MM} mm).`);
  } else {
    notes.push(`Blind hole ${diameterMm} mm × ${depthMm.toFixed(1)} mm along ${axis.toUpperCase()}.`);
  }

  return {
    diameterMm,
    through,
    axis,
    centerMm,
    entryFace: entryFaceFromPrompt(text, axis),
    depthMm,
    overshootMm: OVERSHOOT_MM,
    notes,
  };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

function holeCutter(spec: ImportHoleSpec, box: BoundingBoxMm): string {
  const [minx, miny, minz] = box.min;
  const [maxx, maxy, maxz] = box.max;
  const [sx, sy, sz] = box.size;
  const [cx, cy, cz] = spec.centerMm;
  const o = spec.overshootMm;

  if (spec.through) {
    if (spec.axis === "z") {
      return `translate([${fmt(cx)}, ${fmt(cy)}, ${fmt(minz - o)}])\n    cylinder(h = ${fmt(sz + 2 * o)}, d = hole_d);`;
    }
    if (spec.axis === "x") {
      return `translate([${fmt(minx - o)}, ${fmt(cy)}, ${fmt(cz)}])\n    rotate([0, 90, 0])\n      cylinder(h = ${fmt(sx + 2 * o)}, d = hole_d);`;
    }
    return `translate([${fmt(cx)}, ${fmt(miny - o)}, ${fmt(cz)}])\n    rotate([-90, 0, 0])\n      cylinder(h = ${fmt(sy + 2 * o)}, d = hole_d);`;
  }

  const depth = spec.depthMm;
  if (spec.axis === "z") {
    if (spec.entryFace === "base") {
      return `translate([${fmt(cx)}, ${fmt(cy)}, ${fmt(minz - o)}])\n    cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
    }
    return `translate([${fmt(cx)}, ${fmt(cy)}, ${fmt(maxz - depth)}])\n    cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
  }
  if (spec.axis === "x") {
    if (spec.entryFace === "right") {
      return `translate([${fmt(maxx - depth)}, ${fmt(cy)}, ${fmt(cz)}])\n    rotate([0, 90, 0])\n      cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
    }
    return `translate([${fmt(minx - o)}, ${fmt(cy)}, ${fmt(cz)}])\n    rotate([0, 90, 0])\n      cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
  }
  if (spec.entryFace === "back") {
    return `translate([${fmt(cx)}, ${fmt(miny - o)}, ${fmt(cz)}])\n    rotate([-90, 0, 0])\n      cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
  }
  return `translate([${fmt(cx)}, ${fmt(maxy - depth)}, ${fmt(cz)}])\n    rotate([-90, 0, 0])\n      cylinder(h = ${fmt(depth + o)}, d = hole_d);`;
}

export function buildImportedMeshWrapper(input: {
  mesh: Mesh;
  hole?: ImportHoleSpec | null;
  addTab?: boolean;
  reliefs?: CadRelief[] | null;
  prompt?: string;
}): string {
  const box = boundingBoxMm(input.mesh);
  const [minx, miny, minz] = box.min;
  const [sx, sy] = box.size;
  const cy = miny + sy / 2;
  const hole = input.hole;
  const reliefs =
    input.reliefs?.length
      ? input.reliefs
      : input.prompt
        ? inferCadReliefs(input.prompt, box.size)
        : [];
  const lines = [
    "// DescribePrint imported-mesh wrapper (mm)",
    "$fn = 64;",
  ];
  if (hole) {
    lines.push(`hole_d = ${fmt(hole.diameterMm)};`);
    lines.push(`hole_through = ${hole.through};`);
  }
  if (input.addTab) {
    lines.push(`tab_w = ${TAB_W};`);
    lines.push(`tab_d = ${TAB_D};`);
    lines.push(`tab_h = ${TAB_H};`);
  }
  if (reliefs.length) {
    const first = reliefs[0];
    lines.push(`// relief: ${first?.kind} ${first?.motif} on ${first?.region}`);
    lines.push(`relief_extent = ${fmt(first?.kind === "etch" ? first.depth_mm : first?.height_mm ?? 0.8)};`);
  }

  const host = `import("${IMPORTED_MESH_FILENAME}", convexity = 10);`;
  const etchReliefs = reliefs.filter((relief) => relief.kind === "etch");
  const embossReliefs = reliefs.filter((relief) => relief.kind === "emboss");
  const etchCutter = etchReliefs.map((relief) => reliefMotifScad(relief, box)).join("\n  ");
  const embossBody = embossReliefs.map((relief) => reliefMotifScad(relief, box)).join("\n  ");
  const holeBlock =
    hole &&
    `difference() {
  ${host}
  ${holeCutter(hole, box)}
}`;
  const etchedHost = etchCutter
    ? `difference() {
  ${holeBlock ?? host}
  ${etchCutter}
}`
    : holeBlock ?? host;
  const tabBlock = `translate([${fmt(minx + sx)}, ${fmt(cy - TAB_D / 2)}, ${fmt(minz)}])
    cube([tab_w, tab_d, tab_h]);`;
  const extras = [input.addTab ? tabBlock : "", embossBody].filter(Boolean);

  if (extras.length) {
    lines.push(`union() {
  ${etchedHost}
  ${extras.join("\n  ")}
}`);
  } else {
    lines.push(etchedHost);
  }
  return lines.join("\n");
}

const FIRST_SOLID =
  /\b(import|cylinder|cube|sphere|polyhedron|hull|minkowski|union|intersection|linear_extrude|rotate_extrude)\s*\(/i;

export function diagnoseImportedWrap(code: string): ImportedWrapDiagnosis {
  const stripped = stripComments(code);
  const hasImport = /import\s*\(\s*"imported\.stl"/i.test(stripped);
  const hasDifference = /\bdifference\s*\(/.test(stripped);
  const hasCutter = /\b(cylinder|cube)\s*\(/.test(stripped);
  let invertedDifference = false;
  const diff = stripped.match(/difference\s*\(\s*\)\s*\{([\s\S]*)/);
  if (diff?.[1]) {
    const first = diff[1].match(FIRST_SOLID);
    const name = first?.[1]?.toLowerCase();
    if (name && name !== "import") invertedDifference = true;
  }
  return {
    hasImport,
    hasDifference,
    invertedDifference,
    floatingCutter: hasImport && hasCutter && !hasDifference,
    fromScratch: !hasImport && /\b(cube|sphere|cylinder|polyhedron)\s*\(/.test(stripped),
  };
}

export function importedWrapErrors(
  code: string,
  opts: { requireHoleDifference?: boolean; allowUnionedRelief?: boolean } = {},
): string[] {
  const d = diagnoseImportedWrap(code);
  const errors: string[] = [];
  if (!d.hasImport || d.fromScratch) {
    errors.push('Imported-mesh edits must keep import("imported.stl") as the host solid — do not rebuild a from-scratch part');
  }
  if (d.invertedDifference) {
    errors.push("difference() is inverted: import(\"imported.stl\") must be the first child, cutter second");
  }
  if (d.floatingCutter && !opts.allowUnionedRelief) {
    errors.push("Hole cutters must be inside difference() — do not union a floating cylinder onto the import");
  }
  if (opts.requireHoleDifference && d.hasImport && !d.hasDifference) {
    errors.push("Holes must difference() the imported solid (through-cut unless a blind hole was requested)");
  }
  return errors;
}

export function formatHoleSpecForPrompt(spec: ImportHoleSpec, box: BoundingBoxMm): string {
  const [cx, cy, cz] = spec.centerMm;
  return [
    `Hole spec (engineering wrap — follow this, do not invent a new part):`,
    `- diameter_mm: ${spec.diameterMm}`,
    `- through: ${spec.through}`,
    `- axis: ${spec.axis}`,
    `- center_mm: [${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)}]`,
    `- bbox_min: [${box.min.map((n) => n.toFixed(2)).join(", ")}] bbox_size: [${box.size.map((n) => n.toFixed(2)).join(", ")}]`,
    `- cutter overshoot: ${spec.overshootMm} mm on through-holes`,
    `- import("imported.stl", convexity = 10) is the FIRST child of difference(); cylinder/cube cutter is second.`,
  ].join("\n");
}
