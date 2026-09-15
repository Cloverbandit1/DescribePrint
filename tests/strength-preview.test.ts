import { describe, expect, it } from "vitest";
import { createJob, resetJobs, toGenerateResult } from "@/lib/jobs";
import { checkMesh } from "@/lib/mesh-check";
import { printRules } from "@/lib/printability";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import {
  STRENGTH_PREVIEW_DISCLAIMER,
  formatStrengthPreviewNote,
  heatmapRgb,
  isConcaveDihedral,
  makeBoxWithThroughHoleMesh,
  overhangScoreFromNormal,
  previewStrength,
  thicknessScoreFromMm,
} from "@/lib/strength-preview";

describe("strength-preview helpers", () => {
  it("maps thickness to a 0–1 heuristic (not FEA)", () => {
    const rules = printRules();
    expect(thicknessScoreFromMm(0.6, rules)).toBe(1);
    expect(thicknessScoreFromMm(1.2, rules)).toBeGreaterThan(0.55);
    expect(thicknessScoreFromMm(4, rules)).toBe(0);
    expect(STRENGTH_PREVIEW_DISCLAIMER).toMatch(/not FEA/i);
    expect(STRENGTH_PREVIEW_DISCLAIMER).not.toMatch(/finite element/i);
  });

  it("scores downward faces past 45° and ignores supported bed faces", () => {
    expect(overhangScoreFromNormal([0, 0, -1], false)).toBe(1);
    expect(overhangScoreFromNormal([0, 0, -1], true)).toBe(0);
    expect(overhangScoreFromNormal([0, 0, 1], false)).toBe(0);
    expect(overhangScoreFromNormal([0, -Math.SQRT1_2, -Math.SQRT1_2], false)).toBeCloseTo(0, 5);
    expect(overhangScoreFromNormal([0, -0.3, -0.95], false)).toBeGreaterThan(0.4);
  });

  it("treats a cube edge as convex and a hole wall pair as concave", () => {
    const cube = makeAxisAlignedBoxMesh([10, 10, 10]);
    expect(isConcaveDihedral(cube.triangles[2], cube.triangles[10])).toBe(false);
    const holed = makeBoxWithThroughHoleMesh([20, 20, 20], [5, 5]);
    expect(isConcaveDihedral(holed.triangles[8], holed.triangles[12])).toBe(true);
  });

  it("uses a cool→hot ramp", () => {
    const cool = heatmapRgb(0);
    const hot = heatmapRgb(1);
    expect(cool[2]).toBeGreaterThan(cool[0]);
    expect(hot[0]).toBeGreaterThan(hot[2]);
  });
});

