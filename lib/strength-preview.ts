/**
 * Heuristic strength preview — not FEA / MechStyle.
 *
 * After mesh-check, score likely weak regions from local thickness,
 * sharp concave edges, overhangs vs the build plate, and tiny slices.
 * Cool→hot overlay + short report notes. In-app only.
 */
import { printRules, type PrintRules } from "./printability";
import type { Mesh, StrengthPreview, StrengthPreviewIssue, StrengthPreviewKind, Triangle } from "./types";

export const STRENGTH_PREVIEW_KINDS = [
  "thin-wall",
  "stress-concentration",
  "overhang",
  "tiny-section",
] as const;

export type { StrengthPreview, StrengthPreviewIssue, StrengthPreviewKind };

export const STRENGTH_PREVIEW_DISCLAIMER =
  "Heuristic strength preview — not FEA. Colors flag likely thin walls, sharp concave corners, overhangs, and tiny sections.";

/** FDM support rule-of-thumb vs +Z build direction. */
export const OVERHANG_FROM_VERTICAL_DEG = 45;
const WELD_EPS = 1e-4;
const RAY_EPS = 1e-4;
const CONCAVE_EPS = 1e-5;
const MAX_RAY_TRIANGLES = 6_000;
const ISSUE_SCORE = 0.34;
const MAX_ISSUES = 5;

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize(a: Vec3): Vec3 {
  const n = length(a);
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

export function triangleCentroid(tri: Triangle): Vec3 {
  const [a, b, c] = tri.vertices;
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

export function triangleUnitNormal(tri: Triangle): Vec3 {
  const [a, b, c] = tri.vertices;
  const n = normalize(cross(sub(b, a), sub(c, a)));
  if (length(n) > 0.2) return n;
  const stored = tri.normal;
  const sn = length(stored);
  return sn > 1e-9 ? [stored[0] / sn, stored[1] / sn, stored[2] / sn] : [0, 0, 1];
}

export function emptyStrengthPreview(triangleCount = 0): StrengthPreview {
  return {
    method: "heuristic",
    fea: false,
    disclaimer: STRENGTH_PREVIEW_DISCLAIMER,
    triangleCount,
    maxScore: 0,
    meanScore: 0,
    issues: [],
    triangleScores: Array.from({ length: triangleCount }, () => 0),
  };
}

export function thicknessScoreFromMm(thicknessMm: number, rules: PrintRules = printRules()): number {
  if (!Number.isFinite(thicknessMm)) return 0;
  if (thicknessMm <= rules.minFeatureMm) return 1;
  if (thicknessMm >= rules.minWallMm * 2) return 0;
  if (thicknessMm <= rules.minWallMm) {
    return 0.55 + (0.45 * (rules.minWallMm - thicknessMm)) / Math.max(rules.minWallMm - rules.minFeatureMm, 0.2);
  }
  return (0.55 * (rules.minWallMm * 2 - thicknessMm)) / rules.minWallMm;
}

/** 0 = vertical wall, 90 = horizontal ceiling. Supported bed faces should be filtered by the caller. */
export function overhangFromVerticalDeg(normal: Vec3): number {
  if (normal[2] >= 0) return 0;
  return (Math.asin(Math.min(1, Math.max(0, -normal[2]))) * 180) / Math.PI;
}

export function overhangScoreFromNormal(normal: Vec3, onBed: boolean): number {
  if (onBed) return 0;
  const fromVertical = overhangFromVerticalDeg(normal);
  if (fromVertical < OVERHANG_FROM_VERTICAL_DEG) return 0;
  return Math.min(1, (fromVertical - OVERHANG_FROM_VERTICAL_DEG) / (90 - OVERHANG_FROM_VERTICAL_DEG));
}

export function heatmapRgb(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const stops: Array<[number, Vec3]> = [
    [0, [0.18, 0.42, 0.75]],
    [0.25, [0.2, 0.72, 0.72]],
    [0.5, [0.35, 0.78, 0.35]],
    [0.75, [0.95, 0.78, 0.2]],
    [1, [0.9, 0.22, 0.2]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const u = (x - t0) / Math.max(t1 - t0, 1e-9);
      return [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
    }
  }
  return stops[stops.length - 1][1];
}

/** Cool→hot sRGB stops for a legend bar. */
export function heatmapLegendStops(): Array<{ t: number; hex: string }> {
  return [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const [r, g, b] = heatmapRgb(t);
    const hex = `#${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
    return { t, hex };
  });
}

function weldKey(v: Vec3, scale: number): string {
  return `${Math.round(v[0] / scale)},${Math.round(v[1] / scale)},${Math.round(v[2] / scale)}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

type Welded = {
  triangles: [number, number, number][];
  edges: Map<string, number[]>;
};

function weldMesh(mesh: Mesh): Welded {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of mesh.triangles) {
    for (const v of tri.vertices) {
      min = [Math.min(min[0], v[0]), Math.min(min[1], v[1]), Math.min(min[2], v[2])];
      max = [Math.max(max[0], v[0]), Math.max(max[1], v[1]), Math.max(max[2], v[2])];
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const scale = Math.max(diag * 1e-7, WELD_EPS);
  const ids = new Map<string, number>();
  let next = 0;
  const indexOf = (v: Vec3) => {
    const key = weldKey(v, scale);
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const id = next++;
    ids.set(key, id);
    return id;
  };

  const triangles: [number, number, number][] = [];
  const edges = new Map<string, number[]>();
  for (const tri of mesh.triangles) {
    const i0 = indexOf(tri.vertices[0]);
    const i1 = indexOf(tri.vertices[1]);
    const i2 = indexOf(tri.vertices[2]);
    if (i0 === i1 || i1 === i2 || i2 === i0) {
      triangles.push([-1, -1, -1]);
      continue;
    }
    const local = triangles.length;
    triangles.push([i0, i1, i2]);
    for (const key of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
      const list = edges.get(key);
      if (list) list.push(local);
      else edges.set(key, [local]);
    }
  }
  return { triangles, edges };
}

/** True when the dihedral folds inward (notch / hole rim), using outward normals. */
export function isConcaveDihedral(a: Triangle, b: Triangle): boolean {
  const nA = triangleUnitNormal(a);
  const cA = triangleCentroid(a);
  const cB = triangleCentroid(b);
  return dot(nA, sub(cB, cA)) > CONCAVE_EPS;
}

function rayTriangleHit(origin: Vec3, dir: Vec3, tri: Triangle): number | null {
  const [v0, v1, v2] = tri.vertices;
  const e1 = sub(v1, v0);
  const e2 = sub(v2, v0);
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-10) return null;
  const inv = 1 / det;
  const tvec = sub(origin, v0);
  const u = dot(tvec, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(tvec, e1);
  const v = dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, q) * inv;
  return t > RAY_EPS ? t : null;
}

function localThicknessRays(mesh: Mesh, centroids: Vec3[], normals: Vec3[]): number[] {
  const n = mesh.triangles.length;
  const out = Array.from({ length: n }, () => Infinity);
  if (n === 0 || n > MAX_RAY_TRIANGLES) return out;
  for (let i = 0; i < n; i++) {
    const inward = scale(normals[i], -1);
    if (length(inward) < 0.2) continue;
    const origin = add(centroids[i], scale(inward, RAY_EPS * 8));
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (dot(normals[i], normals[j]) > -0.05) continue;
      const t = rayTriangleHit(origin, inward, mesh.triangles[j]);
      if (t !== null && t < best) best = t;
    }
    out[i] = best;
  }
  return out;
}

type SliceInfo = {
  widths: number[];
  hasHole: boolean[];
};

function axisComponents(v: Vec3, axis: number): [number, number, number] {
  if (axis === 0) return [v[0], v[1], v[2]];
  if (axis === 1) return [v[1], v[0], v[2]];
  return [v[2], v[0], v[1]];
}

function markAabb(grid: Uint8Array, cols: number, rows: number, u0: number, v0: number, u1: number, v1: number) {
  const c0 = Math.max(0, Math.min(cols - 1, u0));
  const c1 = Math.max(0, Math.min(cols - 1, u1));
  const r0 = Math.max(0, Math.min(rows - 1, v0));
  const r1 = Math.max(0, Math.min(rows - 1, v1));
  for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) {
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
      grid[r * cols + c] = 1;
    }
  }
}

function minRunAndHole(grid: Uint8Array, cols: number, rows: number, cell: number): { width: number; hole: boolean } {
  let minRun = Infinity;
  let hole = false;
  const consider = (run: number) => {
    if (run > 0) minRun = Math.min(minRun, run);
  };

  for (let r = 0; r < rows; r++) {
    let run = 0;
    let seenSolid = false;
    let seenEmpty = false;
    let seenAgain = false;
    for (let c = 0; c <= cols; c++) {
      const on = c < cols && grid[r * cols + c] === 1;
      if (on) {
        run++;
        if (seenSolid && seenEmpty) seenAgain = true;
        seenSolid = true;
      } else {
        consider(run);
        run = 0;
        if (seenSolid) seenEmpty = true;
      }
    }
    if (seenAgain) hole = true;
  }

  for (let c = 0; c < cols; c++) {
    let run = 0;
    let seenSolid = false;
    let seenEmpty = false;
    let seenAgain = false;
    for (let r = 0; r <= rows; r++) {
      const on = r < rows && grid[r * cols + c] === 1;
      if (on) {
        run++;
        if (seenSolid && seenEmpty) seenAgain = true;
        seenSolid = true;
      } else {
        consider(run);
        run = 0;
        if (seenSolid) seenEmpty = true;
      }
    }
    if (seenAgain) hole = true;
  }

  return { width: Number.isFinite(minRun) ? minRun * cell : Infinity, hole };
}

function sliceInfoForAxis(mesh: Mesh, centroids: Vec3[], axis: number, cell: number): SliceInfo {
  const bins = 10;
  const values = centroids.map((c) => axisComponents(c, axis)[0]);
  let minA = Infinity;
  let maxA = -Infinity;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < mesh.triangles.length; i++) {
    for (const vertex of mesh.triangles[i].vertices) {
      const [a, u, v] = axisComponents(vertex, axis);
      minA = Math.min(minA, a);
      maxA = Math.max(maxA, a);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const spanA = Math.max(maxA - minA, cell);
  const spanU = Math.max(maxU - minU, cell);
  const spanV = Math.max(maxV - minV, cell);
  const cols = Math.max(4, Math.ceil(spanU / cell) + 1);
  const rows = Math.max(4, Math.ceil(spanV / cell) + 1);
  const widths = Array.from({ length: bins }, () => Infinity);
  const hasHole = Array.from({ length: bins }, () => false);

  for (let b = 0; b < bins; b++) {
    const lo = minA + (spanA * b) / bins;
    const hi = minA + (spanA * (b + 1)) / bins;
    const grid = new Uint8Array(cols * rows);
    let marked = false;
    for (let i = 0; i < mesh.triangles.length; i++) {
      if (values[i] < lo - cell || values[i] > hi + cell) continue;
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (const vertex of mesh.triangles[i].vertices) {
        const [, u, v] = axisComponents(vertex, axis);
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      marked = true;
      markAabb(
        grid,
        cols,
        rows,
        Math.floor((u0 - minU) / cell),
        Math.floor((v0 - minV) / cell),
        Math.floor((u1 - minU) / cell),
        Math.floor((v1 - minV) / cell),
      );
    }
    if (!marked) continue;
    const { width, hole } = minRunAndHole(grid, cols, rows, cell);
    widths[b] = width;
    hasHole[b] = hole;
  }

  return { widths, hasHole };
}

function triangleSliceWidth(centroid: Vec3, axis: number, minA: number, spanA: number, info: SliceInfo): number {
  const a = axisComponents(centroid, axis)[0];
  const t = spanA <= 1e-9 ? 0 : (a - minA) / spanA;
  const bin = Math.min(info.widths.length - 1, Math.max(0, Math.floor(t * info.widths.length)));
  return info.widths[bin] ?? Infinity;
}

function triangleSliceHole(centroid: Vec3, axis: number, minA: number, spanA: number, info: SliceInfo): boolean {
  const a = axisComponents(centroid, axis)[0];
  const t = spanA <= 1e-9 ? 0 : (a - minA) / spanA;
  const bin = Math.min(info.hasHole.length - 1, Math.max(0, Math.floor(t * info.hasHole.length)));
  return Boolean(info.hasHole[bin]);
}

function boundsOf(mesh: Mesh): { min: Vec3; max: Vec3; size: Vec3 } {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of mesh.triangles) {
    for (const v of tri.vertices) {
      min = [Math.min(min[0], v[0]), Math.min(min[1], v[1]), Math.min(min[2], v[2])];
      max = [Math.max(max[0], v[0]), Math.max(max[1], v[1]), Math.max(max[2], v[2])];
    }
  }
  if (!Number.isFinite(min[0])) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

function formatMm(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function issueMessage(
  kind: StrengthPreviewKind,
  thicknessMm: number | undefined,
  nearHole: boolean,
  overhangDeg?: number,
): string {
  const hole = nearHole ? " near hole" : "";
  if (kind === "thin-wall") {
    return thicknessMm !== undefined && Number.isFinite(thicknessMm)
      ? `thin wall ~${formatMm(thicknessMm)} mm${hole}`
      : `thin wall${hole}`;
  }
  if (kind === "stress-concentration") {
    return `sharp concave edge (stress concentration)${hole || " / notch"}`;
  }
  if (kind === "overhang") {
    const deg = overhangDeg !== undefined ? ` ~${Math.round(overhangDeg)}°` : "";
    return `overhang${deg} vs the build plate`;
  }
  return thicknessMm !== undefined && Number.isFinite(thicknessMm)
    ? `tiny cross-section ~${formatMm(thicknessMm)} mm${hole}`
    : `tiny cross-section${hole}`;
}

export function previewStrength(mesh: Mesh, rules: PrintRules = printRules()): StrengthPreview {
  const n = mesh.triangles.length;
  if (n === 0) return emptyStrengthPreview(0);

  if (n > 20_000) {
    const box = boundsOf(mesh);
    const fallbackMm = Math.min(...box.size.filter((dim) => dim > 0.05), Infinity);
    const triangleScores = mesh.triangles.map((tri) => {
      const onBed = Math.min(...tri.vertices.map((v) => v[2])) <= box.min[2] + 0.45 && box.min[2] <= 0.45;
      return Math.min(1, Math.max(thicknessScoreFromMm(fallbackMm, rules) * 0.9, overhangScoreFromNormal(triangleUnitNormal(tri), onBed) * 0.75));
    });
    const maxScore = triangleScores.reduce((m, s) => Math.max(m, s), 0);
    return {
      method: "heuristic",
      fea: false,
      disclaimer: STRENGTH_PREVIEW_DISCLAIMER,
      triangleCount: n,
      maxScore,
      meanScore: triangleScores.reduce((s, v) => s + v, 0) / n,
      issues:
        maxScore >= ISSUE_SCORE
          ? [
              {
                kind: fallbackMm < rules.minWallMm ? "thin-wall" : "overhang",
                message:
                  fallbackMm < rules.minWallMm
                    ? `thin wall ~${formatMm(fallbackMm)} mm`
                    : "overhang vs the build plate",
                score: maxScore,
                thicknessMm: Number.isFinite(fallbackMm) ? fallbackMm : undefined,
                positionMm: triangleCentroid(mesh.triangles[0]),
              },
            ]
          : [],
      triangleScores,
    };
  }

  const centroids = mesh.triangles.map(triangleCentroid);
  const normals = mesh.triangles.map(triangleUnitNormal);
  const box = boundsOf(mesh);
  const cell = Math.max(0.4, Math.min(rules.minFeatureMm * 0.5, 0.8));
  const rays = localThicknessRays(mesh, centroids, normals);
  const slices = [0, 1, 2].map((axis) => sliceInfoForAxis(mesh, centroids, axis, cell));
  const axisSpan = [0, 1, 2].map((axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of centroids) {
      const a = axisComponents(c, axis)[0];
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    return { minA: lo, spanA: Math.max(hi - lo, cell) };
  });

  const welded = weldMesh(mesh);
  const concave = Array.from({ length: n }, () => 0);
  for (const tris of welded.edges.values()) {
    if (tris.length !== 2) continue;
    const [ia, ib] = tris;
    const a = mesh.triangles[ia];
    const b = mesh.triangles[ib];
    if (!a || !b || !isConcaveDihedral(a, b)) continue;
    const angle = (Math.acos(Math.min(1, Math.max(-1, dot(normals[ia], normals[ib])))) * 180) / Math.PI;
    const sharp = Math.min(1, Math.max(0, (angle - 22) / 68));
    concave[ia] = Math.max(concave[ia], sharp);
    concave[ib] = Math.max(concave[ib], sharp);
  }

  const partHasHole = slices.some((info) => info.hasHole.some(Boolean));
  const triangleScores: number[] = [];
  const factors: Array<{
    thicknessMm: number;
    thicknessScore: number;
    concaveScore: number;
    overhangScore: number;
    sectionScore: number;
    nearHole: boolean;
    overhangDeg: number;
    score: number;
  }> = [];

  for (let i = 0; i < n; i++) {
    let sliceWidth = Infinity;
    let sliceHole = false;
    for (let axis = 0; axis < 3; axis++) {
      const { minA, spanA } = axisSpan[axis];
      sliceWidth = Math.min(sliceWidth, triangleSliceWidth(centroids[i], axis, minA, spanA, slices[axis]));
      sliceHole = sliceHole || triangleSliceHole(centroids[i], axis, minA, spanA, slices[axis]);
    }
    const fallbackMm = Math.min(...box.size.filter((n) => n > 0.05), Infinity);
    const thicknessMm = Number.isFinite(rays[i]) ? rays[i] : fallbackMm;
    const thicknessScore = thicknessScoreFromMm(thicknessMm, rules);
    const triMinZ = Math.min(...mesh.triangles[i].vertices.map((v) => v[2]));
    const onBed = triMinZ <= box.min[2] + 0.45 && box.min[2] <= Math.max(rules.offBedMm, 0.45);
    const overhangScore = overhangScoreFromNormal(normals[i], onBed);
    const fromVertical = overhangFromVerticalDeg(normals[i]);
    const sectionScore =
      Number.isFinite(sliceWidth) &&
      sliceWidth < rules.minWallMm &&
      Number.isFinite(rays[i]) &&
      rays[i] < rules.minWallMm
        ? thicknessScoreFromMm(Math.min(sliceWidth, rays[i]), rules) * 0.7
        : 0;
    const concaveScore = concave[i];
    const nearHole = partHasHole && (concaveScore > 0.2 || sliceHole);
    const blended = 0.46 * thicknessScore + 0.28 * concaveScore + 0.14 * overhangScore + 0.12 * sectionScore;
    const score = Math.min(
      1,
      Math.max(blended, thicknessScore * 0.92, concaveScore * 0.8, overhangScore * 0.75, sectionScore * 0.7),
    );
    triangleScores.push(score);
    factors.push({
      thicknessMm,
      thicknessScore,
      concaveScore,
      overhangScore,
      sectionScore,
      nearHole,
      overhangDeg: fromVertical,
      score,
    });
  }

  const issues: StrengthPreviewIssue[] = [];
  const used = new Set<number>();
  const ranked = factors
    .map((f, index) => ({ ...f, index }))
    .filter((f) => f.score >= ISSUE_SCORE)
    .sort((a, b) => b.score - a.score);

  for (const hit of ranked) {
    if (issues.length >= MAX_ISSUES) break;
    if (used.has(hit.index)) continue;
    const actuallyThin =
      hit.thicknessMm !== undefined &&
      Number.isFinite(hit.thicknessMm) &&
      hit.thicknessMm < rules.minWallMm &&
      hit.thicknessScore >= 0.4;
    const clusterSize = Math.max(...box.size);
    const kind: StrengthPreviewKind = actuallyThin
      ? clusterSize <= 10 && hit.sectionScore >= hit.thicknessScore
        ? "tiny-section"
        : "thin-wall"
      : hit.concaveScore >= 0.4 && hit.concaveScore >= hit.overhangScore
        ? "stress-concentration"
        : hit.overhangScore >= 0.35
          ? "overhang"
          : "tiny-section";
    const cluster: number[] = [];
    for (let i = 0; i < n; i++) {
      if (used.has(i) || factors[i].score < ISSUE_SCORE * 0.75) continue;
      const d = length(sub(centroids[i], centroids[hit.index]));
      if (d <= Math.max(6, 0.35 * Math.max(...box.size))) {
        cluster.push(i);
      }
    }
    if (!cluster.length) cluster.push(hit.index);
    for (const i of cluster) used.add(i);
    const thickness = cluster.reduce((min, i) => Math.min(min, factors[i].thicknessMm), Infinity);
    issues.push({
      kind,
      message: issueMessage(
        kind,
        Number.isFinite(thickness) ? thickness : undefined,
        cluster.some((i) => factors[i].nearHole) || partHasHole,
        kind === "overhang" ? hit.overhangDeg : undefined,
      ),
      score: hit.score,
      thicknessMm: Number.isFinite(thickness) ? thickness : undefined,
      positionMm: centroids[hit.index],
    });
  }

  const maxScore = triangleScores.reduce((m, s) => Math.max(m, s), 0);
  const meanScore = triangleScores.reduce((s, v) => s + v, 0) / n;
  return {
    method: "heuristic",
    fea: false,
    disclaimer: STRENGTH_PREVIEW_DISCLAIMER,
    triangleCount: n,
    maxScore,
    meanScore,
    issues,
    triangleScores,
  };
}

export function formatStrengthPreviewNote(preview?: StrengthPreview | null): string {
  if (!preview || preview.fea !== false) return "";
  if (!preview.issues.length) {
    return preview.maxScore < 0.2 ? "" : `${preview.disclaimer} Highest heuristic score ${preview.maxScore.toFixed(2)}.`;
  }
  const top = preview.issues
    .slice(0, 3)
    .map((issue) => issue.message)
    .join("; ");
  return `${preview.disclaimer} ${top}.`;
}

function addTri(triangles: Triangle[], a: Vec3, b: Vec3, c: Vec3, expected: Vec3) {
  const n = triangleUnitNormal({ normal: expected, vertices: [a, b, c] });
  const verts: Triangle["vertices"] = dot(n, expected) < 0 ? [a, c, b] : [a, b, c];
  triangles.push({ normal: normalize(expected), vertices: verts });
}

function addQuad(triangles: Triangle[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, expected: Vec3) {
  addTri(triangles, a, b, c, expected);
  addTri(triangles, a, c, d, expected);
}

/**
 * Watertight axis-aligned box with a rectangular through-hole along +Z.
 * Default 20 mm cube + 5 mm hole matches the built-in cube-with-hole fixture.
 */
export function makeBoxWithThroughHoleMesh(
  size: Vec3 = [20, 20, 20],
  holeXy: [number, number] = [5, 5],
  origin: Vec3 = [0, 0, 0],
): Mesh {
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;
  const hx = Math.min(Math.max(holeXy[0], 0.2), sx - 0.2);
  const hy = Math.min(Math.max(holeXy[1], 0.2), sy - 0.2);
  const insetX = (sx - hx) / 2;
  const insetY = (sy - hy) / 2;
  const ox0 = ox;
  const ox1 = ox + sx;
  const oy0 = oy;
  const oy1 = oy + sy;
  const oz0 = oz;
  const oz1 = oz + sz;
  const ix0 = ox + insetX;
  const ix1 = ox + sx - insetX;
  const iy0 = oy + insetY;
  const iy1 = oy + sy - insetY;

  const triangles: Triangle[] = [];
  addQuad(triangles, [ox0, oy0, oz0], [ox0, oy1, oz0], [ox0, oy1, oz1], [ox0, oy0, oz1], [-1, 0, 0]);
  addQuad(triangles, [ox1, oy0, oz0], [ox1, oy0, oz1], [ox1, oy1, oz1], [ox1, oy1, oz0], [1, 0, 0]);
  addQuad(triangles, [ox0, oy0, oz0], [ox0, oy0, oz1], [ox1, oy0, oz1], [ox1, oy0, oz0], [0, -1, 0]);
  addQuad(triangles, [ox0, oy1, oz0], [ox1, oy1, oz0], [ox1, oy1, oz1], [ox0, oy1, oz1], [0, 1, 0]);

  addQuad(triangles, [ix0, iy0, oz0], [ix0, iy0, oz1], [ix0, iy1, oz1], [ix0, iy1, oz0], [1, 0, 0]);
  addQuad(triangles, [ix1, iy0, oz0], [ix1, iy1, oz0], [ix1, iy1, oz1], [ix1, iy0, oz1], [-1, 0, 0]);
  addQuad(triangles, [ix0, iy0, oz0], [ix1, iy0, oz0], [ix1, iy0, oz1], [ix0, iy0, oz1], [0, 1, 0]);
  addQuad(triangles, [ix0, iy1, oz0], [ix0, iy1, oz1], [ix1, iy1, oz1], [ix1, iy1, oz0], [0, -1, 0]);

  addQuad(triangles, [ox0, oy0, oz1], [ox1, oy0, oz1], [ox1, iy0, oz1], [ox0, iy0, oz1], [0, 0, 1]);
  addQuad(triangles, [ox0, iy1, oz1], [ox1, iy1, oz1], [ox1, oy1, oz1], [ox0, oy1, oz1], [0, 0, 1]);
  addQuad(triangles, [ox0, iy0, oz1], [ix0, iy0, oz1], [ix0, iy1, oz1], [ox0, iy1, oz1], [0, 0, 1]);
  addQuad(triangles, [ix1, iy0, oz1], [ox1, iy0, oz1], [ox1, iy1, oz1], [ix1, iy1, oz1], [0, 0, 1]);

  addQuad(triangles, [ox0, oy0, oz0], [ox0, iy0, oz0], [ox1, iy0, oz0], [ox1, oy0, oz0], [0, 0, -1]);
  addQuad(triangles, [ox0, iy1, oz0], [ox0, oy1, oz0], [ox1, oy1, oz0], [ox1, iy1, oz0], [0, 0, -1]);
  addQuad(triangles, [ox0, iy0, oz0], [ox0, iy1, oz0], [ix0, iy1, oz0], [ix0, iy0, oz0], [0, 0, -1]);
  addQuad(triangles, [ix1, iy0, oz0], [ix1, iy1, oz0], [ox1, iy1, oz0], [ox1, iy0, oz0], [0, 0, -1]);

  return { triangles };
}
