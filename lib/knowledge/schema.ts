import type { WearableCategoryId } from "../types";

export const KNOWLEDGE_PACK_KIND = "describeprint-knowledge-pack" as const;

export const CHARACTER_CATEGORIES = ["helmet", "prop", "armor", "bust"] as const;
export type KnowledgeCharacterCategory = (typeof CHARACTER_CATEGORIES)[number];

export const TECH_CATEGORIES = ["material", "nozzle", "layer", "joint", "printer", "technique"] as const;
export type KnowledgeTechCategory = (typeof TECH_CATEGORIES)[number];

export type KnowledgeXyz = { x: number; y: number; z: number };

export type KnowledgeFeature = {
  name: string;
  kind?: string;
  dims_mm?: Record<string, number>;
  notes?: string;
};

export type KnowledgePackMeta = {
  version: string;
  kind: typeof KNOWLEDGE_PACK_KIND;
  updated: string;
  curated: true;
  live_web_crawl: false;
  notes: string;
};

export type KnowledgeCharacter = {
  id: string;
  name: string;
  category: KnowledgeCharacterCategory;
  wearableCategory?: WearableCategoryId;
  aliases: string[];
  reference_mm: KnowledgeXyz;
  printable_mm: KnowledgeXyz;
  features: KnowledgeFeature[];
  notes: string[];
  sources: string[];
};

export type KnowledgeTechCrossLinks = {
  filament?: "pla" | "petg" | "pa" | "abs" | "tpu";
  printer?: "bambu-lab-p2s";
  joints?: boolean;
};

export type KnowledgeTechPlanHints = {
  min_wall_mm?: number;
  clearance_mm?: number;
  layer_height_mm?: number;
  nozzle_mm?: number;
};

export type KnowledgeTech = {
  id: string;
  name: string;
  category: KnowledgeTechCategory;
  aliases: string[];
  crossLinks?: KnowledgeTechCrossLinks;
  planHints?: KnowledgeTechPlanHints;
  notes: string[];
};

export type KnowledgePack = {
  meta: KnowledgePackMeta;
  characters: KnowledgeCharacter[];
  tech: KnowledgeTech[];
};

export type KnowledgePackIssue = { path: string; message: string };

export type KnowledgePackValidation =
  | { ok: true; pack: KnowledgePack; issues: [] }
  | { ok: false; pack: null; issues: KnowledgePackIssue[] };

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const WEARABLE = new Set(["helmet_mask", "torso_armor", "gauntlet", "bracer"]);
const FILAMENTS = new Set(["pla", "petg", "pa", "abs", "tpu"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function parseXyz(value: unknown, path: string, issues: KnowledgePackIssue[]): KnowledgeXyz | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "expected {x,y,z} millimeters" });
    return undefined;
  }
  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  const z = asFiniteNumber(value.z);
  if (x === undefined || y === undefined || z === undefined || x <= 0 || y <= 0 || z <= 0) {
    issues.push({ path, message: "x/y/z must be finite millimeters > 0" });
    return undefined;
  }
  return { x, y, z };
}

function parseFeatures(value: unknown, path: string, issues: KnowledgePackIssue[]): KnowledgeFeature[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "features must be an array" });
    return [];
  }
  const features: KnowledgeFeature[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path: itemPath, message: "feature must be an object" });
      return;
    }
    const name = asString(item.name);
    if (!name) {
      issues.push({ path: `${itemPath}.name`, message: "feature name is required" });
      return;
    }
    const dims: Record<string, number> = {};
    if (item.dims_mm !== undefined) {
      if (!isRecord(item.dims_mm)) {
        issues.push({ path: `${itemPath}.dims_mm`, message: "dims_mm must be an object of numbers" });
      } else {
        for (const [key, raw] of Object.entries(item.dims_mm)) {
          const n = asFiniteNumber(raw);
          if (n === undefined) {
            issues.push({ path: `${itemPath}.dims_mm.${key}`, message: "dimension must be a finite number" });
            continue;
          }
          dims[key] = n;
        }
      }
    }
    features.push({
      name,
      kind: asString(item.kind),
      dims_mm: Object.keys(dims).length ? dims : undefined,
      notes: asString(item.notes),
    });
  });
  return features;
}

