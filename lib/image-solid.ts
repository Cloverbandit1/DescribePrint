import type { ImageRaster } from "./image-raster";
import type { Mesh, Triangle } from "./types";

export const DEFAULT_IMAGE_TARGET_MAX_MM = 80;
export const MIN_SOLID_THICKNESS_MM = 12;
export const MAX_MASK_EDGE = 96;

export type BinaryMask = {
  width: number;
  height: number;
  cells: Uint8Array;
};

export function inferredSolidThicknessMm(targetMaxMm: number): number {
  const target = Number.isFinite(targetMaxMm) && targetMaxMm > 0 ? targetMaxMm : DEFAULT_IMAGE_TARGET_MAX_MM;
  const fromRatio = target * 0.22;
  const cap = Math.min(48, target * 0.45);
  return clamp(fromRatio, MIN_SOLID_THICKNESS_MM, Math.max(MIN_SOLID_THICKNESS_MM, cap));
}

export function downscaleRaster(raster: ImageRaster, maxEdge = MAX_MASK_EDGE): ImageRaster {
  const longest = Math.max(raster.width, raster.height);
  if (longest <= maxEdge) return raster;
  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * raster.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * raster.width) / width));
      const sy0 = Math.floor((y * raster.height) / height);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * raster.height) / height));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * raster.width + sx) * 4;
          r += raster.data[i]!;
          g += raster.data[i + 1]!;
          b += raster.data[i + 2]!;
          a += raster.data[i + 3]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
      data[o + 3] = Math.round(a / n);
    }
  }
  return { ...raster, width, height, data };
}

export function rasterToMask(raster: ImageRaster): BinaryMask {
  const { width, height, data } = raster;
  const cells = new Uint8Array(width * height);
  let opaque = 0;
  let lumSum = 0;
  let lumMin = 255;
  let lumMax = 0;
  let hasAlpha = false;
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3]!;
    if (a < 250) hasAlpha = true;
    if (a >= 16) {
      opaque++;
      const y = luminance(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
      lumSum += y;
      lumMin = Math.min(lumMin, y);
      lumMax = Math.max(lumMax, y);
    }
  }
  const avgLum = opaque ? lumSum / opaque : 255;
  const contrast = lumMax - lumMin;
  const invert = !hasAlpha && avgLum < 80 && contrast > 40;

  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    const a = data[i * 4 + 3]!;
    if (a < 16) {
      cells[i] = 0;
      continue;
    }
    if (hasAlpha && a < 250) {
      cells[i] = 1;
      continue;
    }
    const y = luminance(r, g, b);
    cells[i] = (invert ? y > 140 : y < 220) ? 1 : 0;
  }

  if (!cells.includes(1)) {
    for (let i = 0; i < width * height; i++) {
      cells[i] = data[i * 4 + 3]! >= 16 ? 1 : 0;
    }
  }
  if (!cells.includes(1)) {
    throw new Error("Could not find a subject in this photo. Use a clearer object-on-background shot.");
  }
  return { width, height, cells };
}

export function repairMask(mask: BinaryMask): BinaryMask {
  return fillInteriorHoles(morphologicalClose(mask, 2));
}

export function countMaskCells(mask: BinaryMask): number {
  let n = 0;
  for (const cell of mask.cells) if (cell) n++;
  return n;
}

export function maskHasInteriorHole(mask: BinaryMask): boolean {
  return countMaskCells(fillInteriorHoles(mask)) > countMaskCells(mask);
}

