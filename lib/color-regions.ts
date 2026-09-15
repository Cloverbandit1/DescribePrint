import { defaultPrinter, normalizeFilamentId, type FilamentId } from "./printers";

export const DEFAULT_COLOR_HEX = "#C4C4C8";
export const DEFAULT_COLOR_NAME = "default";
export const AMS_SLOT_MIN = 1;

export const NAMED_COLORS: Record<string, string> = {
  red: "#FF0000",
  crimson: "#DC143C",
  scarlet: "#FF2400",
  maroon: "#800000",
  black: "#1A1A1A",
  white: "#FFFFFF",
  ivory: "#FFFFF0",
  blue: "#2F6FED",
  navy: "#001F54",
  green: "#2E8B57",
  lime: "#32CD32",
  yellow: "#FFD100",
  orange: "#FF8C00",
  purple: "#7B2D8E",
  violet: "#8A2BE2",
  pink: "#FF69B4",
  magenta: "#FF00FF",
  cyan: "#00BCD4",
  teal: "#008080",
  brown: "#8B4513",
  beige: "#F5F5DC",
  gray: "#808080",
  grey: "#808080",
  silver: "#C0C0C0",
  gold: "#D4AF37",
  natural: DEFAULT_COLOR_HEX,
};

const COLOR_NAMES = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length);
const COLOR_ALT = COLOR_NAMES.join("|");
const FILAMENT_ALT = "petg|nylon|pla|abs|tpu|pa";
/** Named bodies users paint from chat (letters, base, plaque, …). */
export const COLOR_REGION_FEATURES = [
  "letters",
  "letter",
  "text",
  "logo",
  "inlay",
  "accent",
  "label",
  "numbers",
  "number",
  "icon",
  "body",
  "base",
  "cube",
  "plaque",
  "plate",
  "stand",
  "knob",
  "cap",
  "stem",
  "handle",
  "lid",
  "inset",
  "face",
  "rim",
  "ring",
  "button",
  "bar",
] as const;
const FEATURE_ALT = "letters?|text|logo|inlay|accent|label|numbers?|icon|body|base|cube|plaque|plate|stand|knob|cap|stem|handle|lid|inset|face|rim|ring|button|bar";

export type ColorRegion = {
  id: string;
  name: string;
  colorName: string;
  /** #RRGGBB */
  colorHex: string;
  filament: FilamentId;
  /** 1-based P2S/AMS slot metadata (1–4). Not a live printer mapping. */
  amsSlot: number;
};

export type ColorRegionDraft = {
  name?: string;
  color?: string;
  hex?: string;
  filament?: string;
  ams_slot?: number;
  amsSlot?: number;
};

export function amsSlotCount(): number {
  return defaultPrinter().ams.slotsPerUnit;
}

export function slugifyRegionName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "region";
}

export function normalizeColorHex(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw)) {
    return `#${raw.slice(0, 6).toUpperCase()}`;
  }
  return undefined;
}

export function displayColorHex(hex: string): string {
  const norm = normalizeColorHex(hex) ?? DEFAULT_COLOR_HEX;
  return `${norm}FF`;
}

export function resolveColorToken(token: string | undefined | null): { colorName: string; colorHex: string } | null {
  if (!token) return null;
  const hex = normalizeColorHex(token);
  if (hex) {
    const named = Object.entries(NAMED_COLORS).find(([, value]) => value === hex);
    return { colorName: named?.[0] ?? hex, colorHex: hex };
  }
  const key = token.trim().toLowerCase();
  const mapped = NAMED_COLORS[key];
  if (!mapped) return null;
  return { colorName: key === "grey" ? "gray" : key, colorHex: mapped };
}

function resolveFilament(value: string | undefined | null): FilamentId {
  return normalizeFilamentId(value) ?? "pla";
}

export function defaultColorRegion(): ColorRegion {
  return {
    id: "part",
    name: "part",
    colorName: DEFAULT_COLOR_NAME,
    colorHex: DEFAULT_COLOR_HEX,
    filament: "pla",
    amsSlot: AMS_SLOT_MIN,
  };
}

export function isDefaultOnlyRegions(regions: ColorRegion[]): boolean {
  return regions.length <= 1 && (regions[0]?.colorName ?? DEFAULT_COLOR_NAME) === DEFAULT_COLOR_NAME;
}

/** True when every region is still the uncolored default (even if there are several named solids). */
export function isUncoloredRegions(regions: ColorRegion[]): boolean {
  return regions.every((region) => (region.colorName ?? DEFAULT_COLOR_NAME) === DEFAULT_COLOR_NAME);
}

/** Stamp the Machine-panel material onto uncolored regions. Named colors keep their own filament. */
export function withSelectedFilament(regions: ColorRegion[], filament: FilamentId): ColorRegion[] {
  if (!isUncoloredRegions(regions)) return regions;
  return regions.map((region) => ({ ...region, filament }));
}

function pushDraft(into: ColorRegionDraft[], draft: ColorRegionDraft) {
  const name = draft.name?.trim().toLowerCase();
  const color = (draft.hex ?? draft.color)?.trim().toLowerCase();
  const existing = into.find((item) => {
    const itemName = item.name?.trim().toLowerCase();
    const itemColor = (item.hex ?? item.color)?.trim().toLowerCase();
    if (name && itemName && name === itemName) return true;
    if (!name && !itemName && color && itemColor && color === itemColor) return true;
    return false;
  });
  if (existing) {
    existing.name ||= draft.name;
    existing.color ||= draft.color;
    existing.hex ||= draft.hex;
    existing.filament ||= draft.filament;
    existing.ams_slot ??= draft.ams_slot;
    existing.amsSlot ??= draft.amsSlot;
    return;
  }
  into.push({ ...draft });
}

