/**
 * Client-side Print doctor feedback memory.
 * Keys learned fixes by printer profile + filament + symptom.
 * Persist in localStorage only — not CAD undo/history, not LAN.
 */

import {
  applyLearnedFixes,
  confirmPerfect,
  nextAfterRejected,
  type PrintDoctorResult,
} from "../print-doctor";
import { normalizeFilamentId } from "../printers";

export const PRINT_DOCTOR_MEMORY_KEY = "describeprint.machine.printDoctorMemory";

export type PrintDoctorMemoryScope = {
  printerId: string;
  material: string;
  symptom: string;
};

export type PrintDoctorMemoryEntry = PrintDoctorMemoryScope & {
  preferredFixId?: string;
  preferredSteps?: string[];
  rejectedFixIds?: string[];
};

export type PrintDoctorMemoryStore = {
  entries: PrintDoctorMemoryEntry[];
};

export function emptyPrintDoctorMemory(): PrintDoctorMemoryStore {
  return { entries: [] };
}

export function memoryMaterialKey(material: string): string {
  return normalizeFilamentId(material) ?? material.trim().toLowerCase();
}

export function memoryScopeKey(scope: PrintDoctorMemoryScope): string {
  return `${norm(scope.printerId)}|${memoryMaterialKey(scope.material)}|${norm(scope.symptom)}`;
}

export function memoryScopeFromResult(result: PrintDoctorResult): PrintDoctorMemoryScope {
  return {
    printerId: result.printerId,
    material: memoryMaterialKey(String(result.material)),
    symptom: result.amsGuide?.id ?? result.cameraGuide?.id ?? result.defectId,
  };
}

export function parsePrintDoctorMemory(raw: string | null | undefined): PrintDoctorMemoryStore {
  if (!raw?.trim()) return emptyPrintDoctorMemory();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyPrintDoctorMemory();
    const rows = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(rows)) return emptyPrintDoctorMemory();
    const entries = rows
      .map(parseEntry)
      .filter((entry): entry is PrintDoctorMemoryEntry => entry != null);
    return { entries };
  } catch {
    return emptyPrintDoctorMemory();
  }
}

/** Empty store serializes to "" so callers can omit the localStorage key. */
export function serializePrintDoctorMemory(store: PrintDoctorMemoryStore): string {
  const entries = (store.entries ?? []).map(compactEntry).filter((entry): entry is PrintDoctorMemoryEntry => entry != null);
  if (entries.length === 0) return "";
  return JSON.stringify({ entries });
}

export function findMemoryEntry(
  store: PrintDoctorMemoryStore,
  scope: PrintDoctorMemoryScope,
): PrintDoctorMemoryEntry | undefined {
  const key = memoryScopeKey(scope);
  return store.entries.find((entry) => memoryScopeKey(entry) === key);
}

export function applyStoredDoctorMemory(
  store: PrintDoctorMemoryStore,
  result: PrintDoctorResult,
): PrintDoctorResult {
  return applyLearnedFixes(result, findMemoryEntry(store, memoryScopeFromResult(result)));
}

export function rememberPerfect(
  store: PrintDoctorMemoryStore,
  result: PrintDoctorResult,
): PrintDoctorMemoryStore {
  const tagged = applyLearnedFixes(result);
  const scope = memoryScopeFromResult(tagged);
  const existing = findMemoryEntry(store, scope);
  const preferredFixId = tagged.fixes[0]?.id;
  const preferredSteps = tagged.physicalSteps.filter((step) => step.trim());
  if (!preferredFixId && preferredSteps.length === 0) return omitEmpty(store);
  return upsert(store, {
    ...scope,
    preferredFixId,
    preferredSteps: preferredSteps.length ? preferredSteps : undefined,
    rejectedFixIds: existing?.rejectedFixIds,
  });
}

