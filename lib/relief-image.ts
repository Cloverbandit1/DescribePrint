/**
 * Image-driven emboss / etch — silhouette + optional luminance heightfield.
 *
 * Honest stub: not Style2Fab / neural stylization. A logo or crest PNG/JPG
 * becomes face-local CSG prisms (merged cells) on a named host face.
 */
import { downscaleRaster, rasterToMask, subjectLuminanceField } from "./image-mask";
import { decodeImageRaster, type ImageRaster, type ImageRasterFormat } from "./image-raster";
import { looksLikeImageUpload, validateImageUpload } from "./image-import";

export type ImageReliefKind = "emboss" | "etch";
export type ImageReliefRegion = "front" | "back" | "left" | "right" | "top" | "bottom";

export type FaceRect = { u: number; v: number; du: number; dv: number };

const RELIEF_WORD =
  /\b(emboss(?:ed|ing)?|etch(?:ed|ing)?|engrav(?:e|ed|ing)|recess(?:ed|ing)?|raised|relief|crest|initials?|monogram)\b/i;

/** Keep CSG cube count printable — this is a motif, not a photo loaf. */
export const MAX_IMAGE_RELIEF_EDGE = 20;
export const DEFAULT_IMAGE_RELIEF_FACE_FRAC = 0.42;

export type ImageReliefField = {
  width: number;
  height: number;
  /** 1 = logo ink / subject. Row-major, image origin top-left. */
  cells: number[];
  /** Optional 0–1 height (darker ink → taller). */
  heights?: number[];
  pixelsInferred: boolean;
  format: ImageRasterFormat;
};

export type ImageReliefPrism = FaceRect & {
  /** 0–1 of the relief extent. */
  t: number;
};

const LOGO_FILE =
  /\b(logo|crest|emblem|badge|sigil|seal|insignia|icon|mark)\b/i;
const APPLY_IMAGE =
  /\b(this|uploaded|my|the)\s+(logo|crest|emblem|badge|sigil|image|photo|png|jpg|jpeg|webp)\b/i;
const RELIEF_ON_HOST =
  /\b(emboss|etch|engrav|recess|raised|relief)\b.+\b(on|onto|into)\b|\b(on|onto|into)\s+(?:the\s+)?(?:front|back|left|right|top|bottom|helmet|chest|gauntlet|cube|plaque|plate|cuff)\b/i;

export function looksLikeLogoFileName(fileName?: string | null): boolean {
  if (!fileName) return false;
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return LOGO_FILE.test(base.replace(/[_-]+/g, " "));
}

export function promptHasImageRelief(prompt: string): boolean {
  const text = prompt ?? "";
  return RELIEF_WORD.test(text) || APPLY_IMAGE.test(text);
}

/**
 * True when an uploaded photo should become a face relief instead of a
 * full photo→solid loaf. Requires relief language (or a logo filename
 * plus a host / previous part). Bare photo import stays a loaf.
 */
export function wantsImageRelief(input: {
  prompt?: string | null;
  fileName?: string | null;
  hasPreviousPart?: boolean;
}): boolean {
  const prompt = input.prompt ?? "";
  const logoFile = looksLikeLogoFileName(input.fileName);
  if (promptHasImageRelief(prompt)) {
    return Boolean(input.hasPreviousPart || RELIEF_ON_HOST.test(prompt) || logoFile || /\b(cube|plaque|helmet|chest|gauntlet|bracer)\b/i.test(prompt));
  }
  return Boolean(logoFile && input.hasPreviousPart);
}

export function looksLikeReliefImageUpload(buffer: Buffer, fileName?: string): boolean {
  return looksLikeImageUpload(buffer, fileName);
}

export function decodeImageReliefField(buffer: Buffer, fileName?: string): ImageReliefField {
  validateImageUpload(buffer, fileName);
  const raster = decodeImageRaster(buffer, fileName);
  return rasterToImageReliefField(raster);
}

