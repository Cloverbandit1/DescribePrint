import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/machine/route";
import { createJob, resetJobs } from "@/lib/jobs";
import {
  CAD_RESHAPE_INSTRUCTION,
  MockMachineAdapter,
  RESUME_IS_MANUAL,
  getSharedMachine,
  injectStubCameraScene,
  isReshapeRemainingEnabled,
  maybeEmergencyReshapeRemaining,
  planRemainingLayerReshape,
  resetSharedMachine,
  resolveHandoffLayerHeightMm,
  stumpCutPlaneBoundsFromMesh,
} from "@/lib/machine";
import {
  diagnosePrintComplaint,
  isEmergencyReshapeRequest,
  looksLikeEmergencyReshape,
  looksLikePrintDoctorComplaint,
} from "@/lib/print-doctor";
import { printPresetSummary } from "@/lib/printers";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import type { PrintabilityReport } from "@/lib/types";

const FLAG = "RESHAPE_REMAINING";

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  delete process.env[FLAG];
  delete process.env.BAMBU_CAMERA_STUB;
  resetSharedMachine();
  resetJobs();
});

function testReport(size: [number, number, number] = [20, 15, 8]): PrintabilityReport {
  return {
    triangleCount: 12,
    volumeMm3: size[0] * size[1] * size[2],
    boundingBoxMm: { min: [0, 0, 0], max: size, size },
    manifold: true,
    watertight: true,
    issues: [],
    units: "mm",
  };
}

function storeTestJob(opts?: { scad?: string; size?: [number, number, number]; material?: "pla" | "petg" | "pa" }) {
  const size = opts?.size ?? ([20, 15, 8] as [number, number, number]);
  const mesh = makeAxisAlignedBoxMesh(size);
  return createJob({
    stl: writeBinaryStl(mesh),
    threemf: Buffer.from("PK"),
    scad: opts?.scad ?? "size = 20;\nhole_d = 5;\ncube(size);",
    report: testReport(size),
    usedFixture: true,
    retried: false,
    printPreset: printPresetSummary(opts?.material ?? "pla"),
  });
}

describe("RESHAPE_REMAINING flag", () => {
  it("stays off by default", () => {
    expect(isReshapeRemainingEnabled()).toBe(false);
  });

  it("turns on only when RESHAPE_REMAINING is set", () => {
    process.env[FLAG] = "1";
    expect(isReshapeRemainingEnabled()).toBe(true);
  });
});

describe("emergency reshape chat routing", () => {
  it("routes reshape phrases to Print doctor, not CAD", () => {
    expect(looksLikeEmergencyReshape("reshape the rest")).toBe(true);
    expect(looksLikeEmergencyReshape("emergency reshape remaining layers")).toBe(true);
    expect(looksLikePrintDoctorComplaint("reshape the rest")).toBe(true);
    expect(looksLikePrintDoctorComplaint("emergency reshape remaining layers")).toBe(true);
    expect(looksLikePrintDoctorComplaint("yes, confirm the camera failure")).toBe(true);
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);
  });

  it("treats a confirmed camera suspected-failure as a reshape request", () => {
    expect(isEmergencyReshapeRequest("yes, confirm the camera failure")).toBe(true);
    expect(isEmergencyReshapeRequest("yes", { kind: "suspected-failure" })).toBe(true);
    expect(isEmergencyReshapeRequest("yes", { kind: "none" })).toBe(false);
    expect(isEmergencyReshapeRequest("20mm cube")).toBe(false);
  });

  it("diagnoses the reshape phrase as emergency-reshape", () => {
    const result = diagnosePrintComplaint({ complaint: "reshape the rest" });
    expect(result.defectId).toBe("emergency-reshape");
    expect(result.diagnosis).toMatch(/later option|RESHAPE_REMAINING/i);
    expect(result.physicalSteps.join(" ")).toMatch(/Resume is manual/i);
  });
});

