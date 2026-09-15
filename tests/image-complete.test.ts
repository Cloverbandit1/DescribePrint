import { describe, expect, it } from "vitest";
import { encodePng } from "@/lib/image-raster";
import { photoPlateHeadline } from "@/lib/image-import";
import { identifyPartialSubject, promptSuggestsCompleteBody } from "@/lib/image-subject";
import { rasterToMask } from "@/lib/image-solid";
import { decodeImageRaster } from "@/lib/image-raster";
import { parseMeshEditIntent } from "@/lib/mesh-edit";
import { runGeneratePipeline, runImageImportPipeline } from "@/lib/pipeline";

function rgba(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(fill(x, y), (y * width + x) * 4);
    }
  }
  return data;
}

/** Head mugshot: oval in the upper two-thirds, slight neck taper, empty chest space. */
function headMugshotPng(width = 36, height = 48): Buffer {
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const cx = (width - 1) / 2;
      const headCy = height * 0.34;
      const rx = width * 0.28;
      const ry = height * 0.22;
      const head = ((x - cx) / rx) ** 2 + ((y - headCy) / ry) ** 2 <= 1;
      const neck =
        y > headCy + ry * 0.55 &&
        y < headCy + ry * 1.15 &&
        Math.abs(x - cx) < rx * 0.38;
      return head || neck ? [42, 36, 32, 255] : [250, 250, 248, 255];
    }),
  );
}

function helmetPartialPng(width = 40, height = 36): Buffer {
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const cx = (width - 1) / 2;
      const cy = height * 0.38;
      const top = y < cy + 2 && ((x - cx) / (width * 0.4)) ** 2 + ((y - cy + 4) / (height * 0.28)) ** 2 <= 1;
      const brim = y >= cy && y <= cy + 5 && Math.abs(x - cx) < width * 0.42;
      return top || brim ? [28, 30, 36, 255] : [252, 252, 252, 255];
    }),
  );
}

function bustPartialPng(width = 40, height = 44): Buffer {
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const cx = (width - 1) / 2;
      const head = ((x - cx) / (width * 0.18)) ** 2 + ((y - height * 0.22) / (height * 0.16)) ** 2 <= 1;
      const shoulders = y > height * 0.38 && y < height * 0.78 && Math.abs(x - cx) < width * 0.42 * (0.55 + 0.45 * ((y - height * 0.38) / (height * 0.4)));
      return head || shoulders ? [40, 34, 30, 255] : [255, 255, 255, 255];
    }),
  );
}

function mugSilhouettePng(width = 32, height = 32): Buffer {
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const cx = (width - 1) / 2;
      const cy = (height - 1) / 2 + 1;
      const rx = width * 0.32;
      const ry = height * 0.36;
      const body = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const handle = x > cx + rx * 0.55 && x < cx + rx * 1.15 && y > cy - ry * 0.35 && y < cy + ry * 0.35;
      const handleHole = x > cx + rx * 0.72 && x < cx + rx * 0.98 && y > cy - ry * 0.18 && y < cy + ry * 0.18;
      const subject = body || (handle && !handleHole);
      return subject ? [36, 36, 40, 255] : [250, 250, 250, 255];
    }),
  );
}

