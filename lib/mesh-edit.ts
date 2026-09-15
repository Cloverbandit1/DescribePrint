import { wantsNewDesign } from "./printability";
import { parseWearableCategoryFromPrompt, parseWearableSizeFromPrompt } from "./wearable-sizes";
import type { WearableCategoryId, WearableSizeId } from "./types";

export type MeshEditKind = "transform" | "describe-wrapper" | "new-design";

export type MeshEditIntent = {
  kind: MeshEditKind;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId | null;
  /** Uniform scale to apply (1 = none). Combined with wearable if both present. */
  scale: number;
  targetMaxMm: number | null;
  rotateZDeg: number | null;
  sitOnBed: boolean;
  holeMm: number | null;
  addTab: boolean;
  notes: string[];
};

const GENERATIVE =
  /\b(hole|bore|cut|slot|slit|tab|thicken|fillet|chamfer|emboss|engrave|etch|add a|add an|difference|boolean|remesh|carve|pocket)\b/i;

const BIGGER = /\b(larger|bigger|scale\s*up|increase (?:the )?size)\b/i;
const SMALLER = /\b(smaller|scale\s*down|decrease (?:the )?size)\b/i;
const SIT_ON_BED = /\b(sit on|on the (?:build )?plate|on the bed|onto the plate|move to (?:the )?plate|z\s*=\s*0)\b/i;
const ROTATE = /\brotate\b|\bturn\b|\bspin\b/i;

function numberAt(source: string, re: RegExp): number | null {
  const match = source.match(re);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isGenerativeMeshEdit(prompt: string): boolean {
  return GENERATIVE.test(prompt);
}

export function parseMeshEditIntent(
  prompt: string,
  requestedSize?: WearableSizeId | null,
  requestedCategory?: WearableCategoryId | null,
): MeshEditIntent {
  const text = prompt.trim();
  const notes: string[] = [];
  const wearableCategory = requestedCategory ?? parseWearableCategoryFromPrompt(text);

  if (wantsNewDesign(text)) {
    return {
      kind: "new-design",
      wearableSize: requestedSize ?? parseWearableSizeFromPrompt(text),
      wearableCategory,
      scale: 1,
      targetMaxMm: null,
      rotateZDeg: null,
      sitOnBed: false,
      holeMm: null,
      addTab: false,
      notes,
    };
  }

  const wearableSize = requestedSize ?? parseWearableSizeFromPrompt(text);
  const holeMm =
    numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/i) ??
    numberAt(text, /(?:hole|bore)\s+(?:of\s+)?(\d+(?:\.\d+)?)/i);
  const addTab = /\btab\b|\bmount(?:ing)?\b/i.test(text);
  const generative = isGenerativeMeshEdit(text) || holeMm !== null || addTab;

  let scale = 1;
  if (BIGGER.test(text)) scale *= 1.15;
  if (SMALLER.test(text)) scale /= 1.15;

  const percent = text.match(/scale\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*%/i);
  if (percent) {
    const n = Number(percent[1]);
    if (Number.isFinite(n) && n > 0) scale *= n / 100;
  }
  const times = text.match(/scale\s+(?:by\s+)?(\d+(?:\.\d+)?)\s*x\b/i);
  if (times) {
    const n = Number(times[1]);
    if (Number.isFinite(n) && n > 0) scale *= n;
  }

  const targetMaxMm =
    numberAt(text, /(?:scale to|overall|make it|size (?:to|of))\s+(\d+(?:\.\d+)?)\s*mm/i) ??
    numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:tall|wide|long|overall)/i);

  let rotateZDeg: number | null = null;
  const deg = text.match(/(\d+(?:\.\d+)?)\s*deg(?:ree)?s?/i);
  if (ROTATE.test(text) && deg) {
    const n = Number(deg[1]);
    if (Number.isFinite(n)) rotateZDeg = n;
  } else if (/\brotate\s+(?:left|ccw|counter[- ]?clockwise)\b/i.test(text)) {
    rotateZDeg = 90;
  } else if (/\brotate\s+(?:right|cw|clockwise)\b/i.test(text)) {
    rotateZDeg = -90;
  } else if (/\brotate\b/i.test(text)) {
    rotateZDeg = 90;
  }

  const sitOnBed = SIT_ON_BED.test(text);
  const hasTransform =
    wearableSize !== null ||
    Math.abs(scale - 1) > 1e-9 ||
    targetMaxMm !== null ||
    rotateZDeg !== null ||
    sitOnBed;

  if (!text && wearableSize) {
    return {
      kind: "transform",
      wearableSize,
      wearableCategory,
      scale: 1,
      targetMaxMm: null,
      rotateZDeg: null,
      sitOnBed: false,
      holeMm: null,
      addTab: false,
      notes,
    };
  }

  if (generative) {
    notes.push(
      "Generative remesh is partial: OpenSCAD wraps the imported STL (holes/tabs). Full triangle sculpt is not ready.",
    );
    return {
      kind: "describe-wrapper",
      wearableSize,
      wearableCategory,
      scale,
      targetMaxMm,
      rotateZDeg,
      sitOnBed: sitOnBed || true,
      holeMm,
      addTab,
      notes,
    };
  }

  if (hasTransform || wearableSize) {
    return {
      kind: "transform",
      wearableSize,
      wearableCategory,
      scale,
      targetMaxMm,
      rotateZDeg,
      sitOnBed: sitOnBed || Boolean(wearableSize) || Math.abs(scale - 1) > 1e-9 || targetMaxMm !== null,
      holeMm: null,
      addTab: false,
      notes,
    };
  }

  notes.push(
    "Could not parse a scale/size/hole edit. Describe a size (S–XL), a scale, or a hole — or start a new part.",
  );
  return {
    kind: "describe-wrapper",
    wearableSize,
    wearableCategory,
    scale: 1,
    targetMaxMm: null,
    rotateZDeg: null,
    sitOnBed: true,
    holeMm: null,
    addTab: false,
    notes,
  };
}

export function hasMeshTransform(intent: MeshEditIntent): boolean {
  return (
    intent.wearableSize !== null ||
    Math.abs(intent.scale - 1) > 1e-9 ||
    intent.targetMaxMm !== null ||
    intent.rotateZDeg !== null ||
    intent.sitOnBed
  );
}
