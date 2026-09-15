import {
  applyMaskCompletion,
  noneCompletion,
  planMatchAndComplete,
  standCompletedFigure,
} from "./image-complete";
import {
  identifyFragment,
  restoreFragmentMask,
  withRestoredFragment,
} from "./image-fragment";
import {
  distanceToBackground,
  downscaleRaster,
  MAX_MASK_EDGE,
  rasterToMask,
  subjectLuminanceField,
  type BinaryMask,
} from "./image-mask";
import type { ImageRaster } from "./image-raster";
import { identifyPartialSubject } from "./image-subject";
import { sitMeshOnBed } from "./mesh-transform";
import type { ImageCompletion, ImageFragmentIdentify, ImageSubjectIdentify, Mesh, Triangle } from "./types";

export const DEFAULT_IMAGE_TARGET_MAX_MM = 80;
export const MIN_SOLID_THICKNESS_MM = 12;
export { MAX_MASK_EDGE };

export type { BinaryMask };
export {
  countMaskCells,
  downscaleRaster,
  fillInteriorHoles,
  maskHasInteriorHole,
  rasterToMask,
  repairMask,
} from "./image-mask";

export type HeightField = {
  width: number;
  height: number;
  cellMm: number;
  front: Float64Array;
  back: Float64Array;
  active: Uint8Array;
};

export function inferredSolidThicknessMm(targetMaxMm: number): number {
  const target = Number.isFinite(targetMaxMm) && targetMaxMm > 0 ? targetMaxMm : DEFAULT_IMAGE_TARGET_MAX_MM;
  const fromRatio = target * 0.22;
  const cap = Math.min(48, target * 0.45);
  return clamp(fromRatio, MIN_SOLID_THICKNESS_MM, Math.max(MIN_SOLID_THICKNESS_MM, cap));
}

/** Constant-thickness slab from the #27 stub — kept for comparison tests. */
export function extrudeMaskToSolid(mask: BinaryMask, cellMm: number, thicknessMm: number): Mesh {
  if (cellMm <= 0 || thicknessMm <= 0) {
    throw new Error("Image solid size must be positive.");
  }
  const field = constantHeightField(mask, cellMm, thicknessMm);
  return heightFieldToSolid(field);
}

/**
 * Infer a closed backside: loaf-shaped taper (thick center, thin rim) plus
 * luminance depth on the visible face. Sit-on-bed after build. Not NeRF.
 */
export function inferBacksideHeightField(
  mask: BinaryMask,
  raster: ImageRaster | null,
  cellMm: number,
  thicknessMm: number,
): HeightField {
  if (cellMm <= 0 || thicknessMm <= 0) {
    throw new Error("Image solid size must be positive.");
  }
  const dist = distanceToBackground(mask);
  let maxDist = 0;
  for (let i = 0; i < dist.length; i++) {
    if (mask.cells[i] && dist[i]! > maxDist) maxDist = dist[i]!;
  }
  const lum =
    raster && raster.width === mask.width && raster.height === mask.height
      ? subjectLuminanceField(raster, mask)
      : null;
  const front = new Float64Array(mask.cells.length);
  const back = new Float64Array(mask.cells.length);
  const minWall = Math.max(thicknessMm * 0.32, MIN_SOLID_THICKNESS_MM * 0.45);

  for (let i = 0; i < mask.cells.length; i++) {
    if (!mask.cells[i]) continue;
    const taper = smoothstep(maxDist > 0 ? dist[i]! / maxDist : 1);
    const lum01 = lum ? lum[i]! : 0.5;
    // Brighter subject pixels sit closer to the camera (higher front).
    const frontRound = thicknessMm * (0.58 + 0.42 * taper);
    const frontLum = thicknessMm * 0.16 * (lum01 - 0.5);
    let zFront = frontRound + frontLum;
    // Rounded backside: center sits on the bed; rim rises to close the loaf.
    let zBack = thicknessMm * 0.4 * Math.pow(1 - taper, 1.55);
    if (zFront - zBack < minWall) {
      const mid = (zFront + zBack) / 2;
      zFront = mid + minWall / 2;
      zBack = mid - minWall / 2;
    }
    if (zBack < 0) {
      zFront -= zBack;
      zBack = 0;
    }
    front[i] = zFront;
    back[i] = zBack;
  }

  return {
    width: mask.width,
    height: mask.height,
    cellMm,
    front,
    back,
    active: new Uint8Array(mask.cells),
  };
}

