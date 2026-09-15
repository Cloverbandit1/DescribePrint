import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultColorRegion } from "@/lib/color-regions";
import { printPresetSummary } from "@/lib/printers";
import type { GenerateResult } from "@/lib/types";
import {
  PART_LIBRARY_CAP,
  PART_LIBRARY_NOTE,
  PART_LIBRARY_STORAGE_KEY,
  REMIX_DIM_CHIP,
  REMIX_FIT_CHIP,
  REMIX_PRETTY_CHIP,
  REMIX_SCALE_CHIP,
  REMIX_SIZE_CHIP,
  buildRemixRequest,
  canSavePlate,
  classifyRemixIntent,
  compactGenerateResult,
  emptyPartLibrary,
  formatLibraryLoadNote,
  getPart,
  getPartLibrarySnapshot,
  getServerPartLibrary,
  listParts,
  normalizePartLibrary,
  parsePartLibrary,
  removePart,
  restorePlateFromPart,
  remixFollowUps,
  savePart,
  serializePartLibrary,
  suggestPartName,
  writePartLibrary,
} from "@/lib/part-library";

function fakeResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  const jobId = overrides.jobId ?? "job-cube";
  return {
    jobId,
    language: "openscad",
    code: "cube([20,20,20]);",
    usedFixture: true,
    retried: false,
    stlUrl: `/api/jobs/${jobId}/model.stl`,
    threemfUrl: `/api/jobs/${jobId}/model.3mf`,
    scadUrl: `/api/jobs/${jobId}/model.scad`,
    printPreset: printPresetSummary("pla"),
    printPresetUrl: `/api/jobs/${jobId}/model.print.json`,
    projectPackUrl: `/api/jobs/${jobId}/model.pack.zip`,
    report: {
      triangleCount: 12,
      volumeMm3: 8000,
      boundingBoxMm: { min: [0, 0, 0], max: [20, 20, 20], size: [20, 20, 20] },
      manifold: true,
      watertight: true,
      issues: [],
      units: "mm",
      strengthPreview: {
        method: "heuristic",
        fea: false,
        disclaimer: "not FEA",
        triangleCount: 12,
        maxScore: 0.2,
        meanScore: 0.1,
        issues: [],
        triangleScores: [0.1, 0.2, 0.1],
      },
    },
    source: "openscad",
    editMode: "create",
    notes: [],
    colorRegions: [defaultColorRegion()],
    ...overrides,
  };
}

