import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/machine/route";
import {
  cameraDetectCallCount,
  cameraStatusLine,
  detectFailure,
  futureLanJpegUrl,
  getSharedMachine,
  injectStubCameraScene,
  isCameraStubEnabled,
  machineMonitorPollPath,
  mockCameraFrame,
  parseCameraStubPref,
  resetSharedMachine,
  serializeCameraStubPref,
} from "@/lib/machine";
import { diagnosisFromCameraDetect, diagnosePrintComplaint } from "@/lib/print-doctor";
import { MockMachineAdapter } from "@/lib/machine/mock";

const FLAG = "BAMBU_CAMERA_STUB";

afterEach(() => {
  delete process.env[FLAG];
  delete process.env.AMS_AUTOFIX;
  resetSharedMachine();
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

  it("formats the Machine-panel camera line", () => {
    expect(cameraStatusLine({ kind: "none" })).toBe("ok");
    expect(cameraStatusLine({ kind: "suspected-failure", failure: "spaghetti" })).toBe("suspected spaghetti");
    expect(cameraStatusLine({ kind: "suspected-failure", failure: "nozzle-scrape" })).toBe(
      "suspected nozzle scrape",
    );
    expect(cameraStatusLine({ kind: "suspected-failure", failure: "empty-bed" })).toBe("suspected empty bed");
  });

  it("sends the checkbox on each monitor poll path", () => {
    expect(machineMonitorPollPath(false)).toBe("/api/machine?cameraStub=0");
    expect(machineMonitorPollPath(true)).toBe("/api/machine?cameraStub=1");
  });
});

describe("print-doctor camera hints", () => {
  it("maps injected camera failures to a chat-first doctor result", () => {
    const spaghetti = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("spaghetti")));
    expect(spaghetti?.defectId).toBe("spaghetti");
    expect(spaghetti?.fixes.some((fix) => fix.key === "pause" && !fix.autoApplicable)).toBe(true);

    const scrape = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("nozzle-scrape")));
    expect(scrape?.defectId).toBe("nozzle-scrape");
    expect(scrape?.physicalSteps.join(" ")).toMatch(/z-offset|toolhead|pause/i);

    const empty = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("empty-bed")));
    expect(empty?.defectId).toBe("empty-bed");
    expect(empty?.physicalSteps.join(" ")).toMatch(/plate|pause/i);

    expect(diagnosisFromCameraDetect(detectFailure())).toBeUndefined();
  });

  it("still diagnoses those failures from chat text", () => {
    expect(diagnosePrintComplaint({ complaint: "nozzle scrape on the plate" }).defectId).toBe("nozzle-scrape");
    expect(diagnosePrintComplaint({ complaint: "empty bed, the part came off" }).defectId).toBe("empty-bed");
  });
});

