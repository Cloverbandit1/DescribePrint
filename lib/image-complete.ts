import type { BinaryMask } from "./image-mask";
import type { ImageRaster } from "./image-raster";
import { boundingBoxMm } from "./mesh-check";
import { combineMeshes, sitMeshOnBed } from "./mesh-transform";
import { makeAxisAlignedBoxMesh } from "./stl";
import { shouldCompletePartial, type SubjectMaskFeatures, measureSubjectFeatures } from "./image-subject";
import { WEARABLE_CATEGORY_CHARTS } from "./wearable-sizes";
import type {
  ImageCompletion,
  ImageCompletionProportions,
  ImageCompletionRegion,
  ImageCompletionRegionId,
  ImageFragmentIdentify,
  ImageSubjectClass,
  ImageSubjectIdentify,
  Mesh,
} from "./types";

/** ISO 8559-2 Medium chest / EN 960 Medium head circ — used for invented torso width. */
export const CHEST_TO_HEAD_CIRC = WEARABLE_CATEGORY_CHARTS.torso_armor.sizes.M.chest! / WEARABLE_CATEGORY_CHARTS.helmet_mask.sizes.M.headCirc!;
export const WAIST_TO_CHEST = WEARABLE_CATEGORY_CHARTS.torso_armor.sizes.M.waist! / WEARABLE_CATEGORY_CHARTS.torso_armor.sizes.M.chest!;

export type CompletionLayout = {
  padLeft: number;
  padRight: number;
  padBottom: number;
  headY0: number;
  headY1: number;
  neckY0: number;
  neckY1: number;
  torsoY0: number;
  torsoY1: number;
  cx: number;
  neckWidth: number;
  shoulderWidth: number;
  waistWidth: number;
};

export function noneCompletion(subject: ImageSubjectIdentify): ImageCompletion {
  return {
    applied: false,
    kind: "none",
    subjectClass: subject.class,
    matched: [],
    invented: [],
    regions: [],
    proportions: null,
    note:
      subject.class === "fragment"
        ? "Fragment identify / restore still applies. Match-and-complete did not invent a body."
        : "No match-and-complete body — the plate is the photographed silhouette loaf only.",
    identityAccurate: false,
    photogrammetry: false,
  };
}

export function completionRegions(cls: ImageSubjectClass): ImageCompletionRegion[] {
  const matchedId: ImageCompletionRegionId = cls === "helmet" ? "helmet" : cls === "bust" ? "bust" : "head";
  const matchedLabel = cls === "helmet" ? "helmet" : cls === "bust" ? "bust (head + shoulders)" : "head";
  const matchedNote =
    cls === "bust"
      ? "Matched from the photographed silhouette / loaf (head and visible shoulders)."
      : `Matched from the photographed ${matchedLabel} silhouette / loaf.`;
  return [
    { id: matchedId, label: matchedLabel, origin: "matched", note: matchedNote },
    {
      id: "neck",
      label: "neck",
      origin: "invented",
      note: "Invented parametric neck — not photographed, not identity-accurate.",
    },
    {
      id: "torso",
      label: "torso",
      origin: "invented",
      note: "Invented parametric torso from wearable chest/waist proportions — not photographed, not photogrammetry.",
    },
  ];
}

export function planMatchAndComplete(
  mask: BinaryMask,
  subject: ImageSubjectIdentify,
  opts?: { prompt?: string | null; fragment?: ImageFragmentIdentify | null; cellMm?: number },
): { apply: boolean; layout: CompletionLayout | null; completion: ImageCompletion } {
  if (!shouldCompletePartial(subject, { prompt: opts?.prompt, fragment: opts?.fragment })) {
    return { apply: false, layout: null, completion: noneCompletion(subject) };
  }
  const features = measureSubjectFeatures(mask);
  if (!features) {
    return { apply: false, layout: null, completion: noneCompletion(subject) };
  }
  const layout = layoutForFeatures(mask, features, subject.class);
  return {
    apply: true,
    layout,
    completion: completionFromLayout(subject, layout, opts?.cellMm ?? 1),
  };
}

export function applyMaskCompletion(
  mask: BinaryMask,
  raster: ImageRaster | null,
  layout: CompletionLayout,
): { mask: BinaryMask; raster: ImageRaster | null } {
  const width = mask.width + layout.padLeft + layout.padRight;
  const height = mask.height + layout.padBottom;
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.cells[y * mask.width + x]) {
        cells[y * width + (x + layout.padLeft)] = 1;
      }
    }
  }
  paintInventedBody(cells, width, layout);
  const next: BinaryMask = { width, height, cells };
  return { mask: next, raster: raster ? padRaster(raster, layout, width, height) : null };
}

export function standCompletedFigure(mesh: Mesh): Mesh {
  const standing: Mesh = {
    triangles: mesh.triangles.map((tri) => ({
      normal: [tri.normal[0], tri.normal[2], -tri.normal[1]] as Mesh["triangles"][number]["normal"],
      vertices: tri.vertices.map(([x, y, z]) => [x, z, -y] as [number, number, number]) as Mesh["triangles"][number]["vertices"],
    })),
  };
  return sitMeshOnBed(standing);
}

