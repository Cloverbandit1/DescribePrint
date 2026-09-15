import { describe, expect, it } from "vitest";
import { parseMeshEditIntent } from "@/lib/mesh-edit";

describe("imported-mesh edit intent", () => {
  it("treats wearable size and scale as transform-only", () => {
    const size = parseMeshEditIntent("Apply wearable size L", "L");
    expect(size.kind).toBe("transform");
    expect(size.wearableSize).toBe("L");
    expect(parseMeshEditIntent("helmet size L").wearableCategory).toBe("helmet_mask");
    expect(parseMeshEditIntent("gauntlet XL").wearableCategory).toBe("gauntlet");

    const bigger = parseMeshEditIntent("make it larger");
    expect(bigger.kind).toBe("transform");
    expect(bigger.scale).toBeCloseTo(1.15);

    const rotate = parseMeshEditIntent("rotate 90 degrees and sit on the plate");
    expect(rotate.kind).toBe("transform");
    expect(rotate.rotateZDeg).toBe(90);
    expect(rotate.sitOnBed).toBe(true);
  });

  it("routes holes and tabs through the OpenSCAD import wrapper", () => {
    const hole = parseMeshEditIntent("add an 8 mm hole through the center");
    expect(hole.kind).toBe("describe-wrapper");
    expect(hole.holeMm).toBe(8);
    expect(hole.notes.join(" ")).toMatch(/partial/i);

    const tab = parseMeshEditIntent("add a mounting tab");
    expect(tab.kind).toBe("describe-wrapper");
    expect(tab.addTab).toBe(true);

    const etch = parseMeshEditIntent("etch initials on the front");
    expect(etch.kind).toBe("describe-wrapper");
    expect(etch.notes.join(" ")).toMatch(/emboss\/etch|partial/i);
  });

  it("starts over when the user wants a new part", () => {
    expect(parseMeshEditIntent("start over with something else").kind).toBe("new-design");
  });
});
