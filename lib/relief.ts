import { printRules } from "./printability";
import type { BoundingBoxMm } from "./types";

/** Raised (union onto a face) vs recessed (difference into a face). */
export type ReliefKind = "emboss" | "etch";

/** Honest primitive motifs — no Style2Fab / fonts / neural stylization. */
export type ReliefMotifKind = "text" | "crest" | "disc" | "bar";

/**
 * Face the relief sits on. Part sits on z=0, +Z up, +X right.
 *
 * | Region | Face | Outward |
 * | --- | --- | --- |
 * | front (default) | +Y | +Y |
 * | back | −Y | −Y |
 * | left | −X | −X |
 * | right | +X | +X |
 * | top | +Z | +Z |
 * | bottom | −Z | −Z |
 *
 * Unspecified region → **largest vertical face**, ties go to **front** (+Y).
 */
export type ReliefRegion = "front" | "back" | "left" | "right" | "top" | "bottom";

export type CadRelief = {
  kind: ReliefKind;
  motif: ReliefMotifKind;
  /** Initials or short label for motif=text (no OpenSCAD text()). */
  text?: string;
  region: ReliefRegion;
  /** Raised height (emboss). */
  height_mm: number;
  /** Recessed depth (etch). */
  depth_mm: number;
  notes?: string;
};

/** Visible at 1× 0.4 mm nozzle. */
export const MIN_RELIEF_MM = 0.4;
/** Default raised height — two 0.4 mm layers, enough to see, not a blade. */
export const DEFAULT_EMBOSS_HEIGHT_MM = 0.8;
/** Default etch depth — visible recess that usually leaves #11 1.6 mm walls. */
export const DEFAULT_ETCH_DEPTH_MM = 0.6;
/** Cap raised height so the motif stays a surface detail. */
export const MAX_EMBOSS_HEIGHT_MM = 2.0;
/** Cap etch so a solid host is never gouged into a cavity. */
export const MAX_ETCH_DEPTH_MM = 1.2;
export const DEFAULT_RELIEF_REGION: ReliefRegion = "front";
export const DEFAULT_INITIALS = "DP";
export const RELIEF_OVERSHOOT_MM = 0.2;

export const HELMET_EMBOSS_PROMPT = "helmet with embossed crest on the back";
export const CUBE_ETCH_PROMPT = "20mm cube with etched initials on the front";

const RELIEF_WORD =
  /\b(emboss(?:ed|ing)?|etch(?:ed|ing)?|engrav(?:e|ed|ing)|recess(?:ed|ing)?|raised|relief|crest|initials?|monogram)\b/i;

export function promptHasRelief(prompt: string): boolean {
  return RELIEF_WORD.test(prompt);
}

export function defaultReliefRegion(sizeMm?: [number, number, number] | null): ReliefRegion {
  if (!sizeMm) return DEFAULT_RELIEF_REGION;
  const [sx, sy, sz] = sizeMm;
  const frontArea = sx * sz;
  const sideArea = sy * sz;
  if (sideArea > frontArea + 0.05) return "right";
  return "front";
}

