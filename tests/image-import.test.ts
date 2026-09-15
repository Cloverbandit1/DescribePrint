import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/import/route";
import { designateMachineForSize, machinesThatFit } from "@/lib/alternate-machines";
import {
  encodeJpeg,
  encodePng,
  encodeWebpStub,
  detectImageFormat,
} from "@/lib/image-raster";
import {
  buildImageSolidFromUpload,
  looksLikeImageUpload,
  parseImageImportOptions,
  validateImageUpload,
  wantsKeepWear,
} from "@/lib/image-import";
import { countMaskCells, maskHasInteriorHole, rasterToMask, repairMask } from "@/lib/image-solid";
import { checkMesh } from "@/lib/mesh-check";
import { runGeneratePipeline, runImageImportPipeline } from "@/lib/pipeline";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";

function rgba(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(fill(x, y), (y * width + x) * 4);
    }
  }
  return data;
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

function crackedBracketPng(): Buffer {
  const width = 28;
  const height = 20;
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const left = x >= 2 && x <= 12 && y >= 3 && y <= 16;
      const right = x >= 14 && x <= 25 && y >= 3 && y <= 16;
      const subject = left || right;
      return subject ? [30, 30, 32, 255] : [255, 255, 255, 255];
    }),
  );
}

function filledSubjectPng(width = 24, height = 16): Buffer {
  return encodePng(width, height, rgba(width, height, () => [24, 24, 28, 255]));
}

function holedPlatePng(): Buffer {
  const width = 24;
  const height = 24;
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const plate = x >= 2 && x <= 21 && y >= 2 && y <= 21;
      const hole = x >= 9 && x <= 14 && y >= 9 && y <= 14;
      return plate && !hole ? [20, 20, 22, 255] : [255, 255, 255, 255];
    }),
  );
}

describe("image upload validation", () => {
  it("accepts png / jpeg / webp and rejects empty or unknown bytes", () => {
    const png = mugSilhouettePng();
    const jpeg = encodeJpeg(16, 16, rgba(16, 16, () => [20, 20, 24, 255]));
    const webp = encodeWebpStub(40, 24);

    expect(detectImageFormat(png, "mug.png")).toBe("png");
    expect(detectImageFormat(jpeg, "mug.jpg")).toBe("jpeg");
    expect(detectImageFormat(webp, "mug.webp")).toBe("webp");
    expect(looksLikeImageUpload(png, "mug.png")).toBe(true);
    expect(looksLikeImageUpload(writeBinaryStl(makeAxisAlignedBoxMesh()), "part.stl")).toBe(false);

    expect(validateImageUpload(png, "mug.png")).toBe("png");
    expect(validateImageUpload(jpeg, "photo.jpeg")).toBe("jpeg");
    expect(validateImageUpload(webp, "shot.webp")).toBe("webp");

    expect(() => validateImageUpload(Buffer.alloc(0), "empty.png")).toThrow(/PNG, JPG, or WebP/i);
    expect(() => validateImageUpload(Buffer.from("not-an-image"), "notes.txt")).toThrow(/PNG, JPG, or WebP/i);
    expect(() => validateImageUpload(Buffer.alloc(12 * 1024 * 1024 + 1), "huge.png")).toThrow(/12 MB/i);
  });

  it("defaults repair on and honors keep-wear overrides", () => {
    expect(parseImageImportOptions({})).toEqual({
      repair: true,
      keepWear: false,
      targetMaxMm: null,
      prompt: null,
    });
    expect(parseImageImportOptions({ repair: "0" }).repair).toBe(false);
    expect(parseImageImportOptions({ keepWear: "1" })).toMatchObject({ repair: false, keepWear: true });
    expect(parseImageImportOptions({ prompt: "keep the wear on this broken bracket" })).toMatchObject({
      repair: false,
      keepWear: true,
    });
    expect(wantsKeepWear("please keep the damage")).toBe(true);
    expect(wantsKeepWear("repair the cracks")).toBe(false);
  });
});

