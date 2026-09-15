import type { ImageRaster } from "./image-raster";

export const MAX_MASK_EDGE = 96;

export type BinaryMask = {
  width: number;
  height: number;
  cells: Uint8Array;
};

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

export function morphologicalClose(mask: BinaryMask, radius: number): BinaryMask {
  if (radius < 1) return mask;
  let next = padMask(mask, radius, 0);
  for (let i = 0; i < radius; i++) next = dilate(next);
  for (let i = 0; i < radius; i++) next = erode(next);
  return cropMask(next, radius, mask.width, mask.height);
}

export function fillInteriorHoles(mask: BinaryMask): BinaryMask {
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

export function countConnectedComponents(mask: BinaryMask): { count: number; sizes: number[] } {
  const labels = new Int32Array(mask.cells.length);
  const sizes: number[] = [0];
  let count = 0;
  const stack: number[] = [];
  const { width, height, cells } = mask;

  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || labels[i]) continue;
    count++;
    let size = 0;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % width;
      const y = Math.floor(j / width);
      const neighbors = [j - 1, j + 1, j - width, j + width];
      const valid = [
        x > 0,
        x + 1 < width,
        y > 0,
        y + 1 < height,
      ];
      for (let n = 0; n < 4; n++) {
        if (!valid[n]) continue;
        const k = neighbors[n]!;
        if (!cells[k] || labels[k]) continue;
        labels[k] = count;
        stack.push(k);
      }
    }
    sizes[count] = size;
  }
  return { count, sizes };
}

export function labelMaskComponents(mask: BinaryMask): { count: number; labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(mask.cells.length);
  const sizes: number[] = [0];
  let count = 0;
  const stack: number[] = [];
  const { width, height, cells } = mask;

  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || labels[i]) continue;
    count++;
    let size = 0;
    labels[i] = count;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % width;
      const y = Math.floor(j / width);
      if (x > 0 && cells[j - 1] && !labels[j - 1]) {
        labels[j - 1] = count;
        stack.push(j - 1);
      }
      if (x + 1 < width && cells[j + 1] && !labels[j + 1]) {
        labels[j + 1] = count;
        stack.push(j + 1);
      }
      if (y > 0 && cells[j - width] && !labels[j - width]) {
        labels[j - width] = count;
        stack.push(j - width);
      }
      if (y + 1 < height && cells[j + width] && !labels[j + width]) {
        labels[j + width] = count;
        stack.push(j + width);
      }
    }
    sizes[count] = size;
  }
  return { count, labels, sizes };
}

/** Euclidean-ish distance from each subject cell to the nearest background cell. */
export function distanceToBackground(mask: BinaryMask): Float64Array {
  const { width, height, cells } = mask;
  const dist = new Float64Array(cells.length);
  const inf = width + height + 2;
  for (let i = 0; i < cells.length; i++) dist[i] = cells[i] ? inf : 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!cells[i]) continue;
      let d = dist[i]!;
      if (x > 0) d = Math.min(d, dist[i - 1]! + 1);
      if (y > 0) d = Math.min(d, dist[i - width]! + 1);
      if (x > 0 && y > 0) d = Math.min(d, dist[i - width - 1]! + Math.SQRT2);
      if (x + 1 < width && y > 0) d = Math.min(d, dist[i - width + 1]! + Math.SQRT2);
      dist[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!cells[i]) continue;
      let d = dist[i]!;
      if (x + 1 < width) d = Math.min(d, dist[i + 1]! + 1);
      if (y + 1 < height) d = Math.min(d, dist[i + width]! + 1);
      if (x + 1 < width && y + 1 < height) d = Math.min(d, dist[i + width + 1]! + Math.SQRT2);
      if (x > 0 && y + 1 < height) d = Math.min(d, dist[i + width - 1]! + Math.SQRT2);
      dist[i] = d;
    }
  }
  return dist;
}

export function maxDistanceToBackground(mask: BinaryMask): number {
  const dist = distanceToBackground(mask);
  let max = 0;
  for (const d of dist) if (d > max) max = d;
  return max;
}

export function invertMask(mask: BinaryMask): BinaryMask {
  const cells = new Uint8Array(mask.cells.length);
  for (let i = 0; i < cells.length; i++) cells[i] = mask.cells[i] ? 0 : 1;
  return { ...mask, cells };
}

export function subtractMask(positive: BinaryMask, negative: BinaryMask): BinaryMask {
  if (positive.width !== negative.width || positive.height !== negative.height) {
    throw new Error("Mask sizes must match.");
  }
  const cells = new Uint8Array(positive.cells.length);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = positive.cells[i] && !negative.cells[i] ? 1 : 0;
  }
  return { width: positive.width, height: positive.height, cells };
}

/** Fill every cell whose center lies in the convex hull of the occupied cells. */
export function convexHullFill(mask: BinaryMask): BinaryMask {
  const points: Array<[number, number]> = [];
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.cells[y * mask.width + x]) continue;
      points.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }
  }
  const hull = convexHull(points);
  if (hull.length < 3) return { width: mask.width, height: mask.height, cells: new Uint8Array(mask.cells) };

  const cells = new Uint8Array(mask.cells.length);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (pointInConvex([x + 0.5, y + 0.5], hull)) {
        cells[y * mask.width + x] = 1;
      }
    }
  }
  if (!cells.includes(1)) {
    return { width: mask.width, height: mask.height, cells: new Uint8Array(mask.cells) };
  }
  return { width: mask.width, height: mask.height, cells };
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function subjectLuminanceField(raster: ImageRaster, mask: BinaryMask): Float64Array {
  if (raster.width !== mask.width || raster.height !== mask.height) {
    throw new Error("Luminance field needs a raster aligned with the mask.");
  }
  const field = new Float64Array(mask.cells.length);
  let min = 255;
  let max = 0;
  for (let i = 0; i < mask.cells.length; i++) {
    if (!mask.cells[i]) continue;
    const y = luminance(raster.data[i * 4]!, raster.data[i * 4 + 1]!, raster.data[i * 4 + 2]!);
    field[i] = y;
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  const span = Math.max(1, max - min);
  for (let i = 0; i < field.length; i++) {
    if (!mask.cells[i]) continue;
    field[i] = (field[i]! - min) / span;
  }
  return field;
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

function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length <= 2) return points.slice();
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function cross(o: [number, number], a: [number, number], b: [number, number]): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function pointInConvex(p: [number, number], hull: Array<[number, number]>): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    if (cross(a, b, p) < -1e-9) return false;
  }
  return true;
}
