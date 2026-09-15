/**
 * In-app part library + remix stub.
 *
 * Save a successful plate (prompt + OpenSCAD or imported-mesh job id +
 * preview metadata) under a name, load it back onto the plate, then remix
 * (scale, one dimension, pretty-up, fit, wearable size) from that saved
 * part instead of a blank description.
 *
 * Persisted in localStorage on this device only — not cloud sync.
 * Preview job URLs expire with the in-memory job store (~1h); remix still
 * uses the saved OpenSCAD (or the import job id while it lasts).
 */

import { useSyncExternalStore } from "react";
import type { AppliedDesignChoice } from "./design-options";
import { defaultColorRegion } from "./color-regions";
import { inferFitKind } from "./fits";
import { promptHasPrettyUp } from "./pretty-up";
import { printPresetSummary } from "./printers";
import type {
  GenerateResult,
  PartSource,
  WearableCategoryId,
  WearableSizeId,
} from "./types";
import { parseWearableSizeFromPrompt } from "./wearable-sizes";

export const PART_LIBRARY_STORAGE_KEY = "describeprint.partLibrary";
export const PART_LIBRARY_CAP = 12;
export const PART_LIBRARY_MAX_NAME = 64;
export const PART_LIBRARY_MAX_CODE_CHARS = 80_000;

export const PART_LIBRARY_NOTE =
  "Saved on this device only — not cloud sync. Preview jobs expire (~1h); remix still uses saved OpenSCAD or the import job id.";

export const REMIX_SCALE_CHIP = "Make it 10% larger";
export const REMIX_DIM_CHIP = "Make the hole 8 mm";
export const REMIX_PRETTY_CHIP = "Round the edges";
export const REMIX_FIT_CHIP = "Press-fit 8mm pin hole";
export const REMIX_SIZE_CHIP = "Make it size L";

export const REMIX_KINDS = ["scale", "dimension", "pretty-up", "fit", "size", "other"] as const;
export type RemixKind = (typeof REMIX_KINDS)[number];

export type SavedPart = {
  id: string;
  version: 1;
  cloudSync: false;
  name: string;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  designPrompt: string;
  /** OpenSCAD source when the plate is parametric (or an import wrap). */
  code: string | null;
  /** Same as jobId when the plate is an imported mesh; otherwise null. */
  importedMeshId: string | null;
  jobId: string;
  source: PartSource;
  /** Compact generate snapshot for preview restore (no heatmap scores). */
  result: GenerateResult;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId | null;
  appliedChoices: AppliedDesignChoice[];
};

export type PartLibraryState = {
  version: 1;
  cloudSync: false;
  parts: SavedPart[];
};

export type SavePartInput = {
  id?: string;
  name?: string;
  createdAt?: number;
  updatedAt?: number;
  prompt: string;
  designPrompt: string;
  result: GenerateResult;
  wearableSize?: WearableSizeId | null;
  wearableCategory?: WearableCategoryId | null;
  appliedChoices?: AppliedDesignChoice[] | null;
};

export type RemixRequest = {
  prompt: string;
  previousPrompt: string;
  previousCode: string | null;
  previousJobId: string;
  previousSource: PartSource;
  fromLibrary: true;
  blankStart: false;
  remixKind: RemixKind;
};

export type LibraryLoadRestore = {
  part: SavedPart;
  result: GenerateResult;
  designPrompt: string;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId | null;
  appliedChoices: AppliedDesignChoice[];
  loadNote: string;
};

let nextPartSeq = 0;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function emptyPartLibrary(): PartLibraryState {
  return { version: 1, cloudSync: false, parts: [] };
}

export function suggestPartName(prompt: string, max = PART_LIBRARY_MAX_NAME): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled part";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function normalizePartName(name: string | null | undefined): string {
  const cleaned = (name ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled part";
  if (cleaned.length <= PART_LIBRARY_MAX_NAME) return cleaned;
  return `${cleaned.slice(0, PART_LIBRARY_MAX_NAME - 1).trimEnd()}…`;
}

function nameKey(name: string): string {
  return normalizePartName(name).toLowerCase();
}

export function canSavePlate(result: GenerateResult | null | undefined): boolean {
  return Boolean(result?.jobId);
}