describe("part library stub", () => {
  it("starts empty and is honest about localStorage-only persistence", () => {
    const state = emptyPartLibrary();
    expect(state).toEqual({ version: 1, cloudSync: false, parts: [] });
    expect(canSavePlate(null)).toBe(false);
    expect(canSavePlate(fakeResult())).toBe(true);
    expect(PART_LIBRARY_STORAGE_KEY).toBe("describeprint.partLibrary");
    expect(PART_LIBRARY_NOTE).toMatch(/this device only/i);
    expect(PART_LIBRARY_NOTE).toMatch(/not cloud sync/i);
    expect(suggestPartName("20mm cube with 5mm hole")).toBe("20mm cube with 5mm hole");
    expect(suggestPartName("")).toBe("Untitled part");
  });

  it("saves prompt + OpenSCAD + preview metadata under a name", () => {
    const result = fakeResult({
      jobId: "job-1",
      code: "difference(){cube([20,20,20]);cylinder(h=20,d=5);}",
    });
    const { state, part } = savePart(emptyPartLibrary(), {
      id: "lib-cube",
      name: "Cube hole",
      prompt: "20mm cube with 5mm hole",
      designPrompt: "20mm cube with 5mm hole",
      result,
    });
    expect(state.cloudSync).toBe(false);
    expect(part.cloudSync).toBe(false);
    expect(part.name).toBe("Cube hole");
    expect(part.code).toContain("cylinder(h=20,d=5)");
    expect(part.jobId).toBe("job-1");
    expect(part.importedMeshId).toBeNull();
    expect(part.source).toBe("openscad");
    expect(part.result.stlUrl).toBe("/api/jobs/job-1/model.stl");
    expect(part.result.report.strengthPreview?.triangleScores).toEqual([]);
    expect(listParts(state)).toHaveLength(1);
    expect(getPart(state, "lib-cube")?.name).toBe("Cube hole");
  });

  it("saves an imported mesh as a job-id ref, not invented geometry", () => {
    const result = fakeResult({
      jobId: "job-import",
      source: "imported-mesh",
      editMode: "import",
      code: 'import("imported.stl");',
      fileName: "bracket.stl",
    });
    const { part } = savePart(emptyPartLibrary(), {
      name: "Proven fixture",
      prompt: "imported bracket.stl",
      designPrompt: "imported bracket.stl",
      result,
    });
    expect(part.source).toBe("imported-mesh");
    expect(part.importedMeshId).toBe("job-import");
    expect(part.code).toContain("imported.stl");
  });

  it("loads a saved part onto the plate with preview + chat seed", () => {
    const result = fakeResult({ jobId: "job-load", code: "cube([24,24,24]);" });
    const { part } = savePart(emptyPartLibrary(), {
      name: "Phone stand",
      prompt: "phone stand",
      designPrompt: "phone stand",
      result,
      wearableSize: "M",
    });
    const restored = restorePlateFromPart(part);
    expect(restored.result.jobId).toBe("job-load");
    expect(restored.result.code).toContain("cube([24,24,24])");
    expect(restored.designPrompt).toBe("phone stand");
    expect(restored.wearableSize).toBe("M");
    expect(restored.loadNote).toMatch(/Phone stand/);
    expect(restored.loadNote).toMatch(/not cloud sync/i);
    expect(formatLibraryLoadNote(part)).toMatch(/OpenSCAD/);
  });

  it("upserts the same name and caps the library", () => {
    let state = emptyPartLibrary();
    for (let i = 0; i < PART_LIBRARY_CAP + 3; i += 1) {
      ({ state } = savePart(state, {
        name: `Part ${i}`,
        prompt: `prompt ${i}`,
        designPrompt: `prompt ${i}`,
        result: fakeResult({ jobId: `job-${i}`, code: `cube([${i + 10},${i + 10},${i + 10}]);` }),
        updatedAt: 1_000 + i,
      }));
    }
    expect(state.parts).toHaveLength(PART_LIBRARY_CAP);
    expect(state.parts.some((part) => part.name === "Part 0")).toBe(false);
    expect(state.parts.some((part) => part.name === `Part ${PART_LIBRARY_CAP + 2}`)).toBe(true);

    const latest = listParts(state)[0];
    ({ state } = savePart(state, {
      name: latest.name,
      prompt: "updated prompt",
      designPrompt: "updated prompt",
      result: fakeResult({ jobId: "job-upsert", code: "cube([30,30,30]);" }),
      updatedAt: 9_000,
    }));
    expect(state.parts).toHaveLength(PART_LIBRARY_CAP);
    expect(getPart(state, latest.id)?.jobId).toBe("job-upsert");
    expect(getPart(state, latest.id)?.prompt).toBe("updated prompt");
  });

  it("round-trips localStorage and ignores corrupt JSON", () => {
    const { state } = savePart(emptyPartLibrary(), {
      name: "Keep",
      prompt: "cube",
      designPrompt: "cube",
      result: fakeResult(),
    });
    expect(parsePartLibrary(serializePartLibrary(state)).parts[0]?.name).toBe("Keep");
    expect(parsePartLibrary(null)).toEqual(emptyPartLibrary());
    expect(parsePartLibrary("not-json")).toEqual(emptyPartLibrary());
    expect(normalizePartLibrary({ version: 9, cloudSync: true, parts: [{ name: "nope" }] }).parts).toEqual([]);
    const trimmed = removePart(state, state.parts[0]!.id);
    expect(trimmed.parts).toEqual([]);
    expect(trimmed.cloudSync).toBe(false);
  });
});