describe("repair-by-default silhouette", () => {
  it("fills interior holes unless keep-wear is on", () => {
    const holed = buildImageSolidFromUpload(holedPlatePng(), "plate.png", {
      repair: true,
      keepWear: false,
      targetMaxMm: 80,
    });
    const worn = buildImageSolidFromUpload(holedPlatePng(), "plate.png", {
      repair: false,
      keepWear: true,
      targetMaxMm: 80,
    });
    expect(holed.repairApplied).toBe(true);
    expect(worn.keepWear).toBe(true);
    expect(holed.mesh.triangles.length).toBeGreaterThan(0);
    expect(worn.mesh.triangles.length).toBeGreaterThan(0);
    expect(checkMesh(holed.mesh).volumeMm3).toBeGreaterThan(checkMesh(worn.mesh).volumeMm3);

    const raw = rasterToMask({
      width: 24,
      height: 24,
      data: rgba(24, 24, (x, y) => {
        const plate = x >= 2 && x <= 21 && y >= 2 && y <= 21;
        const hole = x >= 9 && x <= 14 && y >= 9 && y <= 14;
        return plate && !hole ? [20, 20, 22, 255] : [255, 255, 255, 255];
      }),
      format: "png",
      pixelsInferred: false,
    });
    expect(maskHasInteriorHole(raw)).toBe(true);
    expect(countMaskCells(repairMask(raw))).toBeGreaterThan(countMaskCells(raw));
  });

  it("closes a 2 px crack by default", () => {
    const repaired = buildImageSolidFromUpload(crackedBracketPng(), "bracket.png", {
      repair: true,
      keepWear: false,
      targetMaxMm: 60,
    });
    const worn = buildImageSolidFromUpload(crackedBracketPng(), "bracket.png", {
      repair: false,
      keepWear: true,
      targetMaxMm: 60,
    });
    expect(repaired.notes.join(" ")).toMatch(/Repair-by-default/i);
    expect(worn.notes.join(" ")).toMatch(/Keep damage/i);
    expect(checkMesh(repaired.mesh).issues.some((issue) => issue.code === "disconnected")).toBe(false);
    expect(checkMesh(worn.mesh).issues.some((issue) => issue.code === "disconnected")).toBe(true);
  });
});

describe("photo → printable solid pipeline", () => {
  it("puts a mug photo on the plate as a watertight-ish solid with inferred backside", async () => {
    const result = await runImageImportPipeline({
      buffer: mugSilhouettePng(),
      fileName: "mug.png",
      options: { repair: true, keepWear: false, targetMaxMm: 80 },
    });
    expect(result.source).toBe("imported-mesh");
    expect(result.editMode).toBe("image-import");
    expect(result.imageImport).toMatchObject({
      kind: "image-solid",
      format: "png",
      repairApplied: true,
      keepWear: false,
      inferredBackside: true,
      method: "silhouette-extrude",
      photogrammetry: false,
      neuralReconstruction: false,
    });
    expect(result.code).toMatch(/not photogrammetry \/ NeRF/i);
    expect(result.code).not.toMatch(/neural reconstruction is (done|complete|implemented)/i);
    expect(result.notes.join(" ")).toMatch(/inferred backside/i);
    expect(result.notes.join(" ")).not.toMatch(/neural reconstruction is complete/i);
    expect(result.report.boundingBoxMm.size[0]).toBeGreaterThan(20);
    expect(result.report.boundingBoxMm.size[2]).toBeGreaterThanOrEqual(12);
    expect(result.report.boundingBoxMm.min[2]).toBeCloseTo(0);
    expect(result.report.volumeMm3).toBeGreaterThan(1000);
    expect(result.report.triangleCount).toBeGreaterThan(12);
    expect(result.stlUrl).toMatch(/model\.stl/);
    expect(result.threemfUrl).toMatch(/model\.3mf/);
    expect(result.machineDesignation?.exceedsCurrentPrinter).toBe(false);
  });

  it("accepts jpeg and webp stubs and still exports a solid", async () => {
    const jpeg = await runImageImportPipeline({
      buffer: encodeJpeg(20, 16, rgba(20, 16, (x, y) => (x > 3 && x < 16 && y > 2 && y < 13 ? [10, 10, 12, 255] : [255, 255, 255, 255]))),
      fileName: "part.jpg",
    });
    const webp = await runImageImportPipeline({
      buffer: encodeWebpStub(36, 20),
      fileName: "part.webp",
    });
    expect(jpeg.imageImport?.format).toBe("jpeg");
    expect(jpeg.report.volumeMm3).toBeGreaterThan(0);
    expect(webp.imageImport?.format).toBe("webp");
    expect(webp.imageImport?.pixelsInferred).toBe(true);
    expect(webp.notes.join(" ")).toMatch(/WebP/i);
    expect(webp.report.volumeMm3).toBeGreaterThan(0);
  });

  it("stays on the imported-mesh edit path so hole wraps and size charts still apply", async () => {
    const imported = await runImageImportPipeline({
      buffer: mugSilhouettePng(),
      fileName: "mug.png",
    });
    expect(imported.source).toBe("imported-mesh");
    const scaled = await runGeneratePipeline({
      prompt: "Apply wearable size L",
      previousJobId: imported.jobId,
      previousSource: "imported-mesh",
      wearableSize: "L",
      fixture: true,
    });
    expect(scaled.source).toBe("imported-mesh");
    expect(scaled.editMode).toBe("transform");
    expect(scaled.wearableSize).toBe("L");
    expect(scaled.report.boundingBoxMm.size[0]).toBeGreaterThan(imported.report.boundingBoxMm.size[0]);
  });
});

