/**
 * CAD-side region paint: assign / recolor named bodies from chat or chips.
 *
 * Emits region names + colors + suggested extruder indices for 3MF export.
 * AMS physical tray mapping stays Print Control — this is not live AMS.
 */
import {
  AMS_SLOT_MIN,
  COLOR_REGION_FEATURES,
  DEFAULT_COLOR_NAME,
  NAMED_COLORS,
  amsSlotCount,
  defaultColorRegion,
  isDefaultOnlyRegions,
  normalizeColorHex,
  normalizeColorRegions,
  resolveColorToken,
  slugifyRegionName,
  type ColorRegion,
} from "./color-regions";
import { normalizeFilamentId } from "./printers";
import { wantsNewDesign } from "./printability";
import type { ThreeMfObject } from "./threemf";

export const PAINT_CHIP_COLORS = ["red", "black", "white", "blue"] as const;

export const UNSPLIT_COLOR_NOTE =
  "OpenSCAD compiled as one mesh, so this 3MF has a single colored object. Named region_* modules or color() groups are needed to split filament bodies.";

export type RegionPaintIntent = {
  name?: string;
  color?: string;
  hex?: string;
  filament?: string;
};

const FEATURE_ALT = COLOR_REGION_FEATURES.join("|");
const COLOR_ALT = Object.keys(NAMED_COLORS).sort((a, b) => b.length - a.length).join("|");
const FILAMENT_ALT = "petg|nylon|pla|abs|tpu|pa";

const PAINT_VERB = /\b(?:paint|recolou?r|re-colou?r|tint|dye)\b/i;
const COLOR_THE_FEATURE = new RegExp(
  `\\bcolou?r(?:ed)?\\s+(?:the\\s+)?(${FEATURE_ALT}|[a-z][a-z0-9_-]{1,24})\\b`,
  "i",
);
const GEOMETRY_EDIT =
  /\b(hole|bore|cut|slot|slit|tab|thicken|fillet|chamfer|emboss|engrave|etch|add a|add an|difference|boolean|remesh|carve|pocket|pretty(?:\s+(?:it|this|that|the\s+\w+))?(?:\s|-)?up|restyle|steampunk|decorative\s+(?:ribs?|panels?)|round(?:\s+the)?\s+edges|bigger|smaller|scale|rotate|sit on)\b/i;
const NEW_PART_SHAPE =
  /\b(cube|stand|knob|plaque|helmet|box|bracket|hook|clip|phone)\b/i;
const STATED_MM = /\b\d+(?:\.\d+)?\s*mm\b/i;

const REGION_ALIASES: Record<string, string[]> = {
  letters: ["letter", "letters", "text", "logo", "inlay", "number", "numbers", "label", "icon"],
  body: ["body", "plaque", "plate", "cube", "part", "stand"],
  base: ["base", "stand", "plate"],
  accent: ["accent", "inlay", "logo", "icon"],
};

export function looksLikeRegionPaint(prompt: string): boolean {
  const text = (prompt ?? "").trim();
  if (!text) return false;
  if (MAKE_FEATURE_COLOR().test(text) || SET_FEATURE_COLOR().test(text) || COLOR_THE_FEATURE.test(text)) return true;
  return PAINT_VERB.test(text);
}

export function isRegionPaintOnly(prompt: string): boolean {
  const text = (prompt ?? "").trim();
  if (!looksLikeRegionPaint(text)) return false;
  if (wantsNewDesign(text)) return false;
  if (GEOMETRY_EDIT.test(text)) return false;
  if (STATED_MM.test(text) && NEW_PART_SHAPE.test(text)) return false;
  return text.length > 0 && text.length < 140;
}

function MAKE_FEATURE_COLOR() {
  return new RegExp(
    `\\bmake\\s+(?:the\\s+)?(${FEATURE_ALT}|[a-z][a-z0-9_-]{1,24})\\s+(?:(?:to|as|in)\\s+)?(?:(${FILAMENT_ALT})\\s+)?(?:(${COLOR_ALT})|(#(?:[0-9a-f]{3}|[0-9a-f]{6})))\\b`,
    "gi",
  );
}

function SET_FEATURE_COLOR() {
  return new RegExp(
    `\\bset\\s+(?:the\\s+)?(${FEATURE_ALT}|[a-z][a-z0-9_-]{1,24})\\s+to\\s+(?:(${FILAMENT_ALT})\\s+)?(?:(${COLOR_ALT})|(#(?:[0-9a-f]{3}|[0-9a-f]{6})))\\b`,
    "gi",
  );
}

