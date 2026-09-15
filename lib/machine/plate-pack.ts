/**
 * Smart plate-packing stub. Shelf / largest-first layout on the P2S bed.
 * Uses bounding boxes only — does not invent geometry, send LAN, or enqueue.
 */

import { defaultPrinter } from "../printers";
import type { BoundingBoxMm } from "../types";

export type PackPart = {
  id: string;
  widthMm: number;
  depthMm: number;
  heightMm?: number;
};

export type PackPlacement = {
  id: string;
  x: number;
  y: number;
  rotationDeg: number;
};

export type PackPlan = {
  placements: PackPlacement[];
  plateMm: [number, number];
  fitted: boolean;
  message: string;
};

export type PackOptions = {
  /** Bed size. Defaults to `defaultPrinter().buildVolumeMm` (P2S 256×256). */
  plateMm?: [number, number] | [number, number, number];
  /** Inset from each plate edge. Default 2 mm. */
  marginMm?: number;
  /** Gap between packed parts. Default 3 mm. */
  clearanceMm?: number;
  /** Center a single fitting part. Default true. */
  centerSingle?: boolean;
};

export type PackFootprint = {
  id: string;
  x: number;
  y: number;
  widthMm: number;
  depthMm: number;
};

export const DEFAULT_PACK_MARGIN_MM = 2;
export const DEFAULT_PACK_CLEARANCE_MM = 3;
export const PLATE_PACK_NOTE = "Pack plate (stub) · layout only, no send";

const EPS = 1e-6;
const MAX_COPIES = 24;

function finitePositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function plateFromOptions(options: PackOptions): {
  plateW: number;
  plateD: number;
  plateH: number;
  plateMm: [number, number];
} {
  const printer = defaultPrinter();
  const src = options.plateMm ?? printer.buildVolumeMm;
  const plateW = src[0] ?? printer.buildVolumeMm[0];
  const plateD = src[1] ?? printer.buildVolumeMm[1];
  const plateH = src[2] ?? printer.buildVolumeMm[2];
  return { plateW, plateD, plateH, plateMm: [plateW, plateD] };
}

export function placedSize(part: PackPart, rotationDeg: number): { widthMm: number; depthMm: number } {
  return rotationDeg % 180 === 90
    ? { widthMm: part.depthMm, depthMm: part.widthMm }
    : { widthMm: part.widthMm, depthMm: part.depthMm };
}

export function placementFootprint(part: PackPart, placement: PackPlacement): PackFootprint {
  const size = placedSize(part, placement.rotationDeg);
  return {
    id: placement.id,
    x: placement.x,
    y: placement.y,
    widthMm: size.widthMm,
    depthMm: size.depthMm,
  };
}

export function footprintsOverlap(a: PackFootprint, b: PackFootprint, gapMm = 0): boolean {
  return !(
    a.x + a.widthMm + gapMm <= b.x + EPS ||
    b.x + b.widthMm + gapMm <= a.x + EPS ||
    a.y + a.depthMm + gapMm <= b.y + EPS ||
    b.y + b.depthMm + gapMm <= a.y + EPS
  );
}

export function footprintInsidePlate(
  footprint: PackFootprint,
  plateMm: [number, number],
  marginMm = 0,
): boolean {
  return (
    footprint.x + EPS >= marginMm &&
    footprint.y + EPS >= marginMm &&
    footprint.x + footprint.widthMm <= plateMm[0] - marginMm + EPS &&
    footprint.y + footprint.depthMm <= plateMm[1] - marginMm + EPS
  );
}

export function packPartFromSize(
  id: string,
  widthMm: number,
  depthMm: number,
  heightMm?: number,
): PackPart {
  return heightMm == null ? { id, widthMm, depthMm } : { id, widthMm, depthMm, heightMm };
}

export function packPartFromBoundingBox(id: string, box: BoundingBoxMm): PackPart {
  const [widthMm, depthMm, heightMm] = box.size;
  return { id, widthMm, depthMm, heightMm };
}

/** Repeat a footprint for the multi-copy stub. Does not invent new geometry. */
export function copiesOfPart(part: PackPart, count: number): PackPart[] {
  const n = Number.isFinite(count) ? Math.min(MAX_COPIES, Math.max(0, Math.floor(count))) : 0;
  if (n <= 0) return [];
  if (n === 1) return [{ ...part }];
  return Array.from({ length: n }, (_, i) => ({ ...part, id: `${part.id}#${i + 1}` }));
}

export function packOverlays(plan: PackPlan, parts: PackPart[]): PackFootprint[] {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const overlays: PackFootprint[] = [];
  for (const placement of plan.placements) {
    const part = byId.get(placement.id);
    if (!part) continue;
    overlays.push(placementFootprint(part, placement));
  }
  return overlays;
}

function orientations(part: PackPart): Array<{ rotationDeg: number; widthMm: number; depthMm: number }> {
  const zero = { rotationDeg: 0, widthMm: part.widthMm, depthMm: part.depthMm };
  if (Math.abs(part.widthMm - part.depthMm) < EPS) return [zero];
  return [zero, { rotationDeg: 90, widthMm: part.depthMm, depthMm: part.widthMm }];
}

function sortLargestFirst(parts: PackPart[]): PackPart[] {
  return [...parts].sort((a, b) => {
    const area = b.widthMm * b.depthMm - a.widthMm * a.depthMm;
    if (Math.abs(area) > EPS) return area;
    return Math.max(b.widthMm, b.depthMm) - Math.max(a.widthMm, a.depthMm);
  });
}