export function rasterToImageReliefField(raster: ImageRaster, maxEdge = MAX_IMAGE_RELIEF_EDGE): ImageReliefField {
  const small = downscaleRaster(raster, maxEdge);
  const mask = rasterToMask(small);
  const lum =
    small.width === mask.width && small.height === mask.height
      ? subjectLuminanceField(small, mask)
      : null;
  const cells: number[] = [];
  const heights: number[] = [];
  let contrast = 0;
  let minH = 1;
  let maxH = 0;
  for (let i = 0; i < mask.cells.length; i++) {
    const on = mask.cells[i] ? 1 : 0;
    cells.push(on);
    // Darker subject ink sits taller (classic logo stamp). Uniform if flat.
    const h = on && lum ? 1 - lum[i]! : on ? 1 : 0;
    heights.push(h);
    if (on) {
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  }
  contrast = maxH - minH;
  return {
    width: mask.width,
    height: mask.height,
    cells,
    heights: contrast > 0.18 ? heights : undefined,
    pixelsInferred: raster.pixelsInferred,
    format: raster.format,
  };
}

/**
 * Greedy merge of active cells into face-local prisms.
 * +u right, +v up, image y=0 at the top of the upload.
 */
export function imageFieldToPrisms(
  field: ImageReliefField,
  targetWidthMm: number,
  targetHeightMm: number,
): ImageReliefPrism[] {
  const { width, height } = field;
  if (width < 1 || height < 1) return [];
  const cellU = targetWidthMm / width;
  const cellV = targetHeightMm / height;
  const used = new Uint8Array(width * height);
  const prisms: ImageReliefPrism[] = [];
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && field.cells[y * width + x] && !used[y * width + x];
  const heightAt = (x: number, y: number) => field.heights?.[y * width + x] ?? 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!on(x, y)) continue;
      const t0 = heightAt(x, y);
      let w = 1;
      while (on(x + w, y) && Math.abs(heightAt(x + w, y) - t0) < 0.12) w++;
      let h = 1;
      expand: while (y + h < height) {
        for (let dx = 0; dx < w; dx++) {
          if (!on(x + dx, y + h) || Math.abs(heightAt(x + dx, y + h) - t0) >= 0.12) break expand;
        }
        h++;
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          used[(y + dy) * width + (x + dx)] = 1;
        }
      }
      // Image y grows down; face +v grows up. Center the motif on the face.
      const u = (x - width / 2) * cellU;
      const v = (height / 2 - (y + h)) * cellV;
      prisms.push({
        u,
        v,
        du: w * cellU,
        dv: h * cellV,
        t: Math.min(1, Math.max(0.45, t0)),
      });
    }
  }
  return prisms;
}

export function imageReliefFaceMm(
  sizeMm: [number, number, number] | undefined,
  region: ImageReliefRegion,
  frac = DEFAULT_IMAGE_RELIEF_FACE_FRAC,
): { width: number; height: number } {
  const [sx, sy, sz] = sizeMm ?? [40, 30, 8];
  const faceW = region === "left" || region === "right" ? sy : sx;
  const faceH = region === "top" || region === "bottom" ? sy : sz;
  const span = Math.max(8, Math.min(faceW, faceH) * frac);
  const fieldAspect = 1;
  return { width: span, height: span * fieldAspect };
}

export function imageReliefFaceMmForField(
  field: ImageReliefField,
  sizeMm: [number, number, number] | undefined,
  region: ImageReliefRegion,
): { width: number; height: number } {
  const base = imageReliefFaceMm(sizeMm, region);
  const aspect = field.height / Math.max(1, field.width);
  return { width: base.width, height: base.width * aspect };
}

export function formatImageReliefNote(field: ImageReliefField, kind: ImageReliefKind): string {
  const method = field.heights?.length ? "silhouette + luminance heightfield" : "silhouette";
  return `Image ${kind} (${method}, ${field.width}×${field.height} cells). Not Style2Fab / neural.`;
}

export function slimImageReliefForPrompt(field: ImageReliefField): { width: number; height: number; cells: number; heightfield: boolean } {
  return {
    width: field.width,
    height: field.height,
    cells: field.cells.filter(Boolean).length,
    heightfield: Boolean(field.heights?.length),
  };
}

/** Default host when a logo is uploaded without a previous part. */
export function imageReliefHostSizeMm(prompt: string): [number, number, number] {
  const cube = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+cube/i);
  if (cube) {
    const n = Number(cube[1]);
    if (Number.isFinite(n) && n > 0) return [n, n, n];
  }
  if (/\bcube\b/i.test(prompt)) return [20, 20, 20];
  if (/\bhelmet\b/i.test(prompt)) return [96, 108, 64];
  if (/\b(chest|breast)\s*plate\b/i.test(prompt)) return [120, 28, 90];
  if (/\bgauntlet\b/i.test(prompt)) return [70, 90, 45];
  return [40, 24, 8];
}
