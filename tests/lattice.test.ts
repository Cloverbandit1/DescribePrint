import { describe, expect, it } from "vitest";
import { buildImportedMeshWrapper, canBuildDeterministicImportWrap } from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import { normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";
import {
  CUBE_GYROID_PROMPT,
  CUBE_HONEYCOMB_PROMPT,
  PHONE_HONEYCOMB_PROMPT,
  clampLatticeCellMm,
  clampLatticeStrutMm,
  formatLatticeConstraints,
  formatLatticeNote,
  inferCadLattice,
  inferLatticePattern,
  latticeWouldCutHoles,
  latticeWouldCutJoints,
  nozzleAwareShellMm,
  normalizeCadLattice,
  parseCadLattice,
  promptHasLattice,
} from "@/lib/lattice";
import { HINGE_FIXTURE_PROMPT } from "@/lib/joints";
import { matchConversationFixture, matchFixture } from "@/lib/fixtures";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

describe("lattice intent vs ordinary describe", () => {
  it("detects lightweight / honeycomb / gyroid prompts and leaves ordinary describe alone", () => {
    expect(promptHasLattice(PHONE_HONEYCOMB_PROMPT)).toBe(true);
    expect(promptHasLattice(CUBE_HONEYCOMB_PROMPT)).toBe(true);
    expect(promptHasLattice(CUBE_GYROID_PROMPT)).toBe(true);
    expect(promptHasLattice("make it lighter")).toBe(true);
    expect(promptHasLattice("cubic grid lattice")).toBe(true);
    expect(promptHasLattice("20mm cube with 5mm hole")).toBe(false);
    expect(promptHasLattice("phone stand for iPhone 15, 60 degree tilt")).toBe(false);
    expect(inferLatticePattern(PHONE_HONEYCOMB_PROMPT)).toBe("honeycomb");
    expect(inferLatticePattern(CUBE_GYROID_PROMPT)).toBe("gyroid");
    expect(inferLatticePattern("20mm cube with diagonal lattice")).toBe("diagonal");
    expect(inferLatticePattern("lighten the cube")).toBe("honeycomb");
  });

  it("keeps a nozzle-aware shell and printable struts", () => {
    expect(nozzleAwareShellMm()).toBeGreaterThanOrEqual(1.6);
    expect(nozzleAwareShellMm(0.4)).toBe(1.6);
    expect(clampLatticeStrutMm(0.2)).toBe(1.6);
    expect(clampLatticeCellMm(8, [20, 20, 20], 1.6)).toBeGreaterThanOrEqual(4);
    expect(clampLatticeCellMm(40, [20, 20, 20], 1.6)).toBeLessThan(20);
  });
});

describe("lattice functional preserve + refuse", () => {
  it("refuses lattice that would cut a PIP joint", () => {
    expect(
      latticeWouldCutJoints("lattice through the hinge", {
        prompt: "lattice through the hinge",
        previousPrompt: HINGE_FIXTURE_PROMPT,
        previousCode: "module box_body() {}\nmodule hinge_pin() {}",
      }),
    ).toBe(true);
    const refused = inferCadLattice({
      prompt: "lighten the hinged box",
      previousPrompt: HINGE_FIXTURE_PROMPT,
      previousCode: "module box_body() {}\nmodule hinge_pin() {}",
      joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
    });
    expect(refused?.refused).toBe(true);
    expect(refused?.applied).toBe(false);
    expect(refused?.refuse_reason).toMatch(/joint|mating/i);
    expect(refused?.functional_regions.some((region) => region.role === "joint")).toBe(true);
    expect(refused?.fea).toBe(false);
  });

  it("refuses lattice through a functional hole", () => {
    expect(
      latticeWouldCutHoles("lattice through the hole", {
        prompt: "lattice through the hole",
        previousPrompt: "20mm cube with 5mm hole",
        previousCode: "size = 20;\nhole_d = 5;",
      }),
    ).toBe(true);
    const refused = inferCadLattice({
      prompt: "honeycomb through the hole",
      previousPrompt: "20mm cube with 5mm hole",
      holes: [{ d: 5, through: true }],
    });
    expect(refused?.refused).toBe(true);
    expect(refused?.refuse_reason).toMatch(/hole|bore/i);
  });

  it("marks shell / hole keepers on a safe lightweight cube", () => {
    const lattice = inferCadLattice({
      prompt: CUBE_HONEYCOMB_PROMPT,
      holes: [{ d: 5, through: true }],
      sizeMm: [20, 20, 20],
    });
    expect(lattice?.applied).toBe(true);
    expect(lattice?.refused).toBe(false);
    expect(lattice?.pattern).toBe("honeycomb");
    expect(lattice?.shell_mm).toBeGreaterThanOrEqual(1.6);
    expect(lattice?.strut_mm).toBeGreaterThanOrEqual(1.6);
    expect(lattice?.fea).toBe(false);
    expect(lattice?.one_piece).toBe(true);
    expect(lattice?.functional_regions.map((region) => region.role)).toEqual(
      expect.arrayContaining(["shell", "wall", "hole"]),
    );
    expect(formatLatticeNote(lattice)).toMatch(/Lattice stub/i);
    expect(formatLatticeNote(lattice)).toMatch(/not FEA/i);
  });
});

describe("lattice plan parse + normalize", () => {
  it("strips hallucinated lattice and keeps a lightweight prompt", () => {
    const parsed = parseCadLattice({
      pattern: "honeycomb",
      applied: true,
      shell_mm: 1.6,
      cell_mm: 8,
      strut_mm: 1.6,
    });
    expect(parsed?.pattern).toBe("honeycomb");
    expect(normalizeCadLattice(parsed, { prompt: "a sturdy tray" })).toBeUndefined();
    const kept = normalizeCadLattice(parsed, { prompt: PHONE_HONEYCOMB_PROMPT });
    expect(kept?.applied).toBe(true);
    expect(kept?.pattern).toBe("honeycomb");
    expect(kept?.fea).toBe(false);
  });
});

describe("lattice fixtures + OpenSCAD", () => {
  it("matches the honeycomb phone stand and keeps the cable slot", () => {
    const stand = matchFixture(PHONE_HONEYCOMB_PROMPT);
    expect(stand?.id).toBe("phone-stand-honeycomb");
    expect(sanitizeOpenScad(stand!.code).ok).toBe(true);
    expect(stand?.code).toMatch(/shell_mm = 1\.6/);
    expect(stand?.code).toMatch(/cell_mm = 8/);
    expect(stand?.code).toMatch(/module lattice_voids/);
    expect(stand?.code).toMatch(/cable = 14/);
    expect(stand?.code).toMatch(/cable_keeper/);
    expect(stand?.code).toMatch(/latticed_box/);
    expect(stand?.code).toMatch(/not FEA/);
    expect(matchFixture("phone stand for iPhone 15, 60 degree tilt")?.id).toBe("phone-stand");
  });

  it("matches cube honeycomb / gyroid fixtures and keeps a through-hole when asked", () => {
    const honey = matchFixture(CUBE_HONEYCOMB_PROMPT);
    expect(honey?.id).toBe("cube-lattice-honeycomb");
    expect(sanitizeOpenScad(honey!.code).ok).toBe(true);
    expect(honey?.code).toMatch(/shell_mm = 1\.6/);
    expect(honey?.code).not.toMatch(/hole_d/);

    const gyroid = matchFixture(CUBE_GYROID_PROMPT);
    expect(gyroid?.id).toBe("cube-lattice-gyroid");
    expect(sanitizeOpenScad(gyroid!.code).ok).toBe(true);
    expect(gyroid?.code).toMatch(/hole_d = 5/);
    expect(gyroid?.code).toMatch(/Gyroid-ish/);
    expect(gyroid?.code).toMatch(/hole_d \+ 2 \* shell_mm/);
    expect(matchFixture("20mm cube with 5mm hole")?.id).toBe("cube-with-hole");
  });

  it("applies lattice as a chat follow-up on the cube-with-hole and phone stand", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    const lighter = matchConversationFixture("make it lighter", "20mm cube with 5mm hole", previous!.code);
    expect(lighter?.id).toBe("cube-lattice-honeycomb");
    expect(lighter?.code).toMatch(/hole_d = 5/);
    expect(lighter?.code).toMatch(/shell_mm = 1\.6/);

    const stand = matchFixture("phone stand for iPhone 15, 60 degree tilt");
    const honey = matchConversationFixture("add honeycomb", "phone stand for iPhone 15, 60 degree tilt", stand!.code);
    expect(honey?.id).toBe("phone-stand-honeycomb");
    expect(honey?.code).toMatch(/cable = 14/);
  });

  it("documents heuristic limits in printer constraints", () => {
    expect(formatLatticeConstraints()).toMatch(/internal volume/i);
    expect(formatLatticeConstraints()).toMatch(/not FEA/i);
    expect(formatLatticeConstraints()).toMatch(/1\.6/);
  });
});

