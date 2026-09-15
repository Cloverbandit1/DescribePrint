/**
 * Structured camera-defect guides for Print doctor.
 * Hands-on only — this module never sends LAN commands.
 */

import type { CameraFailureKind } from "./camera";

export type CameraHelpGuideId = Exclude<CameraFailureKind, "none">;

export const CAMERA_HELP_GUIDE_IDS: readonly CameraHelpGuideId[] = [
  "spaghetti",
  "nozzle-scrape",
  "empty-bed",
] as const;

/** Suggested mid-print chips — never auto-sent. */
export type CameraHelpMidPrintAction = "pause" | "slow-down" | "cool-nozzle";

export type CameraHelpGuide = {
  id: CameraHelpGuideId;
  symptom: string;
  steps: string[];
  whenToRetrySoftware?: string;
  /** User-confirmed chips on the doctor bubble. Empty-bed is pause only. */
  midPrintActions: readonly CameraHelpMidPrintAction[];
};

type GuideTemplate = {
  symptom: string;
  steps: string[];
  whenToRetrySoftware?: string;
};

const MID_PRINT_ACTIONS: Record<CameraHelpGuideId, readonly CameraHelpMidPrintAction[]> = {
  spaghetti: ["pause", "slow-down", "cool-nozzle"],
  "nozzle-scrape": ["pause", "slow-down"],
  "empty-bed": ["pause"],
};

export function cameraHelpMidPrintActions(id: CameraHelpGuideId): readonly CameraHelpMidPrintAction[] {
  return MID_PRINT_ACTIONS[id];
}

const GUIDE_TEMPLATES: Record<CameraHelpGuideId, GuideTemplate> = {
  spaghetti: {
    symptom: "Camera suspected spaghetti — the part has left the plate.",
    steps: [
      "Pause or abort if the job is still extruding. Do not keep printing into air.",
      "Clear the spaghetti from the nozzle and plate. Watch for a stuck blob on the hotend.",
      "Wash the plate and check first-layer adhesion before reprinting.",
      "If the skirt never stuck, fix z-offset / bed temp before the next job.",
      "Emergency reshape of remaining layers is a later option (flag off by default). Do not auto-resume.",
    ],
    whenToRetrySoftware:
      "Retry only after the bed is clear. The camera stub does not pause or abort on its own.",
  },
  "nozzle-scrape": {
    symptom: "Camera suspected nozzle scrape — check z-offset or a crashed toolhead.",
    steps: [
      "Pause before inspecting the nozzle or plate.",
      "Check z-offset and whether the toolhead crashed into a curled part or the bed.",
      "Clear gouged plastic from the plate and look for a bent or scarred nozzle.",
      "Re-home and reprint only after the offset is safe.",
      "Do not keep printing a scrape — it can wreck the plate.",
    ],
    whenToRetrySoftware:
      "Retry only after you inspect z-offset and the plate. The camera stub does not pause on its own.",
  },
  "empty-bed": {
    symptom: "Camera suspected empty bed — the part may have come off.",
    steps: [
      "Pause. The plate looks empty — the part may have come off.",
      "Find the part (bed, bin, or still on the toolhead).",
      "Clean the plate and fix first-layer adhesion before reprinting.",
      "Confirm the live first-layer offset is not printing in air.",
      "Do not keep extruding onto an empty plate.",
    ],
    whenToRetrySoftware:
      "Retry only after you inspect the plate. The camera stub does not pause or abort on its own.",
  },
};

export function isCameraHelpGuideId(value: string | undefined): value is CameraHelpGuideId {
  return Boolean(value && (CAMERA_HELP_GUIDE_IDS as readonly string[]).includes(value));
}

export function buildCameraHelpGuide(id: CameraHelpGuideId): CameraHelpGuide {
  const template = GUIDE_TEMPLATES[id];
  return {
    id,
    symptom: template.symptom,
    steps: [...template.steps],
    midPrintActions: [...cameraHelpMidPrintActions(id)],
    ...(template.whenToRetrySoftware ? { whenToRetrySoftware: template.whenToRetrySoftware } : {}),
  };
}

export function cameraHelpPhysicalSteps(id: CameraHelpGuideId): string[] {
  return buildCameraHelpGuide(id).steps;
}

export function selectCameraHelpGuideId(input: {
  defectId?: string;
  failure?: string;
}): CameraHelpGuideId | undefined {
  if (isCameraHelpGuideId(input.defectId)) return input.defectId;
  if (isCameraHelpGuideId(input.failure)) return input.failure;
  return undefined;
}

export function selectCameraHelpGuide(input: {
  defectId?: string;
  failure?: string;
}): CameraHelpGuide | undefined {
  const id = selectCameraHelpGuideId(input);
  return id ? buildCameraHelpGuide(id) : undefined;
}
