import { printRules } from "./printability";
import {
  formatImageReliefNote,
  imageFieldToPrisms,
  imageReliefFaceMmForField,
  promptHasImageRelief,
  type ImageReliefField,
} from "./relief-image";
import {
  formatReliefTargetNote,
  inferWearableCategoryForRelief,
  parseReliefRegionText,
  parseReliefTarget,
  type ReliefTarget,
} from "./relief-regions";
import type { BoundingBoxMm, WearableCategoryId } from "./types";
import { isWearableCategoryId } from "./wearable-sizes";

/** Raised (union onto a face) vs recessed (difference into a face). */
export type ReliefKind = "emboss" | "etch";

/** Honest primitive + image-silhouette motifs — no Style2Fab / fonts / neural stylization. */
export const RELIEF_MOTIF_KINDS = [
  "text",
  "crest",
  "disc",
  "bar",
  "chevron",
  "shield",
  "star",
  "cross",
  "ring",
  "stripe",
  "grid",
  "diamond",
  "image",
] as const;
export type ReliefMotifKind = (typeof RELIEF_MOTIF_KINDS)[number];

export type { ImageReliefField, ReliefTarget };
export type FaceRect = { u: number; v: number; du: number; dv: number };

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
  /** Wearable / pack phrase (“chest plate”, “gauntlet cuff”). */
  target?: string;
  wearableCategory?: WearableCategoryId;
  knowledgeFeature?: string;
  source?: "description" | "image";
  /** Silhouette / heightfield cells when motif=image. */
  image?: ImageReliefField;
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
export const CHEST_CHEVRON_PROMPT = "chest plate with embossed chevron on the front";
export const GAUNTLET_CUFF_PROMPT = "gauntlet with etched ring on the cuff";
export const HELMET_MULTI_RELIEF_PROMPT =
  "helmet with embossed crest on the back and etched initials on the front";

const RELIEF_WORD =
  /\b(emboss(?:ed|ing)?|etch(?:ed|ing)?|engrav(?:e|ed|ing)|recess(?:ed|ing)?|raised|relief|crest|initials?|monogram)\b/i;

export function promptHasRelief(prompt: string): boolean {
  return RELIEF_WORD.test(prompt) || promptHasImageRelief(prompt);
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
  if (/\b(helmet|mask|shell|armor|cuirass|hollow|chest\s*plate|gauntlet|bracer)\b/i.test(prompt)) {
    return 2.4;
  }
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
  return parseReliefRegionText(raw);
}

export function parseReliefKind(raw: unknown): ReliefKind | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (/\b(etch(?:ed|ing)?|engrav(?:e|ed|ing)?|recess(?:ed|ing)?|carv(?:e|ed|ing)?|intaglio|deboss(?:ed|ing)?)\b/.test(text)) {
    return "etch";
  }
  if (/\b(emboss(?:ed|ing)?|raised|relief|cameo)\b/.test(text)) return "emboss";
  return undefined;
}

export function parseReliefMotif(raw: unknown): ReliefMotifKind | undefined {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!text) return undefined;
  if (/\b(image|silhouette|heightfield|uploaded|photo\s+logo)\b/.test(text)) return "image";
  if (/\bchevron\b/.test(text)) return "chevron";
  if (/\bshield\b/.test(text)) return "shield";
  if (/\b(star|asterisk)\b/.test(text)) return "star";
  if (/\b(cross|plus)\b/.test(text)) return "cross";
  if (/\b(ring|annulus|circle\s+frame)\b/.test(text)) return "ring";
  if (/\b(stripes?|hash\s*marks?)\b/.test(text)) return "stripe";
  if (/\b(grid|hatch|check)\b/.test(text)) return "grid";
  if (/\bdiamond\b/.test(text)) return "diamond";
  if (/\b(crest|logo|emblem|badge|sigil)\b/.test(text)) return "crest";
  if (/\b(disc|disk|dot|circle|coin)\b/.test(text)) return "disc";
  if (/\b(bar|dash)\b/.test(text)) return "bar";
  if (/\b(text|letters?|initials?|word|monogram|glyph)\b/.test(text)) return "text";
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
  const etched = prompt.match(/\b(?:etched?|engraved?|embossed?)\s+([A-Za-z]{1,4})\b/i);
  if (etched?.[1] && !INITIALS_STOP.test(etched[1])) return etched[1].toUpperCase();
  const lone = prompt.match(/\b([A-Z]{2,4})\b/);
  if (lone?.[1] && !INITIALS_STOP.test(lone[1])) return lone[1];
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

