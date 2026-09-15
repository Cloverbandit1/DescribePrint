import { defaultPrinter, type PrinterId } from "../printers";
import { mapDesignFilamentsToAms } from "./ams";
import type { CommandResult, FilamentPlan, LiveMachineStatus, RemainingLayerReshapePlan } from "./types";

/** Print Control never resumes in this flow. CAD Core / the user resume by hand. */
export const RESUME_IS_MANUAL = "Resume is manual";

/** Instruction CAD Core should execute later — not OpenSCAD generation here. */
export const CAD_RESHAPE_INSTRUCTION = "redesign unprinted upper above Z" as const;

/**
 * Axis-aligned stump footprint on the cut plane, millimeters.
 * Print Control measures the already-printed top face at current Z (XY only).
 */
export type StumpCutPlaneBoundsMm = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Typed handoff for Allos CAD Core (Bella).
 * Allos Print Control emits this; CAD Core consumes it later to generate a
 * new OpenSCAD/mesh for the unprinted region only. Do not rewrite geometry here.
 */
export type CadReshapeHandoff = {
  owner: "allos-cad-core";
  from: "allos-print-control";
  kind: "redesign-unprinted-upper";
  instruction: typeof CAD_RESHAPE_INSTRUCTION;
  /** Already-printed stump height (current Z). */
  currentZ: number | null;
  remainingHeightMm: number | null;
  remainingLayers: number | null;
  layer?: number;
  totalLayers?: number;
  printerId: PrinterId;
  suggestedNextStep: string;
  /** Original-part OpenSCAD when Print Control already has it. */
  previousCode?: string;
  /** Stump XY bounds at the cut plane (`stumpCutPlaneBoundsMm`, mm). */
  stumpCutPlaneBoundsMm?: StumpCutPlaneBoundsMm;
  /** Layer height in mm. CAD still will not invent remainingHeightMm from remainingLayers alone. */
  layerHeightMm?: number;
};

/** Reslice stub — printer profile + AMS mapping. Never send gcode. */
export type ReslicePlanStub = {
  kind: "reslice-remaining-stub";
  printerProfile: "P2S";
  printerId: PrinterId;
  amsMapping: FilamentPlan;
  sendGcode: false;
  note: string;
};

export type EmergencyRemainingReshapePlan = {
  attempted: boolean;
  enabled: boolean;
  requested: boolean;
  paused: boolean;
  pauseConfirmed: boolean;
  /** Recorded when the adapter is not connected or pause could not be sent. */
  pauseNeeded: boolean;
  resume: "manual";
  resumeNote: typeof RESUME_IS_MANUAL;
  sentResume: false;
  remainingHeightMm: number | null;
  currentZ: number | null;
  remainingLayers: number | null;
  cadHandoff?: CadReshapeHandoff;
  reslice?: ReslicePlanStub;
  planner?: RemainingLayerReshapePlan;
  message: string;
  commands: CommandResult[];
};

export function emptyReshapePlan(partial: Partial<EmergencyRemainingReshapePlan> & Pick<EmergencyRemainingReshapePlan, "message">): EmergencyRemainingReshapePlan {
  return {
    attempted: false,
    enabled: false,
    requested: false,
    paused: false,
    pauseConfirmed: false,
    pauseNeeded: false,
    resume: "manual",
    resumeNote: RESUME_IS_MANUAL,
    sentResume: false,
    remainingHeightMm: null,
    currentZ: null,
    remainingLayers: null,
    commands: [],
    ...partial,
  };
}

export function suggestedCadNextStep(currentZ: number | null, remainingHeightMm: number | null): string {
  const zBit = currentZ != null ? `${currentZ.toFixed(2)} mm` : "current Z";
  const hBit = remainingHeightMm != null ? `${remainingHeightMm.toFixed(2)} mm` : "remaining height H";
  return `CAD Core: generate new OpenSCAD/mesh for the unprinted region only (${hBit} above Z ${zBit}). Do not rewrite already-printed geometry.`;
}