describe("imported-mesh lattice wrap", () => {
  it("differences inset honeycomb voids and keeps a hole keeper", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const lattice = inferCadLattice({
      prompt: "honeycomb lattice the interior",
      holes: [{ d: 5, through: true }],
      sizeMm: boundingBoxMm(mesh).size,
    });
    expect(lattice?.applied).toBe(true);
    expect(canBuildDeterministicImportWrap("honeycomb lattice the interior", null, false, null, null, lattice)).toBe(
      true,
    );
    const code = buildImportedMeshWrapper({
      mesh,
      lattice,
      prompt: "honeycomb lattice the interior",
      hole: {
        diameterMm: 5,
        through: true,
        axis: "z",
        centerMm: [10, 10, 10],
        entryFace: "top",
        depthMm: 20,
        overshootMm: 1,
        notes: [],
      },
    });
    expect(code).toMatch(/lattice: honeycomb/);
    expect(code).toMatch(/import\("imported\.stl"/);
    expect(code).toMatch(/module lattice_voids/);
    expect(code).toMatch(/shell_mm/);
    expect(sanitizeOpenScad(code, { allowImportedMesh: true }).ok).toBe(true);
  });
});

describe("CAD plan schema mentions lattice", () => {
  it("documents lattice in planner + codegen prompts", () => {
    expect(systemPrompt()).toMatch(/Lattice \/ lightweighting only when asked/i);
    expect(systemPrompt()).toMatch(/not FEA \/ MechStyle/i);
    expect(planSystemPrompt()).toMatch(/omit lattice unless/i);
    expect(planSystemPrompt()).toMatch(/"pattern":"honeycomb\|cubic\|gyroid\|diagonal"/);
    const plan = parseCadPlan(
      JSON.stringify({
        object: "phone stand",
        one_piece: true,
        units: "mm",
        features: [],
        holes: [{ d: 14, purpose: "cable" }],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        sit_on_z0: true,
        lattice: {
          applied: true,
          pattern: "honeycomb",
          shell_mm: 1.6,
          cell_mm: 8,
          strut_mm: 1.6,
          fea: false,
        },
      }),
    );
    expect(plan?.lattice?.pattern).toBe("honeycomb");
    expect(plan?.lattice?.applied).toBe(true);
    const stripped = normalizeCadPlan(plan!, { prompt: "a sturdy tray" });
    expect(stripped.lattice).toBeUndefined();
    const kept = normalizeCadPlan(plan!, { prompt: PHONE_HONEYCOMB_PROMPT });
    expect(kept.lattice?.applied).toBe(true);
    expect(kept.lattice?.fea).toBe(false);
  });
});
