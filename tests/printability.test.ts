import { describe, expect, it } from "vitest";
import {
  allowsThinWalls,
  extractScadParams,
  statedWallMm,
  formatPrinterConstraints,
  formatPrintabilityFeedback,
  printRules,
  promptAllowsOversize,
  promptAllowsSmallHole,
  shouldRetryPrintability,
  wantsMultiPart,
  wantsNewDesign,
} from "@/lib/printability";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";
import { checkMesh } from "@/lib/mesh-check";

describe("printability rules (P2S)", () => {
  it("derives 1.6 mm walls and 256 mm bed from the 0.4 mm nozzle profile", () => {
    const rules = printRules();
    expect(rules.bedMm).toEqual([256, 256, 256]);
    expect(rules.nozzleMm).toBe(0.4);
    expect(rules.minWallMm).toBe(1.6);
    expect(rules.minFeatureMm).toBe(0.8);
    expect(rules.minHoleMm).toBe(2.5);
    expect(formatPrinterConstraints()).toMatch(/256 × 256 × 256 mm/);
    expect(formatPrinterConstraints()).toMatch(/0\.4 mm/);
    expect(formatPrinterConstraints()).toMatch(/print-in-place/);
    expect(formatPrinterConstraints()).toMatch(/0\.4 mm\/side/);
  });

  it("detects assembly vs one-piece and new-design follow-ups", () => {
    expect(wantsMultiPart("phone stand")).toBe(false);
    expect(wantsMultiPart("print as an assembly with two pieces")).toBe(true);
    expect(wantsMultiPart("multi-part kit of loose parts")).toBe(true);
    expect(wantsNewDesign("make the hole 8mm")).toBe(false);
    expect(wantsNewDesign("start over from scratch")).toBe(true);
  });

  it("only allows thin walls or oversize when the user stated them", () => {
    expect(allowsThinWalls("bracket")).toBe(false);
    expect(allowsThinWalls("0.8mm wall clip")).toBe(true);
    expect(statedWallMm("0.8mm wall clip")).toBe(0.8);
    expect(allowsThinWalls("thin walls please")).toBe(true);
    expect(promptAllowsOversize("a tray", 400)).toBe(false);
    expect(promptAllowsOversize("300mm panel", 300)).toBe(true);
    expect(promptAllowsSmallHole("20mm cube", 2)).toBe(false);
    expect(promptAllowsSmallHole("2mm hole", 2)).toBe(true);
  });

  it("extracts named OpenSCAD parameters and skips $fn", () => {
    const params = extractScadParams(`$fn = 64;
size = 20;
hole_d = 5;
cube(size);
`);
    expect(params).toEqual({ size: 20, hole_d: 5 });
  });

  it("retries disconnected / off-bed / knife-edge meshes but not a healthy cube", () => {
    const ok = checkMesh(makeAxisAlignedBoxMesh([20, 20, 20]));
    expect(shouldRetryPrintability(ok)).toBe(false);

    const floating = checkMesh(makeAxisAlignedBoxMesh([20, 20, 20], [0, 0, 12]));
    expect(shouldRetryPrintability(floating)).toBe(true);
    expect(formatPrintabilityFeedback(floating)).toMatch(/sit on z=0/i);

    const sliver = checkMesh(makeAxisAlignedBoxMesh([20, 20, 0.4]));
    expect(shouldRetryPrintability(sliver)).toBe(true);

    const sheet = checkMesh(makeAxisAlignedBoxMesh([40, 40, 1.2]));
    expect(sheet.issues.some((i) => i.code === "thin-wall")).toBe(true);
    expect(shouldRetryPrintability(sheet)).toBe(false);
  });

  it("does not retry imported STL CSG solely for non-manifold noise", () => {
    const importedCsg = checkMesh(makeAxisAlignedBoxMesh([20, 20, 20]));
    importedCsg.issues.push({
      code: "non-manifold",
      severity: "warning",
      message: "Mesh is not edge-manifold (may not be watertight)",
    });
    expect(shouldRetryPrintability(importedCsg)).toBe(true);
    expect(shouldRetryPrintability(importedCsg, undefined, { importedWrap: true })).toBe(false);

    const floating = checkMesh(makeAxisAlignedBoxMesh([20, 20, 20], [0, 0, 12]));
    expect(shouldRetryPrintability(floating, undefined, { importedWrap: true })).toBe(true);

    const a = makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 0]);
    const b = makeAxisAlignedBoxMesh([10, 10, 10], [40, 0, 0]);
    const pip = checkMesh({ triangles: [...a.triangles, ...b.triangles] });
    expect(pip.issues.some((i) => i.code === "disconnected")).toBe(true);
    expect(shouldRetryPrintability(pip)).toBe(true);
    expect(shouldRetryPrintability(pip, undefined, { allowDisconnected: true })).toBe(false);
  });
});