const RELIEF_CLAUSE =
  /\b(emboss|etch|engrav|recess|raised|relief|crest|initials?|monogram|logo|chevron|shield|star|cross|ring|stripe|grid|diamond|disc|bar|this)\b/i;

function splitReliefClauses(prompt: string): string[] {
  const parts = prompt
    .split(/\s+and\s+|,(?=\s*(?:an?\s+)?(?:emboss|etch|engrav|recess|raised|a\s+))/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const hits = parts.filter((part) => RELIEF_CLAUSE.test(part) || parseReliefTarget(part));
  return hits.length >= 2 ? hits : [prompt];
}

function inferOneRelief(
  clause: string,
  hostPrompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  if (!promptHasRelief(clause) && !parseReliefTarget(clause) && !parseReliefMotif(clause)) {
    return [];
  }
  const kind =
    parseReliefKind(clause) ??
    parseReliefKind(hostPrompt) ??
    (/\b(initials?|letters?|text|monogram)\b/i.test(clause) ? "etch" : "emboss");
  const letters = initialsFromPrompt(clause) ?? (clause === hostPrompt ? initialsFromPrompt(hostPrompt) : undefined);
  const motif =
    parseReliefMotif(clause) ??
    (letters || /\b(initials?|letters?|text|monogram)\b/i.test(clause)
      ? "text"
      : /\b(helmet|crest|logo)\b/i.test(clause)
        ? "crest"
        : clause === hostPrompt
          ? parseReliefMotif(hostPrompt) ??
            (/\b(helmet|crest|logo)\b/i.test(hostPrompt)
              ? "crest"
              : letters || /\b(initials?|letters?|text|monogram)\b/i.test(hostPrompt)
                ? "text"
                : "bar")
          : "bar");
  const clauseTarget = parseReliefTarget(clause);
  const clauseRegion = parseReliefRegion(clause);
  const target = clauseTarget ?? (clauseRegion ? undefined : parseReliefTarget(hostPrompt));
  const region =
    clauseRegion ?? target?.region ?? parseReliefRegion(hostPrompt) ?? defaultReliefRegion(sizeMm);
  const wearableCategory = inferWearableCategoryForRelief(hostPrompt, target);
  const shell = inferShellThicknessMm(hostPrompt);
  const host = shell ?? hostThicknessAlongRegion(sizeMm, region);
  const height_mm = clampReliefExtentMm("emboss", kind === "emboss" ? statedExtentMm(clause, "emboss") ?? statedExtentMm(hostPrompt, "emboss") : undefined, host);
  const depth_mm = clampReliefExtentMm("etch", kind === "etch" ? statedExtentMm(clause, "etch") ?? statedExtentMm(hostPrompt, "etch") : undefined, host);
  const text = motif === "text" ? letters ?? DEFAULT_INITIALS : undefined;
  const named = parseReliefRegion(clause) ?? parseReliefRegion(hostPrompt) ?? target?.region;
  const notes = [
    formatReliefTargetNote(target),
    named ? undefined : `Region defaulted to ${region} (largest vertical face; ties use front / +Y).`,
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
      target: target?.label,
      wearableCategory,
      knowledgeFeature: target?.knowledgeFeature,
      source: "description",
      notes: notes.join(" ") || undefined,
    },
  ];
}

export function inferCadReliefs(
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  if (!promptHasRelief(prompt)) return [];
  return splitReliefClauses(prompt).flatMap((clause) => inferOneRelief(clause, prompt, sizeMm));
}