export function rememberStillBad(
  store: PrintDoctorMemoryStore,
  result: PrintDoctorResult,
): { store: PrintDoctorMemoryStore; next: PrintDoctorResult } {
  const tagged = applyLearnedFixes(result);
  const scope = memoryScopeFromResult(tagged);
  const existing = findMemoryEntry(store, scope);
  const primary = tagged.fixes[0]?.id;
  const rejectedFixIds = unique([...(existing?.rejectedFixIds ?? []), primary].filter((id): id is string => Boolean(id)));
  const remaining = tagged.fixes.filter((fix) => fix.id && !rejectedFixIds.includes(fix.id));
  const preferredFixId =
    existing?.preferredFixId && !rejectedFixIds.includes(existing.preferredFixId)
      ? existing.preferredFixId
      : undefined;
  const nextStore = upsert(store, {
    ...scope,
    preferredFixId,
    preferredSteps: preferredFixId ? existing?.preferredSteps : undefined,
    rejectedFixIds: rejectedFixIds.length ? rejectedFixIds : undefined,
  });
  const next = nextAfterRejected(tagged, {
    rejectedFixIds,
    rejectedDefectIds: remaining.length === 0 ? [tagged.defectId] : [],
  });
  return { store: omitEmpty(nextStore), next };
}

export function confirmDoctorPerfect(result: PrintDoctorResult): PrintDoctorResult {
  return confirmPerfect(result);
}

export function readPrintDoctorMemory(
  storage?: Pick<Storage, "getItem"> | null,
): PrintDoctorMemoryStore {
  if (!storage) return emptyPrintDoctorMemory();
  return parsePrintDoctorMemory(storage.getItem(PRINT_DOCTOR_MEMORY_KEY));
}

export function writePrintDoctorMemory(
  store: PrintDoctorMemoryStore,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): void {
  if (!storage) return;
  const raw = serializePrintDoctorMemory(store);
  if (!raw) storage.removeItem(PRINT_DOCTOR_MEMORY_KEY);
  else storage.setItem(PRINT_DOCTOR_MEMORY_KEY, raw);
}

function parseEntry(value: unknown): PrintDoctorMemoryEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.printerId !== "string" || !row.printerId.trim()) return undefined;
  if (typeof row.material !== "string" || !row.material.trim()) return undefined;
  if (typeof row.symptom !== "string" || !row.symptom.trim()) return undefined;
  const preferredFixId = typeof row.preferredFixId === "string" ? row.preferredFixId.trim() : "";
  const preferredSteps = Array.isArray(row.preferredSteps)
    ? row.preferredSteps.filter((step): step is string => typeof step === "string" && Boolean(step.trim()))
    : [];
  const rejectedFixIds = Array.isArray(row.rejectedFixIds)
    ? unique(row.rejectedFixIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))
    : [];
  return compactEntry({
    printerId: row.printerId.trim(),
    material: memoryMaterialKey(row.material),
    symptom: row.symptom.trim().toLowerCase(),
    preferredFixId: preferredFixId || undefined,
    preferredSteps: preferredSteps.length ? preferredSteps : undefined,
    rejectedFixIds: rejectedFixIds.length ? rejectedFixIds : undefined,
  });
}

function compactEntry(entry: PrintDoctorMemoryEntry): PrintDoctorMemoryEntry | undefined {
  const preferredFixId = entry.preferredFixId?.trim() || undefined;
  const preferredSteps = (entry.preferredSteps ?? []).map((step) => step.trim()).filter(Boolean);
  const rejectedFixIds = unique((entry.rejectedFixIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (!entry.printerId.trim() || !entry.material.trim() || !entry.symptom.trim()) return undefined;
  if (!preferredFixId && preferredSteps.length === 0 && rejectedFixIds.length === 0) return undefined;
  return {
    printerId: entry.printerId.trim(),
    material: memoryMaterialKey(entry.material),
    symptom: entry.symptom.trim().toLowerCase(),
    ...(preferredFixId ? { preferredFixId } : {}),
    ...(preferredSteps.length ? { preferredSteps } : {}),
    ...(rejectedFixIds.length ? { rejectedFixIds } : {}),
  };
}

function upsert(store: PrintDoctorMemoryStore, entry: PrintDoctorMemoryEntry): PrintDoctorMemoryStore {
  const compacted = compactEntry(entry);
  const key = memoryScopeKey(entry);
  const entries = store.entries.filter((row) => memoryScopeKey(row) !== key);
  if (!compacted) return { entries };
  return { entries: [...entries, compacted] };
}

function omitEmpty(store: PrintDoctorMemoryStore): PrintDoctorMemoryStore {
  return { entries: store.entries.map(compactEntry).filter((entry): entry is PrintDoctorMemoryEntry => entry != null) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}
