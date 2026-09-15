import { describe, expect, it } from "vitest";
import { defaultColorRegion } from "@/lib/color-regions";
import { printPresetSummary } from "@/lib/printers";
import type { GenerateResult } from "@/lib/types";
import {
  VERSION_HISTORY_CAP,
  VERSION_HISTORY_NOTE,
  canUndo,
  classifyPlateVersionKind,
  currentVersion,
  emptyVersionHistory,
  formatVersionLabel,
  pushVersion,
  resetVersionHistory,
  restoreVersion,
  snapshotFromResult,
  undoVersion,
  versionKindLabel,
} from "@/lib/version-history";

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
    },
    source: "openscad",
    editMode: "create",
    notes: [],
    colorRegions: [defaultColorRegion()],
    ...overrides,
  };
}

describe("version history stack", () => {
  it("starts empty and cannot undo", () => {
    const state = emptyVersionHistory<string[]>();
    expect(state.versions).toEqual([]);
    expect(state.currentIndex).toBe(-1);
    expect(canUndo(state)).toBe(false);
    expect(currentVersion(state)).toBeNull();
    expect(VERSION_HISTORY_NOTE).toMatch(/in-session/i);
    expect(VERSION_HISTORY_NOTE).toMatch(/persist later/i);
  });

  it("pushes generate / edit snapshots with prompt, OpenSCAD, and job preview", () => {
    const first = fakeResult({ jobId: "job-1", code: "cube([20,20,20]);" });
    const second = fakeResult({ jobId: "job-2", code: "difference(){cube([20,20,20]);cylinder(h=20,d=8);}" });

    let state = emptyVersionHistory<string[]>();
    state = pushVersion(state, {
      id: "v-gen",
      kind: "generate",
      prompt: "20mm cube with 5mm hole",
      designPrompt: "20mm cube with 5mm hole",
      result: first,
      thread: ["describe cube"],
    });
    state = pushVersion(state, {
      id: "v-edit",
      kind: "edit",
      prompt: "Make the hole 8 mm",
      designPrompt: "20mm cube with 5mm hole. Make the hole 8 mm",
      result: second,
      thread: ["describe cube", "edit hole"],
    });

    expect(state.versions).toHaveLength(2);
    expect(state.currentIndex).toBe(1);
    expect(canUndo(state)).toBe(true);

    const current = currentVersion(state);
    expect(current?.id).toBe("v-edit");
    expect(current?.kind).toBe("edit");
    expect(current?.prompt).toBe("Make the hole 8 mm");
    expect(current?.designPrompt).toContain("Make the hole 8 mm");
    expect(current?.code).toContain("cylinder(h=20,d=8)");
    expect(current?.jobId).toBe("job-2");
    expect(current?.importedMeshId).toBeNull();
    expect(current?.result.stlUrl).toBe("/api/jobs/job-2/model.stl");
    expect(current?.thread).toEqual(["describe cube", "edit hole"]);
  });

  it("undo restores the earlier plate mesh and thread, not just the text", () => {
    const v1 = fakeResult({ jobId: "job-a", code: "cube([20,20,20]);" });
    const v2 = fakeResult({ jobId: "job-b", code: "cube([30,30,30]);" });
    const v3 = fakeResult({ jobId: "job-c", code: "cube([40,40,40]);" });

    let state = emptyVersionHistory<string[]>();
    state = pushVersion(state, {
      kind: "generate",
      prompt: "20mm cube",
      designPrompt: "20mm cube",
      result: v1,
      thread: ["t1"],
    });
    state = pushVersion(state, {
      kind: "edit",
      prompt: "make it 30mm",
      designPrompt: "20mm cube. make it 30mm",
      result: v2,
      thread: ["t1", "t2"],
    });
    state = pushVersion(state, {
      kind: "edit",
      prompt: "make it 40mm",
      designPrompt: "20mm cube. make it 30mm. make it 40mm",
      result: v3,
      thread: ["t1", "t2", "t3"],
    });

    const firstUndo = undoVersion(state);
    expect(firstUndo.restored?.jobId).toBe("job-b");
    expect(firstUndo.restored?.code).toBe("cube([30,30,30]);");
    expect(firstUndo.restored?.result.stlUrl).toBe("/api/jobs/job-b/model.stl");
    expect(firstUndo.restored?.thread).toEqual(["t1", "t2"]);
    expect(firstUndo.restored?.designPrompt).toBe("20mm cube. make it 30mm");
    expect(firstUndo.state.currentIndex).toBe(1);

    const secondUndo = undoVersion(firstUndo.state);
    expect(secondUndo.restored?.jobId).toBe("job-a");
    expect(secondUndo.restored?.code).toBe("cube([20,20,20]);");
    expect(secondUndo.restored?.result.stlUrl).toBe("/api/jobs/job-a/model.stl");
    expect(secondUndo.restored?.thread).toEqual(["t1"]);
    expect(canUndo(secondUndo.state)).toBe(false);

    const stuck = undoVersion(secondUndo.state);
    expect(stuck.state.currentIndex).toBe(0);
    expect(stuck.restored?.jobId).toBe("job-a");
  });

  it("restore jumps to an earlier plate and keeps later versions for re-select", () => {
    let state = emptyVersionHistory<string[]>();
    state = pushVersion(state, {
      kind: "generate",
      prompt: "cube",
      designPrompt: "cube",
      result: fakeResult({ jobId: "job-1" }),
      thread: ["a"],
    });
    state = pushVersion(state, {
      kind: "edit",
      prompt: "hole",
      designPrompt: "cube. hole",
      result: fakeResult({ jobId: "job-2" }),
      thread: ["a", "b"],
    });
    state = pushVersion(state, {
      kind: "edit",
      prompt: "larger",
      designPrompt: "cube. hole. larger",
      result: fakeResult({ jobId: "job-3" }),
      thread: ["a", "b", "c"],
    });

    const restored = restoreVersion(state, 0);
    expect(restored.restored?.jobId).toBe("job-1");
    expect(restored.restored?.result.stlUrl).toContain("job-1");
    expect(restored.state.versions).toHaveLength(3);
    expect(restored.state.currentIndex).toBe(0);

    const back = restoreVersion(restored.state, 2);
    expect(back.restored?.jobId).toBe("job-3");
    expect(restoreVersion(state, 99).restored?.jobId).toBe("job-3");
    expect(restoreVersion(state, -1).state.currentIndex).toBe(2);
  });

  it("stores imported mesh id instead of relying on OpenSCAD alone", () => {
    const imported = fakeResult({
      jobId: "job-import",
      source: "imported-mesh",
      editMode: "import",
      code: "",
      fileName: "part.stl",
    });
    const state = pushVersion(emptyVersionHistory<string[]>(), {
      kind: "import",
      prompt: "Import part.stl",
      designPrompt: "Imported part.stl",
      result: imported,
      thread: ["import"],
    });
    const snap = snapshotFromResult(imported);
    expect(snap.code).toBeNull();
    expect(snap.importedMeshId).toBe("job-import");
    expect(currentVersion(state)?.importedMeshId).toBe("job-import");
    expect(currentVersion(state)?.jobId).toBe("job-import");
    expect(currentVersion(state)?.result.stlUrl).toBe("/api/jobs/job-import/model.stl");
  });

  it("caps the stack at 20 and drops the oldest", () => {
    let state = emptyVersionHistory<number>();
    for (let i = 0; i < VERSION_HISTORY_CAP + 3; i += 1) {
      state = pushVersion(state, {
        id: `cap-${i}`,
        kind: i === 0 ? "generate" : "edit",
        prompt: `step ${i}`,
        designPrompt: `step ${i}`,
        result: fakeResult({ jobId: `job-${i}` }),
        thread: [i],
      });
    }
    expect(state.versions).toHaveLength(VERSION_HISTORY_CAP);
    expect(state.versions[0]?.id).toBe("cap-3");
    expect(state.versions[0]?.jobId).toBe("job-3");
    expect(currentVersion(state)?.jobId).toBe(`job-${VERSION_HISTORY_CAP + 2}`);
    expect(state.currentIndex).toBe(VERSION_HISTORY_CAP - 1);
  });

  it("push after undo discards the undone future edits", () => {
    let state = emptyVersionHistory<string[]>();
    state = pushVersion(state, {
      kind: "generate",
      prompt: "cube",
      designPrompt: "cube",
      result: fakeResult({ jobId: "job-1", code: "cube(20);" }),
      thread: ["1"],
    });
    state = pushVersion(state, {
      kind: "edit",
      prompt: "bigger",
      designPrompt: "cube. bigger",
      result: fakeResult({ jobId: "job-2", code: "cube(30);" }),
      thread: ["1", "2"],
    });
    state = undoVersion(state).state;
    state = pushVersion(state, {
      kind: "edit",
      prompt: "fillet",
      designPrompt: "cube. fillet",
      result: fakeResult({ jobId: "job-3", code: "cube(20); // fillet" }),
      thread: ["1", "fillet"],
    });
    expect(state.versions.map((v) => v.jobId)).toEqual(["job-1", "job-3"]);
    expect(currentVersion(state)?.prompt).toBe("fillet");
  });

  it("reset clears the in-memory session stack", () => {
    let state = pushVersion(emptyVersionHistory<string[]>(), {
      kind: "generate",
      prompt: "cube",
      designPrompt: "cube",
      result: fakeResult(),
      thread: ["x"],
    });
    state = resetVersionHistory();
    expect(state).toEqual(emptyVersionHistory());
  });
});

