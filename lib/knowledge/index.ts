/**
 * Curated in-repo knowledge pack for SMART_PIPELINE.
 *
 * Characters (cosplay / prop proportions) and tech (materials, nozzle/layer,
 * joint-clearance + printer-volume cross-links). Not a live web crawl and
 * not a RAG product — unknown names are omitted, never fatal.
 */
import { designateMachineForSize } from "../alternate-machines";
import { defaultJointClearances } from "../joints";
import {
  defaultPrinter,
  filamentPreset,
  layerHeightMmFromPreset,
  type FilamentId,
} from "../printers";
import rawPack from "./pack.json";
import {
  validateKnowledgePack,
  type KnowledgeCharacter,
  type KnowledgePack,
  type KnowledgeTech,
  type KnowledgeXyz,
} from "./schema";

export {
  formatKnowledgePackIssues,
  validateKnowledgePack,
  KNOWLEDGE_PACK_KIND,
  CHARACTER_CATEGORIES,
  TECH_CATEGORIES,
} from "./schema";
export type {
  KnowledgeCharacter,
  KnowledgeFeature,
  KnowledgePack,
  KnowledgePackIssue,
  KnowledgePackMeta,
  KnowledgeTech,
  KnowledgeXyz,
} from "./schema";

export const EMPTY_KNOWLEDGE_PACK: KnowledgePack = {
  meta: {
    version: "0.0.0",
    kind: "describeprint-knowledge-pack",
    updated: "1970-01-01",
    curated: true,
    live_web_crawl: false,
    notes: "Empty fallback — the shipped pack failed validation. Generate continues without references.",
  },
  characters: [],
  tech: [],
};

const WEARABLE_SCALE =
  /\b(1\s*:\s*1|life[-\s]?size|wearable|full[-\s]?scale|real[-\s]?size|life[-\s]?scale)\b/i;

export type CadKnowledgeHit = {
  id: string;
  name: string;
  kind: "character" | "tech";
};

export type CadKnowledge = {
  pack_version: string;
  curated: true;
  live_web_crawl: false;
  characters: CadKnowledgeHit[];
  tech: CadKnowledgeHit[];
  notes: string[];
  overall_mm?: KnowledgeXyz;
};

export type KnowledgeMatch = {
  pack: KnowledgePack;
  characters: KnowledgeCharacter[];
  tech: KnowledgeTech[];
};

export type KnowledgeFeatureSeed = {
  name: string;
  kind?: string;
  dims_mm?: Record<string, number>;
  notes?: string;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(alias: string): RegExp {
  const parts = alias
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegex);
  if (!parts.length) return /(?!)/;
  return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
}

function promptMentions(prompt: string, aliases: string[], name?: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  const keys = name ? [name, ...aliases] : aliases;
  return keys.some((alias) => aliasPattern(alias).test(text));
}

/** Load + validate the shipped pack. Invalid JSON/schema fails open to an empty pack. */
export function loadKnowledgePack(raw: unknown = rawPack): KnowledgePack {
  try {
    const result = validateKnowledgePack(raw);
    return result.ok ? result.pack : EMPTY_KNOWLEDGE_PACK;
  } catch {
    return EMPTY_KNOWLEDGE_PACK;
  }
}

export function wantsWearableScale(prompt: string): boolean {
  return WEARABLE_SCALE.test(prompt);
}

export function matchKnowledge(prompt: string, pack: KnowledgePack = loadKnowledgePack()): KnowledgeMatch {
  try {
    const text = prompt ?? "";
    const characters = pack.characters.filter((entry) => promptMentions(text, entry.aliases, entry.name));
    const tech = pack.tech.filter((entry) => promptMentions(text, entry.aliases, entry.name));
    return { pack, characters, tech };
  } catch {
    return { pack, characters: [], tech: [] };
  }
}

function statedLargeMm(prompt: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(mm|millimeters?)\b/gi;
  for (const match of prompt.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n >= 40) out.push(n);
  }
  return out;
}

function maxDim(xyz: KnowledgeXyz): number {
  return Math.max(xyz.x, xyz.y, xyz.z);
}

export function characterPlanMm(character: KnowledgeCharacter, prompt: string): KnowledgeXyz {
  return wantsWearableScale(prompt) ? character.reference_mm : character.printable_mm;
}