describe("remaining-layer planner + injected height", () => {
  it("uses an injected remainingHeightMm and exposes currentZ", () => {
    const plan = planRemainingLayerReshape({
      print: "printing",
      currentLayer: 12,
      totalLayers: 40,
      currentHeightMm: 2.4,
      remainingHeightMm: 5.6,
    });
    expect(plan.action).toBe("pause-now");
    expect(plan.remainingHeightMm).toBeCloseTo(5.6);
    expect(plan.currentZ).toBeCloseTo(2.4);
    expect(plan.remainingLayers).toBe(28);
  });
});

describe("maybeEmergencyReshapeRemaining", () => {
  it("does not pause or emit a live plan when the flag is off", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });

    const result = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: "reshape the rest",
      enabled: false,
    });

    expect(result.requested).toBe(true);
    expect(result.attempted).toBe(false);
    expect(result.paused).toBe(false);
    expect(result.remainingHeightMm).toBeNull();
    expect(result.currentZ).toBeNull();
    expect(result.cadHandoff).toBeUndefined();
    expect(result.reslice).toBeUndefined();
    expect(result.sentResume).toBe(false);
    expect(result.commands).toEqual([]);
    expect(result.message).toMatch(/later option/i);
    expect((await machine.status()).print).toBe("printing");
  });

  it("pauses and emits a CAD-handoff + reslice plan when on, never resume", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.injectRemainingHeight({
      layer: 12,
      totalLayers: 40,
      remainingHeightMm: 5.6,
      currentHeightMm: 2.4,
    });

    const result = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: "emergency reshape remaining layers",
      enabled: true,
    });

    expect(result.attempted).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.pauseConfirmed).toBe(true);
    expect(result.sentResume).toBe(false);
    expect(result.resume).toBe("manual");
    expect(result.resumeNote).toBe(RESUME_IS_MANUAL);
    expect(result.remainingHeightMm).toBeCloseTo(5.6);
    expect(result.currentZ).toBeCloseTo(2.4);
    expect(result.remainingLayers).toBe(28);
    expect(result.cadHandoff?.instruction).toBe(CAD_RESHAPE_INSTRUCTION);
    expect(result.cadHandoff?.owner).toBe("allos-cad-core");
    expect(result.cadHandoff?.suggestedNextStep).toMatch(/unprinted region only/i);
    expect(result.cadHandoff).not.toHaveProperty("previousCode");
    expect(result.cadHandoff).not.toHaveProperty("stumpCutPlaneBoundsMm");
    expect(result.cadHandoff).not.toHaveProperty("layerHeightMm");
    expect(result.reslice?.printerProfile).toBe("P2S");
    expect(result.reslice?.sendGcode).toBe(false);
    expect(result.commands.map((row) => row.message)).toEqual(["Paused."]);
    expect(result.commands.every((row) => !/resumed/i.test(row.message))).toBe(true);
    expect(result.message).toMatch(/Resume is manual/i);
    expect((await machine.status()).print).toBe("paused");
  });
});

