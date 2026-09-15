import { describe, expect, it } from "vitest";
import { buildImportedMeshWrapper, canBuildDeterministicImportWrap } from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import { normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";
import {
  CUBE_ETCH_PROMPT,
  DEFAULT_EMBOSS_HEIGHT_MM,
  DEFAULT_ETCH_DEPTH_MM,
  HELMET_EMBOSS_PROMPT,
  MIN_RELIEF_MM,
  clampReliefExtentMm,
  cubeEtchFixtureScad,
  defaultReliefRegion,
  formatReliefConstraints,
  helmetEmbossFixtureScad,
  inferCadReliefs,
  normalizeCadReliefs,
  parseCadReliefs,
  promptHasRelief,
} from "@/lib/relief";
import { matchConversationFixture, matchFixture } from "@/lib/fixtures";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

describe("relief defaults and clamps", () => {
  it("defaults unspecified region to largest vertical face, ties to front", () => {
    expect(defaultReliefRegion([20, 20, 20])).toBe("front");
    expect(defaultReliefRegion([10, 40, 20])).toBe("right");
    expect(defaultReliefRegion()).toBe("front");
  });

  it("keeps etch shallow enough to leave 1.6 mm walls", () => {
    expect(clampReliefExtentMm("emboss", undefined)).toBe(DEFAULT_EMBOSS_HEIGHT_MM);
    expect(clampReliefExtentMm("etch", undefined, 20)).toBe(DEFAULT_ETCH_DEPTH_MM);
    expect(clampReliefExtentMm("etch", 4, 2.4)).toBeCloseTo(0.8);
    expect(clampReliefExtentMm("etch", 0.8, 1.6)).toBe(MIN_RELIEF_MM);
    expect(clampReliefExtentMm("emboss", 8)).toBe(2);
  });
});

describe("relief plan parse + normalize", () => {
  it("infers helmet crest on the back and cube initials on the front", () => {
    const helmet = inferCadReliefs(HELMET_EMBOSS_PROMPT, [96, 108, 64]);
    expect(helmet[0]).toMatchObject({
      kind: "emboss",
      motif: "crest",
      region: "back",
      height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    });
    const cube = inferCadReliefs(CUBE_ETCH_PROMPT, [20, 20, 20]);
    expect(cube[0]).toMatchObject({
      kind: "etch",
      motif: "text",
      text: "DP",
      region: "front",
      depth_mm: DEFAULT_ETCH_DEPTH_MM,
    });
    expect(inferCadReliefs("a sturdy tray")).toEqual([]);
  });

  it("parses plan JSON and strips hallucinated reliefs", () => {
    const parsed = parseCadReliefs({
      kind: "etch",
      motif: "text",
      text: "ab",
      region: "front",
      depth_mm: 0.6,
    });
    expect(parsed[0]).toMatchObject({ kind: "etch", text: "AB", region: "front" });
    expect(normalizeCadReliefs(parsed, "a sturdy tray")).toEqual([]);
    const kept = normalizeCadReliefs(parsed, CUBE_ETCH_PROMPT, [20, 20, 20]);
    expect(kept[0]?.kind).toBe("etch");
    expect(kept[0]?.region).toBe("front");
  });
});

describe("relief fixtures + OpenSCAD", () => {
  it("matches helmet and cube fixtures with sanitizable CSG", () => {
    const helmet = matchFixture(HELMET_EMBOSS_PROMPT);
    expect(helmet?.id).toBe("helmet-emboss-crest");
    expect(sanitizeOpenScad(helmet!.code).ok).toBe(true);
    expect(helmet?.code).toContain("module helmet_shell()");
    expect(helmet?.code).toContain("module crest_motif()");
    expect(helmet?.code).toMatch(/emboss_h = 0\.8/);
    expect(helmet?.code).toMatch(/union\(\)/);
    expect(helmet?.code).not.toMatch(/\btext\s*\(\s*["']/);

    const cube = matchFixture(CUBE_ETCH_PROMPT);
    expect(cube?.id).toBe("cube-etched-initials");
    expect(sanitizeOpenScad(cube!.code).ok).toBe(true);
    expect(cube?.code).toMatch(/etch_depth = 0\.6/);
    expect(cube?.code).toMatch(/difference\(\)/);
    expect(cube?.code).toMatch(/cube\(size/);
    expect(cube?.code).not.toMatch(/\btext\s*\(\s*["']/);
    expect(matchFixture("20mm cube with 5mm hole")?.id).toBe("cube-with-hole");
    expect(matchFixture("helmet size L")).toBeNull();
  });

  it("edits a cube fixture to add etched initials", () => {
    const previous = matchFixture("20mm cube");
    const edited = matchConversationFixture("etch initials on the front", "20mm cube", previous!.code);
    expect(edited?.id).toBe("cube-etched-initials");
    expect(edited?.code).toMatch(/size = 20/);
    expect(edited?.code).toMatch(/difference\(\)/);
  });

  it("keeps the helmet fixture across a follow-up", () => {
    const helmet = matchFixture(HELMET_EMBOSS_PROMPT);
    const next = matchConversationFixture("keep the crest", HELMET_EMBOSS_PROMPT, helmet!.code);
    expect(next?.id).toBe("helmet-emboss-crest");
  });

  it("emits standalone fixture OpenSCAD that still matches the helpers", () => {
    expect(helmetEmbossFixtureScad()).toMatch(/wall = 2\.4/);
    expect(cubeEtchFixtureScad(20, "AB")).toMatch(/size = 20/);
    expect(promptHasRelief("raised logo")).toBe(true);
    expect(formatReliefConstraints()).toMatch(/largest vertical face/i);
  });
});

describe("imported-mesh relief wrap", () => {
  it("differences etched initials on the front of an imported cube", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const reliefs = inferCadReliefs("etch initials DP on the front", boundingBoxMm(mesh).size);
    expect(reliefs[0]?.motif).toBe("text");
    expect(reliefs[0]?.text).toBe("DP");
    expect(canBuildDeterministicImportWrap("etch initials DP on the front", null, false, reliefs)).toBe(true);
    const code = buildImportedMeshWrapper({ mesh, reliefs, prompt: "etch initials DP on the front" });
    expect(code).toMatch(/import\("imported\.stl"/);
    expect(code).toMatch(/difference\(\)/);
    expect(code).toMatch(/relief: etch text on front/);
    expect(code.indexOf("import")).toBeLessThan(code.indexOf("cube(["));
  });
});

describe("CAD plan schema mentions reliefs", () => {
  it("documents reliefs in planner + codegen prompts", () => {
    expect(planSystemPrompt()).toMatch(/"kind":"emboss\|etch"/);
    expect(planSystemPrompt()).toMatch(/omit the reliefs array unless/i);
    expect(systemPrompt()).toMatch(/Raised etchings \/ emboss/i);
    expect(systemPrompt()).not.toMatch(/Style2Fab neural/i);

    const raw = parseCadPlan(
      JSON.stringify({
        object: "helmet",
        features: [{ name: "shell" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        reliefs: [{ kind: "emboss", motif: "crest", region: "back", height_mm: 0.8 }],
      }),
    );
    const plan = normalizeCadPlan(raw!, { prompt: HELMET_EMBOSS_PROMPT });
    expect(plan.reliefs?.[0]).toMatchObject({ kind: "emboss", motif: "crest", region: "back" });
    const stripped = normalizeCadPlan(raw!, { prompt: "a sturdy tray" });
    expect(stripped.reliefs).toBeUndefined();
  });
});