export function compactGenerateResult(result: GenerateResult): GenerateResult {
  const code = result.code?.trim() ? result.code : "";
  const clipped =
    code.length > PART_LIBRARY_MAX_CODE_CHARS ? code.slice(0, PART_LIBRARY_MAX_CODE_CHARS) : code;
  const strength = result.report?.strengthPreview;
  return {
    ...result,
    code: clipped,
    language: "openscad",
    colorRegions: result.colorRegions?.length ? result.colorRegions : [defaultColorRegion()],
    printPreset: result.printPreset ?? printPresetSummary("pla"),
    report: {
      ...result.report,
      units: "mm",
      strengthPreview: strength
        ? {
            ...strength,
            triangleScores: [],
          }
        : strength,
    },
  };
}

export function snapshotFromPlate(result: GenerateResult): {
  code: string | null;
  jobId: string;
  importedMeshId: string | null;
  source: PartSource;
  result: GenerateResult;
} {
  const compact = compactGenerateResult(result);
  const code = compact.code.trim() ? compact.code : null;
  return {
    code,
    jobId: compact.jobId,
    importedMeshId: compact.source === "imported-mesh" ? compact.jobId : null,
    source: compact.source,
    result: compact,
  };
}

function parseSource(value: unknown): PartSource {
  return value === "imported-mesh" ? "imported-mesh" : "openscad";
}

function parseSavedPart(value: unknown): SavedPart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const resultRaw = row.result;
  if (!resultRaw || typeof resultRaw !== "object" || Array.isArray(resultRaw)) return null;
  const resultRec = resultRaw as Partial<GenerateResult> & Record<string, unknown>;
  const jobId = asString(row.jobId) ?? asString(resultRec.jobId);
  if (!jobId) return null;
  const source = parseSource(row.source ?? resultRec.source);
  const codeRaw = asString(row.code) ?? asString(resultRec.code) ?? null;
  const result = compactGenerateResult({
    ...(resultRec as GenerateResult),
    jobId,
    code: codeRaw ?? "",
    source,
    language: "openscad",
    usedFixture: Boolean(resultRec.usedFixture),
    retried: Boolean(resultRec.retried),
    stlUrl: asString(resultRec.stlUrl) ?? `/api/jobs/${jobId}/model.stl`,
    threemfUrl: asString(resultRec.threemfUrl) ?? `/api/jobs/${jobId}/model.3mf`,
    scadUrl: asString(resultRec.scadUrl) ?? `/api/jobs/${jobId}/model.scad`,
    printPresetUrl: asString(resultRec.printPresetUrl) ?? `/api/jobs/${jobId}/model.print.json`,
    projectPackUrl: asString(resultRec.projectPackUrl) ?? `/api/jobs/${jobId}/model.pack.zip`,
    report: (resultRec.report as GenerateResult["report"]) ?? {
      triangleCount: 0,
      volumeMm3: 0,
      boundingBoxMm: { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] },
      manifold: true,
      watertight: true,
      issues: [],
      units: "mm",
    },
    notes: Array.isArray(resultRec.notes) ? resultRec.notes.map(String) : [],
    colorRegions: Array.isArray(resultRec.colorRegions) ? (resultRec.colorRegions as GenerateResult["colorRegions"]) : [],
    editMode: (resultRec.editMode as GenerateResult["editMode"]) ?? (source === "imported-mesh" ? "import" : "create"),
  });
  const createdAt = asFiniteNumber(row.createdAt) ?? Date.now();
  const wearableSize =
    row.wearableSize === null || row.wearableSize === ""
      ? null
      : ((asString(row.wearableSize) as WearableSizeId | undefined) ?? result.wearableSize ?? null);
  const wearableCategory =
    (asString(row.wearableCategory) as WearableCategoryId | undefined) ?? result.wearableCategory ?? null;
  return {
    id: asString(row.id) ?? `lib-${createdAt}`,
    version: 1,
    cloudSync: false,
    name: normalizePartName(asString(row.name)),
    createdAt,
    updatedAt: asFiniteNumber(row.updatedAt) ?? createdAt,
    prompt: asString(row.prompt) ?? "",
    designPrompt: asString(row.designPrompt) ?? asString(row.prompt) ?? "",
    code: result.code.trim() ? result.code : null,
    importedMeshId: source === "imported-mesh" ? jobId : null,
    jobId,
    source,
    result,
    wearableSize: wearableSize === "S" || wearableSize === "M" || wearableSize === "L" || wearableSize === "XL" ? wearableSize : null,
    wearableCategory,
    appliedChoices: Array.isArray(row.appliedChoices)
      ? (row.appliedChoices as AppliedDesignChoice[])
      : [...(result.appliedChoices ?? [])],
  };
}