describe("machine API emergency reshape", () => {
  it("mentions reshape as a later option and does not pause when the flag is off", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "reshape the rest" }),
      }),
    );
    const body = (await response.json()) as {
      reshapeRemaining: boolean;
      lastReshape?: {
        attempted: boolean;
        paused: boolean;
        remainingHeightMm: number | null;
        currentZ: number | null;
        sentResume: boolean;
        cadHandoff?: unknown;
      };
      diagnosis?: { defectId: string; reshape?: { attempted: boolean } };
      lastCommand?: { message: string };
      status: { print: string };
    };

    expect(response.status).toBe(200);
    expect(body.reshapeRemaining).toBe(false);
    expect(body.diagnosis?.defectId).toBe("emergency-reshape");
    expect(body.lastReshape?.attempted).toBe(false);
    expect(body.lastReshape?.paused).toBe(false);
    expect(body.lastReshape?.remainingHeightMm).toBeNull();
    expect(body.lastReshape?.currentZ).toBeNull();
    expect(body.lastReshape?.cadHandoff).toBeUndefined();
    expect(body.lastReshape?.sentResume).toBe(false);
    expect(body.diagnosis?.reshape?.attempted).toBe(false);
    expect(body.status.print).toBe("printing");
    expect(body.lastCommand).toBeUndefined();
  });

  it("pauses and returns remainingHeightMm / currentZ when the flag is on", async () => {
    process.env[FLAG] = "1";
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "reshape the rest" }),
      }),
    );
    const body = (await response.json()) as {
      reshapeRemaining: boolean;
      lastReshape?: {
        attempted: boolean;
        paused: boolean;
        pauseConfirmed: boolean;
        sentResume: boolean;
        remainingHeightMm: number | null;
        currentZ: number | null;
        resume: string;
        cadHandoff?: { instruction: string };
        reslice?: { sendGcode: boolean; printerProfile: string };
        commands: { message: string }[];
      };
      status: { print: string; remainingHeightMm?: number; currentHeightMm?: number };
    };

    expect(body.reshapeRemaining).toBe(true);
    expect(body.lastReshape?.attempted).toBe(true);
    expect(body.lastReshape?.paused).toBe(true);
    expect(body.lastReshape?.pauseConfirmed).toBe(true);
    expect(body.lastReshape?.sentResume).toBe(false);
    expect(body.lastReshape?.resume).toBe("manual");
    expect(body.lastReshape?.remainingHeightMm).toBeCloseTo(5.6);
    expect(body.lastReshape?.currentZ).toBeCloseTo(2.4);
    expect(body.lastReshape?.cadHandoff?.instruction).toBe(CAD_RESHAPE_INSTRUCTION);
    expect(body.lastReshape?.reslice?.sendGcode).toBe(false);
    expect(body.lastReshape?.reslice?.printerProfile).toBe("P2S");
    expect(body.lastReshape?.commands.map((row) => row.message)).toEqual(["Paused."]);
    expect(body.status.print).toBe("paused");
    expect(body.status.remainingHeightMm).toBeCloseTo(5.6);
    expect(body.status.currentHeightMm).toBeCloseTo(2.4);
  });

  it("enables from the Machine-panel checkbox without the env flag", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 4, currentHeightMm: 3 });

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "reshape the rest", reshapeRemaining: true }),
      }),
    );
    const body = (await response.json()) as {
      reshapeRemaining: boolean;
      lastReshape?: { attempted: boolean; remainingHeightMm: number | null; currentZ: number | null };
      status: { print: string };
    };

    expect(body.reshapeRemaining).toBe(false);
    expect(body.lastReshape?.attempted).toBe(true);
    expect(body.lastReshape?.remainingHeightMm).toBeCloseTo(4);
    expect(body.lastReshape?.currentZ).toBeCloseTo(3);
    expect(body.status.print).toBe("paused");
  });

  it("pauses after a confirmed camera suspected-failure when reshape is on", async () => {
    process.env[FLAG] = "1";
    process.env.BAMBU_CAMERA_STUB = "1";
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });
    injectStubCameraScene("spaghetti");

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "yes, confirm the camera failure" }),
      }),
    );
    const body = (await response.json()) as {
      lastReshape?: { attempted: boolean; paused: boolean; sentResume: boolean };
      status: { print: string };
    };

    expect(body.lastReshape?.attempted).toBe(true);
    expect(body.lastReshape?.paused).toBe(true);
    expect(body.lastReshape?.sentResume).toBe(false);
    expect(body.status.print).toBe("paused");
  });
});

