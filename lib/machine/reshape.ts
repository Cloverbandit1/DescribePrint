import type { MachineAdapter } from "./adapter";
import { envFlagEnabled, type ProcessEnvLike } from "./config";
import {
  buildCadReshapeHandoff,
  buildReslicePlanStub,
  emptyReshapePlan,
  formatEmergencyReshapeMessage,
  resolveHandoffLayerHeightMm,
  resolveHandoffPreviousCode,
  stumpCutPlaneBoundsFromJobStl,
  RESUME_IS_MANUAL,
  type EmergencyRemainingReshapePlan,
} from "./reshape-plan";
import type { LiveMachineStatus, RemainingLayerReshapePlan } from "./types";
import { getJob, getLatestJob } from "../jobs";
import { isEmergencyReshapeRequest } from "../print-doctor";

export type ReshapePlannerInput = {
  print?: "idle" | "printing" | "paused" | "finished";
  currentLayer?: number;
  totalLayers?: number;
  layerHeightMm?: number;
  currentHeightMm?: number;
  objectHeightMm?: number;
  /** Injected remaining height (mock / tests). Wins over derived height. */
  remainingHeightMm?: number;
};

export const MACHINE_RESHAPE_STORAGE_KEY = "describeprint.machine.reshapeRemaining";

const LATER_OPTION =
  "Emergency reshape of remaining layers is a later option (off unless RESHAPE_REMAINING is on).";

let lastPlan: EmergencyRemainingReshapePlan | null = null;

/** Remaining-layer reshape is off unless RESHAPE_REMAINING is explicitly enabled. */
export function isReshapeRemainingEnabled(env: ProcessEnvLike = process.env): boolean {
  return envFlagEnabled(env.RESHAPE_REMAINING, false);
}

/** Env flag or Machine-panel checkbox (session / poll query). */
export function isReshapeRemainingActive(env: ProcessEnvLike = process.env, sessionFlag = false): boolean {
  return isReshapeRemainingEnabled(env) || sessionFlag === true;
}

export function parseReshapeRemainingPref(raw: string | null | undefined): boolean {
  return envFlagEnabled(raw ?? undefined, false);
}

export function serializeReshapeRemainingPref(enabled: boolean): string {
  return enabled ? "1" : "0";
}

export function peekLastReshapePlan(): EmergencyRemainingReshapePlan | undefined {
  return lastPlan ?? undefined;
}

export function rememberReshapePlan(plan: EmergencyRemainingReshapePlan | null): void {
  lastPlan = plan;
}

export function resetReshapeState(): void {
  lastPlan = null;
}

function remainingFromHeights(current: number, total: number): number {
  return Math.max(0, total - current);
}

function finiteNumber(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined;
}

export function resolveCurrentZ(input: ReshapePlannerInput, remainingHeightMm: number | null): number | null {
  const current = finiteNumber(input.currentHeightMm);
  if (current != null) return current;
  const object = finiteNumber(input.objectHeightMm);
  if (object != null && remainingHeightMm != null) return Math.max(0, object - remainingHeightMm);
  const layer = finiteNumber(input.currentLayer);
  const layerHeight = finiteNumber(input.layerHeightMm);
  if (layer != null && layerHeight != null) return layer * layerHeight;
  return null;
}

/**
 * Emergency remaining-layer reshape planner stub.
 * Does not rewrite CAD. Tells the UI when to pause and what height to hand to CAD Core.
 */
export function planRemainingLayerReshape(input: ReshapePlannerInput): RemainingLayerReshapePlan {
  if (input.print === "idle" || input.print === "finished") {
    return {
      action: "nothing-remaining",
      remainingHeightMm: 0,
      remainingLayers: 0,
      currentZ: finiteNumber(input.currentHeightMm) ?? 0,
      askCad: false,
      message: "Nothing is printing — CAD reshape is not needed.",
    };
  }

  let remainingHeightMm: number | null = null;
  let remainingLayers: number | null = null;

  const injected = finiteNumber(input.remainingHeightMm);
  if (injected != null) {
    remainingHeightMm = Math.max(0, injected);
  }

  if (
    remainingHeightMm == null &&
    input.currentHeightMm != null &&
    input.objectHeightMm != null &&
    Number.isFinite(input.currentHeightMm) &&
    Number.isFinite(input.objectHeightMm)
  ) {
    remainingHeightMm = remainingFromHeights(input.currentHeightMm, input.objectHeightMm);
  }

  if (
    input.currentLayer != null &&
    input.totalLayers != null &&
    Number.isFinite(input.currentLayer) &&
    Number.isFinite(input.totalLayers)
  ) {
    remainingLayers = Math.max(0, input.totalLayers - input.currentLayer);
    if (remainingHeightMm == null && input.layerHeightMm && Number.isFinite(input.layerHeightMm)) {
      remainingHeightMm = remainingLayers * input.layerHeightMm;
    }
  }

  const currentZ = resolveCurrentZ(input, remainingHeightMm);

  if (remainingHeightMm == null && remainingLayers == null) {
    return {
      action: "insufficient-data",
      remainingHeightMm: null,
      remainingLayers: null,
      currentZ,
      askCad: false,
      message: "Need live layer or height remaining before asking CAD to restyle the rest.",
    };
  }

  if ((remainingHeightMm ?? 0) <= 0 && (remainingLayers ?? 0) <= 0) {
    return {
      action: "nothing-remaining",
      remainingHeightMm: remainingHeightMm ?? 0,
      remainingLayers: remainingLayers ?? 0,
      currentZ,
      askCad: false,
      message: "No unprinted height left to restyle.",
    };
  }

  const heightBit =
    remainingHeightMm != null ? `remaining height ${remainingHeightMm.toFixed(2)} mm` : "remaining height unknown";
  const layerBit = remainingLayers != null ? `${remainingLayers} layer(s) left` : "layer count unknown";

  return {
    action: "pause-now",
    remainingHeightMm,
    remainingLayers,
    currentZ,
    askCad: true,
    message: `Pause now; ${heightBit}; ${layerBit}. Ask CAD to restyle only the unprinted remainder.`,
  };
}