function PAINT_FEATURE_COLOR() {
  return new RegExp(
    `\\b(?:paint|recolou?r|re-colou?r|tint|dye|colou?r)\\s+(?:the\\s+)?(${FEATURE_ALT}|[a-z][a-z0-9_-]{1,24}|it|this)\\s+(?:(?:to|as|in)\\s+)?(?:(${FILAMENT_ALT})\\s+)?(?:(${COLOR_ALT})|(#(?:[0-9a-f]{3}|[0-9a-f]{6})))\\b`,
    "gi",
  );
}

function PAINT_FEATURE_ONLY() {
  return new RegExp(
    `\\b(?:paint|recolou?r|re-colou?r|tint|dye|colou?r)\\s+(?:the\\s+)?(${FEATURE_ALT}|[a-z][a-z0-9_-]{1,24})\\b`,
    "gi",
  );
}

function PAINT_COLOR_ONLY() {
  return new RegExp(
    `\\b(?:paint|recolou?r|re-colou?r|tint|dye|colou?r)\\s+(?:it|this|everything)?\\s*(?:(?:to|as|in)\\s+)?(?:(${FILAMENT_ALT})\\s+)?(?:(${COLOR_ALT})|(#(?:[0-9a-f]{3}|[0-9a-f]{6})))\\b`,
    "gi",
  );
}

function canonicalRegionName(raw: string): string {
  const slug = slugifyRegionName(raw);
  if (slug === "letter") return "letters";
  if (slug === "number") return "numbers";
  return raw.trim() || slug;
}

function pushIntent(into: RegionPaintIntent[], intent: RegionPaintIntent) {
  const name = intent.name && !/^(it|this)$/i.test(intent.name) ? canonicalRegionName(intent.name) : undefined;
  const next = { ...intent, name };
  const existing = into.find((item) => {
    if (name && item.name && slugifyRegionName(name) === slugifyRegionName(item.name)) return true;
    if (!name && !item.name && (next.color || next.hex) && (item.color || item.hex)) {
      return (next.hex ?? next.color)?.toLowerCase() === (item.hex ?? item.color)?.toLowerCase();
    }
    return false;
  });
  if (existing) {
    existing.name ||= next.name;
    existing.color ||= next.color;
    existing.hex ||= next.hex;
    existing.filament ||= next.filament;
    return;
  }
  into.push(next);
}

export function parseRegionPaintIntents(prompt: string): RegionPaintIntent[] {
  const text = prompt ?? "";
  const intents: RegionPaintIntent[] = [];

  for (const match of text.matchAll(PAINT_FEATURE_COLOR())) {
    pushIntent(intents, { name: match[1], filament: match[2], color: match[3], hex: match[4] });
  }
  for (const match of text.matchAll(MAKE_FEATURE_COLOR())) {
    pushIntent(intents, { name: match[1], filament: match[2], color: match[3], hex: match[4] });
  }
  for (const match of text.matchAll(SET_FEATURE_COLOR())) {
    pushIntent(intents, { name: match[1], filament: match[2], color: match[3], hex: match[4] });
  }

  if (intents.length === 0) {
    for (const match of text.matchAll(PAINT_FEATURE_ONLY())) {
      if (/^(it|this)$/i.test(match[1] ?? "")) continue;
      pushIntent(intents, { name: match[1] });
    }
    for (const match of text.matchAll(PAINT_COLOR_ONLY())) {
      if (match[2] || match[3]) {
        pushIntent(intents, { filament: match[1], color: match[2], hex: match[3] });
      }
    }
  }

  return intents;
}

export function paintIntentComplete(intent: RegionPaintIntent): boolean {
  return Boolean(intent.name && (resolveColorToken(intent.hex) || resolveColorToken(intent.color)));
}

function aliasIds(name: string): string[] {
  const slug = slugifyRegionName(name);
  const ids = new Set<string>([slug]);
  for (const [canonical, aliases] of Object.entries(REGION_ALIASES)) {
    if (canonical === slug || aliases.includes(slug)) {
      ids.add(canonical);
      for (const alias of aliases) ids.add(alias);
    }
  }
  return [...ids];
}

