import { describe, expect, it } from "vitest";
import { buildImportedMeshWrapper, canBuildDeterministicImportWrap } from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import { normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";
import {
  CUBE_FILLET_PROMPT,
  CUBE_RIBS_PROMPT,
  CUBE_STEAMPUNK_PROMPT,
  DEFAULT_EDGE_MM,
  clampPrettyExtentMm,
  cubePrettyFilletScad,
  cubePrettySteampunkScad,
  formatPrettyUpConstraints,
  formatPrettyUpNote,
  inferCadPrettyUp,
  inferPrettyUpStyle,
  normalizeCadPrettyUp,
  parseCadPrettyUp,
  prettyUpWouldCloseHoles,
  prettyUpWouldFuseJoints,
  promptHasPrettyUp,
} from "@/lib/pretty-up";
import { HINGE_FIXTURE_PROMPT } from "@/lib/joints";
import { matchConversationFixture, matchFixture } from "@/lib/fixtures";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

describe("pretty-up intent vs structural edits", () => {
  it("detects restyle prompts and leaves ordinary describe alone", () => {
    expect(promptHasPrettyUp(CUBE_FILLET_PROMPT)).toBe(true);
    expect(promptHasPrettyUp("make it look steampunk")).toBe(true);
    expect(promptHasPrettyUp("add decorative ribs")).toBe(true);
    expect(promptHasPrettyUp("pretty-up the part")).toBe(true);
    expect(promptHasPrettyUp("20mm cube with 5mm hole")).toBe(false);
    expect(promptHasPrettyUp("add an 8 mm hole")).toBe(false);
    expect(inferPrettyUpStyle("round the edges")).toBe("fillet");
    expect(inferPrettyUpStyle("chamfer the edges")).toBe("chamfer");
    expect(inferPrettyUpStyle("make it look steampunk")).toBe("steampunk");
    expect(inferPrettyUpStyle("add decorative ribs")).toBe("ribs");
  });

  it("clamps edge breaks so a through-hole and #11 walls survive", () => {
    expect(clampPrettyExtentMm(undefined, "fillet", [20, 20, 20], 5)).toBe(DEFAULT_EDGE_MM);
    expect(clampPrettyExtentMm(20, "fillet", [20, 20, 20], 5)).toBeLessThanOrEqual(4);
    expect(clampPrettyExtentMm(0.2, "fillet")).toBe(0.8);
  });
});

describe("pretty-up functional preserve + refuse", () => {
  it("refuses pretty-up that would fuse a PIP joint", () => {
    expect(
      prettyUpWouldFuseJoints("fuse the joint to pretty it up", {
        prompt: "fuse the joint to pretty it up",
        previousPrompt: HINGE_FIXTURE_PROMPT,
        previousCode: "module box_body() {}\nmodule hinge_pin() {}",
      }),
    ).toBe(true);
    const refused = inferCadPrettyUp({
      prompt: "fill the gaps to pretty it up",
      previousPrompt: HINGE_FIXTURE_PROMPT,
      previousCode: "module box_body() {}\nmodule hinge_pin() {}",
      joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
    });
    expect(refused?.refused).toBe(true);
    expect(refused?.applied).toBe(false);
    expect(refused?.refuse_reason).toMatch(/fuse print-in-place/i);
    expect(refused?.functional_regions.some((region) => region.role === "joint")).toBe(true);
  });

  it("refuses pretty-up that would close a through-hole", () => {
    expect(
      prettyUpWouldCloseHoles("close the hole so it looks nicer", {
        prompt: "close the hole so it looks nicer",
        previousPrompt: "20mm cube with 5mm hole",
        previousCode: "size = 20;\nhole_d = 5;",
      }),
    ).toBe(true);
    const refused = inferCadPrettyUp({
      prompt: "plug the hole to pretty it up",
      previousPrompt: "20mm cube with 5mm hole",
      holes: [{ d: 5, through: true }],
    });
    expect(refused?.refused).toBe(true);
    expect(refused?.refuse_reason).toMatch(/through-hole/i);
    expect(refused?.functional_regions.some((region) => region.role === "hole")).toBe(true);
  });

  it("marks functional vs decorative regions on a safe restyle", () => {
    const pretty = inferCadPrettyUp({
      prompt: CUBE_FILLET_PROMPT,
      holes: [{ d: 5, through: true }],
      sizeMm: [20, 20, 20],
    });
    expect(pretty?.applied).toBe(true);
    expect(pretty?.refused).toBe(false);
    expect(pretty?.style).toBe("fillet");
    expect(pretty?.functional_regions.map((region) => region.role)).toEqual(
      expect.arrayContaining(["hole", "wall"]),
    );
    expect(pretty?.decorative_regions.some((region) => region.role === "fillet")).toBe(true);
    expect(formatPrettyUpNote(pretty)).toMatch(/Functional preserve/i);
    expect(formatPrettyUpNote(pretty)).toMatch(/Not neural Style2Fab/i);
  });

  it("skips decorative CSG on PIP members without refusing a safe restyle", () => {
    const pretty = inferCadPrettyUp({
      prompt: "add decorative ribs",
      previousPrompt: HINGE_FIXTURE_PROMPT,
      previousCode: "module box_body() {}\nmodule hinge_pin() {}",
      joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
    });
    expect(pretty?.refused).toBe(false);
    expect(pretty?.applied).toBe(false);
    expect(pretty?.notes).toMatch(/skipped on print-in-place/i);
    expect(pretty?.functional_regions.some((region) => region.role === "clearance")).toBe(true);
  });
});

describe("pretty-up plan parse + normalize", () => {
  it("strips hallucinated pretty-up and keeps a restyle prompt", () => {
    const parsed = parseCadPrettyUp({
      style: "fillet",
      applied: true,
      ops: [{ kind: "fillet", mm: 2 }],
      functional_regions: [{ kind: "functional", role: "hole", note: "keep bore" }],
      decorative_regions: [{ kind: "decorative", role: "fillet", note: "2 mm" }],
    });
    expect(parsed?.style).toBe("fillet");
    expect(normalizeCadPrettyUp(parsed, { prompt: "a sturdy tray" })).toBeUndefined();
    const kept = normalizeCadPrettyUp(parsed, { prompt: CUBE_FILLET_PROMPT, holes: [{ d: 5, through: true }] });
    expect(kept?.applied).toBe(true);
    expect(kept?.ops[0]?.kind).toBe("fillet");
  });
});

describe("pretty-up fixtures + OpenSCAD", () => {
  it("matches fillet / steampunk / ribs fixtures and keeps the hole", () => {
    const fillet = matchFixture(CUBE_FILLET_PROMPT);
    expect(fillet?.id).toBe("cube-pretty-fillet");
    expect(sanitizeOpenScad(fillet!.code).ok).toBe(true);
    expect(fillet?.code).toMatch(/fillet_r = 2/);
    expect(fillet?.code).toMatch(/hole_d = 5/);
    expect(fillet?.code).toMatch(/hull\(\)/);
    expect(fillet?.code).toMatch(/difference\(\)/);
    expect(fillet?.code).not.toMatch(/\bminkowski\s*\(/);
    expect(fillet?.code).not.toMatch(/\btext\s*\(\s*["']/);

    const steampunk = matchFixture(CUBE_STEAMPUNK_PROMPT);
    expect(steampunk?.id).toBe("cube-pretty-steampunk");
    expect(sanitizeOpenScad(steampunk!.code).ok).toBe(true);
    expect(steampunk?.code).toMatch(/steampunk_disc/);
    expect(steampunk?.code).toMatch(/hole_d = 5/);

    const ribs = matchFixture(CUBE_RIBS_PROMPT);
    expect(ribs?.id).toBe("cube-pretty-ribs");
    expect(sanitizeOpenScad(ribs!.code).ok).toBe(true);
    expect(ribs?.code).toMatch(/decorative_ribs/);
    expect(matchFixture("20mm cube with 5mm hole")?.id).toBe("cube-with-hole");
  });

  it("applies pretty-up as a chat follow-up on the cube-with-hole fixture", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    const rounded = matchConversationFixture("round the edges", "20mm cube with 5mm hole", previous!.code);
    expect(rounded?.id).toBe("cube-pretty-fillet");
    expect(rounded?.code).toMatch(/size = 20/);
    expect(rounded?.code).toMatch(/hole_d = 5/);

    const steampunk = matchConversationFixture("make it look steampunk", "20mm cube with 5mm hole", previous!.code);
    expect(steampunk?.id).toBe("cube-pretty-steampunk");
    expect(steampunk?.code).toMatch(/hole_d = 5/);
  });

  it("refuses a close-the-hole follow-up and keeps the working hole fixture", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    const kept = matchConversationFixture(
      "close the hole to pretty it up",
      "20mm cube with 5mm hole",
      previous!.code,
    );
    expect(kept?.id).toBe("cube-with-hole");
    expect(kept?.code).toMatch(/hole_d = 5/);
    expect(kept?.code).not.toMatch(/fillet_r/);
  });

  it("does not restyle a PIP hinge into a fused blob", () => {
    const hinge = matchFixture(HINGE_FIXTURE_PROMPT);
    const next = matchConversationFixture("fuse the joint to pretty it up", HINGE_FIXTURE_PROMPT, hinge!.code);
    expect(next?.id).toBe("hinged-box-lid");
    expect(next?.code).toContain("module hinge_pin()");
    expect(next?.code).toMatch(/Separate solids/);
  });

  it("emits standalone fixture OpenSCAD that still matches the helpers", () => {
    expect(cubePrettyFilletScad(20, 5)).toMatch(/size = 20/);
    expect(cubePrettySteampunkScad()).toMatch(/Not neural Style2Fab/);
    expect(formatPrettyUpConstraints()).toMatch(/functional preserve/i);
    expect(formatPrettyUpConstraints()).toMatch(/not neural Style2Fab/i);
  });
});

describe("imported-mesh pretty-up wrap", () => {
  it("unions decorative ribs onto an imported cube without dropping the hole", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const pretty = inferCadPrettyUp({
      prompt: "add decorative ribs",
      holes: [{ d: 8, through: true }],
      sizeMm: boundingBoxMm(mesh).size,
    });
    expect(pretty?.applied).toBe(true);
    expect(canBuildDeterministicImportWrap("add decorative ribs", null, false, null, pretty)).toBe(true);
    const code = buildImportedMeshWrapper({
      mesh,
      prettyUp: pretty,
      prompt: "add decorative ribs",
    });
    expect(code).toMatch(/import\("imported\.stl"/);
    expect(code).toMatch(/pretty-up: ribs/);
    expect(code).toMatch(/union\(\)/);
    expect(code).not.toMatch(/\bminkowski\s*\(/);
  });
});

describe("CAD plan schema mentions pretty-up", () => {
  it("documents pretty_up in planner + codegen prompts", () => {
    expect(planSystemPrompt()).toMatch(/"style":"fillet\|chamfer\|ribs\|panels\|steampunk\|motif"/);
    expect(planSystemPrompt()).toMatch(/omit pretty_up unless/i);
    expect(systemPrompt()).toMatch(/Pretty-up \/ restyle/i);
    expect(systemPrompt()).toMatch(/Not neural Style2Fab/i);

    const raw = parseCadPlan(
      JSON.stringify({
        object: "cube",
        features: [{ name: "body" }],
        holes: [{ d: 5, through: true }],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        pretty_up: {
          style: "fillet",
          applied: true,
          ops: [{ kind: "fillet", mm: 2 }],
          functional_regions: [{ kind: "functional", role: "hole", note: "keep 5 mm" }],
        },
      }),
    );
    const plan = normalizeCadPlan(raw!, { prompt: CUBE_FILLET_PROMPT });
    expect(plan.pretty_up?.style).toBe("fillet");
    expect(plan.pretty_up?.applied).toBe(true);
    expect(plan.holes[0]?.d).toBe(5);
    const stripped = normalizeCadPlan(raw!, { prompt: "a sturdy tray" });
    expect(stripped.pretty_up).toBeUndefined();
  });
});