export function attachImageMotif(
  reliefs: CadRelief[],
  field: ImageReliefField,
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  const inferred = reliefs.length ? reliefs : inferCadReliefs(prompt, sizeMm);
  const seed =
    inferred.find((relief) => relief.motif === "image" || relief.motif === "crest" || /\b(logo|this|image|photo|crest)\b/i.test(prompt)) ??
    inferred[0];
  const kind = seed?.kind ?? (parseReliefKind(prompt) === "etch" ? "etch" : "emboss");
  const region = seed?.region ?? parseReliefRegion(prompt) ?? defaultReliefRegion(sizeMm);
  const target = parseReliefTarget(prompt);
  const host = inferShellThicknessMm(prompt) ?? hostThicknessAlongRegion(sizeMm, region);
  const attached: CadRelief = {
    kind,
    motif: "image",
    region,
    height_mm: clampReliefExtentMm("emboss", seed?.height_mm, host),
    depth_mm: clampReliefExtentMm("etch", seed?.depth_mm, host),
    target: seed?.target ?? target?.label,
    wearableCategory: seed?.wearableCategory ?? target?.wearableCategory,
    knowledgeFeature: seed?.knowledgeFeature ?? target?.knowledgeFeature,
    source: "image",
    image: field,
    notes: [seed?.notes, formatImageReliefNote(field, kind)].filter(Boolean).join(" ") || undefined,
  };
  if (!inferred.length) return [attached];
  let used = false;
  return inferred.map((relief) => {
    if (used) return relief;
    if (relief === seed || relief.motif === "crest" || relief.motif === "image") {
      used = true;
      return { ...relief, ...attached, notes: attached.notes };
    }
    return relief;
  });
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
    const region =
      parseReliefRegion(rec.region ?? rec.face ?? rec.side ?? rec.target) ?? DEFAULT_RELIEF_REGION;
    const text = asString(rec.text) ?? asString(rec.initials) ?? asString(rec.letters);
    const height = asFiniteNumber(rec.height_mm) ?? asFiniteNumber(rec.height);
    const depth = asFiniteNumber(rec.depth_mm) ?? asFiniteNumber(rec.depth);
    const target = asString(rec.target) ?? parseReliefTarget(rec.region ?? rec.target)?.label;
    return [
      {
        kind,
        motif,
        text: text ? text.toUpperCase().slice(0, 4) : undefined,
        region,
        height_mm: height && height > 0 ? height : DEFAULT_EMBOSS_HEIGHT_MM,
        depth_mm: depth && depth > 0 ? depth : DEFAULT_ETCH_DEPTH_MM,
        target,
        wearableCategory: isWearableCategoryId(asString(rec.wearableCategory))
          ? (asString(rec.wearableCategory) as WearableCategoryId)
          : undefined,
        knowledgeFeature: asString(rec.knowledgeFeature ?? rec.feature),
        source: rec.source === "image" ? "image" : "description",
        notes: asString(rec.notes),
      },
    ];
  });
}

