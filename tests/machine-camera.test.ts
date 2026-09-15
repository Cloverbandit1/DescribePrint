import { afterEach, describe, expect, it } from "vitest";
import {
  detectFailure,
  futureLanJpegUrl,
  isCameraStubEnabled,
  mockCameraFrame,
  parseCameraStubPref,
  serializeCameraStubPref,
} from "@/lib/machine";

const FLAG = "BAMBU_CAMERA_STUB";

afterEach(() => {
  delete process.env[FLAG];
});

describe("camera / failure-detect stub", () => {
  it("stays off by default", () => {
    expect(isCameraStubEnabled()).toBe(false);
    expect(parseCameraStubPref(null)).toBe(false);
    expect(parseCameraStubPref("0")).toBe(false);
    expect(serializeCameraStubPref(true)).toBe("1");
  });

  it("turns on only when BAMBU_CAMERA_STUB is set", () => {
    process.env[FLAG] = "1";
    expect(isCameraStubEnabled()).toBe(true);
  });

  it("detectFailure returns none on the default mock frame", () => {
    const result = detectFailure();
    expect(result.kind).toBe("none");
    expect(result.failure).toBeUndefined();
    expect(result.frame.source).toBe("stub");
    expect(result.frame.jpeg).toBeUndefined();
    expect(result.hint).toMatch(/no failure/i);
  });

  it("classifies stub scenes as suspected failures with a print-doctor hint", () => {
    const spaghetti = detectFailure(mockCameraFrame("spaghetti"));
    expect(spaghetti.kind).toBe("suspected-failure");
    expect(spaghetti.failure).toBe("spaghetti");
    expect(spaghetti.hint).toMatch(/spaghetti/i);

    const scrape = detectFailure(mockCameraFrame("nozzle-scrape"));
    expect(scrape.kind).toBe("suspected-failure");
    expect(scrape.failure).toBe("nozzle-scrape");
    expect(scrape.hint).toMatch(/scrape|z-offset/i);

    const empty = detectFailure(mockCameraFrame("empty-bed"));
    expect(empty.kind).toBe("suspected-failure");
    expect(empty.failure).toBe("empty-bed");
    expect(empty.hint).toMatch(/empty bed/i);
  });

  it("exposes a later LAN JPEG attach URL without fetching it", () => {
    expect(futureLanJpegUrl("192.168.1.20")).toBe("http://192.168.1.20:6000/");
  });
});