export function findPaintTarget(regions: ColorRegion[], name: string): ColorRegion | undefined {
  const wanted = aliasIds(name);
  return (
    regions.find((region) => wanted.includes(slugifyRegionName(region.id))) ??
    regions.find((region) => wanted.includes(slugifyRegionName(region.name)))
  );
}

export function applyRegionPaint(
  existing: ColorRegion[],
  intents: RegionPaintIntent[],
  opts: { maxSlots?: number } = {},
): ColorRegion[] {
  const maxSlots = opts.maxSlots ?? amsSlotCount();
  if (!intents.length) return existing.length ? existing : [defaultColorRegion()];

  const next = (existing.length ? existing : [defaultColorRegion()]).map((region) => ({ ...region }));

  for (const intent of intents) {
    const token = resolveColorToken(intent.hex) ?? resolveColorToken(intent.color);
    if (!token) continue;
    const filament = normalizeFilamentId(intent.filament);
    const target = intent.name ? findPaintTarget(next, intent.name) : next.length === 1 ? next[0] : undefined;
    if (target) {
      target.colorName = token.colorName;
      target.colorHex = token.colorHex;
      if (filament) target.filament = filament;
      if (intent.name && (target.id === "part" || target.colorName === DEFAULT_COLOR_NAME || target.name === "part")) {
        target.name = canonicalRegionName(intent.name);
        target.id = slugifyRegionName(target.name);
      }
      continue;
    }
    if (intent.name && next.length <= 1) {
      const only = next[0] ?? defaultColorRegion();
      only.name = canonicalRegionName(intent.name);
      only.id = slugifyRegionName(only.name);
      only.colorName = token.colorName;
      only.colorHex = token.colorHex;
      if (filament) only.filament = filament;
      if (!next[0]) next.push(only);
      continue;
    }
    if (intent.name) {
      next.push({
        id: slugifyRegionName(canonicalRegionName(intent.name)),
        name: canonicalRegionName(intent.name),
        colorName: token.colorName,
        colorHex: token.colorHex,
        filament: filament ?? "pla",
        amsSlot: AMS_SLOT_MIN,
      });
    }
  }

  const unique = new Map<string, ColorRegion>();
  for (const region of next) {
    unique.set(region.id || slugifyRegionName(region.name), region);
  }
  return normalizeColorRegions(
    [...unique.values()].map((region) => ({
      name: region.name,
      color: region.colorName,
      hex: region.colorHex,
      filament: region.filament,
      ams_slot: region.amsSlot,
    })),
    { maxSlots },
  );
}

export function paintThreeMfObjects(objects: ThreeMfObject[], regions: ColorRegion[]): ThreeMfObject[] {
  if (objects.length === 0) return objects;
  return objects.map((object, index) => {
    const byName =
      findPaintTarget(regions, object.name) ??
      regions.find((region) => slugifyRegionName(region.name) === slugifyRegionName(object.name));
    const region = byName ?? regions[index] ?? regions[0];
    if (!region) return object;
    return {
      ...object,
      name: object.name,
      colorHex: region.colorHex,
      colorName: region.colorName,
      filament: region.filament,
      extruder: region.amsSlot,
    };
  });
}

export function regionPaintNote(input: {
  before: ColorRegion[];
  after: ColorRegion[];
  objectCount: number;
}): string {
  const changes = input.after.flatMap((region) => {
    const prior = findPaintTarget(input.before, region.name) ?? input.before.find((item) => item.id === region.id);
    if (!prior) return [`${region.name} → ${region.colorName}`];
    if (prior.colorHex === region.colorHex && prior.filament === region.filament) return [];
    return [`${region.name} → ${region.colorName} ${region.filament.toUpperCase()}`];
  });
  const painted = changes.length ? `Recolored ${changes.join("; ")}.` : "Named color regions unchanged.";
  if (input.objectCount <= 1 && input.after.length > 1) {
    return `${painted} ${UNSPLIT_COLOR_NOTE}`;
  }
  if (input.objectCount >= 2) {
    return `${painted} 3MF still has ${input.objectCount} color objects with basematerials + extruder metadata. CAD export only — not live AMS.`;
  }
  return `${painted} Single colored 3MF object. A slicer can still assign a filament. Export metadata only; not live AMS.`;
}

export function suggestedPaintFollowUp(regions: ColorRegion[]): string | null {
  if (isDefaultOnlyRegions(regions)) return null;
  const letters = findPaintTarget(regions, "letters");
  if (letters) {
    const next = letters.colorName === "black" ? "white" : "black";
    return `Paint the letters ${next}`;
  }
  const base = findPaintTarget(regions, "base") ?? findPaintTarget(regions, "body") ?? regions[0];
  if (!base) return null;
  const next = base.colorName === "red" ? "black" : "red";
  return `Make the ${base.name} ${next}`;
}