function clampOneRelief(
  relief: CadRelief,
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief {
  const target = parseReliefTarget(relief.target ?? prompt);
  const region = relief.region ?? target?.region ?? defaultReliefRegion(sizeMm);
  const shell = inferShellThicknessMm(prompt);
  const host = shell ?? hostThicknessAlongRegion(sizeMm, region);
  const kind = relief.kind;
  const stated = statedExtentMm(prompt, kind);
  return {
    ...relief,
    region,
    target: relief.target ?? target?.label,
    wearableCategory: relief.wearableCategory ?? target?.wearableCategory,
    knowledgeFeature: relief.knowledgeFeature ?? target?.knowledgeFeature,
    height_mm: clampReliefExtentMm("emboss", kind === "emboss" ? stated ?? relief.height_mm : relief.height_mm, host),
    depth_mm: clampReliefExtentMm("etch", kind === "etch" ? stated ?? relief.depth_mm : relief.depth_mm, host),
    text:
      relief.motif === "text"
        ? (relief.text ?? initialsFromPrompt(prompt) ?? DEFAULT_INITIALS).toUpperCase().slice(0, 4)
        : relief.text,
  };
}

export function normalizeCadReliefs(
  reliefs: CadRelief[],
  prompt: string,
  sizeMm?: [number, number, number] | null,
): CadRelief[] {
  if (!promptHasRelief(prompt) && !reliefs.some((relief) => relief.motif === "image" && relief.image)) {
    return [];
  }
  const inferred = inferCadReliefs(prompt, sizeMm);
  if (inferred.length > 1) {
    if (reliefs.length === inferred.length) {
      return inferred.map((item, index) =>
        clampOneRelief(
          {
            ...item,
            height_mm: reliefs[index]?.height_mm ?? item.height_mm,
            depth_mm: reliefs[index]?.depth_mm ?? item.depth_mm,
            image: reliefs[index]?.image ?? item.image,
            source: reliefs[index]?.source ?? item.source,
            notes: reliefs[index]?.notes ?? item.notes,
          },
          prompt,
          sizeMm,
        ),
      );
    }
    return inferred.map((item) => clampOneRelief(item, prompt, sizeMm));
  }
  const typed = reliefs.length ? reliefs : inferred;
  const fallback = inferred[0];
  return typed.map((relief) => {
    const kind = parseReliefKind(prompt) ?? relief.kind;
    const target = parseReliefTarget(prompt);
    const region =
      parseReliefRegion(prompt) ?? relief.region ?? fallback?.region ?? defaultReliefRegion(sizeMm);
    const motif = parseReliefMotif(prompt) ?? relief.motif ?? fallback?.motif ?? "bar";
    return clampOneRelief(
      {
        ...relief,
        kind,
        motif,
        region,
        target: relief.target ?? target?.label ?? fallback?.target,
        wearableCategory: relief.wearableCategory ?? target?.wearableCategory ?? fallback?.wearableCategory,
        knowledgeFeature: relief.knowledgeFeature ?? target?.knowledgeFeature ?? fallback?.knowledgeFeature,
        image: relief.image ?? fallback?.image,
        source: relief.source ?? fallback?.source,
        notes: relief.notes ?? fallback?.notes,
      },
      prompt,
      sizeMm,
    );
  });
}

export function formatReliefConstraints(): string {
  return [
    `Raised etchings / emboss (only when the user asks for emboss, etch, engrave, crest, initials, or an uploaded logo):`,
    `- Honest CSG stub — not Style2Fab / neural stylization. Motifs are extruded primitives, block initials, or an image silhouette/heightfield (no text() / fonts).`,
    `- Emboss = union a motif onto the named face (default height ${DEFAULT_EMBOSS_HEIGHT_MM} mm). Etch = difference a motif into that face (default depth ${DEFAULT_ETCH_DEPTH_MM} mm).`,
    `- Motifs: text / crest / disc / bar / chevron / shield / star / cross / ring / stripe / grid / diamond / image. Multiple reliefs when they ask for more than one (crest on the back and initials on the front).`,
    `- Region default: largest vertical face; ties use front (+Y). back=−Y, left=−X, right=+X, top=+Z, bottom=−Z. Wearable phrases: “back of helmet”, “chest plate”, “gauntlet cuff” (ties to helmet_mask / torso_armor / gauntlet when present).`,
    `- Depth is print-aware: ≥ ${MIN_RELIEF_MM} mm (visible) and etch leaves ≥ ${printRules().minWallMm} mm remaining wall (#11) when host thickness is known. Max emboss ${MAX_EMBOSS_HEIGHT_MM} mm, max etch ${MAX_ETCH_DEPTH_MM} mm.`,
    `- One piece first. Do not close through-holes or fuse print-in-place joints. Do not replace or destroy the host solid.`,
  ].join("\n");
}

export function formatReliefNote(reliefs: CadRelief[]): string {
  if (!reliefs.length) return "";
  return reliefs
    .map((relief) => {
      const extent = relief.kind === "emboss" ? `${relief.height_mm} mm raised` : `${relief.depth_mm} mm recessed`;
      const motif =
        relief.motif === "text"
          ? `block initials “${relief.text ?? DEFAULT_INITIALS}”`
          : relief.motif === "image"
            ? "image silhouette"
            : relief.motif;
      const where = relief.target ? `${relief.target} (${relief.region} face)` : `${relief.region} face`;
      return `Relief stub: ${relief.kind} ${motif} on the ${where} (${extent}). Not Style2Fab.`;
    })
    .join(" ");
}

function slimReliefForPrompt(relief: CadRelief): Record<string, unknown> {
  const { image, ...rest } = relief;
  if (!image) return rest;
  return {
    ...rest,
    motif: "image",
    image: { width: image.width, height: image.height, cells: image.cells.filter(Boolean).length, heightfield: Boolean(image.heights?.length) },
  };
}

export function formatReliefPromptHint(reliefs: CadRelief[]): string {
  if (!reliefs.length) return "";
  return [
    `Relief: apply CSG without replacing the host. Emboss = union; etch = difference. Prefer primitive crest / chevron / shield / star / ring / stripe / grid / diamond / disc / bar or block initials — avoid text() (no fonts). Image motifs are silhouette/heightfield cubes, not neural Style2Fab.`,
    `Keep remaining walls ≥ ${printRules().minWallMm} mm. Do not close holes or fuse PIP joints. Region defaults: largest vertical face / front (+Y). Wearable: back of helmet / chest plate / gauntlet cuff.`,
    JSON.stringify(reliefs.map(slimReliefForPrompt)),
  ].join("\n");
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, "");
}

