import { describe, expect, it } from "vitest";
import { checkMesh } from "@/lib/mesh-check";
import {
  DEFAULT_FILAMENT_COST_PER_KG,
  DEFAULT_INFILL_FACTOR,
  FILAMENT_DENSITY_GCM3,
  aabbVolumeMm3,
  defaultCostPerKgFor,
  densityGcm3For,
  estimatePrint,
  estimatePrintFromReport,
  formatPrintEstimateLine,
  parseCostPerKgMap,
  parseCostPerKgSession,
  serializeCostPerKgMap,
} from "@/lib/machine/print-estimate";
import { defaultPrinter, filamentPreset } from "@/lib/printers";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

describe("print estimate stub", () => {
  it("returns null when there is no mesh or volume", () => {
    expect(estimatePrint({})).toBeNull();
    expect(estimatePrint({ volumeMm3: 0, boundingBoxMm: { size: [0, 0, 0] } })).toBeNull();
    expect(estimatePrint({ mesh: { triangles: [] } })).toBeNull();
    expect(estimatePrintFromReport(null, "pla")).toBeNull();
  });

  it("estimates ballpark grams for a known 20 mm cube", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const report = checkMesh(mesh);
    expect(report.volumeMm3).toBeCloseTo(8000, 4);
    expect(aabbVolumeMm3(report.boundingBoxMm)).toBeCloseTo(8000, 4);

    const fromMesh = estimatePrint({ mesh, material: "pla" });
    const fromReport = estimatePrintFromReport(report, "pla");
    expect(fromMesh).not.toBeNull();
    expect(fromReport).not.toBeNull();
    expect(fromMesh!.assumptions.volumeSource).toBe("mesh");
    expect(fromMesh!.assumptions.solidVolumeMm3).toBeCloseTo(8000, 4);
    expect(fromMesh!.assumptions.infillFactor).toBe(DEFAULT_INFILL_FACTOR);

    const expectedGrams = (8000 * DEFAULT_INFILL_FACTOR * FILAMENT_DENSITY_GCM3.pla) / 1000;
    expect(expectedGrams).toBeCloseTo(1.984, 3);
    expect(fromMesh!.filamentGrams).toBeCloseTo(2, 1);
    expect(fromReport!.filamentGrams).toBeCloseTo(fromMesh!.filamentGrams, 5);
    expect(fromMesh!.filamentMeters).toBeGreaterThan(0);
    expect(fromMesh!.filamentMeters).toBeLessThan(1);
    expect(fromMesh!.costUsd).toBeCloseTo((expectedGrams / 1000) * DEFAULT_FILAMENT_COST_PER_KG.pla, 2);
    expect(fromMesh!.timeMinutes).toBeGreaterThanOrEqual(1);
    expect(fromMesh!.assumptions.stub).toBe(true);
    expect(fromMesh!.assumptions.approximate).toBe(true);
    expect(fromMesh!.assumptions.layerHeightMm).toBe(filamentPreset("pla").layerHeightMm);
    expect(fromMesh!.assumptions.printSpeedMms).toBe(filamentPreset("pla").printSpeedMms);
    expect(fromMesh!.assumptions.nozzleMm).toBe(defaultPrinter().nozzleMm);
  });

  it("falls back to AABB volume when mesh volume is missing", () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [50, 40, 20] as [number, number, number], size: [50, 40, 20] as [number, number, number] };
    const estimate = estimatePrint({ boundingBoxMm: box, material: "pla" });
    expect(estimate).not.toBeNull();
    expect(estimate!.assumptions.volumeSource).toBe("aabb");
    expect(estimate!.assumptions.solidVolumeMm3).toBe(50 * 40 * 20);
    expect(estimate!.filamentGrams).toBeGreaterThan(0);
  });

  it("changes density and cost when the material switches", () => {
    const report = checkMesh(makeAxisAlignedBoxMesh([50, 50, 50]));
    const pla = estimatePrintFromReport(report, "pla");
    const petg = estimatePrintFromReport(report, "petg");
    const pa = estimatePrintFromReport(report, "pa");

    expect(pla).not.toBeNull();
    expect(petg).not.toBeNull();
    expect(pa).not.toBeNull();

    expect(densityGcm3For("pla")).toBe(1.24);
    expect(densityGcm3For("petg")).toBe(1.27);
    expect(densityGcm3For("pa")).toBe(1.14);
    expect(pla!.assumptions.densityGcm3).toBe(1.24);
    expect(petg!.assumptions.densityGcm3).toBe(1.27);
    expect(pla!.assumptions.costPerKg).toBe(20);
    expect(petg!.assumptions.costPerKg).toBe(25);
    expect(pa!.assumptions.costPerKg).toBe(45);

    expect(petg!.filamentGrams).toBeGreaterThan(pla!.filamentGrams);
    expect(pa!.filamentGrams).toBeLessThan(pla!.filamentGrams);
    expect(petg!.costUsd).toBeGreaterThan(pla!.costUsd);
    expect(pa!.costUsd).toBeGreaterThan(pla!.costUsd);

    const tpu = estimatePrintFromReport(report, "tpu");
    expect(tpu).not.toBeNull();
    expect(tpu!.timeMinutes).toBeGreaterThan(pla!.timeMinutes);
    expect(tpu!.assumptions.printSpeedMms).toBeLessThan(pla!.assumptions.printSpeedMms);
  });

  it("uses an explicit $/kg override without touching LAN", () => {
    const report = checkMesh(makeAxisAlignedBoxMesh([40, 40, 40]));
    const cheap = estimatePrintFromReport(report, "pla", { costPerKg: 10 });
    const dear = estimatePrintFromReport(report, "pla", { costPerKg: 40 });
    expect(cheap).not.toBeNull();
    expect(dear).not.toBeNull();
    expect(dear!.costUsd).toBeGreaterThan(cheap!.costUsd);
    expect(dear!.assumptions.costPerKg).toBe(cheap!.assumptions.costPerKg * 4);
    expect(cheap!.assumptions.costPerKg).toBe(10);
  });

  it("formats a compact stub line and round-trips cost session overrides", () => {
    const estimate = estimatePrint({
      volumeMm3: 125_000,
      boundingBoxMm: { size: [50, 50, 50] },
      material: "pla",
    });
    expect(estimate).not.toBeNull();
    expect(formatPrintEstimateLine(estimate!)).toMatch(/^~[\dh m]+ · [\d.]+ g · \$\d+\.\d{2} \(stub\)$/);
    expect(formatPrintEstimateLine(estimate!)).toContain("(stub)");

    expect(parseCostPerKgSession(null, "pla")).toBe(defaultCostPerKgFor("pla"));
    expect(parseCostPerKgSession("not-json", "petg")).toBe(25);
    const raw = serializeCostPerKgMap({ petg: 18, pla: 12 });
    expect(parseCostPerKgMap(raw)).toEqual({ pla: 12, petg: 18 });
    expect(parseCostPerKgSession(raw, "petg")).toBe(18);
    expect(parseCostPerKgSession(raw, "tpu")).toBe(35);
  });

  it("defaults material to PLA / P2S layer height and speed", () => {
    const estimate = estimatePrint({ volumeMm3: 8000, boundingBoxMm: { size: [20, 20, 20] } });
    expect(estimate).not.toBeNull();
    expect(estimate!.assumptions.material).toBe("pla");
    expect(estimate!.assumptions.layerHeightMm).toBe(0.2);
    expect(estimate!.assumptions.printSpeedMms).toBe(filamentPreset("pla").printSpeedMms);
    expect(estimate!.assumptions.note).toMatch(/stub/i);
  });
});
