/**
 * Mid-design choice chips for the describe loop.
 *
 * High-value forks only (scale, wearable size, material, PIP vs multi-part,
 * emboss face, vague color regions). Ordinary prompts like a sized cube
 * generate immediately — no options wall.
 */
import { colorRegionsFromPrompt, isDefaultOnlyRegions } from "./color-regions";
import { matchKnowledge, wantsWearableScale } from "./knowledge";
import { wantsMotion } from "./joints";
import { FILAMENT_IDS, isFilamentId, normalizeFilamentId, type FilamentId } from "./printers";
import { parseReliefRegion, promptHasRelief, type ReliefRegion } from "./relief";
import type { WearableSizeId } from "./types";
import { isWearableSizeId, parseWearableSizeFromPrompt, WEARABLE_SIZE_IDS, WEARABLE_SIZE_LABELS } from "./wearable-sizes";

export const DESIGN_OPTION_GROUP_IDS = [
  "scale_mode",
  "wearable_size",
  "material",
  "clearance",
  "emboss_face",
  "color_regions",
] as const;

export type DesignOptionGroupId = (typeof DESIGN_OPTION_GROUP_IDS)[number];

/** Chip the user can pick. Returned from generate/plan when a fork is open. */
export type DesignOption = {
  id: string;
  label: string;
  value: string;
  description?: string;
};

export type DesignOptionGroup = {
  id: DesignOptionGroupId;
  label: string;
  prompt: string;
  options: DesignOption[];
};

export type AppliedDesignChoice = {
  id: DesignOptionGroupId;
  value: string;
};

export type DesignOptionsResult = {
  needs_user_choice: boolean;
  options: DesignOptionGroup[];
  applied: AppliedDesignChoice[];
};

export type DesignOptionsInput = {
  prompt?: string | null;
  previousPrompt?: string | null;
  choices?: AppliedDesignChoice[] | null;
  wearableSize?: WearableSizeId | null;
  filament?: string | null;
  /** LLM/plan may mark a fork; still ignored unless a known group is open. */
  plan?: {
    needs_user_choice?: boolean;
    options?: unknown;
    clearance_intent?: string | null;
    knowledge?: { characters?: Array<{ id?: string }> | null } | null;
  } | null;
};

const EXPLICIT_PIP = /\b(print[-\s]?in[-\s]?place|\bpip\b|captured pin|as[-\s]?printed)\b/i;
const EXPLICIT_MULTI =
  /\b(separate parts|print separately|two pieces|three pieces|removable|multi[-\s]?part|kit of|loose parts|mating parts|hand[-\s]?assembl)\b/i;
const DISPLAY_SCALE =
  /\b(display(?:\s+scale)?|desk(?:top)?\s+scale|fit\s+(?:the\s+)?(?:p2s|bed|printer)|p2s\s+scale|printable\s+scale|miniature|\bmini\b)\b/i;
const ASKS_MATERIAL =
  /\b(?:what|which|pick|choose|select)\s+(?:a\s+)?(?:material|filament|plastic)\b|\bmaterial\s*\?|\bfilament\s*\?|\bin\s+plastic\b|\b(?:material|filament)\s+(?:please|choice|options?)\b/i;
const ASKS_COLOR =
  /\b(?:multi[-\s]?colou?r(?:ed)?|two\s+colou?rs|colou?r(?:\s+it|\s+this|\s+regions?)|ams\s+colou?rs?|paint(?:ed)?(?:\s+it)?|make\s+it\s+colou?rful)\b/i;
const STATED_OVERALL_MM = /(\d+(?:\.\d+)?)\s*(mm|millimeters?)\b/gi;

const RELIEF_REGIONS: ReliefRegion[] = ["front", "back", "left", "right", "top", "bottom"];

const GROUP_SET = new Set<string>(DESIGN_OPTION_GROUP_IDS);