describe("CadReshapeHandoff optionals from Print Control sources", () => {
  it("measures stump XY at the cut plane and omits when Z is unknown", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 15, 8]);
    expect(stumpCutPlaneBoundsFromMesh(mesh, 2.4)).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 15 });
    expect(stumpCutPlaneBoundsFromMesh(mesh, null)).toBeUndefined();
    expect(stumpCutPlaneBoundsFromMesh(mesh, 40)).toBeUndefined();
    expect(stumpCutPlaneBoundsFromMesh({ triangles: [] }, 2.4)).toBeUndefined();
  });

  it("uses live layer height before the selected preset, and omits when both are unknown", () => {
    expect(resolveHandoffLayerHeightMm({ statusLayerHeightMm: 0.16, material: "petg" })).toBeCloseTo(0.16);
    expect(resolveHandoffLayerHeightMm({ material: "petg" })).toBeCloseTo(0.2);
    expect(resolveHandoffLayerHeightMm({ jobMaterial: "pa" })).toBeCloseTo(0.2);
    expect(resolveHandoffLayerHeightMm({})).toBeUndefined();
    expect(resolveHandoffLayerHeightMm({ statusLayerHeightMm: 0 })).toBeUndefined();
  });

  it("fills previousCode, stump bounds, and layerHeightMm when a job and live layer height exist", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4, layerHeightMm: 0.16 });
    storeTestJob({ scad: "size = 30;\nhole_d = 6;\ncube(size);", size: [20, 15, 8] });

    const result = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: "reshape the rest",
      enabled: true,
    });

    expect(result.cadHandoff?.previousCode).toContain("size = 30");
    expect(result.cadHandoff?.stumpCutPlaneBoundsMm).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 15 });
    expect(result.cadHandoff?.layerHeightMm).toBeCloseTo(0.16);
    expect(result.remainingHeightMm).toBeCloseTo(5.6);
  });

  it("uses the selected material preset layer height when live status has none", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });

    const result = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: "reshape the rest",
      enabled: true,
      material: "petg",
    });

    expect(result.cadHandoff?.layerHeightMm).toBeCloseTo(0.2);
    expect(result.cadHandoff).not.toHaveProperty("previousCode");
    expect(result.cadHandoff).not.toHaveProperty("stumpCutPlaneBoundsMm");
  });

  it("does not invent remainingHeightMm from remainingLayers even when layerHeightMm is known", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting({ layer: 12, totalLayers: 40, omitHeights: true, layerHeightMm: 0.2 });

    const result = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: "reshape the rest",
      enabled: true,
      material: "pla",
    });

    expect(result.remainingLayers).toBe(28);
    expect(result.remainingHeightMm).toBeNull();
    expect(result.currentZ).toBeNull();
    expect(result.cadHandoff?.remainingHeightMm).toBeNull();
    expect(result.cadHandoff?.currentZ).toBeNull();
    expect(result.cadHandoff?.layerHeightMm).toBeCloseTo(0.2);
    expect(result.cadHandoff).not.toHaveProperty("stumpCutPlaneBoundsMm");
  });

  it("fills optionals from the latest job through the machine API", async () => {
    process.env[FLAG] = "1";
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.injectRemainingHeight({ remainingHeightMm: 5.6, currentHeightMm: 2.4 });
    storeTestJob({ scad: "cube(24);", size: [24, 18, 10], material: "pa" });

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "reshape the rest", material: "petg" }),
      }),
    );
    const body = (await response.json()) as {
      lastReshape?: {
        remainingHeightMm: number | null;
        cadHandoff?: {
          previousCode?: string;
          stumpCutPlaneBoundsMm?: { minX: number; minY: number; maxX: number; maxY: number };
          layerHeightMm?: number;
        };
      };
    };

    expect(body.lastReshape?.remainingHeightMm).toBeCloseTo(5.6);
    expect(body.lastReshape?.cadHandoff?.previousCode).toContain("cube(24)");
    expect(body.lastReshape?.cadHandoff?.stumpCutPlaneBoundsMm).toEqual({ minX: 0, minY: 0, maxX: 24, maxY: 18 });
    expect(body.lastReshape?.cadHandoff?.layerHeightMm).toBeCloseTo(0.2);
  });
});
