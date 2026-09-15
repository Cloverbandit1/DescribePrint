import { describe, expect, it } from "vitest";
import {
  PRESS_FIT_CUBE_PROMPT,
  applyFitToHoles,
  applyFitToJoints,
  applyFitToMatingFeatures,
  clampHoleForWalls,
  defaultFitTable,
  finishedHoleMm,
  formatFitTableMarkdown,
  inferCadFit,
  inferFitGrade,
  inferFitKind,
  materialFitDeltaMm,
  normalizeCadFit,
  parseCadFit,
  parseExplicitClearanceMm,
  parseShaftMm,
  promptAsksFitChoice,
  resolveFitClearance,
} from "@/lib/fits";
import { applyChoicesToGenerateFields, resolveDesignOptions } from "@/lib/design-options";
import { matchFixture } from "@/lib/fixtures";
import { parseImportHoleSpec } from "@/lib/import-hole";
import { normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";
import { wantsWearableScale } from "@/lib/knowledge";
import { defaultPrinter } from "@/lib/printers";
import { printRules } from "@/lib/printability";
import { boundingBoxMm } from "@/lib/mesh-check";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";
import { jointClearance } from "@/lib/joints";

describe("fit wizard table (P2S 0.4 mm nozzle)", () => {
  it("documents S/M/L radial/axial and reuses joints.ts Medium snap / hinge band", () => {
    const printer = defaultPrinter();
    expect(printer.nozzleMm).toBe(0.4);
    expect(printRules().minWallMm).toBe(1.6);

    const snapM = resolveFitClearance("snap", "M");
    expect(snapM.radial_mm).toBe(jointClearance("snap", "print-in-place").radialMm);
    expect(snapM.radial_mm).toBe(0.3);
    expect(resolveFitClearance("snap", "S").radial_mm).toBe(0.2);
    expect(resolveFitClearance("snap", "L").radial_mm).toBe(0.4);

    expect(resolveFitClearance("press", "S").radial_mm).toBe(0.1);
    expect(resolveFitClearance("press", "M").radial_mm).toBe(0.2);
    expect(resolveFitClearance("press", "L").radial_mm).toBe(printRules().clearanceMm);

    const slideM = resolveFitClearance("sliding", "M");
    expect(slideM.radial_mm).toBe(jointClearance("hinge", "print-in-place").radialMm);
    expect(resolveFitClearance("sliding", "L").radial_mm).toBe(jointClearance("hinge", "multi-part").radialMm);

    expect(resolveFitClearance("hinge", "S").radial_mm).toBe(0.4);
    expect(resolveFitClearance("hinge", "M").radial_mm).toBe(0.45);
    expect(resolveFitClearance("hinge", "L").radial_mm).toBe(0.5);

    expect(resolveFitClearance("wearable", "S").radial_mm).toBe(0.5);
    expect(resolveFitClearance("wearable", "M").radial_mm).toBe(1);
    expect(resolveFitClearance("wearable", "L").radial_mm).toBe(2);

    expect(defaultFitTable()).toHaveLength(15);
    expect(formatFitTableMarkdown()).toMatch(/\| press \| M \| 0\.20 \|/);
    expect(formatFitTableMarkdown()).toMatch(/\| snap \| M \| 0\.30 \|/);
    expect(formatFitTableMarkdown()).toMatch(/\| hinge \| S \| 0\.40 \|/);
  });

  it("adds a small material delta and honors explicit mm", () => {
    expect(materialFitDeltaMm("pla")).toBe(0);
    expect(materialFitDeltaMm("petg")).toBe(0.05);
    expect(materialFitDeltaMm("tpu")).toBe(0.1);
    expect(resolveFitClearance("press", "M", { filament: "petg" }).radial_mm).toBe(0.25);
    const explicit = resolveFitClearance("press", "M", { overrideMm: 0.25 });
    expect(explicit.radial_mm).toBe(0.25);
    expect(explicit.override_mm).toBe(0.25);
    expect(explicit.diameter_delta_mm).toBe(0.5);
  });

  it("infers kind / grade / shaft / mm from chat", () => {
    expect(inferFitKind(PRESS_FIT_CUBE_PROMPT)).toBe("press");
    expect(inferFitKind("sliding fit 8mm pin")).toBe("sliding");
    expect(inferFitKind("wearable fit around the wrist")).toBe("wearable");
    expect(inferFitKind("hinge fit grade S")).toBe("hinge");
    expect(inferFitKind("20mm cube with 5mm hole")).toBeNull();
    expect(inferFitGrade("press-fit 8mm pin, fit grade S")).toBe("S");
    expect(parseShaftMm(PRESS_FIT_CUBE_PROMPT)).toBe(8);
    expect(parseExplicitClearanceMm("press-fit 8mm pin, 0.25 mm clearance")).toBe(0.25);
    expect(promptAsksFitChoice("which fit should I use for this pin?")).toBe(true);
    expect(promptAsksFitChoice(PRESS_FIT_CUBE_PROMPT)).toBe(false);
    expect(wantsWearableScale("wearable fit around the wrist")).toBe(false);
    expect(wantsWearableScale("wearable stormtrooper helmet")).toBe(true);

    const inferred = inferCadFit({ prompt: PRESS_FIT_CUBE_PROMPT });
    expect(inferred).toMatchObject({ kind: "press", grade: "M", radial_mm: 0.2 });
    expect(finishedHoleMm(8, inferred!)).toBe(8.4);
  });
});

describe("plan / codegen / holes", () => {
  it("normalizes a press-fit pin hole and keeps ordinary holes alone", () => {
    const raw = parseCadPlan(
      JSON.stringify({
        object: "cube",
        one_piece: true,
        units: "mm",
        overall_mm: { x: 20, y: 20, z: 20 },
        features: [{ name: "bore", kind: "bore", dims_mm: { d: 8, wall: 1.2 } }],
        holes: [{ d: 8, purpose: "pin" }],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        sit_on_z0: true,
      }),
    );
    expect(raw).not.toBeNull();
    const fitted = normalizeCadPlan(raw!, { prompt: PRESS_FIT_CUBE_PROMPT });
    expect(fitted.fit).toMatchObject({ kind: "press", grade: "M", radial_mm: 0.2 });
    expect(fitted.clearance_mm).toBe(0.2);
    expect(fitted.holes[0]?.d).toBe(8.4);
    expect(fitted.features[0]?.dims_mm?.d).toBe(8.4);
    expect(fitted.features[0]?.dims_mm?.wall).toBe(1.6);
    expect(fitted.min_wall_mm).toBe(1.6);

    const ordinary = normalizeCadPlan(raw!, { prompt: "20mm cube with 5mm hole" });
    expect(ordinary.fit).toBeUndefined();
    expect(ordinary.holes[0]?.d).toBe(8);
    expect(ordinary.clearance_mm).toBe(0.3);

    const override = normalizeCadPlan(raw!, { prompt: "press-fit 8mm pin, 0.25 mm clearance" });
    expect(override.fit?.override_mm).toBe(0.25);
    expect(override.holes[0]?.d).toBe(8.5);

    const snapJoint = normalizeCadPlan(
      parseCadPlan(
        JSON.stringify({
          object: "clip",
          features: [{ name: "hook" }],
          holes: [],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          joints: [{ type: "snap", intent: "print-in-place", radial_mm: 0.3, axial_mm: 0.5 }],
        }),
      )!,
      { prompt: "snap-fit clip, fit grade L" },
    );
    expect(snapJoint.joints?.[0]).toMatchObject({ type: "snap", radial_mm: 0.4, axial_mm: 0.6 });
  });

  it("clamps finished holes so walls stay ≥ 1.6 mm", () => {
    expect(clampHoleForWalls(18, 20, 1.6)).toBe(16.8);
    const holes = applyFitToHoles([{ d: 16 }], resolveFitClearance("wearable", "L"), {
      prompt: "wearable fit 16mm shaft",
      sizeMm: [20, 20, 20],
    });
    expect(holes[0]?.d).toBe(16.8);
  });

  it("overlays sliding clearances on pin joints and leaves ball alone", () => {
    const joints = applyFitToJoints(
      [
        { type: "pin", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 },
        { type: "ball", intent: "print-in-place", radial_mm: 0.5, axial_mm: 0.5 },
      ],
      resolveFitClearance("sliding", "L"),
    );
    expect(joints[0]).toMatchObject({ type: "pin", radial_mm: 0.5, axial_mm: 0.6 });
    expect(joints[1]).toMatchObject({ type: "ball", radial_mm: 0.5 });
    expect(applyFitToMatingFeatures([{ name: "body", dims_mm: { x: 20 } }], resolveFitClearance("press", "M"))[0]?.dims_mm?.x).toBe(
      20,
    );
  });

  it("embeds the wizard in system/plan prompts", () => {
    expect(systemPrompt()).toMatch(/Fit wizard/);
    expect(systemPrompt()).toMatch(/Finished hole = shaft/);
    expect(planSystemPrompt()).toMatch(/omit fit unless/i);
  });
});

describe("option chips + fixtures + import wrap", () => {
  it("does not ask on an ordinary cube, asks kind/grade on fit forks", () => {
    expect(resolveDesignOptions({ prompt: "20mm cube with 5mm hole" }).needs_user_choice).toBe(false);
    expect(resolveDesignOptions({ prompt: "which fit should I use for this 8mm pin?" }).options.map((g) => g.id)).toEqual([
      "fit_kind",
    ]);
    expect(resolveDesignOptions({ prompt: PRESS_FIT_CUBE_PROMPT }).options.map((g) => g.id)).toEqual(["fit_grade"]);
    expect(resolveDesignOptions({ prompt: "snap-fit clip" }).options.some((g) => g.id === "fit_grade")).toBe(false);
    expect(
      resolveDesignOptions({
        prompt: PRESS_FIT_CUBE_PROMPT,
        choices: [{ id: "fit_grade", value: "S" }],
      }).needs_user_choice,
    ).toBe(false);

    const fields = applyChoicesToGenerateFields({
      prompt: "8mm pin hole",
      choices: [
        { id: "fit_kind", value: "press" },
        { id: "fit_grade", value: "S" },
      ],
    });
    expect(fields.prompt).toMatch(/press fit/);
    expect(fields.prompt).toMatch(/fit grade S/);
  });

  it("emits a press-fit cube fixture with hole_d = shaft + 2×radial", () => {
    const fixture = matchFixture(PRESS_FIT_CUBE_PROMPT);
    expect(fixture?.id).toBe("cube-press-fit-hole");
    expect(fixture?.code).toMatch(/hole_d = 8\.4/);
    expect(matchFixture("20mm cube with 5mm hole")?.code).toMatch(/hole_d = 5/);
  });

  it("applies fit clearance on imported-mesh holes", () => {
    const cube20 = boundingBoxMm(makeAxisAlignedBoxMesh([20, 20, 20]));
    const ordinary = parseImportHoleSpec("add an 8 mm hole through the center", cube20);
    expect(ordinary?.diameterMm).toBe(8);
    const press = parseImportHoleSpec("add a press-fit hole for an 8mm pin through the center", cube20);
    expect(press?.diameterMm).toBe(8.4);
    expect(press?.notes.join(" ")).toMatch(/fit wizard/i);
  });

  it("parses a plan fit object", () => {
    const parsed = parseCadFit({ kind: "sliding", grade: "L", radial_mm: 0.5 });
    expect(parsed).toMatchObject({ kind: "sliding", grade: "L", radial_mm: 0.5 });
    expect(normalizeCadFit(parsed, { prompt: "a sturdy tray" })).toBeUndefined();
    expect(normalizeCadFit(undefined, { prompt: "a sturdy tray" })).toBeUndefined();
  });
});
