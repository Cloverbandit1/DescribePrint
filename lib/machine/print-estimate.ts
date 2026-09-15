/**
 * Print time / filament / cost estimate stub.
 *
 * Advisory only: volume × infill × density, time from volumetric flow.
 * Never a LAN write, farm enqueue, or slicer.
 */

import { boundingBoxMm, signedVolumeMm3 } from "../mesh-check";
import {
  defaultPrinter,
  filamentPreset,
  normalizeFilamentId,
  type FilamentId,
  type PrinterProfile,
} from "../printers";
import type { BoundingBoxMm, Mesh, PrintabilityReport } from "../types";

export type PrintEstimateVolumeSource = "mesh" | "aabb";

export type PrintEstimateAssumptions = {
  stub: true;
  approximate: true;
  volumeSource: PrintEstimateVolumeSource;
  solidVolumeMm3: number;
  plasticVolumeMm3: number;
  infillFactor: number;
  densityGcm3: number;
  costPerKg: number;
  material: FilamentId;
  printSpeedMms: number;
  layerHeightMm: number;
  nozzleMm: number;
  filamentDiameterMm: number;
  volumetricFlowMm3s: number;
  note: string;
};

export type PrintEstimate = {
  timeMinutes: number;
  filamentGrams: number;
  filamentMeters: number;
  costUsd: number;
  assumptions: PrintEstimateAssumptions;
};

export type PrintEstimateInput = {
  volumeMm3?: number | null;
  boundingBoxMm?: BoundingBoxMm | { size: [number, number, number] } | null;
  mesh?: Mesh | null;
  material?: FilamentId | string | null;
  costPerKg?: number | null;
  infillFactor?: number | null;
  printer?: PrinterProfile;
};

/** Browser session key for optional $/kg overrides (JSON map). */
export const ESTIMATE_COST_SESSION_KEY = "describeprint.estimate.costPerKg";

/** Stub infill + walls stand-in. Not a slicer profile. */
export const DEFAULT_INFILL_FACTOR = 0.2;

const VOLUME_EPS = 1e-6;

/**
 * Approximate filament densities (g/cm³). Typical FDM / slicer constants,
 * not a specific spool lot.
 *
 * - PLA 1.24 — NatureWorks Ingeo-class PLA; Cura / PrusaSlicer default
 * - PETG 1.27 — generic PETG datasheets; Cura / PrusaSlicer default
 * - PA 1.14 — unfilled PA6-class nylon (PA12 is closer to 1.01)
 * - ABS 1.04 — generic ABS; Cura / PrusaSlicer default
 * - TPU 1.21 — ~95A TPU (NinjaFlex-class ~1.20–1.22)
 */
export const FILAMENT_DENSITY_GCM3: Record<FilamentId, number> = {
  pla: 1.24,
  petg: 1.27,
  pa: 1.14,
  abs: 1.04,
  tpu: 1.21,
};

/** Approximate consumer 1 kg spool prices (USD). User-editable in the Print column. */
export const DEFAULT_FILAMENT_COST_PER_KG: Record<FilamentId, number> = {
  pla: 20,
  petg: 25,
  pa: 45,
  abs: 22,
  tpu: 35,
};

export const PRINT_ESTIMATE_NOTE =
  "Estimate (stub) · mesh/AABB volume × 20% infill × density; time from preset speed × nozzle × layer height. Approximate.";

export function aabbVolumeMm3(box: BoundingBoxMm | { size: [number, number, number] } | null | undefined): number {
  const size = box?.size;
  if (!size) return 0;
  const [x, y, z] = size;
  if (![x, y, z].every((n) => Number.isFinite(n) && n > 0)) return 0;
  return x * y * z;
}

export function densityGcm3For(id: FilamentId): number {
  return FILAMENT_DENSITY_GCM3[id];
}

export function defaultCostPerKgFor(id: FilamentId): number {
  return DEFAULT_FILAMENT_COST_PER_KG[id];
}

export function parseCostPerKgSession(
  raw: string | null | undefined,
  material: FilamentId,
): number {
  const map = parseCostPerKgMap(raw);
  return map[material] ?? defaultCostPerKgFor(material);
}

export function parseCostPerKgMap(raw: string | null | undefined): Partial<Record<FilamentId, number>> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<FilamentId, number>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = normalizeFilamentId(key);
      const n = typeof value === "number" ? value : Number(value);
      if (id && Number.isFinite(n) && n > 0 && n < 10_000) out[id] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeCostPerKgMap(map: Partial<Record<FilamentId, number>>): string {
  const clean: Partial<Record<FilamentId, number>> = {};
  for (const [key, value] of Object.entries(map)) {
    const id = normalizeFilamentId(key);
    if (id && typeof value === "number" && Number.isFinite(value) && value > 0) {
      clean[id] = value;
    }
  }
  return JSON.stringify(clean);
}

