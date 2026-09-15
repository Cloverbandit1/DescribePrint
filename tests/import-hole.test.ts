import { describe, expect, it } from "vitest";
import {
  buildImportedMeshWrapper,
  canBuildDeterministicImportWrap,
  defaultThroughAxis,
  diagnoseImportedWrap,
  importedWrapErrors,
  parseImportHoleSpec,
} from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

const cube20 = boundingBoxMm(makeAxisAlignedBoxMesh([20, 20, 20]));
const plate = boundingBoxMm(makeAxisAlignedBoxMesh([40, 20, 10]));
const column = boundingBoxMm(makeAxisAlignedBoxMesh([10, 10, 80]));

describe("import hole spec", () => {
  it("defaults to a through-hole on the largest/stable face", () => {
    expect(defaultThroughAxis([20, 20, 20])).toBe("z");
    expect(defaultThroughAxis([40, 20, 10])).toBe("z");
    expect(defaultThroughAxis([10, 10, 80])).not.toBe("z");

    const spec = parseImportHoleSpec("add an 8 mm hole through the center", cube20);
    expect(spec).not.toBeNull();
    expect(spec!.diameterMm).toBe(8);
    expect(spec!.through).toBe(true);
    expect(spec!.axis).toBe("z");
    expect(spec!.centerMm[0]).toBeCloseTo(10);
    expect(spec!.centerMm[1]).toBeCloseTo(10);
  });

  it("infers axis and offset from the prompt", () => {
    const front = parseImportHoleSpec("add an 8 mm hole through the front, 8 mm from the base", cube20);
    expect(front!.axis).toBe("y");
    expect(front!.through).toBe(true);
    expect(front!.centerMm[2]).toBeCloseTo(8);
    expect(front!.centerMm[0]).toBeCloseTo(10);

    const side = parseImportHoleSpec("8 mm hole through the side", plate);
    expect(side!.axis).toBe("x");

    const blind = parseImportHoleSpec("add a blind 6 mm hole 4 mm deep from the top", cube20);
    expect(blind!.through).toBe(false);
    expect(blind!.diameterMm).toBe(6);
    expect(blind!.depthMm).toBe(4);
    expect(blind!.entryFace).toBe("top");
  });

  it("clamps oversized holes so walls stay printable", () => {
    const spec = parseImportHoleSpec("add a 19 mm hole through the center", cube20);
    expect(spec!.diameterMm).toBeLessThanOrEqual(20 - 3.2);
    expect(spec!.notes.join(" ")).toMatch(/clamped/i);
  });
});

describe("imported-mesh wrap generation", () => {
  it("differences the import with a through-cutter that overshoots", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const spec = parseImportHoleSpec("add an 8 mm hole through the center", cube20)!;
    const code = buildImportedMeshWrapper({ mesh, hole: spec });
    expect(code).toMatch(/import\("imported\.stl"/);
    expect(code).toMatch(/hole_d = 8/);
    expect(code).toMatch(/hole_through = true/);
    expect(code).toMatch(/difference\(\)/);
    expect(code).toMatch(/cylinder\(h = 22, d = hole_d\)/);
    expect(code).toMatch(/translate\(\[10, 10, -1\]\)/);
    const first = code.split("difference()")[1] ?? "";
    expect(first.indexOf("import")).toBeLessThan(first.indexOf("cylinder"));
  });

  it("rotates a front through-hole along Y", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const spec = parseImportHoleSpec("add an 8 mm hole through the front", cube20)!;
    const code = buildImportedMeshWrapper({ mesh, hole: spec });
    expect(code).toMatch(/rotate\(\[-90, 0, 0\]\)/);
    expect(code).toMatch(/cylinder\(h = 22, d = hole_d\)/);
  });

  it("keeps a mounting tab unioned on the bed", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const spec = parseImportHoleSpec("add an 8 mm hole and a tab", cube20)!;
    const code = buildImportedMeshWrapper({ mesh, hole: spec, addTab: true });
    expect(code).toMatch(/union\(\)/);
    expect(code).toMatch(/tab_w = 12/);
    expect(code).toMatch(/cube\(\[tab_w, tab_d, tab_h\]\)/);
  });

  it("uses the engineering wrap for simple holes and pretty-up, not slots/remesh", () => {
    const spec = parseImportHoleSpec("add an 8 mm hole", cube20);
    expect(canBuildDeterministicImportWrap("add an 8 mm hole", spec, false)).toBe(true);
    expect(canBuildDeterministicImportWrap("fillet the edges and add a hole", spec, false)).toBe(true);
    expect(canBuildDeterministicImportWrap("slot the side and remesh", spec, false)).toBe(false);
    expect(canBuildDeterministicImportWrap("etch initials on the front", null, false)).toBe(true);
  });
});

describe("imported-mesh wrap sanitization", () => {
  it("rejects inverted difference, floating cutters, and from-scratch parts", () => {
    expect(diagnoseImportedWrap('difference() { import("imported.stl"); cylinder(h=22, d=8); }').invertedDifference).toBe(
      false,
    );
    expect(diagnoseImportedWrap('difference() { cylinder(h=22, d=8); import("imported.stl"); }').invertedDifference).toBe(
      true,
    );
    expect(diagnoseImportedWrap('union() { import("imported.stl"); cylinder(h=22, d=8); }').floatingCutter).toBe(true);
    expect(diagnoseImportedWrap("cube(20);").fromScratch).toBe(true);

    expect(
      importedWrapErrors('difference() { cylinder(h=22, d=8); import("imported.stl"); }', { requireHoleDifference: true }).join(
        " ",
      ),
    ).toMatch(/inverted/i);
    expect(importedWrapErrors("cube(20);").join(" ")).toMatch(/from-scratch/i);
    expect(
      importedWrapErrors('union() { import("imported.stl"); cylinder(h=8, d=8); }', { requireHoleDifference: true }).join(
        " ",
      ),
    ).toMatch(/floating/i);
  });
});