export function hostThicknessAlongRegion(
  sizeMm: [number, number, number] | null | undefined,
  region: ReliefRegion,
): number | undefined {
  if (!sizeMm) return undefined;
  if (region === "left" || region === "right") return sizeMm[0];
  if (region === "front" || region === "back") return sizeMm[1];
  return sizeMm[2];
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

export function inferShellThicknessMm(prompt: string): number | undefined {
  const stated = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+walls?\b/i);
  if (stated) {
    const n = Number(stated[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (/\b(helmet|mask|shell|armor|cuirass|hollow)\b/i.test(prompt)) return 2.4;
  return undefined;
}

/**
 * Print-aware depth: visible (≥ 0.4 mm) but etch never eats the #11 1.6 mm
 * remaining wall when host thickness is known.
 */
export function clampReliefExtentMm(
  kind: ReliefKind,
  requested: number | undefined,
  hostThicknessMm?: number | null,
  minWallMm = printRules().minWallMm,
): number {
  if (kind === "emboss") {
    const raw = requested && requested > 0 ? requested : DEFAULT_EMBOSS_HEIGHT_MM;
    return round1(clamp(raw, MIN_RELIEF_MM, MAX_EMBOSS_HEIGHT_MM));
  }
  const raw = requested && requested > 0 ? requested : DEFAULT_ETCH_DEPTH_MM;
  let maxSafe = MAX_ETCH_DEPTH_MM;
  if (hostThicknessMm && hostThicknessMm > 0) {
    const remain = hostThicknessMm - minWallMm;
    if (remain >= MIN_RELIEF_MM) {
      maxSafe = Math.min(MAX_ETCH_DEPTH_MM, remain);
    } else {
      maxSafe = MIN_RELIEF_MM;
    }
  }
  return round1(clamp(raw, MIN_RELIEF_MM, maxSafe));
}

export function parseReliefRegion(raw: unknown): ReliefRegion | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!text) return undefined;
  if (/\b(back|rear)\b/.test(text)) return "back";
  if (/\b(front|face|visor)\b/.test(text)) return "front";
  if (/\bleft\b/.test(text)) return "left";
  if (/\bright\b/.test(text)) return "right";
  if (/\b(top|lid|crown)\b/.test(text)) return "top";
  if (/\b(bottom|base|bed|plate)\b/.test(text)) return "bottom";
  return undefined;
}

export function parseReliefKind(raw: unknown): ReliefKind | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (/\b(etch|engrav|recess|carv|intaglio|deboss)\b/.test(text)) return "etch";
  if (/\b(emboss|raised|relief|cameo)\b/.test(text)) return "emboss";
  return undefined;
}

export function parseReliefMotif(raw: unknown): ReliefMotifKind | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (/\b(crest|shield|logo|chevron)\b/.test(text)) return "crest";
  if (/\b(disc|disk|dot|circle|coin)\b/.test(text)) return "disc";
  if (/\b(bar|stripe|dash)\b/.test(text)) return "bar";
  if (/\b(text|letter|initial|word|monogram|glyph)\b/.test(text)) return "text";
  return undefined;
}

const INITIALS_STOP =
  /^(the|and|on|in|of|to|for|at|front|back|left|right|top|face|rear|init|letter|text|logo|from|with)$/i;

