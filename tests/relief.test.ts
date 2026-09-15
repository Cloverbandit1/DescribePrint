import { describe, expect, it } from "vitest";
import { buildImportedMeshWrapper, canBuildDeterministicImportWrap } from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import { normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";
import {
  CHEST_CHEVRON_PROMPT,
  CUBE_ETCH_PROMPT,
  DEFAULT_EMBOSS_HEIGHT_MM,
  DEFAULT_ETCH_DEPTH_MM,
  GAUNTLET_CUFF_PROMPT,
  HELMET_EMBOSS_PROMPT,
  HELMET_MULTI_RELIEF_PROMPT,
  MIN_RELIEF_MM,
  attachImageMotif,
  clampReliefExtentMm,
  cubeEtchFixtureScad,
  defaultReliefRegion,
  formatReliefConstraints,
  helmetEmbossFixtureScad,
  inferCadReliefs,
  normalizeCadReliefs,
  parseCadReliefs,
  parseReliefRegion,
  promptHasRelief,
  reliefMotifScad,
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

describe("richer motifs + multi-relief + wearable regions", () => {
  it("does not treat a chest plate as the build plate", () => {
    expect(parseReliefRegion("chest plate")).toBe("front");
    expect(parseReliefRegion("back of helmet")).toBe("back");
    expect(parseReliefRegion("gauntlet cuff")).toBe("front");
    expect(parseReliefRegion("build plate")).toBe("bottom");
  });

  it("infers chevron on a chest plate and a ring on a gauntlet cuff", () => {
    const chest = inferCadReliefs(CHEST_CHEVRON_PROMPT, [120, 28, 90]);
    expect(chest[0]).toMatchObject({
      kind: "emboss",
      motif: "chevron",
      region: "front",
      target: "chest plate",
      wearableCategory: "torso_armor",
      height_mm: DEFAULT_EMBOSS_HEIGHT_MM,
    });
    const cuff = inferCadReliefs(GAUNTLET_CUFF_PROMPT, [70, 90, 45]);
    expect(cuff[0]).toMatchObject({
      kind: "etch",
      motif: "ring",
      region: "front",
      target: "gauntlet cuff",
      wearableCategory: "gauntlet",
      depth_mm: DEFAULT_ETCH_DEPTH_MM,
    });
  });

  it("splits multi-relief helmet crest + front initials", () => {
    const reliefs = inferCadReliefs(HELMET_MULTI_RELIEF_PROMPT, [96, 108, 64]);
    expect(reliefs).toHaveLength(2);
    expect(reliefs[0]).toMatchObject({ kind: "emboss", motif: "crest", region: "back" });
    expect(reliefs[1]).toMatchObject({ kind: "etch", motif: "text", region: "front", text: "DP" });
    const normalized = normalizeCadReliefs([], HELMET_MULTI_RELIEF_PROMPT, [96, 108, 64]);
    expect(normalized).toHaveLength(2);
    expect(normalized[0]?.kind).toBe("emboss");
    expect(normalized[1]?.kind).toBe("etch");
  });

  it("matches new wearable fixtures with sanitizable CSG", () => {
    const chest = matchFixture(CHEST_CHEVRON_PROMPT);
    expect(chest?.id).toBe("chest-chevron-emboss");
    expect(sanitizeOpenScad(chest!.code).ok).toBe(true);
    expect(chest?.code).toContain("module chest_plate()");
    expect(chest?.code).toMatch(/union\(\)/);
    expect(chest?.code).not.toMatch(/\btext\s*\(\s*["']/);

    const cuff = matchFixture(GAUNTLET_CUFF_PROMPT);
    expect(cuff?.id).toBe("gauntlet-cuff-etch");
    expect(sanitizeOpenScad(cuff!.code).ok).toBe(true);
    expect(cuff?.code).toContain("module gauntlet_cuff()");
    expect(cuff?.code).toMatch(/difference\(\)/);

    const multi = matchFixture(HELMET_MULTI_RELIEF_PROMPT);
    expect(multi?.id).toBe("helmet-multi-relief");
    expect(sanitizeOpenScad(multi!.code).ok).toBe(true);
    expect(multi?.code).toMatch(/emboss_h = 0\.8/);
    expect(multi?.code).toMatch(/etch_depth = 0\.6/);
  });

  it("attaches an image silhouette without dropping a second relief", () => {
    const field = {
      width: 4,
      height: 4,
      cells: [0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
      pixelsInferred: false,
      format: "png" as const,
    };
    const reliefs = attachImageMotif(
      inferCadReliefs(HELMET_MULTI_RELIEF_PROMPT, [96, 108, 64]),
      field,
      "emboss this logo on the back of the helmet and etch initials on the front",
      [96, 108, 64],
    );
    expect(reliefs).toHaveLength(2);
    expect(reliefs[0]?.motif).toBe("image");
    expect(reliefs[0]?.image?.width).toBe(4);
    expect(reliefs[1]?.motif).toBe("text");
    const box = { min: [0, 0, 0] as [number, number, number], max: [96, 108, 64] as [number, number, number], size: [96, 108, 64] as [number, number, number] };
    expect(reliefMotifScad(reliefs[0]!, box)).toMatch(/cube\(/);
  });
});
