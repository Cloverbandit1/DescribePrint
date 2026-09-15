import type { WearableCategoryId, WearableSizeId } from "./types";

export type WearableMeasurementKey =
  | "headCirc"
  | "chest"
  | "waist"
  | "handCirc"
  | "handLength"
  | "wrist"
  | "forearm";

export const MEASUREMENT_LABELS: Record<WearableMeasurementKey, string> = {
  headCirc: "Head circ",
  chest: "Chest",
  waist: "Waist",
  handCirc: "Hand circ",
  handLength: "Hand length",
  wrist: "Wrist",
  forearm: "Forearm",
};

export type WearableCategoryChart = {
  id: WearableCategoryId;
  label: string;
  shortLabel: string;
  /** Governing fit measurement — uniform scale is this value vs Medium. */
  primaryKey: WearableMeasurementKey;
  keys: WearableMeasurementKey[];
  sizes: Record<WearableSizeId, Partial<Record<WearableMeasurementKey, number>>>;
  sources: string[];
};

export const DEFAULT_WEARABLE_CATEGORY: WearableCategoryId = "helmet_mask";

export const WEARABLE_SIZE_IDS: WearableSizeId[] = ["S", "M", "L", "XL"];

export const WEARABLE_CATEGORY_IDS: WearableCategoryId[] = [
  "helmet_mask",
  "torso_armor",
  "gauntlet",
  "bracer",
];

export const WEARABLE_SIZE_LABELS: Record<WearableSizeId, string> = {
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Extra large",
};

/**
 * Documented adult S–XL charts in millimetres. Values are body/fit
 * measurements (not garment ease). Medium is the native-mesh reference.
 *
 * Scale choice: **uniform** (isotropic) from the category primary
 * measurement. Axis-aware XYZ would ovalize holes, thin walls on one
 * axis, and break printability checks — imported meshes also have no
 * reliable semantic axes. Native / unset size is treated as Medium.
 */
export const WEARABLE_CATEGORY_CHARTS: Record<WearableCategoryId, WearableCategoryChart> = {
  helmet_mask: {
    id: "helmet_mask",
    label: "Helmet / mask",
    shortLabel: "Helmet",
    primaryKey: "headCirc",
    keys: ["headCirc"],
    sizes: {
      S: { headCirc: 555 },
      M: { headCirc: 575 },
      L: { headCirc: 595 },
      XL: { headCirc: 615 },
    },
    sources: [
      "EN 960:2006 headform size designations (circumference at the reference plane, 10 mm steps): 555 / 575 / 595 / 615 mm.",
      "Letter mapping follows common ECE/DOT helmet charts (S 55–56 cm, M 57–58, L 59–60, XL 61–62), using the matching EN 960 designation.",
    ],
  },
  torso_armor: {
    id: "torso_armor",
    label: "Torso armor",
    shortLabel: "Torso",
    primaryKey: "chest",
    keys: ["chest", "waist"],
    sizes: {
      S: { chest: 900, waist: 760 },
      M: { chest: 1000, waist: 860 },
      L: { chest: 1100, waist: 960 },
      XL: { chest: 1200, waist: 1060 },
    },
    sources: [
      "ISO 8559-2: chest girth is the primary size designation for adult jackets / torso garments; waist is secondary.",
      "ISO 8559-3 typical adult girth interval is 50 mm; S–XL uses every other step (100 mm) centered on a 1000 mm (100 cm) Medium.",
    ],
  },
  gauntlet: {
    id: "gauntlet",
    label: "Gauntlet / glove",
    shortLabel: "Gauntlet",
    primaryKey: "handCirc",
    keys: ["handCirc", "handLength"],
    sizes: {
      S: { handCirc: 178, handLength: 171 },
      M: { handCirc: 203, handLength: 182 },
      L: { handCirc: 229, handLength: 192 },
      XL: { handCirc: 254, handLength: 204 },
    },
    sources: [
      "EN ISO 21420:2020 Annex B (and EN 420) hand sizes 7–10: circumference 178 / 203 / 229 / 254 mm; length 171 / 182 / 192 / 204 mm.",
      "Letter mapping is the usual PPE glove alias: 7 = S, 8 = M, 9 = L, 10 = XL.",
    ],
  },
  bracer: {
    id: "bracer",
    label: "Bracer / cuff",
    shortLabel: "Bracer",
    primaryKey: "wrist",
    keys: ["wrist", "forearm"],
    sizes: {
      S: { wrist: 152, forearm: 240 },
      M: { wrist: 165, forearm: 265 },
      L: { wrist: 178, forearm: 290 },
      XL: { wrist: 191, forearm: 315 },
    },
    sources: [
      "Wrist girth is defined in ISO 8559-1 (measurement method). Adult S–XL uses a 13 mm (½ in) apparel grade from 152–191 mm.",
      "Forearm is a secondary fit girth at a 25 mm grade from 240–315 mm, spanning typical adult ranges (not a custom-fit scan).",
    ],
  },
};