export function isDesignOptionGroupId(value: unknown): value is DesignOptionGroupId {
  return typeof value === "string" && GROUP_SET.has(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function option(group: DesignOptionGroupId, value: string, label: string, description?: string): DesignOption {
  return { id: `${group}:${value}`, label, value, description };
}

export function parseAppliedChoices(raw: unknown): AppliedDesignChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: AppliedDesignChoice[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = asString(rec.id);
    const value = asString(rec.value);
    if (!id || !value || !isDesignOptionGroupId(id)) continue;
    if (!isKnownChoiceValue(id, value)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, value });
  }
  return out;
}

function isKnownChoiceValue(id: DesignOptionGroupId, value: string): boolean {
  switch (id) {
    case "scale_mode":
      return value === "display" || value === "wearable";
    case "wearable_size":
      return isWearableSizeId(value);
    case "material":
      return isFilamentId(value);
    case "clearance":
      return value === "print-in-place" || value === "multi-part";
    case "emboss_face":
      return (RELIEF_REGIONS as string[]).includes(value);
    case "color_regions":
      return value === "red_black" || value === "white_black" || value === "one";
    default:
      return false;
  }
}

export function upsertAppliedChoice(
  choices: AppliedDesignChoice[],
  next: AppliedDesignChoice,
): AppliedDesignChoice[] {
  if (!isDesignOptionGroupId(next.id) || !isKnownChoiceValue(next.id, next.value)) return choices;
  const rest = choices.filter((choice) => choice.id !== next.id);
  return [...rest, { id: next.id, value: next.value }];
}

export function choiceValue(choices: AppliedDesignChoice[], id: DesignOptionGroupId): string | undefined {
  return choices.find((choice) => choice.id === id)?.value;
}

function combinedText(prompt?: string | null, previousPrompt?: string | null): string {
  return [previousPrompt, prompt].filter((part) => part && part.trim()).join("\n");
}

function statedLargeMm(text: string): boolean {
  for (const match of text.matchAll(STATED_OVERALL_MM)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n >= 40) return true;
  }
  return false;
}

function scaleGroup(): DesignOptionGroup {
  return {
    id: "scale_mode",
    label: "Scale",
    prompt: "Fit the P2S bed, or print 1:1 wearable?",
    options: [
      option("scale_mode", "display", "Fit P2S", "Display size that fits the 256 mm bed."),
      option("scale_mode", "wearable", "1:1 wearable", "Life-size. May be bigger than the P2S."),
    ],
  };
}

function wearableSizeGroup(): DesignOptionGroup {
  return {
    id: "wearable_size",
    label: "Size",
    prompt: "Which wearable size?",
    options: WEARABLE_SIZE_IDS.map((size) =>
      option("wearable_size", size, size, WEARABLE_SIZE_LABELS[size]),
    ),
  };
}

function materialGroup(): DesignOptionGroup {
  const labels: Record<FilamentId, { label: string; description: string }> = {
    pla: { label: "PLA", description: "Easy default for display parts." },
    petg: { label: "PETG", description: "Tougher, dry the spool." },
    pa: { label: "PA", description: "Nylon — stronger, drier." },
    abs: { label: "ABS", description: "Enclosed P2S, watch fumes." },
    tpu: { label: "TPU", description: "Flexible; slower print." },
  };
  return {
    id: "material",
    label: "Material",
    prompt: "Which filament?",
    options: FILAMENT_IDS.map((id) => option("material", id, labels[id].label, labels[id].description)),
  };
}

function clearanceGroup(): DesignOptionGroup {
  return {
    id: "clearance",
    label: "Joints",
    prompt: "Print-in-place, or separate pieces?",
    options: [
      option("clearance", "print-in-place", "Print-in-place", "One print with documented gaps."),
      option("clearance", "multi-part", "Multi-part", "Separate pieces you assemble."),
    ],
  };
}

function embossFaceGroup(): DesignOptionGroup {
  const labels: Record<ReliefRegion, string> = {
    front: "Front",
    back: "Back",
    left: "Left",
    right: "Right",
    top: "Top",
    bottom: "Bottom",
  };
  return {
    id: "emboss_face",
    label: "Emboss face",
    prompt: "Which face gets the relief?",
    options: RELIEF_REGIONS.map((region) => option("emboss_face", region, labels[region])),
  };
}

