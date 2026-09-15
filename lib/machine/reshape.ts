import type { RemainingLayerReshapePlan } from "./types";

export type ReshapePlannerInput = {
  print?: "idle" | "printing" | "paused" | "finished";
  currentLayer?: number;
  totalLayers?: number;
  layerHeightMm?: number;
  currentHeightMm?: number;
  objectHeightMm?: number;
};

function remainingFromHeights(current: number, total: number): number {
  return Math.max(0, total - current);
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
      askCad: false,
      message: "Nothing is printing — CAD reshape is not needed.",
    };
  }

  let remainingHeightMm: number | null = null;
  let remainingLayers: number | null = null;

  if (
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

  if (remainingHeightMm == null && remainingLayers == null) {
    return {
      action: "insufficient-data",
      remainingHeightMm: null,
      remainingLayers: null,
      askCad: false,
      message: "Need live layer or height remaining before asking CAD to restyle the rest.",
    };
  }

  if ((remainingHeightMm ?? 0) <= 0 && (remainingLayers ?? 0) <= 0) {
    return {
      action: "nothing-remaining",
      remainingHeightMm: remainingHeightMm ?? 0,
      remainingLayers: remainingLayers ?? 0,
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
    askCad: true,
    message: `Pause now; ${heightBit}; ${layerBit}. Ask CAD to restyle only the unprinted remainder.`,
  };
}