describe("live monitor poll + detectFailure", () => {
  it("does not detect when the stub is off, even if a scene is injected", async () => {
    injectStubCameraScene("spaghetti");
    const response = await GET();
    const body = (await response.json()) as {
      cameraStub: boolean;
      cameraDetect?: unknown;
      diagnosis?: unknown;
    };
    expect(body.cameraStub).toBe(false);
    expect(body.cameraDetect).toBeUndefined();
    expect(body.diagnosis).toBeUndefined();
    expect(cameraDetectCallCount()).toBe(0);
  });

  it("returns camera: ok on a mock none frame when the env flag is on", async () => {
    process.env[FLAG] = "1";
    const response = await GET();
    const body = (await response.json()) as {
      cameraStub: boolean;
      cameraDetect?: { kind: string; line: string; failure?: string };
      diagnosis?: unknown;
    };
    expect(body.cameraStub).toBe(true);
    expect(body.cameraDetect?.kind).toBe("none");
    expect(body.cameraDetect?.line).toBe("ok");
    expect(body.cameraDetect?.failure).toBeUndefined();
    expect(body.diagnosis).toBeUndefined();
    expect(cameraDetectCallCount()).toBe(1);
    expect(JSON.stringify(body)).not.toMatch(/jpeg|accessCode/i);
  });

  it("surfaces injected spaghetti / scrape / empty-bed on the poll for the panel and doctor", async () => {
    process.env[FLAG] = "1";

    injectStubCameraScene("spaghetti");
    const spaghetti = (await (await GET()).json()) as {
      cameraDetect?: { kind: string; failure?: string; line: string; hint: string };
      diagnosis?: { defectId: string; diagnosis: string };
    };
    expect(spaghetti.cameraDetect?.kind).toBe("suspected-failure");
    expect(spaghetti.cameraDetect?.failure).toBe("spaghetti");
    expect(spaghetti.cameraDetect?.line).toBe("suspected spaghetti");
    expect(spaghetti.diagnosis?.defectId).toBe("spaghetti");
    expect(spaghetti.diagnosis?.diagnosis).toMatch(/pause|abort|plate/i);

    injectStubCameraScene("nozzle-scrape");
    const scrape = (await (await GET()).json()) as {
      cameraDetect?: { failure?: string; line: string };
      diagnosis?: { defectId: string };
    };
    expect(scrape.cameraDetect?.failure).toBe("nozzle-scrape");
    expect(scrape.cameraDetect?.line).toBe("suspected nozzle scrape");
    expect(scrape.diagnosis?.defectId).toBe("nozzle-scrape");

    injectStubCameraScene("empty-bed");
    const empty = (await (await GET()).json()) as {
      cameraDetect?: { failure?: string; line: string };
      diagnosis?: { defectId: string };
    };
    expect(empty.cameraDetect?.failure).toBe("empty-bed");
    expect(empty.cameraDetect?.line).toBe("suspected empty bed");
    expect(empty.diagnosis?.defectId).toBe("empty-bed");
  });

  it("enables detect from the Machine-panel checkbox without the env flag", async () => {
    injectStubCameraScene("spaghetti");
    const off = await GET(new Request("http://localhost/api/machine?cameraStub=0"));
    const offBody = (await off.json()) as { cameraDetect?: unknown; cameraStub: boolean };
    expect(offBody.cameraStub).toBe(false);
    expect(offBody.cameraDetect).toBeUndefined();
    expect(cameraDetectCallCount()).toBe(0);

    const on = await GET(new Request("http://localhost/api/machine?cameraStub=1"));
    const onBody = (await on.json()) as {
      cameraStub: boolean;
      cameraDetect?: { failure?: string; line: string };
      diagnosis?: { defectId: string };
    };
    expect(onBody.cameraStub).toBe(false);
    expect(onBody.cameraDetect?.failure).toBe("spaghetti");
    expect(onBody.cameraDetect?.line).toBe("suspected spaghetti");
    expect(onBody.diagnosis?.defectId).toBe("spaghetti");
    expect(cameraDetectCallCount()).toBe(1);
  });

  it("does not pause or send commands when the camera suspects a failure", async () => {
    process.env[FLAG] = "1";
    process.env.AMS_AUTOFIX = "1";
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.simulatePrinting();
    injectStubCameraScene("spaghetti");

    const response = await GET();
    const body = (await response.json()) as {
      cameraDetect?: { failure?: string };
      diagnosis?: { defectId: string; autofix?: { attempted: boolean } };
      lastCommand?: unknown;
      lastAutofix?: unknown;
      status: { print: string };
    };
    expect(body.cameraDetect?.failure).toBe("spaghetti");
    expect(body.diagnosis?.defectId).toBe("spaghetti");
    expect(body.diagnosis?.autofix).toBeUndefined();
    expect(body.lastCommand).toBeUndefined();
    expect(body.lastAutofix).toBeUndefined();
    expect(body.status.print).toBe("printing");
  });

  it("POST configure can turn the checkbox on for the next snapshot", async () => {
    injectStubCameraScene("empty-bed");
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({
          lan: false,
          credentials: { host: "", serial: "", accessCode: "" },
          cameraStub: true,
        }),
      }),
    );
    const body = (await response.json()) as {
      cameraDetect?: { failure?: string; line: string };
      diagnosis?: { defectId: string };
    };
    expect(body.cameraDetect?.failure).toBe("empty-bed");
    expect(body.cameraDetect?.line).toBe("suspected empty bed");
    expect(body.diagnosis?.defectId).toBe("empty-bed");
  });
});