describe("remix from a saved part", () => {
  function savedCube() {
    const { part } = savePart(emptyPartLibrary(), {
      name: "Cube hole",
      prompt: "20mm cube with 5mm hole",
      designPrompt: "20mm cube with 5mm hole",
      result: fakeResult({
        jobId: "job-remix",
        code: "difference(){cube([20,20,20]);cylinder(h=20,d=5);}",
      }),
    });
    return part;
  }

  it("classifies scale / dim / pretty-up / fit / size remixes", () => {
    expect(classifyRemixIntent(REMIX_SCALE_CHIP)).toBe("scale");
    expect(classifyRemixIntent("make it 10% larger")).toBe("scale");
    expect(classifyRemixIntent(REMIX_DIM_CHIP)).toBe("dimension");
    expect(classifyRemixIntent(REMIX_PRETTY_CHIP)).toBe("pretty-up");
    expect(classifyRemixIntent(REMIX_FIT_CHIP)).toBe("fit");
    expect(classifyRemixIntent(REMIX_SIZE_CHIP)).toBe("size");
    expect(classifyRemixIntent("a brand new helmet")).toBe("other");
  });

  it("builds a follow-up generate request from the saved part, not a blank start", () => {
    const part = savedCube();
    const remix = buildRemixRequest(part, REMIX_SCALE_CHIP);
    expect(remix.blankStart).toBe(false);
    expect(remix.fromLibrary).toBe(true);
    expect(remix.remixKind).toBe("scale");
    expect(remix.prompt).toBe(REMIX_SCALE_CHIP);
    expect(remix.previousPrompt).toBe("20mm cube with 5mm hole");
    expect(remix.previousCode).toContain("cylinder(h=20,d=5)");
    expect(remix.previousJobId).toBe("job-remix");
    expect(remix.previousSource).toBe("openscad");
    expect(remix.previousPrompt).not.toBe("");
  });

  it("pretty-up / fit / size remixes still carry the saved OpenSCAD", () => {
    const part = savedCube();
    for (const chip of [REMIX_PRETTY_CHIP, REMIX_FIT_CHIP, REMIX_SIZE_CHIP] as const) {
      const remix = buildRemixRequest(part, chip);
      expect(remix.previousCode).toBe(part.code);
      expect(remix.previousPrompt).toBe(part.designPrompt);
      expect(remix.blankStart).toBe(false);
    }
    expect(buildRemixRequest(part, REMIX_PRETTY_CHIP).remixKind).toBe("pretty-up");
    expect(buildRemixRequest(part, REMIX_FIT_CHIP).remixKind).toBe("fit");
    expect(buildRemixRequest(part, REMIX_SIZE_CHIP).remixKind).toBe("size");
  });

  it("offers remix chips that are not a blank description", () => {
    const chips = remixFollowUps(savedCube());
    expect(chips).toEqual([
      REMIX_SCALE_CHIP,
      REMIX_DIM_CHIP,
      REMIX_PRETTY_CHIP,
      REMIX_FIT_CHIP,
      REMIX_SIZE_CHIP,
      "Start a new part",
    ]);
  });
});

describe("part library localStorage hook snapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a stored library and stays Object.is-stable until rewritten", () => {
    const { state } = savePart(emptyPartLibrary(), {
      name: "Cached",
      prompt: "cube",
      designPrompt: "cube",
      result: fakeResult({ jobId: "job-cache" }),
    });
    const store: Record<string, string> = {
      [PART_LIBRARY_STORAGE_KEY]: serializePartLibrary(state),
    };
    const localStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    vi.stubGlobal("window", { localStorage });
    const first = getPartLibrarySnapshot();
    const second = getPartLibrarySnapshot();
    expect(first).toBe(second);
    expect(first.parts[0]?.name).toBe("Cached");
    expect(getServerPartLibrary()).toEqual(emptyPartLibrary());

    writePartLibrary(
      savePart(first, {
        name: "Cached two",
        prompt: "box",
        designPrompt: "box",
        result: fakeResult({ jobId: "job-cache-2" }),
      }).state,
    );
    const third = getPartLibrarySnapshot();
    expect(third).not.toBe(first);
    expect(third.parts.map((part) => part.name)).toContain("Cached two");
    expect(JSON.parse(store[PART_LIBRARY_STORAGE_KEY]!).cloudSync).toBe(false);
  });
});

describe("compact generate snapshot", () => {
  it("drops heatmap scores so localStorage stays small", () => {
    const compact = compactGenerateResult(fakeResult());
    expect(compact.report.strengthPreview?.triangleScores).toEqual([]);
    expect(compact.report.strengthPreview?.fea).toBe(false);
    expect(compact.colorRegions[0]?.name).toBe("part");
  });
});