export function initialsFromPrompt(prompt: string): string | undefined {
  const quoted = prompt.match(/["“']([A-Za-z0-9]{1,4})["”']/);
  if (quoted?.[1]) return quoted[1].toUpperCase();
  const labeled = prompt.match(
    /\b(?:initials?|letters?|monogram|text)\s+(?:of\s+|is\s+|are\s+)?([A-Za-z]{1,4})\b/i,
  );
  if (labeled?.[1] && !INITIALS_STOP.test(labeled[1])) return labeled[1].toUpperCase();
  const etched = prompt.match(/\b(?:etched?|engraved?|embossed?)\s+([A-Za-z]{2,4})\b/i);
  if (etched?.[1] && !INITIALS_STOP.test(etched[1])) return etched[1].toUpperCase();
  return undefined;
}

function statedExtentMm(prompt: string, kind: ReliefKind): number | undefined {
  const labeled =
    kind === "emboss"
      ? prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:high|tall|raised|emboss(?:ed)?|relief)\b/i)
      : prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:deep|depth|etch(?:ed)?|recess(?:ed)?|engrav(?:ed|e))\b/i);
  if (labeled) {
    const n = Number(labeled[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

export function inferCadReliefs(
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  if (!promptHasRelief(prompt)) return [];
  const kind =
    parseReliefKind(prompt) ??
    (/\b(initials?|letters?|text|monogram)\b/i.test(prompt) ? "etch" : "emboss");
  const motif =
    parseReliefMotif(prompt) ??
    (/\b(helmet|crest|logo)\b/i.test(prompt) ? "crest" : /\b(initials?|letters?|text|monogram)\b/i.test(prompt) ? "text" : "bar");
  const region = parseReliefRegion(prompt) ?? defaultReliefRegion(sizeMm);
  const shell = inferShellThicknessMm(prompt);
  const host = shell ?? hostThicknessAlongRegion(sizeMm, region);
  const height_mm = clampReliefExtentMm("emboss", kind === "emboss" ? statedExtentMm(prompt, "emboss") : undefined, host);
  const depth_mm = clampReliefExtentMm("etch", kind === "etch" ? statedExtentMm(prompt, "etch") : undefined, host);
  const text = motif === "text" ? initialsFromPrompt(prompt) ?? DEFAULT_INITIALS : undefined;
  const notes = [
    region === (parseReliefRegion(prompt) ?? undefined)
      ? undefined
      : `Region defaulted to ${region} (largest vertical face; ties use front / +Y).`,
    kind === "etch"
      ? `Etch depth ${depth_mm} mm (visible, remaining wall ≥ ${printRules().minWallMm} mm when host thickness is known).`
      : `Emboss height ${height_mm} mm (raised, does not thin the host wall).`,
  ].filter(Boolean) as string[];
  return [
    {
      kind,
      motif,
      text,
      region,
      height_mm,
      depth_mm,
      notes: notes.join(" ") || undefined,
    },
  ];
}

export function parseCadReliefs(raw: unknown): CadRelief[] {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const rec = item as Record<string, unknown>;
    const kind =
      parseReliefKind(rec.kind ?? rec.type ?? rec.mode) ??
      (asFiniteNumber(rec.depth_mm) && !asFiniteNumber(rec.height_mm) ? "etch" : "emboss");
    const motif =
      parseReliefMotif(rec.motif ?? rec.shape ?? rec.kind ?? rec.name) ??
      (asString(rec.text) || asString(rec.initials) || asString(rec.letters) ? "text" : "bar");
    const region = parseReliefRegion(rec.region ?? rec.face ?? rec.side) ?? DEFAULT_RELIEF_REGION;
    const text = asString(rec.text) ?? asString(rec.initials) ?? asString(rec.letters);
    const height = asFiniteNumber(rec.height_mm) ?? asFiniteNumber(rec.height);
    const depth = asFiniteNumber(rec.depth_mm) ?? asFiniteNumber(rec.depth);
    return [
      {
        kind,
        motif,
        text: text ? text.toUpperCase().slice(0, 4) : undefined,
        region,
        height_mm: height && height > 0 ? height : DEFAULT_EMBOSS_HEIGHT_MM,
        depth_mm: depth && depth > 0 ? depth : DEFAULT_ETCH_DEPTH_MM,
        notes: asString(rec.notes),
      },
    ];
  });
}

export function normalizeCadReliefs(
  reliefs: CadRelief[],
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  if (!promptHasRelief(prompt)) return [];
  const inferred = inferCadReliefs(prompt, sizeMm);
  const typed = reliefs.length ? reliefs : inferred;
  const fallback = inferred[0];
  return typed.map((relief) => {
    const kind = parseReliefKind(prompt) ?? relief.kind;
    const region = parseReliefRegion(prompt) ?? relief.region ?? fallback?.region ?? defaultReliefRegion(sizeMm);
    const motif = parseReliefMotif(prompt) ?? relief.motif ?? fallback?.motif ?? "bar";
    const shell = inferShellThicknessMm(prompt);
    const host = shell ?? hostThicknessAlongRegion(sizeMm, region);
    const stated = statedExtentMm(prompt, kind);
    const height_mm = clampReliefExtentMm("emboss", kind === "emboss" ? stated ?? relief.height_mm : relief.height_mm, host);
    const depth_mm = clampReliefExtentMm("etch", kind === "etch" ? stated ?? relief.depth_mm : relief.depth_mm, host);
    const text =
      motif === "text"
        ? (initialsFromPrompt(prompt) ?? relief.text ?? fallback?.text ?? DEFAULT_INITIALS).toUpperCase().slice(0, 4)
        : relief.text;
    return {
      kind,
      motif,
      text,
      region,
      height_mm,
      depth_mm,
      notes: relief.notes ?? fallback?.notes,
    };
  });
}

export function formatReliefConstraints(): string {
  return [
    `Raised etchings / emboss (only when the user asks for emboss, etch, engrave, crest, or initials):`,
    `- Honest CSG stub — not Style2Fab / neural stylization. Motifs are extruded primitives or block initials (no text() / fonts).`,
    `- Emboss = union a motif onto the named face (default height ${DEFAULT_EMBOSS_HEIGHT_MM} mm). Etch = difference a motif into that face (default depth ${DEFAULT_ETCH_DEPTH_MM} mm).`,
    `- Region default: largest vertical face; ties use front (+Y). back=−Y, left=−X, right=+X, top=+Z, bottom=−Z.`,
    `- Depth is print-aware: ≥ ${MIN_RELIEF_MM} mm (visible) and etch leaves ≥ ${printRules().minWallMm} mm remaining wall (#11) when host thickness is known. Max emboss ${MAX_EMBOSS_HEIGHT_MM} mm, max etch ${MAX_ETCH_DEPTH_MM} mm.`,
    `- Do not replace or destroy the host solid. Keep the base, then union/difference the motif.`,
  ].join("\n");
}

export function formatReliefNote(reliefs: CadRelief[]): string {
  if (!reliefs.length) return "";
  return reliefs
    .map((relief) => {
      const extent = relief.kind === "emboss" ? `${relief.height_mm} mm raised` : `${relief.depth_mm} mm recessed`;
      const motif =
        relief.motif === "text" ? `block initials “${relief.text ?? DEFAULT_INITIALS}”` : relief.motif;
      return `Relief stub: ${relief.kind} ${motif} on the ${relief.region} face (${extent}). Not Style2Fab.`;
    })
    .join(" ");
}

export function formatReliefPromptHint(reliefs: CadRelief[]): string {
  if (!reliefs.length) return "";
  return [
    `Relief: apply CSG without replacing the host. Emboss = union; etch = difference. Prefer primitive bars / crest / disc or block initials — avoid text() (no fonts).`,
    `Keep remaining walls ≥ ${printRules().minWallMm} mm. Region defaults: largest vertical face / front (+Y).`,
    JSON.stringify(reliefs),
  ].join("\n");
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

type FaceRect = { u: number; v: number; du: number; dv: number };

/** 5×7-ish stroke boxes for block initials (local u/v, origin bottom-left of the cell). */
const GLYPHS: Record<string, FaceRect[]> = {
  A: [
    [0, 0, 1.2, 8],
    [3.8, 0, 1.2, 8],
    [0, 6.6, 5, 1.4],
    [0, 3.2, 5, 1.3],
  ],
  B: [
    [0, 0, 1.3, 8],
    [0, 0, 4.2, 1.3],
    [0, 3.3, 4, 1.3],
    [0, 6.7, 4.2, 1.3],
    [3.4, 1.1, 1.3, 2.4],
    [3.4, 4.4, 1.3, 2.5],
  ],
  C: [
    [0, 0, 1.3, 8],
    [0, 0, 5, 1.3],
    [0, 6.7, 5, 1.3],
  ],
  D: [
    [0, 0, 1.3, 8],
    [0, 0, 4.2, 1.3],
    [0, 6.7, 4.2, 1.3],
    [3.5, 1.1, 1.4, 5.8],
  ],
  E: [
    [0, 0, 1.3, 8],
    [0, 0, 5, 1.3],
    [0, 3.3, 4.2, 1.3],
    [0, 6.7, 5, 1.3],
  ],
  F: [
    [0, 0, 1.3, 8],
    [0, 3.3, 4.2, 1.3],
    [0, 6.7, 5, 1.3],
  ],
  H: [
    [0, 0, 1.3, 8],
    [3.7, 0, 1.3, 8],
    [0, 3.3, 5, 1.4],
  ],
  I: [[1.85, 0, 1.3, 8]],
  L: [
    [0, 0, 1.3, 8],
    [0, 0, 5, 1.3],
  ],
  N: [
    [0, 0, 1.3, 8],
    [3.7, 0, 1.3, 8],
    [1.1, 2.2, 2.8, 1.6],
  ],
  O: [
    [0, 0, 1.3, 8],
    [3.7, 0, 1.3, 8],
    [0, 0, 5, 1.3],
    [0, 6.7, 5, 1.3],
  ],
  P: [
    [0, 0, 1.3, 8],
    [0, 3.4, 4.4, 1.3],
    [0, 6.7, 4.4, 1.3],
    [3.4, 3.4, 1.4, 4.6],
  ],
  R: [
    [0, 0, 1.3, 8],
    [0, 3.4, 4.4, 1.3],
    [0, 6.7, 4.4, 1.3],
    [3.4, 3.4, 1.4, 4.6],
    [2.6, 0, 1.4, 3.6],
  ],
  S: [
    [0, 0, 5, 1.3],
    [0, 3.3, 5, 1.4],
    [0, 6.7, 5, 1.3],
    [3.7, 0, 1.3, 3.5],
    [0, 4.5, 1.3, 3.5],
  ],
  T: [
    [0, 6.7, 5, 1.3],
    [1.85, 0, 1.3, 8],
  ],
  X: [
    [0, 0, 1.4, 3.2],
    [3.6, 0, 1.4, 3.2],
    [1.8, 3, 1.4, 2],
    [0, 4.8, 1.4, 3.2],
    [3.6, 4.8, 1.4, 3.2],
  ],
};

function glyphRects(ch: string): FaceRect[] {
  return GLYPHS[ch.toUpperCase()] ?? [{ u: 1.6, v: 0, du: 1.6, dv: 8 }];
}

function faceCenter(box: BoundingBoxMm, region: ReliefRegion): [number, number, number] {
  const [minx, miny, minz] = box.min;
  const [maxx, maxy, maxz] = box.max;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const cz = (minz + maxz) / 2;
  switch (region) {
    case "front":
      return [cx, maxy, cz];
    case "back":
      return [cx, miny, cz];
    case "left":
      return [minx, cy, cz];
    case "right":
      return [maxx, cy, cz];
    case "top":
      return [cx, cy, maxz];
    case "bottom":
      return [cx, cy, minz];
  }
}

/**
 * Map face-local (u, v, n) to world. +u is right on the face, +v is up, +n is outward.
 */
function worldFromFace(
  region: ReliefRegion,
  origin: [number, number, number],
  u: number,
  v: number,
  n: number,
): [number, number, number] {
  const [ox, oy, oz] = origin;
  switch (region) {
    case "front":
      return [ox + u, oy + n, oz + v];
    case "back":
      return [ox - u, oy - n, oz + v];
    case "left":
      return [ox - n, oy + u, oz + v];
    case "right":
      return [ox + n, oy - u, oz + v];
    case "top":
      return [ox + u, oy - v, oz + n];
    case "bottom":
      return [ox + u, oy + v, oz - n];
  }
}

function worldSize(region: ReliefRegion, du: number, dv: number, dn: number): [number, number, number] {
  switch (region) {
    case "front":
    case "back":
      return [du, dn, dv];
    case "left":
    case "right":
      return [dn, du, dv];
    case "top":
    case "bottom":
      return [du, dv, dn];
  }
}

function cubeOnFace(
  region: ReliefRegion,
  origin: [number, number, number],
  u: number,
  v: number,
  n0: number,
  du: number,
  dv: number,
  dn: number,
): string {
  // Place the cube so its min corner is the more-negative world corner of the prism.
  const corners: [number, number, number][] = [
    worldFromFace(region, origin, u, v, n0),
    worldFromFace(region, origin, u + du, v, n0),
    worldFromFace(region, origin, u, v + dv, n0),
    worldFromFace(region, origin, u, v, n0 + dn),
  ];
  const min: [number, number, number] = [
    Math.min(...corners.map((c) => c[0])),
    Math.min(...corners.map((c) => c[1])),
    Math.min(...corners.map((c) => c[2])),
  ];
  const [sx, sy, sz] = worldSize(region, du, dv, dn);
  return `translate([${fmt(min[0])}, ${fmt(min[1])}, ${fmt(min[2])}]) cube([${fmt(sx)}, ${fmt(sy)}, ${fmt(sz)}]);`;
}

function motifRects(relief: CadRelief): FaceRect[] {
  if (relief.motif === "crest") {
    return [
      { u: -6, v: -2, du: 12, dv: 12 },
      { u: -1, v: -7, du: 2, dv: 6 },
      { u: -5, v: 6, du: 10, dv: 2 },
      { u: -1, v: 0, du: 2, dv: 8 },
    ];
  }
  if (relief.motif === "disc") {
    return [{ u: -4, v: -4, du: 8, dv: 8 }];
  }
  if (relief.motif === "bar") {
    return [{ u: -6, v: -1.2, du: 12, dv: 2.4 }];
  }
  const letters = (relief.text ?? DEFAULT_INITIALS).toUpperCase().slice(0, 4);
  const cell = 6;
  const gap = 1.2;
  const total = letters.length * cell + Math.max(0, letters.length - 1) * gap;
  const rects: FaceRect[] = [];
  letters.split("").forEach((ch, index) => {
    const x0 = -total / 2 + index * (cell + gap);
    const y0 = -4;
    for (const g of glyphRects(ch)) {
      rects.push({ u: x0 + g.u, v: y0 + g.v, du: g.du, dv: g.dv });
    }
  });
  return rects;
}

export function reliefExtentMm(relief: CadRelief): number {
  return relief.kind === "emboss" ? relief.height_mm : relief.depth_mm;
}

/** OpenSCAD cubes for one relief, already placed on the host bbox face. */
export function reliefMotifScad(relief: CadRelief, box: BoundingBoxMm): string {
  const origin = faceCenter(box, relief.region);
  const extent = reliefExtentMm(relief);
  const n0 = relief.kind === "emboss" ? -RELIEF_OVERSHOOT_MM : -(extent);
  const dn = extent + RELIEF_OVERSHOOT_MM;
  const cubes = motifRects(relief).map((rect) =>
    cubeOnFace(relief.region, origin, rect.u, rect.v, n0, rect.du, rect.dv, dn),
  );
  if (cubes.length === 1) return cubes[0] ?? "";
  return `union() {\n    ${cubes.join("\n    ")}\n  }`;
}

export function reliefBooleanFor(reliefs: CadRelief[]): "union" | "difference" | "none" {
  if (!reliefs.length) return "none";
  return reliefs.some((relief) => relief.kind === "etch") ? "difference" : "union";
}

export function cubeEtchFixtureScad(size = 20, initials = DEFAULT_INITIALS, holeMm?: number): string {
  const relief: CadRelief = {
    kind: "etch",
    motif: "text",
    text: initials.toUpperCase().slice(0, 4),
    region: "front",
    height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    depth_mm: DEFAULT_ETCH_DEPTH_MM,
  };
  const box: BoundingBoxMm = {
    min: [0, 0, 0],
    max: [size, size, size],
    size: [size, size, size],
  };
  const hole = holeMm && holeMm > 0
    ? `  translate([${fmt(size / 2)}, ${fmt(size / 2)}, -1])\n    cylinder(h = ${fmt(size + 2)}, d = hole_d);\n`
    : "";
  return `// Fixture: ${size}mm cube with etched initials on the front (mm)
// Region default (unspecified): largest vertical face / front (+Y).
// Etch depth ${DEFAULT_ETCH_DEPTH_MM} mm — visible, leaves #11 1.6 mm walls on this solid host.
// Honest stub: block initials, not Style2Fab / text().
$fn = 48;
size = ${fmt(size)};
etch_depth = ${fmt(DEFAULT_ETCH_DEPTH_MM)};
${holeMm && holeMm > 0 ? `hole_d = ${fmt(holeMm)};\n` : ""}difference() {
  cube(size, center = false);
${hole}  ${reliefMotifScad(relief, box)}
}
`;
}

export function helmetEmbossFixtureScad(): string {
  return `// Fixture: helmet with embossed crest on the back (mm)
// Region: back (−Y). Unspecified region would default to largest vertical / front (+Y).
// Emboss height ${DEFAULT_EMBOSS_HEIGHT_MM} mm (raised). Shell wall 2.4 mm so #11 1.6 mm remains if etched later.
// Honest stub: primitive crest, not Style2Fab / neural stylization.
$fn = 48;
body_w = 96;
body_d = 108;
body_h = 64;
wall = 2.4;
emboss_h = ${fmt(DEFAULT_EMBOSS_HEIGHT_MM)};

module helmet_shell() {
  difference() {
    union() {
      cube([body_w, body_d, body_h * 0.62]);
      translate([body_w / 2, body_d / 2, body_h * 0.5])
        scale([1, body_d / body_w, (body_h * 0.9) / body_w])
          sphere(r = body_w / 2);
    }
    translate([wall, wall, -1])
      cube([body_w - 2 * wall, body_d - 2 * wall, body_h * 0.62 + 1]);
    translate([body_w / 2, body_d / 2, body_h * 0.5])
      scale([1, (body_d - 2 * wall) / (body_w - 2 * wall), (body_h * 0.9 - wall) / (body_w - 2 * wall)])
        sphere(r = (body_w - 2 * wall) / 2);
    translate([16, body_d - 18, 14])
      cube([body_w - 32, 22, 36]);
    translate([-4, -4, -40]) cube([body_w + 8, body_d + 8, 40]);
  }
}

module crest_motif() {
  translate([body_w / 2 - 6, -emboss_h, 22]) cube([12, emboss_h + 0.3, 14]);
  translate([body_w / 2 - 1, -emboss_h, 16]) cube([2, emboss_h + 0.3, 7]);
  translate([body_w / 2 - 5, -emboss_h, 31]) cube([10, emboss_h + 0.3, 2]);
  translate([body_w / 2 - 1, -emboss_h, 24]) cube([2, emboss_h + 0.3, 8]);
}

union() {
  helmet_shell();
  crest_motif();
}
`;
}

export function isHelmetEmbossPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bhelmet\b/.test(text) && /\b(emboss|crest|raised|relief|logo)\b/.test(text);
}

export function isCubeEtchPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (!/\bcube\b/.test(text)) return false;
  return /\b(etch|engrav|recess|initials?|monogram)\b/.test(text);
}

/** Follow-up on an existing cube — "etch initials on the front" has no "cube". */
export function isEtchFollowUp(prompt: string): boolean {
  return /\b(etch|engrav|recess|initials?|monogram)\b/i.test(prompt) && !/\bhelmet\b/i.test(prompt);
}

export function cubeEtchSizeFromPrompt(prompt: string, fallback = 20): number {
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+cube/i) ?? prompt.match(/\bcube\b[^\d]{0,12}(\d+(?:\.\d+)?)/i);
  const n = match ? Number(match[1]) : fallback;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
