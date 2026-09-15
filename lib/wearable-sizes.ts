import type { WearableSizeId } from "./types";

export type WearableMeasurementsMm = {
  /** Head circumference stub (helmets / masks). */
  headCirc: number;
  /** Chest circumference stub (cuirass / vests). */
  chest: number;
  /** Wrist circumference stub (bracers / cuffs). */
  wrist: number;
};

export type WearableSizePreset = {
  id: WearableSizeId;
  label: string;
  /** Uniform scale versus Medium. Medium is native / 1.0. */
  scaleFromM: number;
  measurementsMm: WearableMeasurementsMm;
};

/**
 * Placeholder wearable / cosplay chart. Numbers are typical adult costume
 * stubs in millimeters — not a fitted grading system. Wired so S–XL can
 * auto-scale a plate mesh and show the assumed size.
 */
export const WEARABLE_SIZE_PRESETS: Record<WearableSizeId, WearableSizePreset> = {
  S: {
    id: "S",
    label: "Small",
    scaleFromM: 0.88,
    measurementsMm: { headCirc: 540, chest: 860, wrist: 150 },
  },
  M: {
    id: "M",
    label: "Medium",
    scaleFromM: 1,
    measurementsMm: { headCirc: 570, chest: 960, wrist: 165 },
  },
  L: {
    id: "L",
    label: "Large",
    scaleFromM: 1.12,
    measurementsMm: { headCirc: 600, chest: 1060, wrist: 180 },
  },
  XL: {
    id: "XL",
    label: "Extra large",
    scaleFromM: 1.24,
    measurementsMm: { headCirc: 630, chest: 1160, wrist: 195 },
  },
};

export const WEARABLE_SIZE_IDS: WearableSizeId[] = ["S", "M", "L", "XL"];

export function isWearableSizeId(value: unknown): value is WearableSizeId {
  return value === "S" || value === "M" || value === "L" || value === "XL";
}

export function getWearableSize(id: WearableSizeId): WearableSizePreset {
  return WEARABLE_SIZE_PRESETS[id];
}

/** Scale to apply when going from one assumed size to another. Native/null is M. */
export function wearableScaleFactor(
  from: WearableSizeId | null | undefined,
  to: WearableSizeId,
): number {
  const start = WEARABLE_SIZE_PRESETS[from ?? "M"].scaleFromM;
  const end = WEARABLE_SIZE_PRESETS[to].scaleFromM;
  if (start === 0) return 1;
  return end / start;
}

/**
 * Parse an explicit wearable preset from chat. Does not treat "larger" /
 * "large hole" as size L.
 */
export function parseWearableSizeFromPrompt(prompt: string): WearableSizeId | null {
  const text = prompt.trim();
  if (!text) return null;
  if (/\b(x-?large|extra[\s-]?large|\bxl\b|x-?l\b)\b/i.test(text)) return "XL";
  if (/\bsize\s+l\b/i.test(text) || /\bwearable size\s+l\b/i.test(text)) return "L";
  if (/\bsize\s+m\b/i.test(text) || /\bmedium\b/i.test(text)) return "M";
  if (/\bsize\s+s\b/i.test(text) || (/\bsmall\b/i.test(text) && !/\bsmaller\b/i.test(text))) {
    return "S";
  }
  if (/\blarge\b/i.test(text) && !/\blarger\b|\blargest\b|large\s+hole\b/i.test(text)) {
    return "L";
  }
  return null;
}

export function describeWearableSize(id: WearableSizeId | null | undefined): string {
  if (!id) {
    return "Assumed size: Medium (native mesh, stub chart)";
  }
  const preset = WEARABLE_SIZE_PRESETS[id];
  const { headCirc, chest, wrist } = preset.measurementsMm;
  return `Assumed size: ${preset.id} (${preset.label}, stub chart ${preset.scaleFromM}× vs M · head ${headCirc} · chest ${chest} · wrist ${wrist} mm)`;
}

export function wearableChartNote(): string {
  return "Wearable S/M/L/XL uses a placeholder measurement chart (not a custom-fit grade).";
}
