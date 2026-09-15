import { describe, expect, it } from "vitest";
import {
  BAMBU_LAB_P2S,
  coolingHintFor,
  defaultPrinter,
  filamentPreset,
  FILAMENT_IDS,
  listFilamentPresets,
  normalizeFilamentId,
  parseMaterialSession,
  printPresetSidecarJson,
  layerHeightMmFromPreset,
  printPresetSummary,
  serializeMaterialSession,
  speedTierFor,
} from "@/lib/printers";

describe("printer profiles (P2S + AMS)", () => {
  it("defaults to the Bambu Lab P2S build volume and 0.4 mm nozzle", () => {
    const printer = defaultPrinter();
    expect(printer).toEqual(BAMBU_LAB_P2S);
    expect(printer.id).toBe("bambu-lab-p2s");
    expect(printer.buildVolumeMm).toEqual([256, 256, 256]);
    expect(printer.nozzleMm).toBe(0.4);
    expect(printer.supportedNozzlesMm).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(printer.filamentDiameterMm).toBe(1.75);
  });

  it("includes AMS 4-slot capability and published temp limits", () => {
    const printer = defaultPrinter();
    expect(printer.ams.slotsPerUnit).toBe(4);
    expect(printer.ams.units).toBe(1);
    expect(printer.ams.maxSlots).toBeGreaterThanOrEqual(4);
    expect(printer.maxNozzleC).toBe(300);
    expect(printer.maxBedC).toBe(110);
    expect(printer.minNozzleC).toBeLessThan(printer.maxNozzleC);
    expect(printer.hasActiveChamberHeat).toBe(false);
  });

  it("ships auto-best tables for PLA, PETG, PA, ABS, and TPU within P2S limits", () => {
    const printer = defaultPrinter();
    expect(FILAMENT_IDS).toEqual(["pla", "petg", "pa", "abs", "tpu"]);
    expect(listFilamentPresets()).toHaveLength(5);
    expect(printer.defaultFilament).toBe("pla");

    for (const id of FILAMENT_IDS) {
      const preset = filamentPreset(id);
      expect(preset.id).toBe(id);
      expect(preset.nozzleC).toBeGreaterThanOrEqual(printer.minNozzleC);
      expect(preset.nozzleC).toBeLessThanOrEqual(printer.maxNozzleC);
      expect(preset.bedC).toBeGreaterThanOrEqual(printer.minBedC);
      expect(preset.bedC).toBeLessThanOrEqual(printer.maxBedC);
      expect(preset.printSpeedMms).toBeGreaterThan(0);
      expect(preset.layerHeightMm).toBeGreaterThan(0);
    }

    expect(filamentPreset("pla").nozzleC).toBe(220);
    expect(filamentPreset("petg").bedC).toBe(70);
    expect(filamentPreset("pa").nozzleC).toBeGreaterThan(filamentPreset("pla").nozzleC);
    expect(filamentPreset("pa").bedC).toBeGreaterThan(filamentPreset("petg").bedC);
    expect(filamentPreset("pa").fanPercent).toBeLessThan(filamentPreset("pla").fanPercent);
    expect(filamentPreset("abs").fanPercent).toBeLessThan(filamentPreset("pla").fanPercent);
    expect(filamentPreset("tpu").printSpeedMms).toBeLessThan(filamentPreset("pla").printSpeedMms);
    expect(filamentPreset("pa").notes).toMatch(/dry|door|enclosure/i);
  });

  it("normalizes common filament names including nylon / PA", () => {
    expect(normalizeFilamentId("PETG")).toBe("petg");
    expect(normalizeFilamentId("flexible TPU")).toBe("tpu");
    expect(normalizeFilamentId("nylon PA6")).toBe("pa");
    expect(normalizeFilamentId("PA-CF")).toBe("pa");
    expect(normalizeFilamentId("unknown")).toBeUndefined();
  });

  it("parses the Machine-panel material session and builds an advisory summary", () => {
    expect(parseMaterialSession(null)).toBe("pla");
    expect(parseMaterialSession("petg")).toBe("petg");
    expect(parseMaterialSession("nylon")).toBe("pa");
    expect(parseMaterialSession("nope")).toBe("pla");
    expect(serializeMaterialSession("pa")).toBe("pa");

    const pa = printPresetSummary("best for PA");
    expect(pa.material).toBe("pa");
    expect(pa.advisory).toBe(true);
    expect(pa.printerId).toBe("bambu-lab-p2s");
    expect(pa.nozzleC).toBe(270);
    expect(pa.bedC).toBe(100);
    expect(pa.speedTier).toBe("slow");
    expect(pa.coolingHint).toMatch(/low fan/i);
    expect(speedTierFor(filamentPreset("pla"))).toBe("fast");
    expect(coolingHintFor(filamentPreset("pla"))).toBe("full cooling");
    expect(printPresetSidecarJson(pa)).toContain('"material": "pa"');
    expect(printPresetSidecarJson(pa)).toContain('"advisory": true');
    expect(layerHeightMmFromPreset("petg")).toBeCloseTo(0.2);
    expect(layerHeightMmFromPreset("unknown")).toBeUndefined();
    expect(layerHeightMmFromPreset(undefined)).toBeUndefined();
  });
});
