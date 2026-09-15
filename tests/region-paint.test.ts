import { describe, expect, it } from "vitest";
import { colorRegionsFromPrompt, defaultColorRegion } from "@/lib/color-regions";
import {
  applyRegionPaint,
  isRegionPaintOnly,
  looksLikeRegionPaint,
  mergePaintIntoRegions,
  namedColorRegions,
  paintThreeMfObjects,
  parseRegionPaintIntents,
  previewTintHex,
  regionPaintChoicePhrase,
  regionPaintNote,
  regionPaintOptionChips,
  suggestedPaintFollowUp,
} from "@/lib/region-paint";
import { resolveDesignOptions } from "@/lib/design-options";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

const PLAQUE = colorRegionsFromPrompt("red body, black letters");

describe("region paint parse", () => {
  it("reads paint / make-the-X-color follow-ups", () => {
    expect(parseRegionPaintIntents("paint the letters black")).toEqual([
      expect.objectContaining({ name: "letters", color: "black" }),
    ]);
    expect(parseRegionPaintIntents("make the base red")).toEqual([
      expect.objectContaining({ name: "base", color: "red" }),
    ]);
    expect(parseRegionPaintIntents("recolor body #00bcd4")).toEqual([
      expect.objectContaining({ name: "body", hex: "#00bcd4" }),
    ]);
    expect(parseRegionPaintIntents("paint the letters")).toEqual([
      expect.objectContaining({ name: "letters" }),
    ]);
  });

  it("treats paint-only chat as an edit, not a new part", () => {
    expect(isRegionPaintOnly("paint the letters black")).toBe(true);
    expect(isRegionPaintOnly("make the base red")).toBe(true);
    expect(isRegionPaintOnly("make the hole 8 mm")).toBe(false);
    expect(isRegionPaintOnly("red 40mm plaque with black letters")).toBe(false);
    expect(looksLikeRegionPaint("make it multi-color")).toBe(false);
  });
});

describe("apply region paint", () => {
  it("recolors a named body and keeps the other region", () => {
    const painted = applyRegionPaint(PLAQUE, parseRegionPaintIntents("paint the letters white"));
    expect(painted).toHaveLength(2);
    expect(painted.find((region) => region.id === "letters")).toMatchObject({
      colorName: "white",
      colorHex: "#FFFFFF",
    });
    expect(painted.find((region) => region.id === "body")).toMatchObject({
      colorName: "red",
      colorHex: "#FF0000",
    });
  });

  it("maps base → body when the plate has a body region", () => {
    const painted = applyRegionPaint(PLAQUE, parseRegionPaintIntents("make the base blue"));
    expect(painted.find((region) => region.id === "body")).toMatchObject({
      colorName: "blue",
      colorHex: "#2F6FED",
    });
  });

  it("paints a single default object and notes the unsplit limit", () => {
    const painted = applyRegionPaint([defaultColorRegion()], parseRegionPaintIntents("paint the letters black"));
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ name: "letters", colorName: "black" });
    expect(
      regionPaintNote({
        before: [defaultColorRegion()],
        after: colorRegionsFromPrompt("red body, black letters"),
        objectCount: 1,
      }),
    ).toMatch(/single colored object/i);
  });
});

describe("3MF object paint", () => {
  it("rewrites colors and extruder metadata without changing mesh counts", () => {
    const body = makeAxisAlignedBoxMesh([40, 20, 6]);
    const letters = makeAxisAlignedBoxMesh([4, 8, 1.6], [8, 6, 6]);
    const objects = [
      { name: "body", mesh: body, colorHex: "#FF0000", colorName: "red", filament: "pla", extruder: 1 },
      { name: "letters", mesh: letters, colorHex: "#1A1A1A", colorName: "black", filament: "pla", extruder: 2 },
    ];
    const painted = applyRegionPaint(PLAQUE, parseRegionPaintIntents("paint the letters white"));
    const next = paintThreeMfObjects(objects, painted);
    expect(next).toHaveLength(2);
    expect(next[0]?.mesh.triangles.length).toBe(body.triangles.length);
    expect(next[1]).toMatchObject({ name: "letters", colorHex: "#FFFFFF", colorName: "white" });
    expect(next[1]?.extruder).toBeGreaterThanOrEqual(1);
  });
});

describe("merge + preview helpers", () => {
  it("keeps previous named regions on a non-paint follow-up", () => {
    const merged = mergePaintIntoRegions("make it larger", PLAQUE, [defaultColorRegion()]);
    expect(merged.map((region) => region.colorName)).toEqual(["red", "black"]);
  });

  it("tints only a single named color", () => {
    expect(previewTintHex(PLAQUE)).toBeNull();
    expect(previewTintHex(colorRegionsFromPrompt("red body"))).toBe("#FF0000");
    expect(namedColorRegions(PLAQUE)).toHaveLength(2);
    expect(suggestedPaintFollowUp(PLAQUE)).toMatch(/paint the letters/i);
  });
});

describe("paint option chips", () => {
  it("asks for a color when the region is named but unpainted", () => {
    const chips = regionPaintOptionChips({ prompt: "paint the letters", regions: PLAQUE });
    expect(chips.map((chip) => chip.value)).toEqual(
      expect.arrayContaining(["letters:red", "letters:black", "letters:white", "letters:blue"]),
    );
    expect(regionPaintChoicePhrase("letters:black")).toBe("paint the letters black");
  });

  it("does not chip a complete paint phrase", () => {
    expect(regionPaintOptionChips({ prompt: "paint the letters black", regions: PLAQUE })).toEqual([]);
  });

  it("surfaces paint chips from design-options without blocking a cube", () => {
    expect(resolveDesignOptions({ prompt: "20mm cube with 5mm hole" }).needs_user_choice).toBe(false);
    const painted = resolveDesignOptions({
      prompt: "paint the letters",
      colorRegions: PLAQUE,
    });
    expect(painted.options.map((group) => group.id)).toEqual(["region_paint"]);
    expect(painted.options[0]?.options.length).toBeGreaterThan(0);
    expect(
      resolveDesignOptions({ prompt: "make it multi-color" }).options.map((group) => group.id),
    ).toEqual(["color_regions"]);
  });
});