/** 5×7-ish stroke boxes for block initials (u, v, du, dv; origin bottom-left of the cell). */
const GLYPHS: Record<string, Array<[number, number, number, number]>> = {
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
  const raw = GLYPHS[ch.toUpperCase()] ?? ([[1.6, 0, 1.6, 8]] as Array<[number, number, number, number]>);
  return raw.map(([u, v, du, dv]) => ({ u, v, du, dv }));
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
  if (relief.motif === "shield") {
    return [
      { u: -5, v: -2, du: 10, dv: 10 },
      { u: -3.5, v: -6, du: 7, dv: 5 },
      { u: -1.2, v: -8, du: 2.4, dv: 3 },
    ];
  }
  if (relief.motif === "chevron") {
    return [
      { u: -7, v: 1, du: 6.5, dv: 2.2 },
      { u: 0.5, v: 1, du: 6.5, dv: 2.2 },
      { u: -3.2, v: -3, du: 6.4, dv: 2.2 },
    ];
  }
  if (relief.motif === "star") {
    return [
      { u: -1.2, v: -7, du: 2.4, dv: 14 },
      { u: -7, v: -1.2, du: 14, dv: 2.4 },
      { u: -5, v: -5, du: 3.2, dv: 3.2 },
      { u: 1.8, v: -5, du: 3.2, dv: 3.2 },
      { u: -5, v: 1.8, du: 3.2, dv: 3.2 },
      { u: 1.8, v: 1.8, du: 3.2, dv: 3.2 },
    ];
  }
  if (relief.motif === "cross") {
    return [
      { u: -1.4, v: -6, du: 2.8, dv: 12 },
      { u: -6, v: -1.4, du: 12, dv: 2.8 },
    ];
  }
  if (relief.motif === "ring") {
    return [
      { u: -6, v: -6, du: 12, dv: 2 },
      { u: -6, v: 4, du: 12, dv: 2 },
      { u: -6, v: -4, du: 2, dv: 8 },
      { u: 4, v: -4, du: 2, dv: 8 },
    ];
  }
  if (relief.motif === "stripe") {
    return [
      { u: -8, v: -4.5, du: 16, dv: 1.8 },
      { u: -8, v: -0.9, du: 16, dv: 1.8 },
      { u: -8, v: 2.7, du: 16, dv: 1.8 },
    ];
  }
  if (relief.motif === "grid") {
    return [
      { u: -6, v: -6, du: 12, dv: 1.6 },
      { u: -6, v: -0.8, du: 12, dv: 1.6 },
      { u: -6, v: 4.4, du: 12, dv: 1.6 },
      { u: -6, v: -6, du: 1.6, dv: 12 },
      { u: -0.8, v: -6, du: 1.6, dv: 12 },
      { u: 4.4, v: -6, du: 1.6, dv: 12 },
    ];
  }
  if (relief.motif === "diamond") {
    return [
      { u: -2, v: -6, du: 4, dv: 4 },
      { u: -4, v: -2, du: 8, dv: 4 },
      { u: -2, v: 2, du: 4, dv: 4 },
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
  if (relief.motif === "image" && relief.image) {
    const face = imageReliefFaceMmForField(relief.image, box.size, relief.region);
    const prisms = imageFieldToPrisms(relief.image, face.width, face.height);
    const cubes = prisms.map((prism) => {
      const dn = extent * prism.t + RELIEF_OVERSHOOT_MM;
      const n0 = relief.kind === "emboss" ? -RELIEF_OVERSHOOT_MM : -(extent * prism.t);
      return cubeOnFace(relief.region, origin, prism.u, prism.v, n0, prism.du, prism.dv, dn);
    });
    if (!cubes.length) return "";
    if (cubes.length === 1) return cubes[0] ?? "";
    return `union() {\n    ${cubes.join("\n    ")}\n  }`;
  }
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

export function helmetBox(): BoundingBoxMm {
  return { min: [0, 0, 0], max: [96, 108, 64], size: [96, 108, 64] };
}

export function chestPlateEmbossFixtureScad(): string {
  const relief: CadRelief = {
    kind: "emboss",
    motif: "chevron",
    region: "front",
    target: "chest plate",
    wearableCategory: "torso_armor",
    knowledgeFeature: "chest_plate",
    height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    depth_mm: DEFAULT_ETCH_DEPTH_MM,
    source: "description",
  };
  const box: BoundingBoxMm = { min: [0, 0, 0], max: [120, 28, 90], size: [120, 28, 90] };
  return `// Fixture: chest plate with embossed chevron on the front (mm)
// Wearable region: torso_armor / chest plate → front (+Y).
// Emboss height ${DEFAULT_EMBOSS_HEIGHT_MM} mm. Wall 2.4 mm so #11 1.6 mm remains if etched later.
// Honest stub: primitive chevron, not Style2Fab.
$fn = 48;
body_w = 120;
body_d = 28;
body_h = 90;
wall = 2.4;
emboss_h = ${fmt(DEFAULT_EMBOSS_HEIGHT_MM)};

module chest_plate() {
  difference() {
    cube([body_w, body_d, body_h]);
    translate([wall, wall, wall])
      cube([body_w - 2 * wall, body_d - wall + 1, body_h - 2 * wall]);
  }
}

union() {
  chest_plate();
  ${reliefMotifScad(relief, box)}
}
`;
}

export function gauntletCuffEtchFixtureScad(): string {
  const relief: CadRelief = {
    kind: "etch",
    motif: "ring",
    region: "front",
    target: "gauntlet cuff",
    wearableCategory: "gauntlet",
    knowledgeFeature: "wrist_cuff",
    height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    depth_mm: DEFAULT_ETCH_DEPTH_MM,
    source: "description",
  };
  const box: BoundingBoxMm = { min: [0, 0, 0], max: [70, 90, 45], size: [70, 90, 45] };
  return `// Fixture: gauntlet with etched ring on the cuff (mm)
// Wearable region: gauntlet / wrist cuff → front (+Y).
// Etch depth ${DEFAULT_ETCH_DEPTH_MM} mm — visible, remaining wall ≥ 1.6 mm on a 2.4 mm cuff.
// Honest stub: primitive ring, not Style2Fab.
$fn = 48;
body_w = 70;
body_d = 90;
body_h = 45;
wall = 2.4;
etch_depth = ${fmt(DEFAULT_ETCH_DEPTH_MM)};

module gauntlet_cuff() {
  difference() {
    cube([body_w, body_d, body_h]);
    translate([wall, -1, wall])
      cube([body_w - 2 * wall, body_d + 2, body_h - 2 * wall]);
  }
}

difference() {
  gauntlet_cuff();
  ${reliefMotifScad(relief, box)}
}
`;
}

export function helmetMultiReliefFixtureScad(): string {
  const crest: CadRelief = {
    kind: "emboss",
    motif: "crest",
    region: "back",
    target: "helmet back",
    wearableCategory: "helmet_mask",
    height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    depth_mm: DEFAULT_ETCH_DEPTH_MM,
    source: "description",
  };
  const initials: CadRelief = {
    kind: "etch",
    motif: "text",
    text: DEFAULT_INITIALS,
    region: "front",
    target: "helmet front",
    wearableCategory: "helmet_mask",
    height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    depth_mm: DEFAULT_ETCH_DEPTH_MM,
    source: "description",
  };
  const box = helmetBox();
  return `// Fixture: helmet with embossed crest on the back and etched initials on the front (mm)
// Multi-relief: union crest on back (−Y), difference block initials on front (+Y).
// Emboss ${DEFAULT_EMBOSS_HEIGHT_MM} mm / etch ${DEFAULT_ETCH_DEPTH_MM} mm. Shell wall 2.4 mm.
// Honest stub: primitives, not Style2Fab / text().
$fn = 48;
body_w = 96;
body_d = 108;
body_h = 64;
wall = 2.4;
emboss_h = ${fmt(DEFAULT_EMBOSS_HEIGHT_MM)};
etch_depth = ${fmt(DEFAULT_ETCH_DEPTH_MM)};

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

difference() {
  union() {
    helmet_shell();
    ${reliefMotifScad(crest, box)}
  }
  ${reliefMotifScad(initials, box)}
}
`;
}

export function isHelmetMultiReliefPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    /\bhelmet\b/.test(text) &&
    /\b(emboss|crest|raised|relief)\b/.test(text) &&
    /\b(etch|engrav|initials?|monogram)\b/.test(text)
  );
}

export function isChestChevronPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(chest|breast)\s*plates?\b/.test(text) && /\b(emboss|chevron|raised|crest)\b/.test(text);
}

