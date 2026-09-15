import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACK_CLEARANCE_MM,
  DEFAULT_PACK_MARGIN_MM,
  copiesOfPart,
  footprintInsidePlate,
  footprintsOverlap,
  packOverlays,
  packPartFromBoundingBox,
  packPartFromSize,
  packPlate,
  packPlateFromBoundingBox,
  placementFootprint,
} from "@/lib/machine/plate-pack";
import { defaultPrinter } from "@/lib/printers";
import type { BoundingBoxMm } from "@/lib/types";

function box(size: [number, number, number]): BoundingBoxMm {
  return { min: [0, 0, 0], max: size, size };
}

function footprintsFor(parts: ReturnType<typeof packPartFromSize>[], plan: ReturnType<typeof packPlate>) {
  return packOverlays(plan, parts);
}

describe("plate pack stub (P2S)", () => {
  it("uses the P2S build volume by default", () => {
    const printer = defaultPrinter();
    expect(printer.id).toBe("bambu-lab-p2s");
    expect(printer.buildVolumeMm).toEqual([256, 256, 256]);

    const part = packPartFromSize("cube", 20, 20, 20);
    const plan = packPlate([part]);
    expect(plan.plateMm).toEqual([printer.buildVolumeMm[0], printer.buildVolumeMm[1]]);
    expect(plan.fitted).toBe(true);
    expect(plan.placements).toHaveLength(1);
    expect(plan.message).toMatch(/256\s*×\s*256/);
  });

  it("fits a single part on the plate", () => {
    const part = packPartFromBoundingBox("job-1", box([40, 30, 12]));
    const plan = packPlate([part]);
    expect(plan.fitted).toBe(true);
    expect(plan.placements).toEqual([
      expect.objectContaining({ id: "job-1", rotationDeg: 0 }),
    ]);
    const [placement] = plan.placements;
    const footprint = placementFootprint(part, placement!);
    expect(footprintInsidePlate(footprint, plan.plateMm)).toBe(true);
    expect(footprint.widthMm).toBe(40);
    expect(footprint.depthMm).toBe(30);
    expect(placement!.x).toBeGreaterThanOrEqual(DEFAULT_PACK_MARGIN_MM);
    expect(placement!.y).toBeGreaterThanOrEqual(DEFAULT_PACK_MARGIN_MM);
  });

  it("packs two parts without overlap and inside the plate", () => {
    const parts = [packPartFromSize("a", 80, 60, 10), packPartFromSize("b", 70, 50, 8)];
    const plan = packPlate(parts);
    expect(plan.fitted).toBe(true);
    expect(plan.placements).toHaveLength(2);
    expect(new Set(plan.placements.map((row) => row.id))).toEqual(new Set(["a", "b"]));

    const footprints = footprintsFor(parts, plan);
    expect(footprints).toHaveLength(2);
    expect(footprintsOverlap(footprints[0]!, footprints[1]!)).toBe(false);
    expect(footprintsOverlap(footprints[0]!, footprints[1]!, DEFAULT_PACK_CLEARANCE_MM)).toBe(false);
    for (const footprint of footprints) {
      expect(footprintInsidePlate(footprint, plan.plateMm)).toBe(true);
    }
  });

  it("packs N copies of the current AABB without overlap", () => {
    const copies = copiesOfPart(packPartFromSize("mesh", 40, 40, 15), 3);
    expect(copies.map((part) => part.id)).toEqual(["mesh#1", "mesh#2", "mesh#3"]);
    const plan = packPlate(copies);
    expect(plan.fitted).toBe(true);
    expect(plan.placements).toHaveLength(3);
    const footprints = footprintsFor(copies, plan);
    for (let i = 0; i < footprints.length; i += 1) {
      expect(footprintInsidePlate(footprints[i]!, plan.plateMm)).toBe(true);
      for (let j = i + 1; j < footprints.length; j += 1) {
        expect(footprintsOverlap(footprints[i]!, footprints[j]!)).toBe(false);
      }
    }
  });

  it("returns fitted:false for an oversized part with rotate/split advice", () => {
    const part = packPartFromSize("huge", 300, 40, 20);
    const plan = packPlate([part]);
    expect(plan.fitted).toBe(false);
    expect(plan.placements).toHaveLength(0);
    expect(plan.plateMm).toEqual([256, 256]);
    expect(plan.message).toMatch(/won't fit/i);
    expect(plan.message).toMatch(/90°|90 deg|rotate/i);
    expect(plan.message).toMatch(/split/i);
  });

  it("returns fitted:false when height exceeds the P2S volume", () => {
    const part = packPartFromSize("tall", 40, 40, 300);
    const plan = packPlate([part]);
    expect(plan.fitted).toBe(false);
    expect(plan.placements).toHaveLength(0);
    expect(plan.message).toMatch(/taller|split/i);
    expect(plan.message).toMatch(/256/);
  });

  it("rotates 90° when that is the only way a part fits", () => {
    const part = packPartFromSize("strip", 250, 10, 4);
    const plan = packPlate([part], { plateMm: [60, 256], marginMm: 2, centerSingle: false });
    expect(plan.fitted).toBe(true);
    expect(plan.placements[0]?.rotationDeg).toBe(90);
    const footprint = placementFootprint(part, plan.placements[0]!);
    expect(footprint.widthMm).toBe(10);
    expect(footprint.depthMm).toBe(250);
    expect(footprintInsidePlate(footprint, plan.plateMm)).toBe(true);
  });

  it("stays inside the P2S plate with default margin", () => {
    const { plan, parts } = packPlateFromBoundingBox("job", box([200, 180, 20]), 1);
    expect(plan.fitted).toBe(true);
    expect(plan.plateMm).toEqual([256, 256]);
    for (const footprint of packOverlays(plan, parts)) {
      expect(footprintInsidePlate(footprint, plan.plateMm, DEFAULT_PACK_MARGIN_MM)).toBe(true);
    }
  });

  it("does not invent geometry for an empty or invalid part list", () => {
    expect(packPlate([]).fitted).toBe(false);
    expect(packPlate([]).message).toMatch(/nothing/i);
    const invalid = packPlate([packPartFromSize("zero", 0, 20)]);
    expect(invalid.fitted).toBe(false);
    expect(invalid.placements).toHaveLength(0);
  });
});