function parseStringList(value: unknown, path: string, issues: KnowledgePackIssue[], min = 1): string[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "expected a string array" });
    return [];
  }
  const items = value.map((item, index) => {
    const text = asString(item);
    if (!text) issues.push({ path: `${path}[${index}]`, message: "expected a non-empty string" });
    return text;
  });
  const list = items.filter((item): item is string => Boolean(item));
  if (list.length < min) issues.push({ path, message: `need at least ${min} entr${min === 1 ? "y" : "ies"}` });
  return list;
}

function parseCharacter(value: unknown, path: string, issues: KnowledgePackIssue[]): KnowledgeCharacter | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "character must be an object" });
    return undefined;
  }
  const id = asString(value.id);
  if (!id || !ID.test(id)) issues.push({ path: `${path}.id`, message: "id must match [a-z][a-z0-9-]*" });
  const name = asString(value.name);
  if (!name) issues.push({ path: `${path}.name`, message: "name is required" });
  const category = asString(value.category);
  if (!category || !(CHARACTER_CATEGORIES as readonly string[]).includes(category)) {
    issues.push({ path: `${path}.category`, message: `category must be ${CHARACTER_CATEGORIES.join("|")}` });
  }
  let wearableCategory: WearableCategoryId | undefined;
  if (value.wearableCategory !== undefined) {
    const wear = asString(value.wearableCategory);
    if (!wear || !WEARABLE.has(wear)) {
      issues.push({ path: `${path}.wearableCategory`, message: "unknown wearable category" });
    } else {
      wearableCategory = wear as WearableCategoryId;
    }
  }
  const aliases = parseStringList(value.aliases, `${path}.aliases`, issues);
  const reference_mm = parseXyz(value.reference_mm, `${path}.reference_mm`, issues);
  const printable_mm = parseXyz(value.printable_mm, `${path}.printable_mm`, issues);
  const features = parseFeatures(value.features, `${path}.features`, issues);
  const notes = parseStringList(value.notes, `${path}.notes`, issues);
  const sources = parseStringList(value.sources, `${path}.sources`, issues);
  if (!id || !name || !category || !reference_mm || !printable_mm) return undefined;
  if (!(CHARACTER_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return {
    id,
    name,
    category: category as KnowledgeCharacterCategory,
    wearableCategory,
    aliases,
    reference_mm,
    printable_mm,
    features,
    notes,
    sources,
  };
}

function parseTech(value: unknown, path: string, issues: KnowledgePackIssue[]): KnowledgeTech | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "tech entry must be an object" });
    return undefined;
  }
  const id = asString(value.id);
  if (!id || !ID.test(id)) issues.push({ path: `${path}.id`, message: "id must match [a-z][a-z0-9-]*" });
  const name = asString(value.name);
  if (!name) issues.push({ path: `${path}.name`, message: "name is required" });
  const category = asString(value.category);
  if (!category || !(TECH_CATEGORIES as readonly string[]).includes(category)) {
    issues.push({ path: `${path}.category`, message: `category must be ${TECH_CATEGORIES.join("|")}` });
  }
  const aliases = parseStringList(value.aliases, `${path}.aliases`, issues);
  const notes = parseStringList(value.notes, `${path}.notes`, issues);
  let crossLinks: KnowledgeTechCrossLinks | undefined;
  if (value.crossLinks !== undefined) {
    if (!isRecord(value.crossLinks)) {
      issues.push({ path: `${path}.crossLinks`, message: "crossLinks must be an object" });
    } else {
      const filament = asString(value.crossLinks.filament);
      if (filament && !FILAMENTS.has(filament)) {
        issues.push({ path: `${path}.crossLinks.filament`, message: "unknown filament id" });
      }
      const printer = asString(value.crossLinks.printer);
      if (printer && printer !== "bambu-lab-p2s") {
        issues.push({ path: `${path}.crossLinks.printer`, message: "only bambu-lab-p2s is linked today" });
      }
      crossLinks = {
        filament: filament && FILAMENTS.has(filament) ? (filament as KnowledgeTechCrossLinks["filament"]) : undefined,
        printer: printer === "bambu-lab-p2s" ? "bambu-lab-p2s" : undefined,
        joints: value.crossLinks.joints === true ? true : undefined,
      };
    }
  }
  let planHints: KnowledgeTechPlanHints | undefined;
  if (value.planHints !== undefined) {
    if (!isRecord(value.planHints)) {
      issues.push({ path: `${path}.planHints`, message: "planHints must be an object of numbers" });
    } else {
      planHints = {
        min_wall_mm: asFiniteNumber(value.planHints.min_wall_mm),
        clearance_mm: asFiniteNumber(value.planHints.clearance_mm),
        layer_height_mm: asFiniteNumber(value.planHints.layer_height_mm),
        nozzle_mm: asFiniteNumber(value.planHints.nozzle_mm),
      };
    }
  }
  if (!id || !name || !category) return undefined;
  if (!(TECH_CATEGORIES as readonly string[]).includes(category)) return undefined;
  return {
    id,
    name,
    category: category as KnowledgeTechCategory,
    aliases,
    crossLinks,
    planHints,
    notes,
  };
}