export function completeExistingSolid(
  mesh: Mesh,
  subject: ImageSubjectIdentify,
  opts?: { prompt?: string | null },
): { mesh: Mesh; completion: ImageCompletion } {
  if (!shouldCompletePartial(subject, { prompt: opts?.prompt ?? "complete the body" })) {
    return { mesh, completion: noneCompletion(subject) };
  }
  const box = boundingBoxMm(mesh);
  const headW = Math.max(box.size[0], 1);
  const headH = Math.max(box.size[1], 1);
  const headD = Math.max(box.size[2], 8);
  const neckH = Math.max(4, headH * 0.22);
  const torsoH = headH * (subject.class === "bust" ? 1.15 : 1.55);
  const shoulderW = headW * CHEST_TO_HEAD_CIRC;
  const waistW = shoulderW * WAIST_TO_CHEST;
  const neckW = headW * 0.42;
  const cx = (box.min[0] + box.max[0]) / 2;
  const z0 = box.min[2];
  const overlap = Math.max(2, headH * 0.06);
  const neck = makeAxisAlignedBoxMesh(
    [neckW, neckH + overlap, headD * 0.92],
    [cx - neckW / 2, box.max[1] - overlap, z0 + headD * 0.04],
  );
  const torso = taperedTorsoMesh({
    topW: shoulderW,
    botW: waistW,
    depth: headD * 1.12,
    height: torsoH,
    origin: [cx - shoulderW / 2, box.max[1] + neckH - overlap * 0.25, z0 - headD * 0.06],
  });
  const combined = sitMeshOnBed(standCompletedFigure(combineMeshes([mesh, neck, torso])));
  const layoutLike = {
    padLeft: 0,
    padRight: 0,
    padBottom: 0,
    headY0: 0,
    headY1: 0,
    neckY0: 0,
    neckY1: 0,
    torsoY0: 0,
    torsoY1: 0,
    cx: 0,
    neckWidth: neckW,
    shoulderWidth: shoulderW,
    waistWidth: waistW,
  };
  const completion = completionFromLayout(subject, layoutLike, 1, {
    headHeightMm: headH,
    neckHeightMm: neckH,
    torsoHeightMm: torsoH,
    shoulderWidthMm: shoulderW,
    waistWidthMm: waistW,
    chestToHeadCirc: CHEST_TO_HEAD_CIRC,
  });
  return { mesh: combined, completion };
}

export function completionNote(completion: ImageCompletion): string {
  if (!completion.applied) return completion.note;
  const matched = completion.regions.filter((r) => r.origin === "matched").map((r) => r.label);
  const invented = completion.regions.filter((r) => r.origin === "invented").map((r) => r.label);
  return `Match-and-complete: photographed ${matched.join(" / ")} kept; invented ${invented.join(" + ")} from wearable neck/torso proportions (chest/head ${completion.proportions?.chestToHeadCirc.toFixed(2) ?? CHEST_TO_HEAD_CIRC.toFixed(2)}). Not identity-accurate and not photogrammetry.`;
}

export function regionLabelsNote(completion: ImageCompletion): string {
  if (!completion.applied || completion.regions.length === 0) return "";
  return `Region labels: ${completion.regions.map((r) => `${r.label} (${r.origin})`).join("; ")}.`;
}

function layoutForFeatures(mask: BinaryMask, features: SubjectMaskFeatures, cls: ImageSubjectClass): CompletionLayout {
  const headH = features.height;
  const headW = features.width;
  const neckRows = Math.max(2, Math.round(headH * 0.22));
  const torsoRows = Math.max(6, Math.round(headH * (cls === "bust" ? 1.15 : 1.55)));
  const neckWidth = Math.max(3, Math.round(features.botWidth * 0.72 || headW * 0.42));
  const shoulderWidth = Math.max(headW + 2, Math.round(headW * CHEST_TO_HEAD_CIRC));
  const waistWidth = Math.max(4, Math.round(shoulderWidth * WAIST_TO_CHEST));
  const neededBelow = neckRows + torsoRows;
  const existingBelow = Math.max(0, mask.height - 1 - features.maxY);
  const padBottom = Math.max(0, neededBelow - existingBelow);
  const extraW = Math.max(0, shoulderWidth - mask.width);
  const padLeft = Math.ceil(extraW / 2);
  const padRight = extraW - padLeft;
  const cx = features.minX + padLeft + headW / 2;
  const headY0 = features.minY;
  const headY1 = features.maxY;
  const neckY0 = features.maxY + 1;
  const neckY1 = neckY0 + neckRows - 1;
  const torsoY0 = neckY1 + 1;
  const torsoY1 = torsoY0 + torsoRows - 1;
  return {
    padLeft,
    padRight,
    padBottom,
    headY0,
    headY1,
    neckY0,
    neckY1,
    torsoY0,
    torsoY1,
    cx,
    neckWidth,
    shoulderWidth,
    waistWidth,
  };
}

