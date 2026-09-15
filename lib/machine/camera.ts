import { envFlagEnabled, type ProcessEnvLike } from "./config";

/**
 * Camera / failure-detect stub. No real stream, no LAN JPEG fetch.
 * A later adapter can attach `jpeg` bytes from a LAN snapshot URL.
 */
export type CameraFailureKind = "none" | "spaghetti" | "nozzle-scrape" | "empty-bed";

export type CameraSource = "stub" | "lan-jpeg";

export type CameraFrame = {
  source: CameraSource;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  /** Present when a later LAN JPEG fetcher attaches bytes. Stub frames omit this. */
  jpeg?: Uint8Array;
  /** Stub-only scene so tests can force a classification without pixels. */
  scene?: CameraFailureKind;
};

export type FailureDetection = {
  kind: "none" | "suspected-failure";
  failure?: Exclude<CameraFailureKind, "none">;
  confidence: "low" | "medium" | "high";
  /** Print-doctor-style one-liner. */
  hint: string;
  frame: CameraFrame;
};

export const MACHINE_CAMERA_STORAGE_KEY = "describeprint.machine.cameraStub";

const STUB_HINTS: Record<Exclude<CameraFailureKind, "none">, string> = {
  spaghetti: "Suspected spaghetti / print detached. Pause or abort; do not keep extruding into air.",
  "nozzle-scrape": "Suspected nozzle scrape. Pause and check z-offset / a crashed toolhead before reprinting.",
  "empty-bed": "Suspected empty bed — the part may have come off. Pause and inspect the plate.",
};

/** Camera stub is off unless BAMBU_CAMERA_STUB is explicitly enabled. */
export function isCameraStubEnabled(env: ProcessEnvLike = process.env): boolean {
  return envFlagEnabled(env.BAMBU_CAMERA_STUB, false);
}

export function parseCameraStubPref(raw: string | null | undefined): boolean {
  return envFlagEnabled(raw ?? undefined, false);
}

export function serializeCameraStubPref(enabled: boolean): string {
  return enabled ? "1" : "0";
}

/**
 * Future attach point for a LAN camera JPEG. Not fetched by this stub.
 * Community stacks often expose a local HTTP snapshot near this URL.
 */
export function futureLanJpegUrl(host: string, port = 6000): string {
  return `http://${host.trim()}:${port}/`;
}

export function mockCameraFrame(scene: CameraFailureKind = "none"): CameraFrame {
  return {
    source: "stub",
    capturedAt: "1970-01-01T00:00:00.000Z",
    width: 320,
    height: 240,
    mimeType: "image/jpeg",
    scene,
  };
}

/**
 * Classify a (usually stub) frame. Tests use this only — no network, no model.
 * A later revision can run a real classifier on `frame.jpeg`.
 */
export function detectFailure(frame: CameraFrame = mockCameraFrame("none")): FailureDetection {
  const scene = frame.scene ?? "none";
  if (scene === "none") {
    return {
      kind: "none",
      confidence: "medium",
      hint: "Camera stub sees a normal bed — no failure classified.",
      frame,
    };
  }
  return {
    kind: "suspected-failure",
    failure: scene,
    confidence: "low",
    hint: STUB_HINTS[scene],
    frame,
  };
}
