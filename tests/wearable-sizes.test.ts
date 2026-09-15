import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEARABLE_CATEGORY,
  WEARABLE_CATEGORY_CHARTS,
  WEARABLE_CATEGORY_IDS,
  WEARABLE_SIZE_IDS,
  describeWearableSize,
  inferWearableCategory,
  parseWearableCategoryFromPrompt,
  parseWearableSizeFromPrompt,
  primaryMeasurementMm,
  wearableScaleFactor,
  wearableSizeRatio,
} from "@/lib/wearable-sizes";

describe("wearable measurement charts", () => {
  it("encodes documented primary measurements for each category", () => {
    expect(primaryMeasurementMm("S", "helmet_mask")).toBe(555);
    expect(primaryMeasurementMm("M", "helmet_mask")).toBe(575);
    expect(primaryMeasurementMm("L", "helmet_mask")).toBe(595);
    expect(primaryMeasurementMm("XL", "helmet_mask")).toBe(615);

    expect(primaryMeasurementMm("M", "torso_armor")).toBe(1000);
    expect(WEARABLE_CATEGORY_CHARTS.torso_armor.sizes.L.waist).toBe(960);

    expect(primaryMeasurementMm("S", "gauntlet")).toBe(178);
    expect(WEARABLE_CATEGORY_CHARTS.gauntlet.sizes.XL.handLength).toBe(204);

    expect(primaryMeasurementMm("M", "bracer")).toBe(165);
    expect(WEARABLE_CATEGORY_CHARTS.bracer.sizes.L.forearm).toBe(290);
  });

  it("keeps every chart monotonic, positive, and Medium-referenced", () => {
    for (const category of WEARABLE_CATEGORY_IDS) {
      const chart = WEARABLE_CATEGORY_CHARTS[category];
      expect(chart.sources.length).toBeGreaterThan(0);
      expect(chart.keys).toContain(chart.primaryKey);
      let previous = 0;
      for (const size of WEARABLE_SIZE_IDS) {
        const primary = primaryMeasurementMm(size, category);
        expect(primary).toBeGreaterThan(previous);
        previous = primary;
        for (const key of chart.keys) {
          const mm = chart.sizes[size][key];
          expect(mm).toBeGreaterThan(0);
        }
      }
      expect(wearableSizeRatio("M", category)).toBe(1);
    }
    expect(DEFAULT_WEARABLE_CATEGORY).toBe("helmet_mask");
  });

  it("scales uniformly from the category primary measurement", () => {
    expect(wearableScaleFactor(null, "M")).toBe(1);
    expect(wearableScaleFactor("M", "L", "helmet_mask")).toBeCloseTo(595 / 575);
    expect(wearableScaleFactor("L", "S", "helmet_mask")).toBeCloseTo(555 / 595);
    expect(wearableScaleFactor("M", "L", "torso_armor")).toBeCloseTo(1.1);
    expect(wearableScaleFactor("M", "XL", "gauntlet")).toBeCloseTo(254 / 203);
    // Re-grade L helmet → L torso against Medium of each chart.
    expect(wearableScaleFactor("L", "L", "helmet_mask", "torso_armor")).toBeCloseTo(1.1 / (595 / 575));
  });

  it("parses explicit sizes and ignores larger / large hole", () => {
    expect(parseWearableSizeFromPrompt("Apply wearable size L")).toBe("L");
    expect(parseWearableSizeFromPrompt("make it size XL")).toBe("XL");
    expect(parseWearableSizeFromPrompt("medium please")).toBe("M");
    expect(parseWearableSizeFromPrompt("make it larger")).toBeNull();
    expect(parseWearableSizeFromPrompt("add a large hole")).toBeNull();
  });

  it("infers category from chat or filename", () => {
    expect(parseWearableCategoryFromPrompt("scale the helmet to size L")).toBe("helmet_mask");
    expect(parseWearableCategoryFromPrompt("torso armor size M")).toBe("torso_armor");
    expect(parseWearableCategoryFromPrompt("gauntlet XL")).toBe("gauntlet");
    expect(parseWearableCategoryFromPrompt("bracer for the left wrist")).toBe("bracer");
    expect(inferWearableCategory("part.stl", "knight_mask.3mf")).toBe("helmet_mask");
    expect(inferWearableCategory("cuirass.stl")).toBe("torso_armor");
    expect(inferWearableCategory("box.stl")).toBe(DEFAULT_WEARABLE_CATEGORY);
  });

  it("describes the assumed size with category and key measurements", () => {
    expect(describeWearableSize(null)).toMatch(/Medium/);
    expect(describeWearableSize(null)).toMatch(/Helmet \/ mask/);
    expect(describeWearableSize(null)).toMatch(/575/);
    expect(describeWearableSize("L", "torso_armor")).toMatch(/Large/);
    expect(describeWearableSize("L", "torso_armor")).toMatch(/Torso armor/);
    expect(describeWearableSize("L", "torso_armor")).toMatch(/1100/);
    expect(describeWearableSize("L", "torso_armor")).toMatch(/960/);
    expect(describeWearableSize("L", "torso_armor")).toMatch(/1\.100/);
  });
});