function colorRegionsGroup(): DesignOptionGroup {
  return {
    id: "color_regions",
    label: "Colors",
    prompt: "How should color regions split?",
    options: [
      option("color_regions", "red_black", "Red + black", "Red body, black letters."),
      option("color_regions", "white_black", "White + black", "White body, black letters."),
      option("color_regions", "one", "One color", "Single default object."),
    ],
  };
}

function groupById(id: DesignOptionGroupId): DesignOptionGroup {
  switch (id) {
    case "scale_mode":
      return scaleGroup();
    case "wearable_size":
      return wearableSizeGroup();
    case "material":
      return materialGroup();
    case "clearance":
      return clearanceGroup();
    case "emboss_face":
      return embossFaceGroup();
    case "color_regions":
      return colorRegionsGroup();
  }
}

/** Parse planner JSON options; unknown group ids are dropped. */
export function parseDesignOptionGroups(raw: unknown): DesignOptionGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: DesignOptionGroup[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const id = asString(rec.id);
    if (!id || !isDesignOptionGroupId(id) || seen.has(id)) continue;
    seen.add(id);
    const catalog = groupById(id);
    const rawOptions = Array.isArray(rec.options) ? rec.options : [];
    const picked = rawOptions.flatMap((opt) => {
      if (!opt || typeof opt !== "object" || Array.isArray(opt)) return [];
      const o = opt as Record<string, unknown>;
      const value = asString(o.value);
      if (!value || !isKnownChoiceValue(id, value)) return [];
      const fromCatalog = catalog.options.find((entry) => entry.value === value);
      return fromCatalog ? [fromCatalog] : [];
    });
    groups.push({
      ...catalog,
      label: asString(rec.label) ?? catalog.label,
      prompt: asString(rec.prompt) ?? catalog.prompt,
      options: picked.length ? picked : catalog.options,
    });
  }
  return groups;
}

function hasNamedCharacter(prompt: string, plan?: DesignOptionsInput["plan"]): boolean {
  if (plan?.knowledge?.characters && plan.knowledge.characters.length > 0) return true;
  return matchKnowledge(prompt).characters.length > 0;
}

function openGroups(input: DesignOptionsInput, applied: AppliedDesignChoice[]): DesignOptionGroup[] {
  const text = combinedText(input.prompt, input.previousPrompt);
  if (!text.trim()) return [];
  const groups: DesignOptionGroup[] = [];

  const scaleChosen = choiceValue(applied, "scale_mode");
  const wearableChosen = Boolean(
    choiceValue(applied, "wearable_size") || input.wearableSize || parseWearableSizeFromPrompt(text),
  );
  const materialChosen = Boolean(
    choiceValue(applied, "material") || normalizeFilamentId(input.filament ?? "") || normalizeFilamentId(text),
  );
  const clearanceChosen = Boolean(
    choiceValue(applied, "clearance") || EXPLICIT_PIP.test(text) || EXPLICIT_MULTI.test(text),
  );
  const embossChosen = Boolean(choiceValue(applied, "emboss_face") || parseReliefRegion(text));
  const colorChosen = Boolean(choiceValue(applied, "color_regions") || !isDefaultOnlyRegions(colorRegionsFromPrompt(text)));

  const character = hasNamedCharacter(text, input.plan);
  const wearableScale = wantsWearableScale(text) || scaleChosen === "wearable";
  const displayScale = DISPLAY_SCALE.test(text) || scaleChosen === "display";

  if (character && !wearableScale && !displayScale && !statedLargeMm(text) && !scaleChosen) {
    groups.push(scaleGroup());
  }

  if (wearableScale && !wearableChosen) {
    groups.push(wearableSizeGroup());
  }

  if (ASKS_MATERIAL.test(text) && !materialChosen) {
    groups.push(materialGroup());
  }

  if (wantsMotion(text) && !clearanceChosen) {
    groups.push(clearanceGroup());
  }

  if (promptHasRelief(text) && !embossChosen) {
    groups.push(embossFaceGroup());
  }

  if (ASKS_COLOR.test(text) && !colorChosen) {
    groups.push(colorRegionsGroup());
  }

  const fromPlan = parseDesignOptionGroups(input.plan?.options);
  for (const extra of fromPlan) {
    if (applied.some((choice) => choice.id === extra.id)) continue;
    if (groups.some((group) => group.id === extra.id)) continue;
    // Planner-only groups still have to be a known fork, not a settings dump.
    if (extra.id === "material" && !ASKS_MATERIAL.test(text) && materialChosen) continue;
    groups.push(extra);
  }

  return groups;
}