/**
 * Prefer pack millimeters when a known character is named and the user did
 * not already state a large overall size. Implausibly tiny LLM overalls
 * (display helmet planned as a 20 mm cube) are replaced.
 */
export function knowledgeOverallMm(
  prompt: string,
  current?: KnowledgeXyz,
  pack: KnowledgePack = loadKnowledgePack(),
): KnowledgeXyz | undefined {
  const match = matchKnowledge(prompt, pack);
  const character = match.characters[0];
  if (!character) return current;
  const packMm = characterPlanMm(character, prompt);
  if (!current) return packMm;
  if (statedLargeMm(prompt).length) return current;
  if (maxDim(current) < maxDim(packMm) * 0.5) return packMm;
  return current;
}

export function mergeKnowledgeFeatures(
  prompt: string,
  features: KnowledgeFeatureSeed[],
  pack: KnowledgePack = loadKnowledgePack(),
): KnowledgeFeatureSeed[] {
  const match = matchKnowledge(prompt, pack);
  if (!match.characters.length) return features;
  const names = new Set(features.map((feature) => feature.name.toLowerCase()));
  const extra: KnowledgeFeatureSeed[] = [];
  for (const character of match.characters) {
    for (const feature of character.features) {
      if (names.has(feature.name.toLowerCase())) continue;
      names.add(feature.name.toLowerCase());
      extra.push({
        name: feature.name,
        kind: feature.kind,
        dims_mm: feature.dims_mm ? { ...feature.dims_mm } : undefined,
        notes: feature.notes,
      });
    }
  }
  return extra.length ? [...features, ...extra] : features;
}

function filamentNote(id: FilamentId): string {
  const printer = defaultPrinter();
  const preset = filamentPreset(id, printer);
  const layer = layerHeightMmFromPreset(id, printer);
  const bits = [
    `${preset.name} auto-best on ${printer.name}: ${preset.nozzleC} °C / bed ${preset.bedC} °C, ${preset.printSpeedMms} mm/s, ${layer ?? 0.2} mm layer (advisory).`,
  ];
  if (preset.notes) bits.push(preset.notes);
  return bits.join(" ");
}

function jointClearanceNote(): string {
  const rows = defaultJointClearances();
  const summary = rows
    .filter((row) => row.intent === "print-in-place")
    .map((row) => `${row.type} PIP ${row.radialMm} mm/side`)
    .join(", ");
  return `Joint clearances (lib/joints.ts, P2S 0.4 mm nozzle): ${summary}. Removable kits use the larger multi-part column.`;
}

function printerVolumeNote(): string {
  const printer = defaultPrinter();
  const [x, y, z] = printer.buildVolumeMm;
  return `${printer.name} build volume ${x}×${y}×${z} mm (lib/printers.ts). Supported nozzles ${printer.supportedNozzlesMm.join("/")} mm.`;
}

function characterNotes(character: KnowledgeCharacter, prompt: string): string[] {
  const planMm = characterPlanMm(character, prompt);
  const scale = wantsWearableScale(prompt) ? "1:1 / wearable reference" : "display scale that fits P2S";
  const xyz = `${planMm.x}×${planMm.y}×${planMm.z} mm`;
  const notes = [
    `${character.name}: ${scale} ${xyz} (pack ${character.id}).`,
    ...character.notes,
  ];
  if (character.wearableCategory) {
    notes.push(`Wearable fit chart: ${character.wearableCategory} in lib/wearable-sizes.ts (uniform S–XL).`);
  }
  const designation = designateMachineForSize([character.reference_mm.x, character.reference_mm.y, character.reference_mm.z]);
  if (designation.exceedsCurrentPrinter && designation.message) {
    notes.push(`1:1 envelope ${character.reference_mm.x}×${character.reference_mm.y}×${character.reference_mm.z} mm ${designation.message}`);
  }
  return notes;
}

