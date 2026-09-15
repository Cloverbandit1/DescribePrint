/**
 * Debounced camera-detect → Print doctor chat.
 * One announcement per failure kind until the stub returns ok or the user dismisses.
 * Never sends LAN or auto-pauses — Pause now uses the mid-print phrase path.
 */

import { diagnosisFromCameraDetect, type PrintDoctorResult } from "../print-doctor";
import type { CameraDetectReport, CameraFailureKind } from "./camera";
import { isCameraHelpGuideId, type CameraHelpGuideId } from "./camera-help";
import { parseMidPrintCommandPhrase, type MidPrintIntent } from "./mid-print-commands";

/** Same whole-utterance phrase as chat mid-print pause. */
export const CAMERA_PAUSE_NOW_PHRASE = "pause now";

export type CameraDoctorHeld = CameraHelpGuideId | null;

export type CameraDoctorAnnouncement = {
  held: CameraDoctorHeld;
  announce?: PrintDoctorResult;
};

export function cameraFailureKind(
  detect: Pick<CameraDetectReport, "kind" | "failure"> | undefined,
): CameraDoctorHeld {
  if (!detect || detect.kind !== "suspected-failure" || !isCameraHelpGuideId(detect.failure)) {
    return null;
  }
  return detect.failure;
}

/**
 * Off / none / missing detect clears the hold so a later failure can announce.
 * The same suspected kind is ignored until cleared.
 */
export function takeCameraDoctorAnnouncement(
  held: CameraDoctorHeld,
  detect: CameraDetectReport | undefined,
  diagnosis?: PrintDoctorResult,
): CameraDoctorAnnouncement {
  const failure = cameraFailureKind(detect);
  if (!failure) return { held: null };
  if (held === failure) return { held };
  const result =
    diagnosis && (diagnosis.defectId === failure || diagnosis.cameraGuide?.id === failure)
      ? diagnosis
      : diagnosisFromCameraDetect(detect);
  if (!result) return { held };
  return { held: failure, announce: result };
}

/** Perfect / Still bad / dismiss — keep the hold so the next poll does not re-append. */
export function dismissCameraDoctor(held: CameraDoctorHeld, kind?: string): CameraDoctorHeld {
  if (isCameraHelpGuideId(kind)) return kind;
  return held;
}

export function offersCameraPauseChip(result: Pick<PrintDoctorResult, "cameraGuide">): boolean {
  return result.cameraGuide != null;
}

export function cameraPauseNowIntent(): MidPrintIntent | null {
  return parseMidPrintCommandPhrase(CAMERA_PAUSE_NOW_PHRASE);
}

export function isCameraDoctorCueEnabled(cameraOn: boolean, detect?: CameraDetectReport): boolean {
  return cameraOn && detect != null;
}

export function shouldShowCameraOk(cameraOn: boolean, detect?: CameraDetectReport): boolean {
  return cameraOn && (detect == null || detect.kind === "none" || detect.severity === "ok");
}

/** Compile-time / test helper — this bridge must not pull CAD assembly or pack modules. */
export function cameraDoctorBridgeOwnsPrintControlOnly(): true {
  return true;
}

export type { CameraFailureKind };