export function resolveDesignOptions(input: DesignOptionsInput = {}): DesignOptionsResult {
  const applied = parseAppliedChoices(input.choices);
  const options = openGroups(input, applied);
  const needs_user_choice = options.length > 0;
  return { needs_user_choice, options, applied };
}

export function choicePhrase(choice: AppliedDesignChoice): string {
  switch (choice.id) {
    case "scale_mode":
      return choice.value === "wearable" ? "1:1 wearable" : "fit P2S display scale";
    case "wearable_size":
      return `size ${choice.value}`;
    case "material":
      return `in ${String(choice.value).toUpperCase()}`;
    case "clearance":
      return choice.value === "multi-part" ? "multi-part kit" : "print-in-place";
    case "emboss_face":
      return `on the ${choice.value}`;
    case "color_regions":
      if (choice.value === "red_black") return "red body, black letters";
      if (choice.value === "white_black") return "white body, black letters";
      return "one color";
    default:
      return "";
  }
}

export function designChoiceFollowUp(choice: AppliedDesignChoice): string {
  const phrase = choicePhrase(choice);
  switch (choice.id) {
    case "scale_mode":
      return choice.value === "wearable" ? "Use 1:1 wearable scale" : "Use display scale that fits the P2S";
    case "wearable_size":
      return `Apply wearable size ${choice.value}`;
    case "material":
      return `Use ${String(choice.value).toUpperCase()} settings`;
    case "clearance":
      return choice.value === "multi-part" ? "Print as a multi-part kit" : "Print-in-place with documented gaps";
    case "emboss_face":
      return `Put the relief on the ${choice.value}`;
    case "color_regions":
      return phrase;
    default:
      return phrase;
  }
}

export function applyDesignChoiceToPrompt(prompt: string, choice: AppliedDesignChoice): string {
  const phrase = choicePhrase(choice);
  const trimmed = (prompt ?? "").trim();
  if (!phrase) return trimmed;
  if (trimmed.toLowerCase().includes(phrase.toLowerCase())) return trimmed;
  return trimmed ? `${trimmed}. ${phrase}` : phrase;
}

export function applyChoicesToPrompt(prompt: string, choices: AppliedDesignChoice[]): string {
  return choices.reduce((text, choice) => applyDesignChoiceToPrompt(text, choice), prompt ?? "");
}

export function formatDesignOptionsNote(resolved: DesignOptionsResult): string {
  if (!resolved.needs_user_choice || !resolved.options.length) return "";
  const labels = resolved.options.map((group) => group.prompt).join(" ");
  return `Pick a direction before the next generate: ${labels}`.trim();
}

export function flattenDesignOptions(groups: DesignOptionGroup[]): DesignOption[] {
  return groups.flatMap((group) => group.options);
}

export function applyChoicesToGenerateFields(input: {
  prompt?: string | null;
  choices?: unknown;
  wearableSize?: WearableSizeId | null;
  filament?: string | null;
}): {
  prompt: string;
  choices: AppliedDesignChoice[];
  wearableSize: WearableSizeId | null;
  filament: string | null;
} {
  const choices = parseAppliedChoices(input.choices);
  const prompt = applyChoicesToPrompt(input.prompt ?? "", choices);
  let wearableSize = input.wearableSize ?? null;
  let filament = input.filament ?? null;
  const size = choiceValue(choices, "wearable_size");
  if (size && isWearableSizeId(size)) wearableSize = size;
  const material = choiceValue(choices, "material");
  if (material && isFilamentId(material)) filament = material;
  return { prompt, choices, wearableSize, filament };
}