function techNotes(entry: KnowledgeTech): string[] {
  const notes = [...entry.notes];
  const filament = entry.crossLinks?.filament;
  if (filament) notes.push(filamentNote(filament));
  if (entry.crossLinks?.joints) notes.push(jointClearanceNote());
  if (entry.crossLinks?.printer) notes.push(printerVolumeNote());
  if (entry.planHints?.layer_height_mm || entry.planHints?.nozzle_mm) {
    const nozzle = entry.planHints.nozzle_mm ?? defaultPrinter().nozzleMm;
    const layer = entry.planHints.layer_height_mm ?? 0.2;
    notes.push(`Plan hint: ${nozzle} mm nozzle, ${layer} mm layer. Walls ≥ ${Math.max(1.6, nozzle * 4)} mm.`);
  }
  return notes;
}

export function cadKnowledgeFromPrompt(
  prompt: string,
  pack: KnowledgePack = loadKnowledgePack(),
): CadKnowledge | undefined {
  const match = matchKnowledge(prompt, pack);
  if (!match.characters.length && !match.tech.length) return undefined;
  const notes = [
    `Knowledge pack v${match.pack.meta.version} (curated stub, not a live web crawl). Unknown names are omitted.`,
    ...match.characters.flatMap((character) => characterNotes(character, prompt)),
    ...match.tech.flatMap((entry) => techNotes(entry)),
  ];
  const overall_mm = match.characters[0] ? characterPlanMm(match.characters[0], prompt) : undefined;
  return {
    pack_version: match.pack.meta.version,
    curated: true,
    live_web_crawl: false,
    characters: match.characters.map((character) => ({
      id: character.id,
      name: character.name,
      kind: "character",
    })),
    tech: match.tech.map((entry) => ({ id: entry.id, name: entry.name, kind: "tech" })),
    notes,
    overall_mm,
  };
}

export function formatKnowledgeConstraints(): string {
  const pack = loadKnowledgePack();
  const characters = pack.characters.map((entry) => entry.name).join(" / ") || "(none)";
  return [
    `Knowledge pack v${pack.meta.version} (curated in-repo stub — not a live web crawl, not official licensed measurements):`,
    `- Characters / props: ${characters}.`,
    `- Tech: materials (PLA/PETG/PA/ABS/TPU via printers.ts), 0.4 mm nozzle / 0.2 mm layer, joint clearances (joints.ts), P2S 256³, print-in-place, split-for-bed.`,
    `- Use pack millimeters only when the prompt names a known entry. Unknown names: omit knowledge and plan from the description alone.`,
  ].join("\n");
}

export function formatKnowledgeNote(knowledge?: CadKnowledge | null): string {
  if (!knowledge) return "";
  const who = [
    ...knowledge.characters.map((hit) => hit.name),
    ...knowledge.tech.map((hit) => hit.name),
  ].join(", ");
  const dims = knowledge.overall_mm
    ? ` ${knowledge.overall_mm.x}×${knowledge.overall_mm.y}×${knowledge.overall_mm.z} mm.`
    : "";
  return `Knowledge pack v${knowledge.pack_version} (curated stub, not a live web crawl): ${who}.${dims} ${knowledge.notes[1] ?? knowledge.notes[0] ?? ""}`.trim();
}

export function formatKnowledgePlanHint(knowledge?: CadKnowledge | null): string {
  if (!knowledge) return "";
  return [
    "Curated knowledge pack (use these millimeters when they match the request; not a live web crawl):",
    JSON.stringify({
      pack_version: knowledge.pack_version,
      live_web_crawl: false,
      characters: knowledge.characters,
      tech: knowledge.tech,
      overall_mm: knowledge.overall_mm,
      notes: knowledge.notes.slice(0, 8),
    }),
  ].join("\n");
}

export function formatKnowledgeCodegenHint(knowledge?: CadKnowledge | null): string {
  if (!knowledge) return "";
  const dims = knowledge.overall_mm
    ? `${knowledge.overall_mm.x} × ${knowledge.overall_mm.y} × ${knowledge.overall_mm.z} mm`
    : "pack notes";
  return `Knowledge pack v${knowledge.pack_version}: follow curated ${dims} and feature dims. Curated stub only — not a live web crawl.`;
}

export const STORMTROOPER_HELMET_PROMPT = "stormtrooper helmet";
export const UNKNOWN_CHARACTER_PROMPT = "xyzzy warrior helmet for the gandalf-adjacent oc";
export const PETG_TECH_PROMPT = "20mm cube with 5mm hole in PETG";