describe("version helpers", () => {
  it("classifies generate, import, and edit", () => {
    expect(classifyPlateVersionKind({ source: "openscad", editMode: "create" })).toBe("generate");
    expect(classifyPlateVersionKind({ source: "imported-mesh", editMode: "import" })).toBe("import");
    expect(classifyPlateVersionKind({ source: "imported-mesh", editMode: "image-import" })).toBe("import");
    expect(classifyPlateVersionKind({ hasPrevious: true, source: "openscad" })).toBe("edit");
    expect(classifyPlateVersionKind({ hasPrevious: true, source: "imported-mesh", editMode: "describe-wrapper" })).toBe(
      "edit",
    );
    expect(classifyPlateVersionKind({ startFresh: true, source: "openscad", hasPrevious: true })).toBe("generate");
    expect(versionKindLabel("generate")).toBe("Generate");
    expect(versionKindLabel("import")).toBe("Import");
    expect(versionKindLabel("edit")).toBe("Edit");
  });

  it("truncates long prompts for the history list", () => {
    expect(formatVersionLabel("20mm cube")).toBe("20mm cube");
    expect(formatVersionLabel("   ")).toBe("Untitled plate");
    const long = "a".repeat(80);
    expect(formatVersionLabel(long).endsWith("…")).toBe(true);
    expect(formatVersionLabel(long).length).toBeLessThanOrEqual(48);
  });
});