export function normalizePartLibrary(value: unknown): PartLibraryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyPartLibrary();
  const row = value as Record<string, unknown>;
  const rawParts = Array.isArray(row.parts) ? row.parts : [];
  const seen = new Set<string>();
  const parts: SavedPart[] = [];
  for (const item of rawParts) {
    const part = parseSavedPart(item);
    if (!part || seen.has(part.id)) continue;
    seen.add(part.id);
    parts.push(part);
  }
  parts.sort((a, b) => a.updatedAt - b.updatedAt);
  const kept = parts.length > PART_LIBRARY_CAP ? parts.slice(parts.length - PART_LIBRARY_CAP) : parts;
  return { version: 1, cloudSync: false, parts: kept };
}

export function parsePartLibrary(raw: string | null | undefined): PartLibraryState {
  if (!raw?.trim()) return emptyPartLibrary();
  try {
    return normalizePartLibrary(JSON.parse(raw));
  } catch {
    return emptyPartLibrary();
  }
}

export function serializePartLibrary(state: PartLibraryState): string {
  return JSON.stringify(normalizePartLibrary(state));
}

export function listParts(state: PartLibraryState): SavedPart[] {
  return [...state.parts].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getPart(state: PartLibraryState, id: string): SavedPart | null {
  return state.parts.find((part) => part.id === id) ?? null;
}

export function savePart(state: PartLibraryState, input: SavePartInput): { state: PartLibraryState; part: SavedPart } {
  const snapshot = snapshotFromPlate(input.result);
  const name = normalizePartName(input.name || suggestPartName(input.prompt));
  const now = input.updatedAt ?? Date.now();
  const existing =
    (input.id ? state.parts.find((part) => part.id === input.id) : undefined) ??
    state.parts.find((part) => nameKey(part.name) === nameKey(name));
  const part: SavedPart = {
    id: existing?.id ?? input.id ?? `lib-${now}-${++nextPartSeq}`,
    version: 1,
    cloudSync: false,
    name,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
    prompt: input.prompt.trim(),
    designPrompt: input.designPrompt.trim() || input.prompt.trim(),
    code: snapshot.code,
    importedMeshId: snapshot.importedMeshId,
    jobId: snapshot.jobId,
    source: snapshot.source,
    result: snapshot.result,
    wearableSize: input.wearableSize ?? snapshot.result.wearableSize ?? null,
    wearableCategory: input.wearableCategory ?? snapshot.result.wearableCategory ?? null,
    appliedChoices: input.appliedChoices ? [...input.appliedChoices] : [...(snapshot.result.appliedChoices ?? [])],
  };
  const rest = state.parts.filter((row) => row.id !== part.id);
  let parts = [...rest, part].sort((a, b) => a.updatedAt - b.updatedAt);
  if (parts.length > PART_LIBRARY_CAP) {
    parts = parts.slice(parts.length - PART_LIBRARY_CAP);
  }
  return { state: { version: 1, cloudSync: false, parts }, part };
}

export function removePart(state: PartLibraryState, id: string): PartLibraryState {
  return {
    version: 1,
    cloudSync: false,
    parts: state.parts.filter((part) => part.id !== id),
  };
}

export function formatLibraryLoadNote(part: SavedPart): string {
  const kind = part.source === "imported-mesh" ? "import mesh ref" : "OpenSCAD";
  return `Loaded “${part.name}” from the part library (${kind}, this device only — not cloud sync).`;
}

export function restorePlateFromPart(part: SavedPart): LibraryLoadRestore {
  return {
    part,
    result: compactGenerateResult(part.result),
    designPrompt: part.designPrompt || part.prompt,
    wearableSize: part.wearableSize,
    wearableCategory: part.wearableCategory,
    appliedChoices: [...part.appliedChoices],
    loadNote: formatLibraryLoadNote(part),
  };
}

const SCALE_RE =
  /\b(?:make (?:it|this|the \w+) )?(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s+percent)\s+(?:larger|smaller|bigger|scale)|(?:scale|enlarge|shrink)(?:\s+(?:it|this|the \w+))?(?:\s+by)?\s+\d+(?:\.\d+)?\s*%|\b(?:10|5|20)\s*%\s+(?:larger|bigger|smaller)\b|\bmake (?:it|this) (?:10% )?larger\b/i;
const DIM_RE =
  /\b(?:make|change|set|widen|narrow)\s+(?:the\s+)?(?:hole|bore|pin|width|height|depth|length|wall|gap|slot)\b|\bhole\s+\d+(?:\.\d+)?\s*mm\b|\b\d+(?:\.\d+)?\s*mm\s+hole\b/i;

export function classifyRemixIntent(text: string): RemixKind {
  const prompt = text.trim();
  if (!prompt) return "other";
  if (parseWearableSizeFromPrompt(prompt) || /\b(?:make it )?size\s+[smlx]{1,2}\b/i.test(prompt)) {
    return "size";
  }
  if (inferFitKind(prompt)) return "fit";
  if (promptHasPrettyUp(prompt)) return "pretty-up";
  if (SCALE_RE.test(prompt)) return "scale";
  if (DIM_RE.test(prompt)) return "dimension";
  return "other";
}

export function isRemixInstruction(text: string): boolean {
  return classifyRemixIntent(text) !== "other";
}

/** Follow-up chips that remix a saved part instead of starting blank. */
export function remixFollowUps(part?: Pick<SavedPart, "source" | "prompt" | "code"> | null): string[] {
  const chips = [REMIX_SCALE_CHIP];
  const text = `${part?.prompt ?? ""} ${part?.code ?? ""}`;
  if (part?.source !== "imported-mesh" || /\bhole\b/i.test(text)) {
    chips.push(REMIX_DIM_CHIP);
  }
  chips.push(REMIX_PRETTY_CHIP, REMIX_FIT_CHIP, REMIX_SIZE_CHIP, "Start a new part");
  return chips;
}

/**
 * Seed /api/generate from a saved part so remix is a follow-up, not a blank start.
 * Does not invent remaining height or touch CadReshapeHandoff.
 */
export function buildRemixRequest(part: SavedPart, instruction: string): RemixRequest {
  const prompt = instruction.trim();
  return {
    prompt,
    previousPrompt: part.designPrompt || part.prompt,
    previousCode: part.code,
    previousJobId: part.jobId,
    previousSource: part.source,
    fromLibrary: true,
    blankStart: false,
    remixKind: classifyRemixIntent(prompt),
  };
}

export function formatPartSavedAt(part: SavedPart): string {
  try {
    return new Date(part.updatedAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "saved";
  }
}

export function partSourceLabel(source: PartSource): string {
  return source === "imported-mesh" ? "Import" : "OpenSCAD";
}

const DEFAULT_LIBRARY = emptyPartLibrary();
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedLibrary: PartLibraryState = DEFAULT_LIBRARY;

function emitPartLibrary() {
  for (const listener of listeners) listener();
}

export function subscribePartLibrary(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getServerPartLibrary(): PartLibraryState {
  return DEFAULT_LIBRARY;
}

export function getPartLibrarySnapshot(): PartLibraryState {
  if (typeof window === "undefined") return DEFAULT_LIBRARY;
  const raw = window.localStorage.getItem(PART_LIBRARY_STORAGE_KEY);
  if (raw === cachedRaw) return cachedLibrary;
  cachedRaw = raw;
  cachedLibrary = parsePartLibrary(raw);
  return cachedLibrary;
}

export function writePartLibrary(state: PartLibraryState): PartLibraryState {
  const next = normalizePartLibrary(state);
  const raw = serializePartLibrary(next);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(PART_LIBRARY_STORAGE_KEY, raw);
  }
  cachedRaw = raw;
  cachedLibrary = next;
  emitPartLibrary();
  return next;
}

/** Hydration-safe localStorage library. Server snapshot is empty. */
export function usePartLibrary(): [PartLibraryState, (next: PartLibraryState) => void] {
  const library = useSyncExternalStore(subscribePartLibrary, getPartLibrarySnapshot, getServerPartLibrary);
  return [library, writePartLibrary];
}