export function heightFieldToSolid(field: HeightField): Mesh {
  const triangles: Triangle[] = [];
  const { width, height, cellMm, front, back, active } = field;
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height ? active[y * width + x] === 1 : false;
  const zf = (x: number, y: number) => front[y * width + x]!;
  const zb = (x: number, y: number) => back[y * width + x]!;
  const eps = Math.max(cellMm * 1e-4, 1e-6);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue;
      const x0 = x * cellMm;
      const y0 = y * cellMm;
      const x1 = x0 + cellMm;
      const y1 = y0 + cellMm;
      const z0 = zb(x, y);
      const z1 = zf(x, y);
      if (z1 - z0 <= eps) continue;
      pushQuad(triangles, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1]);
      pushQuad(triangles, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
      if (!at(x, y - 1)) pushQuad(triangles, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
      if (!at(x, y + 1)) pushQuad(triangles, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);
      if (!at(x - 1, y)) pushQuad(triangles, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
      if (!at(x + 1, y)) pushQuad(triangles, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);

      if (at(x + 1, y)) {
        emitHeightStepX(triangles, x1, y0, y1, z0, z1, zb(x + 1, y), zf(x + 1, y), eps);
      }
      if (at(x, y + 1)) {
        emitHeightStepY(triangles, y1, x0, x1, z0, z1, zb(x, y + 1), zf(x, y + 1), eps);
      }
    }
  }

  if (!triangles.length) {
    throw new Error("Photo silhouette produced an empty solid.");
  }
  return { triangles };
}

export function buildImageSolidMesh(
  raster: ImageRaster,
  opts: {
    targetMaxMm?: number;
    thicknessMm?: number;
    repair?: boolean;
    prompt?: string | null;
    fileName?: string | null;
  },
): {
  mesh: Mesh;
  mask: BinaryMask;
  repaired: boolean;
  cellMm: number;
  thicknessMm: number;
  targetMaxMm: number;
  fragment: ImageFragmentIdentify;
  subject: ImageSubjectIdentify;
  completion: ImageCompletion;
} {
  const targetMaxMm =
    opts.targetMaxMm && opts.targetMaxMm > 0 ? opts.targetMaxMm : DEFAULT_IMAGE_TARGET_MAX_MM;
  const scaled = downscaleRaster(raster);
  const rawMask = rasterToMask(scaled);
  const fragmentSeen = identifyFragment(rawMask, opts.prompt);
  const repaired = opts.repair !== false;
  const mask = repaired ? restoreFragmentMask(rawMask, fragmentSeen) : rawMask;
  const fragment = withRestoredFragment(fragmentSeen, mask, repaired);
  const subject = identifyPartialSubject(mask, {
    prompt: opts.prompt,
    fileName: opts.fileName,
    fragment,
  });
  const planned = planMatchAndComplete(mask, subject, {
    prompt: opts.prompt,
    fragment,
  });
  const longest = Math.max(mask.width, mask.height);
  const cellMm = targetMaxMm / longest;
  let workMask = mask;
  let workRaster: ImageRaster | null = scaled;
  let completion = planned.completion;
  if (planned.apply && planned.layout) {
    const extended = applyMaskCompletion(mask, scaled, planned.layout);
    workMask = extended.mask;
    workRaster = extended.raster;
  } else {
    completion = noneCompletion(subject);
  }
  if (planned.apply && planned.layout) {
    completion = {
      ...completion,
      proportions: completion.proportions
        ? {
            ...completion.proportions,
            headHeightMm: Math.max(1, planned.layout.headY1 - planned.layout.headY0 + 1) * cellMm,
            neckHeightMm: Math.max(1, planned.layout.neckY1 - planned.layout.neckY0 + 1) * cellMm,
            torsoHeightMm: Math.max(1, planned.layout.torsoY1 - planned.layout.torsoY0 + 1) * cellMm,
            shoulderWidthMm: planned.layout.shoulderWidth * cellMm,
            waistWidthMm: planned.layout.waistWidth * cellMm,
          }
        : completion.proportions,
    };
  }
  const thicknessMm = opts.thicknessMm ?? inferredSolidThicknessMm(targetMaxMm);
  const field = inferBacksideHeightField(workMask, workRaster, cellMm, thicknessMm);
  let mesh = sitMeshOnBed(heightFieldToSolid(field));
  if (completion.applied) mesh = standCompletedFigure(mesh);
  return {
    mesh,
    mask: workMask,
    repaired,
    cellMm,
    thicknessMm,
    targetMaxMm,
    fragment,
    subject,
    completion,
  };
}

