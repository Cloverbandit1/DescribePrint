import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReshapeUpperUserPrompt,
  cadFeedForReslice,
  inferStumpFootprintMm,
  parseCadReshapeHandoff,
  reshapeUpperFixtureScad,
  reshapeUpperNotes,
  reshapeUpperSystemPrompt,
  runCadReshapeUpper,
  stumpFootprintFromCutPlaneBounds,
} from "@/lib/cad-reshape";
import { compileOpenScad } from "@/lib/compile";
import { CAD_RESHAPE_INSTRUCTION, buildCadReshapeHandoff, buildReslicePlanStub } from "@/lib/machine/reshape-plan";
import { runGeneratePipeline } from "@/lib/pipeline";
import { printPresetSummary } from "@/lib/printers";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, completeChat: vi.fn() };
});

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const mockedCompile = vi.mocked(compileOpenScad);

function exampleHandoff() {
  return buildCadReshapeHandoff({
    currentZ: 2.4,
    remainingHeightMm: 5.6,
    remainingLayers: 28,
    layer: 12,
    totalLayers: 40,
    printerId: "bambu-lab-p2s",
  });
}

function compileOk() {
  return {
    stl: writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 5.6])),
    stderr: "",
    stdout: "",
    workDir: "/tmp/describeprint-test",
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("parseCadReshapeHandoff", () => {
  it("accepts a Print Control handoff from buildCadReshapeHandoff", () => {
    const parsed = parseCadReshapeHandoff(exampleHandoff());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff.owner).toBe("allos-cad-core");
    expect(parsed.handoff.from).toBe("allos-print-control");
    expect(parsed.handoff.kind).toBe("redesign-unprinted-upper");
    expect(parsed.handoff.instruction).toBe(CAD_RESHAPE_INSTRUCTION);
    expect(parsed.handoff.currentZ).toBeCloseTo(2.4);
    expect(parsed.handoff.remainingHeightMm).toBeCloseTo(5.6);
    expect(parsed.handoff.remainingLayers).toBe(28);
    expect(parsed.handoff.printerId).toBe("bambu-lab-p2s");
  });

  it("rejects the wrong owner, kind, or instruction", () => {
    expect(parseCadReshapeHandoff({ ...exampleHandoff(), owner: "print-control" }).ok).toBe(false);
    expect(parseCadReshapeHandoff({ ...exampleHandoff(), kind: "full-redesign" }).ok).toBe(false);
    expect(parseCadReshapeHandoff({ ...exampleHandoff(), instruction: "rewrite the whole part" }).ok).toBe(false);
    expect(parseCadReshapeHandoff(null).ok).toBe(false);
    expect(parseCadReshapeHandoff("handoff").ok).toBe(false);
  });

  it("drops invented Print Control fields such as autoResume / sendGcode", () => {
    const parsed = parseCadReshapeHandoff({
      ...exampleHandoff(),
      autoResume: true,
      sendGcode: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff).not.toHaveProperty("autoResume");
    expect(parsed.handoff).not.toHaveProperty("sendGcode");
  });

  it("keeps optional previousCode, stumpCutPlaneBoundsMm, and layerHeightMm", () => {
    const parsed = parseCadReshapeHandoff({
      ...exampleHandoff(),
      previousCode: "size = 30;\nhole_d = 6;\ncube(size);",
      stumpCutPlaneBoundsMm: { minX: -5, minY: 0, maxX: 35, maxY: 12 },
      layerHeightMm: 0.2,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff.previousCode).toContain("size = 30");
    expect(parsed.handoff.stumpCutPlaneBoundsMm).toEqual({ minX: -5, minY: 0, maxX: 35, maxY: 12 });
    expect(parsed.handoff.layerHeightMm).toBeCloseTo(0.2);
  });

  it("rejects invalid stumpCutPlaneBoundsMm or layerHeightMm", () => {
    expect(
      parseCadReshapeHandoff({
        ...exampleHandoff(),
        stumpCutPlaneBoundsMm: { minX: 10, minY: 0, maxX: 10, maxY: 12 },
      }).ok,
    ).toBe(false);
    expect(parseCadReshapeHandoff({ ...exampleHandoff(), layerHeightMm: 0 }).ok).toBe(false);
    expect(parseCadReshapeHandoff({ ...exampleHandoff(), previousCode: 12 }).ok).toBe(false);
  });

  it("omits optional fields when they are absent", () => {
    const parsed = parseCadReshapeHandoff(exampleHandoff());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff).not.toHaveProperty("previousCode");
    expect(parsed.handoff).not.toHaveProperty("stumpCutPlaneBoundsMm");
    expect(parsed.handoff).not.toHaveProperty("layerHeightMm");
  });

  it("keeps null measurements instead of inventing them", () => {
    const parsed = parseCadReshapeHandoff({
      ...exampleHandoff(),
      currentZ: null,
      remainingHeightMm: null,
      remainingLayers: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.handoff.currentZ).toBeNull();
    expect(parsed.handoff.remainingHeightMm).toBeNull();
    expect(parsed.handoff.remainingLayers).toBeNull();
  });
});

describe("reshape-upper fixture", () => {
  it("emits only the remaining height sitting on the cut plane", () => {
    const code = reshapeUpperFixtureScad({
      handoff: exampleHandoff(),
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
      previousPrompt: "20mm cube with 5mm hole",
    });
    const sanitized = sanitizeOpenScad(code);
    expect(sanitized.ok).toBe(true);
    expect(code).toMatch(/remaining_h = 5\.6/);
    expect(code).toMatch(/current_z = 2\.4/);
    expect(code).toMatch(/cube\(\[size_x, size_y, remaining_h\]/);
    expect(code).toMatch(/hole_d = 5/);
    expect(code).toMatch(/cannot be reshaped/i);
    expect(code).toMatch(/cut plane/i);
    expect(code).not.toMatch(/cube\(\s*20\s*\)/);
    expect(code).not.toMatch(/translate\(\[0,\s*0,\s*current_z\]\)/);
  });

  it("mates XY from the last cube-with-hole and keeps a through-hole", () => {
    const footprint = inferStumpFootprintMm({
      previousCode: "size = 20;\nhole_d = 5;\n",
      previousPrompt: "20mm cube with 5mm hole",
    });
    expect(footprint.x).toBe(20);
    expect(footprint.y).toBe(20);
    expect(footprint.holeMm).toBe(5);
  });

  it("refuses to invent remaining height when the handoff height is missing", () => {
    expect(() =>
      reshapeUpperFixtureScad({
        handoff: { ...exampleHandoff(), remainingHeightMm: null, remainingLayers: 28, layerHeightMm: 0.2 },
      }),
    ).toThrow(/remainingLayers alone/i);
  });

  it("prefers stumpCutPlaneBoundsMm over last-part XY inference", () => {
    const footprint = inferStumpFootprintMm({
      previousCode: "size = 20;\nhole_d = 5;\n",
      stumpCutPlaneBoundsMm: { minX: 0, minY: 2, maxX: 40, maxY: 14 },
    });
    expect(footprint.x).toBeCloseTo(40);
    expect(footprint.y).toBeCloseTo(12);
    expect(footprint.holeMm).toBe(5);
    expect(stumpFootprintFromCutPlaneBounds({ minX: 1, minY: 1, maxX: 9, maxY: 4 })).toEqual({ x: 8, y: 3 });
  });

  it("uses handoff previousCode and cut-plane bounds in the fixture", () => {
    const code = reshapeUpperFixtureScad({
      handoff: {
        ...exampleHandoff(),
        previousCode: "size = 30;\nhole_d = 6;\ncube(size);",
        stumpCutPlaneBoundsMm: { minX: 0, minY: 0, maxX: 40, maxY: 15 },
      },
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
    });
    expect(code).toMatch(/size_x = 40/);
    expect(code).toMatch(/size_y = 15/);
    expect(code).toMatch(/hole_d = 6/);
  });

  it("states the printed-plastic limit in user notes", () => {
    const notes = reshapeUpperNotes(exampleHandoff());
    expect(notes.join(" ")).toMatch(/already-printed plastic/i);
    expect(notes.join(" ")).toMatch(/Resume is manual/);
    expect(notes.join(" ")).toMatch(/cut plane/i);
  });
});

describe("reshape-upper prompts", () => {
  it("tells the coder model to emit only the unprinted upper", () => {
    const system = reshapeUpperSystemPrompt();
    expect(system).toMatch(/CANNOT reshape already-printed plastic/i);
    expect(system).toMatch(/cut plane/i);
    expect(system).not.toMatch(/minicpm5|smith-/i);

    const user = buildReshapeUpperUserPrompt({
      prompt: "keep the 5mm hole",
      handoff: exampleHandoff(),
      footprint: { x: 20, y: 20, holeMm: 5 },
      previousCode: "size = 20;\nhole_d = 5;",
    });
    expect(user).toContain(CAD_RESHAPE_INSTRUCTION);
    expect(user).toMatch(/remainingHeightMm/);
    expect(user).toMatch(/2\.40 mm/);
    expect(user).not.toMatch(/auto-resume|send gcode/i);
  });
});

describe("runCadReshapeUpper + generate pipeline", () => {
  it("compiles the fixture upper and attaches it to the reslice stub", async () => {
    mockedCompile.mockResolvedValue(compileOk());
    const handoff = exampleHandoff();
    const result = await runCadReshapeUpper({
      handoff,
      prompt: "keep the 5mm hole",
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
      fixture: true,
    });

    expect(result.usedFixture).toBe(true);
    expect(result.editMode).toBe("reshape-upper");
    expect(result.limits.cannotReshapePrintedPlastic).toBe(true);
    expect(result.limits.onlyAboveZ).toBe(true);
    expect(result.code).toMatch(/remaining_h = 5\.6/);
    expect(result.notes.join(" ")).toMatch(/already-printed plastic/i);
    expect(result.resliceFeed.kind).toBe("reslice-remaining-stub");
    expect(result.resliceFeed.printerProfile).toBe("P2S");
    expect(result.resliceFeed.sendGcode).toBe(false);
    expect(result.resliceFeed.cad.jobId).toBe(result.jobId);
    expect(result.resliceFeed.cad.sitOnCutPlane).toBe(true);
    expect(result.resliceFeed.cad.stlUrl).toBe(result.stlUrl);
    expect(mockedCompile).toHaveBeenCalledTimes(1);
  });

  it("prefers optional handoff fields and still refuses inventing remaining height", async () => {
    mockedCompile.mockResolvedValue(compileOk());
    const handoff = buildCadReshapeHandoff({
      currentZ: 2.4,
      remainingHeightMm: 5.6,
      remainingLayers: 28,
      previousCode: "size = 30;\nhole_d = 6;\ncube(size);",
      stumpCutPlaneBoundsMm: { minX: 0, minY: 0, maxX: 40, maxY: 15 },
      layerHeightMm: 0.2,
    });
    const result = await runCadReshapeUpper({
      handoff,
      prompt: "keep the hole",
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
      fixture: true,
    });
    expect(result.code).toMatch(/size_x = 40/);
    expect(result.code).toMatch(/size_y = 15/);
    expect(result.code).toMatch(/hole_d = 6/);
    expect(result.cadHandoff.previousCode).toContain("size = 30");
    expect(result.cadHandoff.stumpCutPlaneBoundsMm).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 15 });
    expect(result.cadHandoff.layerHeightMm).toBeCloseTo(0.2);
    expect(result.notes.join(" ")).toMatch(/stumpCutPlaneBoundsMm/);
    expect(result.notes.join(" ")).toMatch(/previousCode/);
    expect(result.notes.join(" ")).toMatch(/layerHeightMm/);

    await expect(
      runCadReshapeUpper({
        handoff: { ...handoff, remainingHeightMm: null },
        fixture: true,
      }),
    ).rejects.toThrow(/remainingLayers alone/i);
  });

  it("routes POST-style generate through the CAD handoff without touching image-import", async () => {
    mockedCompile.mockResolvedValue(compileOk());
    const result = await runGeneratePipeline({
      prompt: "keep the 5mm hole on the remaining upper",
      fixture: true,
      previousCode: "size = 20;\nhole_d = 5;",
      cadHandoff: exampleHandoff(),
    });
    expect(result.editMode).toBe("reshape-upper");
    expect(result.code).toMatch(/remaining_h = 5\.6/);
    expect(result.imageImport).toBeFalsy();
  });

  it("matches the existing reslice stub fields when attaching CAD artifacts", () => {
    const handoff = exampleHandoff();
    const stub = buildReslicePlanStub(undefined, handoff.printerId);
    const feed = cadFeedForReslice(handoff, {
      jobId: "job-1",
      language: "openscad",
      code: "cube([20,20,5.6]);",
      usedFixture: true,
      retried: false,
      stlUrl: "/api/jobs/job-1/model.stl",
      threemfUrl: "/api/jobs/job-1/model.3mf",
      scadUrl: "/api/jobs/job-1/model.scad",
      printPreset: printPresetSummary("pla"),
      printPresetUrl: "/api/jobs/job-1/model.print.json",
      projectPackUrl: "/api/jobs/job-1/model.pack.zip",
      report: {
        triangleCount: 12,
        volumeMm3: 1,
        boundingBoxMm: { min: [0, 0, 0], max: [20, 20, 5.6], size: [20, 20, 5.6] },
        manifold: true,
        watertight: true,
        issues: [],
        units: "mm",
      },
      source: "openscad",
      editMode: "reshape-upper",
      notes: [],
      colorRegions: [],
    }, stub);
    expect(feed.kind).toBe(stub.kind);
    expect(feed.sendGcode).toBe(false);
    expect(feed.printerProfile).toBe("P2S");
    expect(feed.cad.jobId).toBe("job-1");
  });
});