export function regionPaintChoiceValue(regionId: string, colorName: string): string {
  return `${slugifyRegionName(regionId)}:${colorName}`;
}

export function parseRegionPaintChoice(value: string): { name: string; color: string } | null {
  const match = String(value ?? "").trim().match(/^([a-z0-9_]+):([#a-z0-9]+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const token = resolveColorToken(match[2]);
  if (!token) return null;
  return { name: canonicalRegionName(match[1].replace(/_/g, " ")), color: token.colorName };
}

export function isRegionPaintChoiceValue(value: string): boolean {
  return parseRegionPaintChoice(value) !== null;
}

export function regionPaintChoicePhrase(value: string): string {
  const parsed = parseRegionPaintChoice(value);
  if (!parsed) return "";
  return `paint the ${parsed.name} ${parsed.color}`;
}

export function previewTintHex(regions: ColorRegion[]): string | null {
  const named = regions.filter((region) => region.colorName !== DEFAULT_COLOR_NAME);
  if (named.length !== 1) return null;
  return normalizeColorHex(named[0]?.colorHex) ?? null;
}

export function regionPaintOptionChips(input: {
  prompt?: string | null;
  regions?: ColorRegion[] | null;
}): Array<{ value: string; label: string; description: string }> {
  const prompt = input.prompt ?? "";
  const regions = input.regions ?? [];
  const intents = parseRegionPaintIntents(prompt);
  const complete = intents.filter(paintIntentComplete);
  if (complete.length && !intents.some((intent) => !paintIntentComplete(intent))) {
    return [];
  }

  const chips: Array<{ value: string; label: string; description: string }> = [];
  const push = (name: string, color: string) => {
    const value = regionPaintChoiceValue(name, color);
    if (chips.some((chip) => chip.value === value)) return;
    chips.push({
      value,
      label: `${canonicalRegionName(name)} ${color}`,
      description: `Paint the ${canonicalRegionName(name)} ${color}. CAD export — not live AMS.`,
    });
  };

  const incomplete = intents.filter((intent) => !paintIntentComplete(intent));
  for (const intent of incomplete) {
    if (intent.name && !(resolveColorToken(intent.hex) || resolveColorToken(intent.color))) {
      for (const color of PAINT_CHIP_COLORS) push(intent.name, color);
    } else if (!intent.name && (resolveColorToken(intent.hex) || resolveColorToken(intent.color))) {
      const token = resolveColorToken(intent.hex) ?? resolveColorToken(intent.color);
      if (!token) continue;
      const targets = regions.length ? regions : [{ name: "body", id: "body" } as ColorRegion];
      for (const region of targets.slice(0, 3)) push(region.name, token.colorName);
    }
  }

  if (chips.length === 0 && looksLikeRegionPaint(prompt)) {
    const targets = regions.filter((region) => region.colorName !== DEFAULT_COLOR_NAME);
    const named = targets.length ? targets : intents.flatMap((intent) => (intent.name ? [{ name: intent.name }] : []));
    for (const region of named.slice(0, 3)) {
      const current = "colorName" in region ? region.colorName : undefined;
      for (const color of PAINT_CHIP_COLORS) {
        if (color === current) continue;
        push(region.name, color);
        if (chips.length >= 6) break;
      }
    }
  }

  return chips.slice(0, 6);
}

export function mergePaintIntoRegions(
  prompt: string,
  previous: ColorRegion[] | null | undefined,
  plannedOrPrompt: ColorRegion[],
): ColorRegion[] {
  const intents = parseRegionPaintIntents(prompt).filter(paintIntentComplete);
  if (previous && previous.length && intents.length) {
    return applyRegionPaint(previous, intents);
  }
  if (!isDefaultOnlyRegions(plannedOrPrompt)) return plannedOrPrompt;
  if (previous && previous.length && !isDefaultOnlyRegions(previous) && !wantsNewDesign(prompt)) {
    return previous;
  }
  return plannedOrPrompt;
}

export function namedColorRegions(regions: ColorRegion[] | null | undefined): ColorRegion[] {
  return (regions ?? []).filter((region) => region.colorName !== DEFAULT_COLOR_NAME);
}