export function isStumpCutPlaneBoundsMm(value: unknown): value is StumpCutPlaneBoundsMm {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const minX = typeof row.minX === "number" && Number.isFinite(row.minX) ? row.minX : undefined;
  const minY = typeof row.minY === "number" && Number.isFinite(row.minY) ? row.minY : undefined;
  const maxX = typeof row.maxX === "number" && Number.isFinite(row.maxX) ? row.maxX : undefined;
  const maxY = typeof row.maxY === "number" && Number.isFinite(row.maxY) ? row.maxY : undefined;
  return minX !== undefined && minY !== undefined && maxX !== undefined && maxY !== undefined && maxX > minX && maxY > minY;
}

export function buildCadReshapeHandoff(input: {
  currentZ: number | null;
  remainingHeightMm: number | null;
  remainingLayers: number | null;
  layer?: number;
  totalLayers?: number;
  printerId?: PrinterId;
  previousCode?: string;
  stumpCutPlaneBoundsMm?: StumpCutPlaneBoundsMm;
  layerHeightMm?: number;
}): CadReshapeHandoff {
  const printerId = input.printerId ?? defaultPrinter().id;
  const previousCode = input.previousCode?.trim() ? input.previousCode : undefined;
  const stumpCutPlaneBoundsMm = isStumpCutPlaneBoundsMm(input.stumpCutPlaneBoundsMm)
    ? {
        minX: input.stumpCutPlaneBoundsMm.minX,
        minY: input.stumpCutPlaneBoundsMm.minY,
        maxX: input.stumpCutPlaneBoundsMm.maxX,
        maxY: input.stumpCutPlaneBoundsMm.maxY,
      }
    : undefined;
  const layerHeightMm =
    input.layerHeightMm != null && Number.isFinite(input.layerHeightMm) && input.layerHeightMm > 0
      ? input.layerHeightMm
      : undefined;
  return {
    owner: "allos-cad-core",
    from: "allos-print-control",
    kind: "redesign-unprinted-upper",
    instruction: CAD_RESHAPE_INSTRUCTION,
    currentZ: input.currentZ,
    remainingHeightMm: input.remainingHeightMm,
    remainingLayers: input.remainingLayers,
    layer: input.layer,
    totalLayers: input.totalLayers,
    printerId,
    suggestedNextStep: suggestedCadNextStep(input.currentZ, input.remainingHeightMm),
    ...(previousCode ? { previousCode } : {}),
    ...(stumpCutPlaneBoundsMm ? { stumpCutPlaneBoundsMm } : {}),
    ...(layerHeightMm != null ? { layerHeightMm } : {}),
  };
}

export function buildReslicePlanStub(status?: LiveMachineStatus, printerId: PrinterId = defaultPrinter().id): ReslicePlanStub {
  const slots = status?.amsSlots ?? [];
  const design = slots
    .filter((slot) => slot.present)
    .map((slot) => ({
      id: `ams-${slot.slot}`,
      type: String(slot.filamentType ?? "pla"),
      colorHex: slot.colorHex,
      name: slot.name,
    }));
  return {
    kind: "reslice-remaining-stub",
    printerProfile: "P2S",
    printerId,
    amsMapping: mapDesignFilamentsToAms(design, slots),
    sendGcode: false,
    note: "Do not send gcode. Reslice the CAD Core mesh for the remaining height only (P2S profile + AMS mapping).",
  };
}

export function formatEmergencyReshapeMessage(input: {
  paused: boolean;
  pauseNeeded: boolean;
  remainingHeightMm: number | null;
  currentZ: number | null;
  remainingLayers: number | null;
}): string {
  const pauseBit = input.pauseNeeded
    ? "Pause needed (adapter not connected)."
    : input.paused
      ? "Paused."
      : "Pause confirmed.";
  const heightBit =
    input.remainingHeightMm != null ? `remaining height ${input.remainingHeightMm.toFixed(2)} mm` : "remaining height unknown";
  const zBit = input.currentZ != null ? `current Z ${input.currentZ.toFixed(2)} mm` : "current Z unknown";
  const layerBit = input.remainingLayers != null ? `${input.remainingLayers} layer(s) left` : "layer count unknown";
  return `${pauseBit} ${heightBit}; ${zBit}; ${layerBit}. Redesign unprinted upper above Z. ${RESUME_IS_MANUAL}.`;
}