describe("strength-preview fixture meshes", () => {
  it("leaves a solid cube mostly cool", () => {
    const preview = previewStrength(makeAxisAlignedBoxMesh([20, 20, 20]));
    expect(preview.method).toBe("heuristic");
    expect(preview.fea).toBe(false);
    expect(preview.maxScore).toBeLessThan(0.35);
    expect(preview.issues).toHaveLength(0);
    expect(formatStrengthPreviewNote(preview)).toBe("");
  });

  it("flags a thin sheet as a thin wall", () => {
    const preview = previewStrength(makeAxisAlignedBoxMesh([30, 20, 1.2]));
    expect(preview.issues.some((issue) => issue.kind === "thin-wall")).toBe(true);
    expect(preview.maxScore).toBeGreaterThan(0.45);
    expect(formatStrengthPreviewNote(preview)).toMatch(/thin wall/i);
    expect(formatStrengthPreviewNote(preview)).toMatch(/not FEA/i);
  });

  it("heats the hole on a 20 mm cube with a 5 mm bore (stress, not FEA)", () => {
    const holed = makeBoxWithThroughHoleMesh([20, 20, 20], [5, 5]);
    const cube = makeAxisAlignedBoxMesh([20, 20, 20]);
    const preview = previewStrength(holed);
    const solid = previewStrength(cube);
    expect(preview.triangleCount).toBe(holed.triangles.length);
    expect(preview.triangleScores).toHaveLength(holed.triangles.length);
    expect(preview.maxScore).toBeGreaterThan(solid.maxScore);
    const inner = preview.triangleScores.slice(8, 16);
    const outer = preview.triangleScores.slice(0, 8);
    const innerMean = inner.reduce((s, v) => s + v, 0) / inner.length;
    const outerMean = outer.reduce((s, v) => s + v, 0) / outer.length;
    expect(innerMean).toBeGreaterThan(outerMean);
    expect(preview.issues.some((issue) => /near hole|concave|stress/i.test(issue.message))).toBe(true);
    expect(preview.disclaimer).toMatch(/not FEA/i);
  });

  it("reports thin wall ~1.2 mm near a large hole", () => {
    const mesh = makeBoxWithThroughHoleMesh([20, 20, 8], [17.6, 17.6]);
    const preview = previewStrength(mesh);
    const thin = preview.issues.find((issue) => issue.kind === "thin-wall");
    expect(thin).toBeTruthy();
    expect(thin?.message).toMatch(/thin wall ~/);
    expect(thin?.message).toMatch(/near hole/);
    expect(thin?.thicknessMm).toBeGreaterThan(0.8);
    expect(thin?.thicknessMm).toBeLessThan(1.7);
    expect(formatStrengthPreviewNote(preview)).toMatch(/thin wall ~/);
  });

  it("flags an unsupported downward face as an overhang", () => {
    const base = makeAxisAlignedBoxMesh([16, 16, 3], [0, 0, 0]);
    const shelf = makeAxisAlignedBoxMesh([16, 6, 2], [0, 0, 8]);
    const preview = previewStrength({ triangles: [...base.triangles, ...shelf.triangles] });
    expect(preview.issues.some((issue) => issue.kind === "overhang" || /overhang/i.test(issue.message))).toBe(
      true,
    );
  });

  it("flags a tiny neck between two blocks", () => {
    const a = makeAxisAlignedBoxMesh([12, 12, 12], [0, 0, 0]);
    const neck = makeAxisAlignedBoxMesh([8, 0.7, 0.7], [12, 5.65, 5.65]);
    const b = makeAxisAlignedBoxMesh([12, 12, 12], [20, 0, 0]);
    const preview = previewStrength({ triangles: [...a.triangles, ...neck.triangles, ...b.triangles] });
    expect(preview.maxScore).toBeGreaterThan(0.4);
    expect(
      preview.issues.some((issue) => issue.kind === "tiny-section" || issue.kind === "thin-wall"),
    ).toBe(true);
  });
});

describe("strength-preview on mesh-check / generate notes", () => {
  it("attaches a heuristic preview after checkMesh", () => {
    const report = checkMesh(makeBoxWithThroughHoleMesh([20, 20, 8], [17.6, 17.6]));
    expect(report.strengthPreview?.method).toBe("heuristic");
    expect(report.strengthPreview?.fea).toBe(false);
    expect(report.strengthPreview?.issues.some((issue) => /thin wall/i.test(issue.message))).toBe(true);
  });

  it("adds the preview note on toGenerateResult without claiming FEA", () => {
    resetJobs();
    const mesh = makeBoxWithThroughHoleMesh([20, 20, 8], [17.6, 17.6]);
    const report = checkMesh(mesh);
    const job = createJob({
      stl: writeBinaryStl(mesh),
      threemf: Buffer.from("PK"),
      scad: "size = 20;\nhole_d = 17.6;\n",
      report,
      usedFixture: true,
      retried: false,
    });
    const result = toGenerateResult(job);
    expect(result.notes.join(" ")).toMatch(/not FEA/i);
    expect(result.notes.join(" ")).toMatch(/thin wall ~/);
    expect(result.notes.join(" ")).not.toMatch(/\bFEA analysis\b/i);
    resetJobs();
  });
});