const CATEGORY_HINTS: Array<{ id: WearableCategoryId; pattern: RegExp }> = [
  { id: "gauntlet", pattern: /\b(gauntlets?|gloves?|mittens?|knuckles?)\b/i },
  { id: "bracer", pattern: /\b(bracers?|vambraces?|cuffs?|wrist|forearm|arm\s*guard)\b/i },
  { id: "helmet_mask", pattern: /\b(helmets?|helms?|masks?|visors?|hoods?)\b/i },
  { id: "torso_armor", pattern: /\b(armou?r|cuirass|chest|breast\s*plates?|vests?|torso|plastron|breastplate)\b/i },
];

export function isWearableSizeId(value: unknown): value is WearableSizeId {
  return value === "S" || value === "M" || value === "L" || value === "XL";
}

export function isWearableCategoryId(value: unknown): value is WearableCategoryId {
  return (
    value === "helmet_mask" || value === "torso_armor" || value === "gauntlet" || value === "bracer"
  );
}

export function getWearableCategory(id: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY): WearableCategoryChart {
  return WEARABLE_CATEGORY_CHARTS[id];
}

export function primaryMeasurementMm(
  size: WearableSizeId,
  category: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): number {
  const chart = getWearableCategory(category);
  const value = chart.sizes[size][chart.primaryKey];
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Missing primary measurement for ${category} ${size}`);
  }
  return value;
}

/** Size ratio versus Medium for a category (Medium = 1). */
export function wearableSizeRatio(
  size: WearableSizeId,
  category: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): number {
  const medium = primaryMeasurementMm("M", category);
  return primaryMeasurementMm(size, category) / medium;
}

/**
 * Uniform scale from one assumed size/category to another.
 * Native / null size is Medium. Switching category re-grades against Medium.
 */
export function wearableScaleFactor(
  from: WearableSizeId | null | undefined,
  to: WearableSizeId,
  fromCategory?: WearableCategoryId | null,
  toCategory?: WearableCategoryId | null,
): number {
  const destCategory = toCategory ?? fromCategory ?? DEFAULT_WEARABLE_CATEGORY;
  const srcCategory = fromCategory ?? destCategory;
  const start = wearableSizeRatio(from ?? "M", srcCategory);
  const end = wearableSizeRatio(to, destCategory);
  if (start === 0) return 1;
  return end / start;
}

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

export function parseWearableCategoryFromPrompt(prompt: string): WearableCategoryId | null {
  const text = prompt.trim();
  if (!text) return null;
  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(text)) return hint.id;
  }
  return null;
}

export function inferWearableCategory(
  ...sources: Array<string | null | undefined>
): WearableCategoryId {
  for (const source of sources) {
    const found = parseWearableCategoryFromPrompt(source ?? "");
    if (found) return found;
  }
  return DEFAULT_WEARABLE_CATEGORY;
}

export function describeWearableMeasurements(
  size: WearableSizeId,
  category: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): string {
  const chart = getWearableCategory(category);
  return chart.keys
    .map((key) => {
      const mm = chart.sizes[size][key];
      const mark = key === chart.primaryKey ? "*" : "";
      return `${MEASUREMENT_LABELS[key]}${mark} ${mm}`;
    })
    .join(" · ");
}

export function describeWearableSize(
  id: WearableSizeId | null | undefined,
  category: WearableCategoryId = DEFAULT_WEARABLE_CATEGORY,
): string {
  const chart = getWearableCategory(category);
  const size = id ?? "M";
  const label = WEARABLE_SIZE_LABELS[size];
  const scale = wearableSizeRatio(size, category);
  const measurements = describeWearableMeasurements(size, category);
  const native = !id ? "native mesh, " : "";
  return `Assumed size: ${size} (${label}, ${native}${chart.label} · ${measurements} mm · uniform ${scale.toFixed(3)}× vs M)`;
}

export function wearableChartNote(): string {
  return "Wearable S–XL uses documented measurement charts in mm. Scale is uniform from the category’s primary measurement so walls and holes stay proportional.";
}

export function wearableScaleNote(): string {
  return "Uniform scale (not axis-aware): factor = primary_mm(to) / primary_mm(from). Medium is 1.0. Preserves #11 printability.";
}