export function parseColorRegionsFromPrompt(prompt: string): ColorRegionDraft[] {
  const text = prompt ?? "";
  const drafts: ColorRegionDraft[] = [];

  const colorThenFeature = new RegExp(
    `\\b(${COLOR_ALT})\\b(?:\\s+(${FILAMENT_ALT}))?(?:\\s+\\d+(?:\\.\\d+)?\\s*mm)?\\s+(${FEATURE_ALT})\\b`,
    "gi",
  );
  for (const match of text.matchAll(colorThenFeature)) {
    pushDraft(drafts, { color: match[1], filament: match[2], name: match[3] });
  }

  const featureThenColor = new RegExp(
    `\\b(${FEATURE_ALT})\\b(?:\\s+(?:in|of))?\\s+(?:(${FILAMENT_ALT})\\s+)?(${COLOR_ALT})\\b`,
    "gi",
  );
  for (const match of text.matchAll(featureThenColor)) {
    pushDraft(drafts, { name: match[1], filament: match[2], color: match[3] });
  }

  const hexFeature = new RegExp(`#([0-9a-f]{6}|[0-9a-f]{3})\\b(?:\\s+(${FEATURE_ALT}))?`, "gi");
  for (const match of text.matchAll(hexFeature)) {
    pushDraft(drafts, { hex: `#${match[1]}`, name: match[2] });
  }

  const filamentColor = new RegExp(`\\b(${FILAMENT_ALT})\\b\\s+(${COLOR_ALT})\\b`, "gi");
  for (const match of text.matchAll(filamentColor)) {
    pushDraft(drafts, { filament: match[1], color: match[2] });
  }

  if (drafts.length === 0) {
    const lone = new RegExp(`\\b(${COLOR_ALT})\\b`, "gi");
    for (const match of text.matchAll(lone)) {
      pushDraft(drafts, { color: match[1], name: match[1] });
    }
  }

  return drafts;
}

export function normalizeColorRegions(
  drafts: ColorRegionDraft[] | undefined | null,
  opts: { maxSlots?: number } = {},
): ColorRegion[] {
  const maxSlots = opts.maxSlots ?? amsSlotCount();
  const resolved: Omit<ColorRegion, "amsSlot">[] = [];

  for (const draft of drafts ?? []) {
    const token = resolveColorToken(draft.hex) ?? resolveColorToken(draft.color);
    if (!token && !draft.name) continue;
    const colorName = token?.colorName ?? DEFAULT_COLOR_NAME;
    const colorHex = token?.colorHex ?? DEFAULT_COLOR_HEX;
    const rawName = (draft.name ?? colorName).trim() || colorName;
    const name = rawName.replace(/s$/i, "").toLowerCase() === "letter" ? "letters" : rawName;
    resolved.push({
      id: slugifyRegionName(name),
      name,
      colorName,
      colorHex,
      filament: resolveFilament(draft.filament),
    });
  }

  const unique: Omit<ColorRegion, "amsSlot">[] = [];
  for (const region of resolved) {
    const existing = unique.find((item) => item.id === region.id);
    if (existing) {
      if (existing.colorName === DEFAULT_COLOR_NAME && region.colorName !== DEFAULT_COLOR_NAME) {
        existing.colorName = region.colorName;
        existing.colorHex = region.colorHex;
      }
      if (region.filament && region.filament !== existing.filament) {
        existing.filament = region.filament;
      }
      continue;
    }
    unique.push(region);
  }

  if (unique.length === 0) {
    return [defaultColorRegion()];
  }

  const slotByKey = new Map<string, number>();
  let nextSlot = AMS_SLOT_MIN;
  const assigned: ColorRegion[] = unique.map((region, index) => {
    const hinted = drafts?.[index]?.amsSlot ?? drafts?.[index]?.ams_slot;
    const key = `${region.filament}:${region.colorHex}`;
    let amsSlot = typeof hinted === "number" && hinted >= AMS_SLOT_MIN && hinted <= maxSlots ? hinted : slotByKey.get(key);
    if (amsSlot === undefined) {
      amsSlot = Math.min(nextSlot, maxSlots);
      slotByKey.set(key, amsSlot);
      if (nextSlot < maxSlots) nextSlot += 1;
    }
    return { ...region, amsSlot };
  });

  return assigned;
}

export function colorRegionsFromPrompt(prompt: string): ColorRegion[] {
  return normalizeColorRegions(parseColorRegionsFromPrompt(prompt));
}

export function mergeColorRegionSources(
  prompt: string,
  planned?: ColorRegionDraft[] | null,
): ColorRegion[] {
  const fromPlan = normalizeColorRegions(planned ?? []);
  if (!isDefaultOnlyRegions(fromPlan)) return fromPlan;
  return colorRegionsFromPrompt(prompt);
}

export function colorRegionsNote(regions: ColorRegion[]): string {
  if (isDefaultOnlyRegions(regions)) {
    return "3MF uses one default material object (uncolored gray). Mention colors (e.g. red body, black letters) to export filament regions.";
  }
  const parts = regions.map((region) => {
    const filament = region.filament.toUpperCase();
    return `${region.name} (${region.colorName} ${filament}, AMS ${region.amsSlot})`;
  });
  if (regions.length === 1) {
    return `3MF material: ${parts[0]}. Single color object — a slicer can still assign a filament. Export metadata only; not live AMS.`;
  }
  return `3MF has ${regions.length} color objects: ${parts.join("; ")}. A slicer can assign filaments from object colors / extruder indices. Export metadata only; not live AMS.`;
}

export function regionsToDesignFilaments(regions: ColorRegion[]) {
  return regions.map((region) => ({
    id: region.id,
    type: region.filament,
    colorHex: region.colorHex,
    name: region.name,
  }));
}
