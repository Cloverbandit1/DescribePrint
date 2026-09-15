import { describe, expect, it } from "vitest";
import { encodePng } from "@/lib/image-raster";
import { buildImportedMeshWrapper } from "@/lib/import-hole";
import { boundingBoxMm } from "@/lib/mesh-check";
import {
  attachImageMotif,
  inferCadReliefs,
  standaloneImageReliefScad,
} from "@/lib/relief";
import {
  decodeImageReliefField,
  imageFieldToPrisms,
  looksLikeLogoFileName,
  wantsImageRelief,
} from "@/lib/relief-image";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

function rgba(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(fill(x, y), (y * width + x) * 4);
    }
  }
  return data;
}

function chevronLogoPng(width = 24, height = 24): Buffer {
  return encodePng(
    width,
    height,
    rgba(width, height, (x, y) => {
      const nx = x / (width - 1);
      const ny = y / (height - 1);
      const left = Math.abs(ny - (1 - nx) * 0.55 - 0.2) < 0.1 && nx < 0.55;
      const right = Math.abs(ny - nx * 0.55 - 0.2) < 0.1 && nx > 0.45;
      const subject = left || right;
      return subject ? [20, 20, 24, 255] : [250, 250, 250, 255];
    }),
  );
}

describe("image relief heuristic", () => {
  it("treats a logo filename + previous part as image relief, not a photo loaf", () => {
    expect(looksLikeLogoFileName("house-crest.png")).toBe(true);
    expect(looksLikeLogoFileName("mug.png")).toBe(false);
    expect(
      wantsImageRelief({
        prompt: "emboss this on the back of the helmet",
        fileName: "crest.png",
        hasPreviousPart: true,
      }),
    ).toBe(true);
    expect(
      wantsImageRelief({
        prompt: "",
        fileName: "mug.png",
        hasPreviousPart: false,
      }),
    ).toBe(false);
  });

  it("decodes a chevron logo into merged silhouette prisms", () => {
    const field = decodeImageReliefField(chevronLogoPng(), "logo.png");
    expect(field.width).toBeGreaterThan(4);
    expect(field.cells.some(Boolean)).toBe(true);
    const prisms = imageFieldToPrisms(field, 16, 16);
    expect(prisms.length).toBeGreaterThan(0);
    expect(prisms.length).toBeLessThan(field.cells.filter(Boolean).length);
    expect(prisms.every((prism) => prism.du > 0 && prism.dv > 0)).toBe(true);
  });

  it("wraps an imported cube with image emboss and re-cuts a through-hole", () => {
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const field = decodeImageReliefField(chevronLogoPng(), "logo.png");
    const reliefs = attachImageMotif(
      inferCadReliefs("emboss this logo on the front", boundingBoxMm(mesh).size),
      field,
      "emboss this logo on the front",
      boundingBoxMm(mesh).size,
    );
    expect(reliefs[0]?.motif).toBe("image");
    const code = buildImportedMeshWrapper({
      mesh,
      hole: {
        diameterMm: 5,
        through: true,
        axis: "z",
        centerMm: [10, 10, 10],
        entryFace: "top",
        depthMm: 22,
        overshootMm: 1,
        notes: [],
      },
      reliefs,
      prompt: "emboss this logo on the front",
    });
    expect(code).toMatch(/import\("imported\.stl"/);
    expect(code).toMatch(/relief: emboss image/);
    expect(sanitizeOpenScad(code, { allowImportedMesh: true }).ok).toBe(true);
    const holeIdx = code.lastIndexOf("cylinder");
    const unionIdx = code.indexOf("union()");
    expect(unionIdx).toBeGreaterThan(-1);
    expect(holeIdx).toBeGreaterThan(unionIdx);
  });

  it("emits sanitizable standalone OpenSCAD from the helper", () => {
    const field = decodeImageReliefField(chevronLogoPng(), "logo.png");
    const reliefs = attachImageMotif([], field, "emboss this logo on the front of a 20mm cube", [20, 20, 20]);
    const code = standaloneImageReliefScad(reliefs, [20, 20, 20], "emboss this logo on the front of a 20mm cube");
    expect(sanitizeOpenScad(code).ok).toBe(true);
    expect(code).toMatch(/not Style2Fab/);
    expect(code).toMatch(/cube\(\[/);
    expect(code).not.toMatch(/import\(/);
  });
});