function constantHeightField(mask: BinaryMask, cellMm: number, thicknessMm: number): HeightField {
  const front = new Float64Array(mask.cells.length);
  const back = new Float64Array(mask.cells.length);
  for (let i = 0; i < mask.cells.length; i++) {
    if (!mask.cells[i]) continue;
    front[i] = thicknessMm;
    back[i] = 0;
  }
  return {
    width: mask.width,
    height: mask.height,
    cellMm,
    front,
    back,
    active: new Uint8Array(mask.cells),
  };
}

function emitHeightStepX(
  triangles: Triangle[],
  x: number,
  y0: number,
  y1: number,
  zBackA: number,
  zFrontA: number,
  zBackB: number,
  zFrontB: number,
  eps: number,
) {
  if (zFrontA > zFrontB + eps) {
    pushQuad(triangles, [x, y0, zFrontB], [x, y1, zFrontB], [x, y1, zFrontA], [x, y0, zFrontA], [1, 0, 0]);
  } else if (zFrontB > zFrontA + eps) {
    pushQuad(triangles, [x, y0, zFrontA], [x, y0, zFrontB], [x, y1, zFrontB], [x, y1, zFrontA], [-1, 0, 0]);
  }
  if (zBackA < zBackB - eps) {
    pushQuad(triangles, [x, y0, zBackA], [x, y1, zBackA], [x, y1, zBackB], [x, y0, zBackB], [1, 0, 0]);
  } else if (zBackB < zBackA - eps) {
    pushQuad(triangles, [x, y0, zBackB], [x, y0, zBackA], [x, y1, zBackA], [x, y1, zBackB], [-1, 0, 0]);
  }
}

function emitHeightStepY(
  triangles: Triangle[],
  y: number,
  x0: number,
  x1: number,
  zBackA: number,
  zFrontA: number,
  zBackB: number,
  zFrontB: number,
  eps: number,
) {
  if (zFrontA > zFrontB + eps) {
    pushQuad(triangles, [x0, y, zFrontB], [x0, y, zFrontA], [x1, y, zFrontA], [x1, y, zFrontB], [0, 1, 0]);
  } else if (zFrontB > zFrontA + eps) {
    pushQuad(triangles, [x0, y, zFrontA], [x1, y, zFrontA], [x1, y, zFrontB], [x0, y, zFrontB], [0, -1, 0]);
  }
  if (zBackA < zBackB - eps) {
    pushQuad(triangles, [x0, y, zBackA], [x1, y, zBackA], [x1, y, zBackB], [x0, y, zBackB], [0, 1, 0]);
  } else if (zBackB < zBackA - eps) {
    pushQuad(triangles, [x0, y, zBackB], [x0, y, zBackA], [x1, y, zBackA], [x1, y, zBackB], [0, -1, 0]);
  }
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
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