export function isGauntletCuffPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bgauntlet\b/.test(text) && /\b(etch|engrav|ring|cuff)\b/.test(text);
}

export function isHelmetEmbossPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (isHelmetMultiReliefPrompt(text)) return false;
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

export function standaloneImageReliefScad(
  reliefs: CadRelief[],
  sizeMm: [number, number, number],
  prompt: string,
): string {
  const [sx, sy, sz] = sizeMm;
  const box: BoundingBoxMm = { min: [0, 0, 0], max: [sx, sy, sz], size: [sx, sy, sz] };
  const etch = reliefs.filter((relief) => relief.kind === "etch");
  const emboss = reliefs.filter((relief) => relief.kind === "emboss");
  const etchCsg = etch.map((relief) => reliefMotifScad(relief, box)).filter(Boolean).join("\n  ");
  const embossCsg = emboss.map((relief) => reliefMotifScad(relief, box)).filter(Boolean).join("\n  ");
  const host = `cube([${fmt(sx)}, ${fmt(sy)}, ${fmt(sz)}], center = false);`;
  const etched = etchCsg
    ? `difference() {\n  ${host}\n  ${etchCsg}\n}`
    : host;
  const body = embossCsg
    ? `union() {\n  ${etched}\n  ${embossCsg}\n}`
    : etched;
  return `// Image-driven relief stub (silhouette / heightfield — not Style2Fab)
// prompt: ${prompt.replace(/\s+/g, " ").slice(0, 160)}
$fn = 48;
${body}
`;
}

export function cubeEtchSizeFromPrompt(prompt: string, fallback = 20): number {
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+cube/i) ?? prompt.match(/\bcube\b[^\d]{0,12}(\d+(?:\.\d+)?)/i);
  const n = match ? Number(match[1]) : fallback;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