describe("partial subject class", () => {
  it("detects a head mugshot from silhouette heuristics", () => {
    const raster = decodeImageRaster(headMugshotPng(), "portrait.png");
    const subject = identifyPartialSubject(rasterToMask(raster), { fileName: "portrait.png" });
    expect(subject.class).toBe("head");
    expect(subject.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("detects helmet and bust from file name / chat plus shape", () => {
    const helmet = identifyPartialSubject(rasterToMask(decodeImageRaster(helmetPartialPng(), "helmet.png")), {
      fileName: "knight_helmet.png",
    });
    expect(helmet.class).toBe("helmet");

    const bust = identifyPartialSubject(rasterToMask(decodeImageRaster(bustPartialPng(), "bust.png")), {
      fileName: "marble_bust.png",
    });
    expect(bust.class).toBe("bust");
  });

  it("does not call a mug a head", () => {
    const mug = identifyPartialSubject(rasterToMask(decodeImageRaster(mugSilhouettePng(), "mug.png")), {
      fileName: "mug.png",
    });
    expect(mug.class).toBe("none");
  });

  it("reads complete-the-body chat", () => {
    expect(promptSuggestsCompleteBody("complete the body")).toBe(true);
    expect(promptSuggestsCompleteBody("match this head with a torso")).toBe(true);
    expect(promptSuggestsCompleteBody("keep the wear")).toBe(false);
    expect(parseMeshEditIntent("complete the body").kind).toBe("complete-body");
    expect(parseMeshEditIntent("match this head with a torso").kind).toBe("complete-body");
  });
});

describe("match-and-complete solid", () => {
  it("turns a head mugshot into one standing completed figure", async () => {
    const completed = await runImageImportPipeline({
      buffer: headMugshotPng(),
      fileName: "head_mugshot.png",
      options: { repair: true, keepWear: false, targetMaxMm: 80 },
    });
    expect(completed.editMode).toBe("image-import");
    expect(completed.imageImport?.subject.class).toBe("head");
    expect(completed.imageImport?.completion.applied).toBe(true);
    expect(completed.imageImport?.completion.kind).toBe("match-and-complete");
    expect(completed.imageImport?.completion.matched).toContain("head");
    expect(completed.imageImport?.completion.invented).toEqual(["neck", "torso"]);
    expect(completed.imageImport?.completion.identityAccurate).toBe(false);
    expect(completed.imageImport?.completion.photogrammetry).toBe(false);
    expect(completed.imageImport?.photogrammetry).toBe(false);
    expect(completed.code).toMatch(/match_and_complete: yes/);
    expect(completed.code).toMatch(/not identity-accurate/i);
    expect(completed.notes.join(" ")).toMatch(/Match-and-complete/i);
    expect(completed.notes.join(" ")).toMatch(/invented neck \+ torso/i);
    expect(completed.notes.join(" ")).toMatch(/Region labels/i);
    expect(completed.notes.join(" ")).toMatch(/head \(matched\)/i);
    expect(photoPlateHeadline(completed.imageImport)).toMatch(/head matched, body completed/i);
    expect(completed.report.boundingBoxMm.min[2]).toBeCloseTo(0, 5);
    expect(completed.report.boundingBoxMm.size[2]).toBeGreaterThan(80);
    expect(completed.report.volumeMm3).toBeGreaterThan(4000);
    expect(completed.report.issues.some((issue) => issue.code === "disconnected")).toBe(false);
    expect(completed.stlUrl).toMatch(/model\.stl/);
    expect(completed.threemfUrl).toMatch(/model\.3mf/);
  });

  it("completes a helmet filename and a bust silhouette", async () => {
    const helmet = await runImageImportPipeline({
      buffer: helmetPartialPng(),
      fileName: "helmet.png",
      options: { repair: true, keepWear: false, targetMaxMm: 70, prompt: "helmet" },
    });
    expect(helmet.imageImport?.subject.class).toBe("helmet");
    expect(helmet.imageImport?.completion.applied).toBe(true);
    expect(helmet.imageImport?.completion.matched).toContain("helmet");
    expect(photoPlateHeadline(helmet.imageImport)).toMatch(/helmet matched/i);

    const bust = await runImageImportPipeline({
      buffer: bustPartialPng(),
      fileName: "bust.png",
      options: { repair: true, keepWear: false, targetMaxMm: 70 },
    });
    expect(bust.imageImport?.subject.class).toBe("bust");
    expect(bust.imageImport?.completion.applied).toBe(true);
    expect(bust.notes.join(" ")).toMatch(/bust/i);
  });

  it("leaves a mug as a loaf unless chat asks to complete a body", async () => {
    const mug = await runImageImportPipeline({
      buffer: mugSilhouettePng(),
      fileName: "mug.png",
      options: { repair: true, keepWear: false, targetMaxMm: 80 },
    });
    expect(mug.imageImport?.completion.applied).toBe(false);
    expect(mug.imageImport?.subject.class).toBe("none");
    expect(photoPlateHeadline(mug.imageImport)).toMatch(/luminance depth/i);

    const forced = await runImageImportPipeline({
      buffer: mugSilhouettePng(),
      fileName: "mug.png",
      options: { repair: true, keepWear: false, targetMaxMm: 80, prompt: "complete the body" },
    });
    expect(forced.imageImport?.completion.applied).toBe(true);
    expect(forced.notes.join(" ")).toMatch(/invented/i);
  });

  it("still honors keep-wear and wearable size on a completed figure", async () => {
    const imported = await runImageImportPipeline({
      buffer: headMugshotPng(),
      fileName: "head.png",
      options: { repair: true, keepWear: false, targetMaxMm: 80 },
    });
    expect(imported.imageImport?.completion.applied).toBe(true);
    const scaled = await runGeneratePipeline({
      prompt: "Apply wearable size L",
      previousJobId: imported.jobId,
      previousSource: "imported-mesh",
      wearableSize: "L",
      fixture: true,
    });
    expect(scaled.source).toBe("imported-mesh");
    expect(scaled.wearableSize).toBe("L");
    expect(scaled.report.boundingBoxMm.size[2]).toBeGreaterThan(imported.report.boundingBoxMm.size[2]);
    expect(scaled.imageImport?.completion.applied).toBe(true);
  });

  it("completes from chat follow-up when the plate was not auto-completed", async () => {
    const mug = await runImageImportPipeline({
      buffer: mugSilhouettePng(),
      fileName: "mug.png",
      options: { repair: true, keepWear: false, targetMaxMm: 60 },
    });
    expect(mug.imageImport?.completion.applied).toBe(false);
    const completed = await runGeneratePipeline({
      prompt: "match this head with a torso",
      previousJobId: mug.jobId,
      previousSource: "imported-mesh",
      fixture: true,
    });
    expect(completed.imageImport?.completion.applied).toBe(true);
    expect(completed.notes.join(" ")).toMatch(/Match-and-complete/i);
    expect(completed.report.volumeMm3).toBeGreaterThan(mug.report.volumeMm3);
    expect(completed.stlUrl).toBeTruthy();
    expect(completed.threemfUrl).toBeTruthy();
  });
});