function wontFitAdvice(part: PackPart, plateW: number, plateD: number, plateH: number, marginMm: number): string {
  const usableW = plateW - 2 * marginMm;
  const usableD = plateD - 2 * marginMm;
  if (finitePositive(part.heightMm) && part.heightMm > plateH + EPS) {
    return `${part.id} is ${part.heightMm} mm tall — taller than the ${plateH} mm P2S volume. Split the part.`;
  }
  const fits0 = part.widthMm <= usableW + EPS && part.depthMm <= usableD + EPS;
  const fits90 = part.depthMm <= usableW + EPS && part.widthMm <= usableD + EPS;
  if (!fits0 && fits90) {
    return `${part.id} (${part.widthMm} × ${part.depthMm} mm) won't fit as-is. Rotate 90° and try again, or split the part.`;
  }
  return `${part.id} (${part.widthMm} × ${part.depthMm} mm) won't fit the ${plateW} × ${plateD} mm P2S plate even after a 90° rotate. Split the part.`;
}

/**
 * Largest-first shelf packer. x/y are the min-corner on the plate (front-left origin).
 * rotationDeg is 0 or 90. Does not move or invent mesh geometry.
 */
export function packPlate(parts: PackPart[], options: PackOptions = {}): PackPlan {
  const { plateW, plateD, plateH, plateMm } = plateFromOptions(options);
  const marginMm = options.marginMm ?? DEFAULT_PACK_MARGIN_MM;
  const clearanceMm = options.clearanceMm ?? DEFAULT_PACK_CLEARANCE_MM;
  const centerSingle = options.centerSingle ?? true;

  if (parts.length === 0) {
    return { placements: [], plateMm, fitted: false, message: "Nothing to pack." };
  }

  const usableW = plateW - 2 * marginMm;
  const usableD = plateD - 2 * marginMm;
  if (usableW <= EPS || usableD <= EPS) {
    return {
      placements: [],
      plateMm,
      fitted: false,
      message: `Plate inset is larger than the ${plateW} × ${plateD} mm P2S bed.`,
    };
  }

  const leftovers: string[] = [];
  const placements: PackPlacement[] = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfDepth = 0;

  const place = (id: string, x: number, y: number, rotationDeg: number, widthMm: number, depthMm: number) => {
    placements.push({ id, x, y, rotationDeg });
    const localX = x - marginMm;
    shelfX = localX + widthMm;
    shelfDepth = Math.max(shelfDepth, depthMm);
  };

  for (const part of sortLargestFirst(parts)) {
    if (!finitePositive(part.widthMm) || !finitePositive(part.depthMm)) {
      leftovers.push(`${part.id} has no usable footprint.`);
      continue;
    }
    if (finitePositive(part.heightMm) && part.heightMm > plateH + EPS) {
      leftovers.push(wontFitAdvice(part, plateW, plateD, plateH, marginMm));
      continue;
    }

    const variants = orientations(part).filter(
      (variant) => variant.widthMm <= usableW + EPS && variant.depthMm <= usableD + EPS,
    );
    if (variants.length === 0) {
      leftovers.push(wontFitAdvice(part, plateW, plateD, plateH, marginMm));
      continue;
    }

    const gapX = shelfX > 0 ? clearanceMm : 0;
    const onShelf = variants.filter(
      (variant) =>
        shelfX + gapX + variant.widthMm <= usableW + EPS &&
        shelfY + variant.depthMm <= usableD + EPS,
    );
    if (onShelf.length > 0) {
      const choice = onShelf[0]!;
      place(part.id, marginMm + shelfX + gapX, marginMm + shelfY, choice.rotationDeg, choice.widthMm, choice.depthMm);
      continue;
    }

    const nextShelfY = shelfDepth > 0 ? shelfY + shelfDepth + clearanceMm : shelfY;
    const onNext = variants.filter((variant) => nextShelfY + variant.depthMm <= usableD + EPS);
    if (onNext.length === 0) {
      leftovers.push(
        `${part.id} won't fit with ${clearanceMm} mm clearance. Try a 90° rotate or split the part.`,
      );
      continue;
    }
    const choice = onNext[0]!;
    shelfX = 0;
    shelfY = nextShelfY;
    shelfDepth = 0;
    place(part.id, marginMm, marginMm + shelfY, choice.rotationDeg, choice.widthMm, choice.depthMm);
  }

  if (centerSingle && leftovers.length === 0 && placements.length === 1 && parts.length === 1) {
    const part = parts[0]!;
    const placement = placements[0]!;
    const size = placedSize(part, placement.rotationDeg);
    placement.x = marginMm + (usableW - size.widthMm) / 2;
    placement.y = marginMm + (usableD - size.depthMm) / 2;
  }

  if (leftovers.length > 0) {
    const packed = placements.length;
    const message =
      packed === 0
        ? leftovers[0]!
        : `Packed ${packed} of ${parts.length}. ${leftovers[0]}`;
    return { placements, plateMm, fitted: false, message };
  }

  const message =
    placements.length === 1
      ? `Placed 1 part on the ${plateW} × ${plateD} mm P2S plate.`
      : `Packed ${placements.length} parts on the ${plateW} × ${plateD} mm P2S plate (${clearanceMm} mm clearance).`;
  return { placements, plateMm, fitted: true, message };
}

export function packPlateFromBoundingBox(
  id: string,
  box: BoundingBoxMm,
  copies = 1,
  options: PackOptions = {},
): { plan: PackPlan; parts: PackPart[] } {
  const parts = copiesOfPart(packPartFromBoundingBox(id, box), copies);
  return { plan: packPlate(parts, options), parts };
}