function paintInventedBody(cells: Uint8Array, width: number, layout: CompletionLayout) {
  const height = cells.length / width;
  for (let y = layout.neckY0; y <= layout.torsoY1 && y < height; y++) {
    const inNeck = y <= layout.neckY1;
    const t = inNeck ? 0 : (y - layout.torsoY0) / Math.max(1, layout.torsoY1 - layout.torsoY0);
    const half = (inNeck ? layout.neckWidth : lerp(layout.shoulderWidth, layout.waistWidth, smooth(t))) / 2;
    const x0 = Math.max(0, Math.floor(layout.cx - half));
    const x1 = Math.min(width - 1, Math.ceil(layout.cx + half));
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - layout.cx) / Math.max(0.5, half);
      if (nx * nx <= 1.05) cells[y * width + x] = 1;
    }
  }
  // Overlap a collar into the photographed chin so the loaf stays one solid.
  const collarY0 = Math.max(layout.headY1 - 1, layout.headY0);
  for (let y = collarY0; y <= layout.headY1; y++) {
    const half = layout.neckWidth / 2;
    const x0 = Math.max(0, Math.floor(layout.cx - half));
    const x1 = Math.min(width - 1, Math.ceil(layout.cx + half));
    for (let x = x0; x <= x1; x++) cells[y * width + x] = 1;
  }
}

function padRaster(raster: ImageRaster, layout: CompletionLayout, width: number, height: number): ImageRaster {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const si = (y * raster.width + x) * 4;
      const di = (y * width + (x + layout.padLeft)) * 4;
      data[di] = raster.data[si]!;
      data[di + 1] = raster.data[si + 1]!;
      data[di + 2] = raster.data[si + 2]!;
      data[di + 3] = raster.data[si + 3]!;
      if (raster.data[si + 3]! > 16) {
        r += raster.data[si]!;
        g += raster.data[si + 1]!;
        b += raster.data[si + 2]!;
        n++;
      }
    }
  }
  const fill: [number, number, number, number] = n
    ? [Math.round(r / n), Math.round(g / n), Math.round(b / n), 255]
    : [48, 48, 52, 255];
  for (let y = raster.height; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 250;
      data[i + 1] = 250;
      data[i + 2] = 250;
      data[i + 3] = 255;
    }
  }
  for (let y = layout.neckY0; y <= layout.torsoY1 && y < height; y++) {
    const inNeck = y <= layout.neckY1;
    const t = inNeck ? 0 : (y - layout.torsoY0) / Math.max(1, layout.torsoY1 - layout.torsoY0);
    const half = (inNeck ? layout.neckWidth : lerp(layout.shoulderWidth, layout.waistWidth, smooth(t))) / 2;
    const x0 = Math.max(0, Math.floor(layout.cx - half));
    const x1 = Math.min(width - 1, Math.ceil(layout.cx + half));
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = 255;
    }
  }
  return { ...raster, width, height, data };
}

function completionFromLayout(
  subject: ImageSubjectIdentify,
  layout: CompletionLayout,
  cellMm: number,
  override?: ImageCompletionProportions,
): ImageCompletion {
  const regions = completionRegions(subject.class === "none" ? "head" : subject.class);
  const proportions: ImageCompletionProportions = override ?? {
    headHeightMm: Math.max(1, layout.headY1 - layout.headY0 + 1) * cellMm,
    neckHeightMm: Math.max(1, layout.neckY1 - layout.neckY0 + 1) * cellMm,
    torsoHeightMm: Math.max(1, layout.torsoY1 - layout.torsoY0 + 1) * cellMm,
    shoulderWidthMm: layout.shoulderWidth * cellMm,
    waistWidthMm: layout.waistWidth * cellMm,
    chestToHeadCirc: CHEST_TO_HEAD_CIRC,
  };
  return {
    applied: true,
    kind: "match-and-complete",
    subjectClass: subject.class === "none" ? "head" : subject.class,
    matched: regions.filter((r) => r.origin === "matched").map((r) => r.id),
    invented: regions.filter((r) => r.origin === "invented").map((r) => r.id),
    regions,
    proportions,
    note: "",
    identityAccurate: false,
    photogrammetry: false,
  };
}

function taperedTorsoMesh(input: {
  topW: number;
  botW: number;
  depth: number;
  height: number;
  origin: [number, number, number];
}): Mesh {
  const slices = 4;
  const parts: Mesh[] = [];
  for (let i = 0; i < slices; i++) {
    const t0 = i / slices;
    const t1 = (i + 1) / slices;
    const w0 = lerp(input.topW, input.botW, t0);
    const w1 = lerp(input.topW, input.botW, t1);
    const w = Math.max(w0, w1);
    const y0 = input.origin[1] + input.height * t0;
    const h = input.height * (t1 - t0) + 0.2;
    const x = input.origin[0] + (input.topW - w) / 2;
    parts.push(makeAxisAlignedBoxMesh([w, h, input.depth], [x, y0, input.origin[2]]));
  }
  return combineMeshes(parts);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