function plannerInputFromStatus(status: LiveMachineStatus): ReshapePlannerInput {
  return {
    print: status.print,
    currentLayer: status.layer,
    totalLayers: status.totalLayers,
    currentHeightMm: status.currentHeightMm,
    objectHeightMm: status.objectHeightMm,
    remainingHeightMm: status.remainingHeightMm,
  };
}

/**
 * Diagnose-only unless RESHAPE_REMAINING (or the Machine-panel checkbox) is on.
 * When on: safe pause, emit a CAD-handoff + reslice plan, never resume.
 */
export async function maybeEmergencyReshapeRemaining(opts: {
  adapter: MachineAdapter;
  complaint?: string;
  defectId?: string;
  cameraDetect?: { kind?: string };
  status?: LiveMachineStatus;
  enabled?: boolean;
  env?: ProcessEnvLike;
  /** Current generate job when the client names one. Else the latest in-memory result. */
  jobId?: string;
  previousCode?: string;
  /** Selected Machine-panel material. Not the doctor's inferred default. */
  material?: string;
}): Promise<EmergencyRemainingReshapePlan> {
  const enabled = opts.enabled ?? isReshapeRemainingEnabled(opts.env);
  const requested =
    opts.defectId === "emergency-reshape" ||
    isEmergencyReshapeRequest(opts.complaint ?? "", opts.cameraDetect);

  if (!requested) {
    return emptyReshapePlan({ enabled, message: "No emergency reshape requested." });
  }

  if (!enabled) {
    return emptyReshapePlan({
      enabled: false,
      requested: true,
      message: `${LATER_OPTION} No pause and no live plan.`,
    });
  }

  const before = opts.status ?? (await opts.adapter.status());
  const commands: EmergencyRemainingReshapePlan["commands"] = [];
  let paused = before.print === "paused";
  let pauseConfirmed = before.print === "paused";
  let pauseNeeded = false;

  if (before.connection !== "connected") {
    pauseNeeded = before.print === "printing" || before.print === "paused" || before.print === "idle";
    if (before.print === "printing") pauseNeeded = true;
  } else if (before.print === "printing") {
    const pause = await opts.adapter.send({ type: "pause" });
    commands.push(pause);
    if (pause.ok) {
      paused = true;
      pauseConfirmed = true;
    } else {
      pauseNeeded = true;
    }
  } else if (before.print === "paused") {
    paused = true;
    pauseConfirmed = true;
  }

  const after = await opts.adapter.status();
  if (after.print === "paused") {
    paused = true;
    pauseConfirmed = true;
  }

  const planner = planRemainingLayerReshape(plannerInputFromStatus(after));
  const remainingHeightMm = planner.remainingHeightMm;
  const currentZ = planner.currentZ ?? resolveCurrentZ(plannerInputFromStatus(after), remainingHeightMm);
  const remainingLayers = planner.remainingLayers;
  const job = opts.jobId ? getJob(opts.jobId) : getLatestJob();
  const previousCode = opts.previousCode ?? resolveHandoffPreviousCode(job);
  const layerHeightMm = resolveHandoffLayerHeightMm({
    statusLayerHeightMm: after.layerHeightMm,
    material: opts.material,
    jobMaterial: job?.printPreset.material,
  });
  const stumpCutPlaneBoundsMm = stumpCutPlaneBoundsFromJobStl(job?.stl, currentZ);
  const cadHandoff = buildCadReshapeHandoff({
    currentZ,
    remainingHeightMm,
    remainingLayers,
    layer: after.layer,
    totalLayers: after.totalLayers,
    printerId: after.printerId,
    previousCode,
    stumpCutPlaneBoundsMm,
    layerHeightMm,
  });
  const reslice = buildReslicePlanStub(after, after.printerId);
  const message = formatEmergencyReshapeMessage({
    paused,
    pauseNeeded,
    remainingHeightMm,
    currentZ,
    remainingLayers,
  });

  const plan: EmergencyRemainingReshapePlan = {
    attempted: true,
    enabled: true,
    requested: true,
    paused,
    pauseConfirmed,
    pauseNeeded,
    resume: "manual",
    resumeNote: RESUME_IS_MANUAL,
    sentResume: false,
    remainingHeightMm,
    currentZ,
    remainingLayers,
    cadHandoff,
    reslice,
    planner,
    message,
    commands,
  };
  rememberReshapePlan(plan);
  return plan;
}

export { RESUME_IS_MANUAL, LATER_OPTION as RESHAPE_LATER_OPTION };
export type { CadReshapeHandoff, EmergencyRemainingReshapePlan, ReslicePlanStub, StumpCutPlaneBoundsMm } from "./reshape-plan";
