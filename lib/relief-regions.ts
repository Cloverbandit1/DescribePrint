/**
 * Wearable / knowledge region targeting for raised etchings.
 *
 * Maps phrases like "back of helmet", "chest plate", "gauntlet cuff" to a
 * bbox face plus an optional wearable chart / pack feature. Honest stub —
 * not a mesh-feature picker.
 */
import { matchKnowledge } from "./knowledge";
import type { ReliefRegion } from "./relief";
import type { WearableCategoryId } from "./types";
import { parseWearableCategoryFromPrompt } from "./wearable-sizes";

export type ReliefTarget = {
  region: ReliefRegion;
  label: string;
  wearableCategory?: WearableCategoryId;
  knowledgeFeature?: string;
  source: "prompt" | "wearable" | "knowledge";
};

const FACE_ONLY: Array<{ re: RegExp; region: ReliefRegion }> = [
  { re: /\b(back|rear)\b/, region: "back" },
  { re: /\b(front|visor|faceplate|face\s*plate)\b/, region: "front" },
  { re: /\bleft\b/, region: "left" },
  { re: /\bright\b/, region: "right" },
  { re: /\b(top|lid|crown|dome)\b/, region: "top" },
  { re: /\b(bottom|base|bed|build\s+plate)\b/, region: "bottom" },
];

/**
 * Cosplay / wearable phrases. Checked before generic "plate" → bed.
 * "chest plate" is a torso face, not the build plate.
 */
const WEARABLE_TARGETS: Array<{
  re: RegExp;
  region: ReliefRegion;
  label: string;
  wearableCategory: WearableCategoryId;
  knowledgeFeature?: string;
}> = [
  {
    re: /\bback\s+of\s+(?:the\s+)?helmet|\bhelmet\b[\s\S]{0,48}\bback\b|\b(?:rear|nape)\s+of\s+(?:the\s+)?helmet\b/i,
    region: "back",
    label: "helmet back",
    wearableCategory: "helmet_mask",
    knowledgeFeature: "dome",
  },
  {
    re: /\b(?:front|visor|face)\s+of\s+(?:the\s+)?helmet|\bhelmet\b[\s\S]{0,48}\b(?:front|visor|faceplate)\b/i,
    region: "front",
    label: "helmet front",
    wearableCategory: "helmet_mask",
    knowledgeFeature: "visor",
  },
  {
    re: /\b(?:top|crown|dome)\s+of\s+(?:the\s+)?helmet|\bhelmet\b[\s\S]{0,48}\b(?:top|crown|dome)\b/i,
    region: "top",
    label: "helmet crown",
    wearableCategory: "helmet_mask",
    knowledgeFeature: "dome",
  },
  {
    re: /\b(?:chest|breast)\s*plates?\b|\bplastron\b|\btorso\s+(?:armor|plate|front)\b/i,
    region: "front",
    label: "chest plate",
    wearableCategory: "torso_armor",
    knowledgeFeature: "chest_plate",
  },
  {
    re: /\bgauntlet\s+cuffs?\b|\bwrist\s+cuffs?\b|\bcuffs?\s+of\s+(?:the\s+)?gauntlet\b|\bgauntlet\b[\s\S]{0,64}\bcuffs?\b|\bcuffs?\b[\s\S]{0,64}\bgauntlet\b/i,
    region: "front",
    label: "gauntlet cuff",
    wearableCategory: "gauntlet",
    knowledgeFeature: "wrist_cuff",
  },
  {
    re: /\bbracer\s+cuffs?\b|\bcuffs?\s+of\s+(?:the\s+)?bracer\b|\bforearm\s+(?:cuff|plate|guard)\b/i,
    region: "front",
    label: "bracer cuff",
    wearableCategory: "bracer",
    knowledgeFeature: "cuff",
  },
];

function asText(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function knowledgeFeatureHit(prompt: string): ReliefTarget | undefined {
  const match = matchKnowledge(prompt);
  if (!match.characters.length) return undefined;
  const text = asText(prompt);
  for (const character of match.characters) {
    for (const feature of character.features) {
      const name = feature.name.replace(/[_-]+/g, " ");
      if (!name || !new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(text)) continue;
      const face =
        /\b(visor|faceplate|eye|jaw|chest|plastron|palm)\b/i.test(name) ? "front"
        : /\b(neck|shroud|rear)\b/i.test(name) ? "back"
        : /\b(dome|crown|emitter)\b/i.test(name) ? "top"
        : /\b(ear)\b/i.test(name) ? "right"
        : undefined;
      if (!face) continue;
      return {
        region: face,
        label: feature.name.replace(/_/g, " "),
        wearableCategory: character.wearableCategory,
        knowledgeFeature: feature.name,
        source: "knowledge",
      };
    }
  }
  return undefined;
}

/** Named wearable / pack region, or undefined when only a generic face word is present. */
export function parseReliefTarget(raw: unknown): ReliefTarget | undefined {
  const text = asText(raw);
  if (!text) return undefined;
  for (const entry of WEARABLE_TARGETS) {
    if (entry.re.test(text)) {
      return {
        region: entry.region,
        label: entry.label,
        wearableCategory: entry.wearableCategory,
        knowledgeFeature: entry.knowledgeFeature,
        source: "wearable",
      };
    }
  }
  const fromPack = knowledgeFeatureHit(String(raw ?? ""));
  if (fromPack) return fromPack;
  return undefined;
}

/**
 * Face from a prompt or plan field. Wearable phrases win over generic
 * "plate" (chest plate ≠ build plate).
 */
export function parseReliefRegionText(raw: unknown): ReliefRegion | undefined {
  const target = parseReliefTarget(raw);
  if (target) return target.region;
  const text = asText(raw);
  if (!text) return undefined;
  for (const entry of FACE_ONLY) {
    if (entry.re.test(text)) return entry.region;
  }
  if (/\bplate\b/.test(text) && !/\b(chest|breast|armor|name|shoulder|back|front|gauntlet|bracer)\b/.test(text)) {
    return "bottom";
  }
  return undefined;
}

export function inferWearableCategoryForRelief(
  prompt: string,
  target?: ReliefTarget,
): WearableCategoryId | undefined {
  return target?.wearableCategory ?? parseWearableCategoryFromPrompt(prompt) ?? undefined;
}

export function formatReliefTargetNote(target?: ReliefTarget): string | undefined {
  if (!target) return undefined;
  const bits = [`Region “${target.label}” → ${target.region} face`];
  if (target.wearableCategory) bits.push(`wearable ${target.wearableCategory}`);
  if (target.knowledgeFeature) bits.push(`pack feature ${target.knowledgeFeature}`);
  return `${bits.join("; ")}.`;
}