describe("oversize → machine designation", () => {
  it("reports P2S oversize and designates the smallest stub that fits", () => {
    const designation = designateMachineForSize([280, 40, 20]);
    expect(designation.exceedsCurrentPrinter).toBe(true);
    expect(designation.currentPrinterName).toMatch(/P2S/);
    expect(designation.currentBuildVolumeMm).toEqual([256, 256, 256]);
    expect(designation.oversizedAxes).toEqual(["x"]);
    expect(designation.designatedMachine?.id).toBe("creality-k1-max");
    expect(designation.suggestedMachines.map((machine) => machine.id)).toEqual([
      "creality-k1-max",
      "bambu-lab-h2d",
      "prusa-xl",
    ]);
    expect(designation.message).toMatch(/larger than the current Bambu Lab P2S/i);
    expect(designation.message).toMatch(/Creality K1 Max/i);
    expect(machinesThatFit([400, 40, 20])).toEqual([]);
  });

  it("does not fail the pipeline when the photo solid exceeds the P2S", async () => {
    const result = await runImageImportPipeline({
      buffer: filledSubjectPng(24, 16),
      fileName: "huge-mug.png",
      options: { repair: true, keepWear: false, targetMaxMm: 280 },
    });
    expect(Math.max(...result.report.boundingBoxMm.size)).toBeCloseTo(280);
    expect(result.report.issues.some((issue) => issue.code === "oversized")).toBe(true);
    expect(result.machineDesignation?.exceedsCurrentPrinter).toBe(true);
    expect(result.machineDesignation?.designatedMachine?.id).toBe("creality-k1-max");
    expect(result.notes.join(" ")).toMatch(/Designated stub machine/i);
    expect(result.stlUrl).toBeTruthy();
    expect(result.threemfUrl).toBeTruthy();
  });
});

describe("import API photo path", () => {
  it("rejects a missing file with 400", async () => {
    const response = await POST(
      new Request("http://localhost/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/PNG\/JPG\/WebP|STL, 3MF/i);
  });

  it("imports a PNG through the JSON upload path", async () => {
    const response = await POST(
      new Request("http://localhost/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName: "mug.png",
          bytesBase64: mugSilhouettePng().toString("base64"),
          repair: true,
        }),
      }),
    );
    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toMatch(/image-solid/);
    expect(text).toMatch(/silhouette-extrude/);
    expect(text).not.toMatch(/NeRF is done/i);
  });
});