export function extrudeMaskToSolid(mask: BinaryMask, cellMm: number, thicknessMm: number): Mesh {
  if (cellMm <= 0 || thicknessMm <= 0) {
    throw new Error("Image solid size must be positive.");
  }
  const triangles: Triangle[] = [];
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < mask.width && y < mask.height ? mask.cells[y * mask.width + x] === 1 : false;

  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!at(x, y)) continue;
      const x0 = x * cellMm;
      const y0 = y * cellMm;
      const x1 = x0 + cellMm;
      const y1 = y0 + cellMm;
      const z0 = 0;
      const z1 = thicknessMm;
      // Bottom (z=0, -Z) and top (z=thickness, +Z) — inferred backside is the cap.
      pushQuad(triangles, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1]);
      pushQuad(triangles, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
      if (!at(x, y - 1)) pushQuad(triangles, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      if (!at(x, y + 1)) pushQuad(triangles, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);
      if (!at(x - 1, y)) pushQuad(triangles, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
      if (!at(x + 1, y)) pushQuad(triangles, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
    }
  }

  if (!triangles.length) {
    throw new Error("Photo silhouette produced an empty solid.");
  }
  return { triangles };
}

export function buildImageSolidMesh(
  raster: ImageRaster,
  opts: { targetMaxMm?: number; thicknessMm?: number; repair?: boolean },
): {
  mesh: Mesh;
  mask: BinaryMask;
  repaired: boolean;
  cellMm: number;
  thicknessMm: number;
  targetMaxMm: number;
} {
  const targetMaxMm =
    opts.targetMaxMm && opts.targetMaxMm > 0 ? opts.targetMaxMm : DEFAULT_IMAGE_TARGET_MAX_MM;
  const scaled = downscaleRaster(raster);
  let mask = rasterToMask(scaled);
  const repaired = opts.repair !== false;
  if (repaired) mask = repairMask(mask);
  const longest = Math.max(mask.width, mask.height);
  const cellMm = targetMaxMm / longest;
  const thicknessMm = opts.thicknessMm ?? inferredSolidThicknessMm(targetMaxMm);
  return {
    mesh: extrudeMaskToSolid(mask, cellMm, thicknessMm),
    mask,
    repaired,
    cellMm,
    thicknessMm,
    targetMaxMm,
  };
}

function morphologicalClose(mask: BinaryMask, radius: number): BinaryMask {
  if (radius < 1) return mask;
  let next = padMask(mask, radius, 0);
  for (let i = 0; i < radius; i++) next = dilate(next);
  for (let i = 0; i < radius; i++) next = erode(next);
  return cropMask(next, radius, mask.width, mask.height);
}

function padMask(mask: BinaryMask, pad: number, fill: number): BinaryMask {
  const width = mask.width + pad * 2;
  const height = mask.height + pad * 2;
  const cells = new Uint8Array(width * height);
  if (fill) cells.fill(1);
  for (let y = 0; y < mask.height; y++) {
    cells.set(mask.cells.subarray(y * mask.width, (y + 1) * mask.width), (y + pad) * width + pad);
  }
  return { width, height, cells };
}

function cropMask(mask: BinaryMask, pad: number, width: number, height: number): BinaryMask {
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = (y + pad) * mask.width + pad;
    cells.set(mask.cells.subarray(src, src + width), y * width);
  }
  return { width, height, cells };
}

function dilate(mask: BinaryMask): BinaryMask {
  const cells = new Uint8Array(mask.cells.length);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      cells[y * mask.width + x] = neighborhoodMax(mask, x, y);
    }
  }
  return { ...mask, cells };
}

function erode(mask: BinaryMask): BinaryMask {
  const cells = new Uint8Array(mask.cells.length);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      cells[y * mask.width + x] = neighborhoodMin(mask, x, y);
    }
  }
  return { ...mask, cells };
}

function neighborhoodMax(mask: BinaryMask, x: number, y: number): number {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) continue;
      if (mask.cells[ny * mask.width + nx]) return 1;
    }
  }
  return 0;
}

function neighborhoodMin(mask: BinaryMask, x: number, y: number): number {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) return 0;
      if (!mask.cells[ny * mask.width + nx]) return 0;
    }
  }
  return 1;
}

function fillInteriorHoles(mask: BinaryMask): BinaryMask {
  const exterior = new Uint8Array(mask.cells.length);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return;
    const i = y * mask.width + x;
    if (mask.cells[i] || exterior[i]) return;
    exterior[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < mask.width; x++) {
    push(x, 0);
    push(x, mask.height - 1);
  }
  for (let y = 0; y < mask.height; y++) {
    push(0, y);
    push(mask.width - 1, y);
  }

  while (stack.length) {
    const i = stack.pop()!;
    const x = i % mask.width;
    const y = Math.floor(i / mask.width);
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  const cells = new Uint8Array(mask.cells.length);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = mask.cells[i] || (exterior[i] ? 0 : 1);
  }
  return { ...mask, cells };
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function pushQuad(
  triangles: Triangle[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  normal: [number, number, number],
) {
  triangles.push({ normal, vertices: [a, b, c] }, { normal, vertices: [a, c, d] });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
