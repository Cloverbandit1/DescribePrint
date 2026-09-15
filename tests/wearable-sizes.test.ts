import { describe, expect, it } from "vitest";
import {
  describeWearableSize,
  parseWearableSizeFromPrompt,
  wearableScaleFactor,
  WEARABLE_SIZE_PRESETS,
} from "@/lib/wearable-sizes";

describe("wearable size stubs", () => {
  it("scales S/M/L/XL relative to Medium", () => {
    expect(wearableScaleFactor(null, "M")).toBe(1);
    expect(wearableScaleFactor("M", "L")).toBeCloseTo(1.12);
    expect(wearableScaleFactor("L", "S")).toBeCloseTo(0.88 / 1.12);
    expect(WEARABLE_SIZE_PRESETS.XL.measurementsMm.headCirc).toBe(630);
  });

  it("parses explicit sizes and ignores larger / large hole", () => {
    expect(parseWearableSizeFromPrompt("Apply wearable size L")).toBe("L");
    expect(parseWearableSizeFromPrompt("make it size XL")).toBe("XL");
    expect(parseWearableSizeFromPrompt("medium please")).toBe("M");
    expect(parseWearableSizeFromPrompt("make it larger")).toBeNull();
    expect(parseWearableSizeFromPrompt("add a large hole")).toBeNull();
  });

  it("describes the assumed size including stub measurements", () => {
    expect(describeWearableSize(null)).toMatch(/Medium/);
    expect(describeWearableSize("L")).toMatch(/Large/);
    expect(describeWearableSize("L")).toMatch(/1\.12/);
    expect(describeWearableSize("L")).toMatch(/1060/);
  });
});