function resolveSolidVolume(input: PrintEstimateInput): { volumeMm3: number; source: PrintEstimateVolumeSource } | null {
  if (input.mesh && input.mesh.triangles.length > 0) {
    const meshVolume = Math.abs(signedVolumeMm3(input.mesh));
    if (meshVolume > VOLUME_EPS) return { volumeMm3: meshVolume, source: "mesh" };
    const box = boundingBoxMm(input.mesh);
    const aabb = aabbVolumeMm3(box);
    if (aabb > VOLUME_EPS) return { volumeMm3: aabb, source: "aabb" };
    return null;
  }

  const reported = input.volumeMm3;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > VOLUME_EPS) {
    return { volumeMm3: reported, source: "mesh" };
  }

  const aabb = aabbVolumeMm3(input.boundingBoxMm);
  if (aabb > VOLUME_EPS) return { volumeMm3: aabb, source: "aabb" };
  return null;
}

function roundGrams(n: number): number {
  if (n >= 100) return Math.round(n);
  return Math.round(n * 10) / 10;
}

function roundMeters(n: number): number {
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

function roundMinutes(n: number): number {
  return Math.max(1, Math.round(n));
}

function roundCostUsd(n: number): number {
  return Math.round(n * 100) / 100;
}

export function estimatePrint(input: PrintEstimateInput): PrintEstimate | null {
  const solid = resolveSolidVolume(input);
  if (!solid) return null;

  const printer = input.printer ?? defaultPrinter();
  const material = normalizeFilamentId(typeof input.material === "string" ? input.material : undefined) ?? printer.defaultFilament;
  const preset = filamentPreset(material, printer);
  const infill =
    typeof input.infillFactor === "number" && Number.isFinite(input.infillFactor) && input.infillFactor > 0
      ? Math.min(1, input.infillFactor)
      : DEFAULT_INFILL_FACTOR;
  const density = densityGcm3For(material);
  const costPerKg =
    typeof input.costPerKg === "number" && Number.isFinite(input.costPerKg) && input.costPerKg > 0
      ? input.costPerKg
      : defaultCostPerKgFor(material);

  const plasticVolumeMm3 = solid.volumeMm3 * infill;
  const filamentGramsRaw = (plasticVolumeMm3 / 1000) * density;
  const radiusMm = printer.filamentDiameterMm / 2;
  const crossSectionMm2 = Math.PI * radiusMm * radiusMm;
  const filamentMetersRaw = crossSectionMm2 > 0 ? plasticVolumeMm3 / crossSectionMm2 / 1000 : 0;

  const flowFrac = preset.flowPercent > 0 ? preset.flowPercent / 100 : 1;
  const volumetricFlowMm3s = preset.printSpeedMms * printer.nozzleMm * preset.layerHeightMm * flowFrac;
  const timeMinutesRaw = volumetricFlowMm3s > 0 ? plasticVolumeMm3 / volumetricFlowMm3s / 60 : 0;

  return {
    timeMinutes: roundMinutes(timeMinutesRaw),
    filamentGrams: roundGrams(filamentGramsRaw),
    filamentMeters: roundMeters(filamentMetersRaw),
    costUsd: roundCostUsd((filamentGramsRaw / 1000) * costPerKg),
    assumptions: {
      stub: true,
      approximate: true,
      volumeSource: solid.source,
      solidVolumeMm3: solid.volumeMm3,
      plasticVolumeMm3,
      infillFactor: infill,
      densityGcm3: density,
      costPerKg,
      material,
      printSpeedMms: preset.printSpeedMms,
      layerHeightMm: preset.layerHeightMm,
      nozzleMm: printer.nozzleMm,
      filamentDiameterMm: printer.filamentDiameterMm,
      volumetricFlowMm3s,
      note: PRINT_ESTIMATE_NOTE,
    },
  };
}

export function estimatePrintFromReport(
  report: PrintabilityReport | null | undefined,
  material?: FilamentId | string | null,
  options: Omit<PrintEstimateInput, "volumeMm3" | "boundingBoxMm" | "mesh" | "material"> = {},
): PrintEstimate | null {
  if (!report) return null;
  return estimatePrint({
    ...options,
    volumeMm3: report.volumeMm3,
    boundingBoxMm: report.boundingBoxMm,
    material,
  });
}

export function formatEstimateTime(minutes: number): string {
  const total = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours <= 0) return `${Math.max(1, mins)}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function formatEstimateGrams(grams: number): string {
  if (!Number.isFinite(grams)) return "— g";
  if (grams >= 100) return `${Math.round(grams)} g`;
  const rounded = Math.round(grams * 10) / 10;
  return `${rounded.toFixed(1).replace(/\.0$/, "")} g`;
}

/** Compact Print-column line: "~1h 5m · 12 g · $0.24 (stub)". */
export function formatPrintEstimateLine(estimate: PrintEstimate): string {
  return `~${formatEstimateTime(estimate.timeMinutes)} · ${formatEstimateGrams(estimate.filamentGrams)} · $${estimate.costUsd.toFixed(2)} (stub)`;
}