/** Validate a knowledge-pack JSON document. Unknown extra keys are allowed. */
export function validateKnowledgePack(raw: unknown): KnowledgePackValidation {
  const issues: KnowledgePackIssue[] = [];
  if (!isRecord(raw)) {
    return { ok: false, pack: null, issues: [{ path: "$", message: "pack must be a JSON object" }] };
  }
  if (!isRecord(raw.meta)) {
    issues.push({ path: "meta", message: "meta is required" });
  }
  const metaRec = isRecord(raw.meta) ? raw.meta : {};
  const version = asString(metaRec.version);
  if (!version || !SEMVER.test(version)) issues.push({ path: "meta.version", message: "version must be semver (1.0.0)" });
  if (metaRec.kind !== KNOWLEDGE_PACK_KIND) {
    issues.push({ path: "meta.kind", message: `kind must be "${KNOWLEDGE_PACK_KIND}"` });
  }
  const updated = asString(metaRec.updated);
  if (!updated || !DATE.test(updated)) issues.push({ path: "meta.updated", message: "updated must be YYYY-MM-DD" });
  if (metaRec.curated !== true) issues.push({ path: "meta.curated", message: "curated must be true" });
  if (metaRec.live_web_crawl !== false) {
    issues.push({ path: "meta.live_web_crawl", message: "live_web_crawl must be false — this stub is not a crawl" });
  }
  const metaNotes = asString(metaRec.notes);
  if (!metaNotes) issues.push({ path: "meta.notes", message: "notes must explain the curated-stub limit" });

  const characters = Array.isArray(raw.characters)
    ? raw.characters.flatMap((item, index) => {
        const parsed = parseCharacter(item, `characters[${index}]`, issues);
        return parsed ? [parsed] : [];
      })
    : (issues.push({ path: "characters", message: "characters must be an array" }), []);
  const tech = Array.isArray(raw.tech)
    ? raw.tech.flatMap((item, index) => {
        const parsed = parseTech(item, `tech[${index}]`, issues);
        return parsed ? [parsed] : [];
      })
    : (issues.push({ path: "tech", message: "tech must be an array" }), []);

  const ids = new Set<string>();
  for (const entry of [...characters, ...tech]) {
    if (ids.has(entry.id)) issues.push({ path: entry.id, message: `duplicate id "${entry.id}"` });
    ids.add(entry.id);
  }

  if (issues.length) return { ok: false, pack: null, issues };
  if (!version || !updated || !metaNotes) return { ok: false, pack: null, issues };

  return {
    ok: true,
    pack: {
      meta: {
        version,
        kind: KNOWLEDGE_PACK_KIND,
        updated,
        curated: true,
        live_web_crawl: false,
        notes: metaNotes,
      },
      characters,
      tech,
    },
    issues: [],
  };
}

export function formatKnowledgePackIssues(issues: KnowledgePackIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}
