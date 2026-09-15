import { bedMaxMm, printRules, type PrintRules } from "./printability";
import { defaultPrinter, type PrinterProfile } from "./printers";
import { previewStrength } from "./strength-preview";
import type { BoundingBoxMm, Mesh, MeshIssue, PrintabilityReport } from "./types";

const VOLUME_EPS = 1e-6;
const WELD_EPS = 1e-4;
const WARN_TRIANGLES = 250_000;
const FAIL_TRIANGLES = 2_000_000;
const WARN_MIN_MM = 1;

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function signedVolumeMm3(mesh: Mesh): number {
  let volume = 0;
  for (const tri of mesh.triangles) {
    const [a, b, c] = tri.vertices;
    volume += dot(a, cross(b, c)) / 6;
  }
  return volume;
}

export function boundingBoxMm(mesh: Mesh): BoundingBoxMm {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

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

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

function weldKey(v: [number, number, number], scale: number): string {
  const q = (n: number) => Math.round(n / scale);
  return `${q(v[0])},${q(v[1])},${q(v[2])}`;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

type WeldedMesh = {
  triangles: [number, number, number][];
  edges: Map<string, number[]>;
};

function weldMesh(mesh: Mesh): WeldedMesh {
  const box = boundingBoxMm(mesh);
  const diag = Math.hypot(box.size[0], box.size[1], box.size[2]);
  const scale = Math.max(diag * 1e-7, WELD_EPS);

  const ids = new Map<string, number>();
  let next = 0;
  const indexOf = (v: [number, number, number]) => {
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
    if (i0 === i1 || i1 === i2 || i2 === i0) continue;
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

/**
 * Edge-manifold / watertight-ish test after welding coincident vertices.
 * Each unique edge should be shared by exactly two triangles.
 */
export function isEdgeManifold(mesh: Mesh): boolean {
  if (mesh.triangles.length === 0) return false;
  const welded = weldMesh(mesh);
  if (welded.edges.size === 0) return false;
  for (const tris of welded.edges.values()) {
    if (tris.length !== 2) return false;
  }
  return true;
}

/**
 * Count edge-connected triangle islands. Separate bodies that only touch at a
 * vertex (or not at all) are floating islands for FDM.
 */
export function countSolidComponents(mesh: Mesh): number {
  if (mesh.triangles.length === 0) return 0;
  const welded = weldMesh(mesh);
  const n = welded.triangles.length;
  if (n === 0) return 0;

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (const tris of welded.edges.values()) {
    for (let i = 1; i < tris.length; i++) {
      union(tris[0], tris[i]);
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

export function checkMesh(mesh: Mesh, printer: PrinterProfile = defaultPrinter()): PrintabilityReport {
  const rules = printRules(printer);
  return checkMeshWithRules(mesh, rules);
}

export function checkMeshWithRules(mesh: Mesh, rules: PrintRules): PrintabilityReport {
  const issues: MeshIssue[] = [];
  const triangleCount = mesh.triangles.length;
  const volumeMm3 = signedVolumeMm3(mesh);
  const box = boundingBoxMm(mesh);
  const maxDim = Math.max(...box.size);
  const minPositive = Math.min(...box.size.filter((n) => n > 0), Infinity);
  const manifold = triangleCount > 0 && isEdgeManifold(mesh);
  const components = countSolidComponents(mesh);
  const bed = bedMaxMm(rules);

  if (triangleCount === 0) {
    issues.push({
      code: "empty",
      severity: "error",
      message: "Mesh is empty (0 triangles)",
    });
  }

  if (triangleCount > 0 && Math.abs(volumeMm3) < VOLUME_EPS) {
    issues.push({
      code: "zero-volume",
      severity: "error",
      message: "Mesh has zero (or near-zero) volume",
    });
  }

  if (triangleCount >= FAIL_TRIANGLES) {
    issues.push({
      code: "huge-triangles",
      severity: "error",
      message: `Triangle count ${triangleCount.toLocaleString()} exceeds ${FAIL_TRIANGLES.toLocaleString()}`,
    });
  } else if (triangleCount >= WARN_TRIANGLES) {
    issues.push({
      code: "huge-triangles",
      severity: "warning",
      message: `High triangle count (${triangleCount.toLocaleString()}). Slicing may be slow.`,
    });
  }

  if (triangleCount > 0 && !manifold) {
    issues.push({
      code: "non-manifold",
      severity: "warning",
      message: "Mesh is not edge-manifold (may not be watertight)",
    });
  }

  if (maxDim >= rules.failMaxMm) {
    issues.push({
      code: "oversized",
      severity: "error",
      message: `Largest dimension ${maxDim.toFixed(1)} mm is beyond a typical print volume`,
    });
  } else if (maxDim > bed) {
    const [bx, by, bz] = rules.bedMm;
    issues.push({
      code: "oversized",
      severity: "warning",
      message: `Largest dimension ${maxDim.toFixed(1)} mm exceeds the ${rules.printerName} bed (${bx} × ${by} × ${bz} mm)`,
    });
  }

  if (triangleCount > 0 && Number.isFinite(minPositive) && minPositive < WARN_MIN_MM) {
    issues.push({
      code: "undersized",
      severity: "warning",
      message: `Smallest dimension ${minPositive.toFixed(3)} mm is under 1 mm`,
    });
  }

  if (triangleCount > 0 && Number.isFinite(minPositive) && minPositive < rules.minWallMm) {
    issues.push({
      code: "thin-wall",
      severity: "warning",
      message: `Smallest extent ${minPositive.toFixed(3)} mm is thinner than ${rules.minWallMm} mm (4× ${rules.nozzleMm} mm nozzle)`,
    });
  }

  if (triangleCount > 0 && box.min[2] > rules.offBedMm) {
    issues.push({
      code: "off-bed",
      severity: "warning",
      message: `Part does not sit on z=0 (lowest Z is ${box.min[2].toFixed(1)} mm). Translate so the base is on the build plate.`,
    });
  }

  if (components > 1) {
    issues.push({
      code: "disconnected",
      severity: "warning",
      message: `Floating island: ${components} disconnected solids. Union them into one piece or connect with a bridge ≥ ${rules.minWallMm} mm.`,
    });
  }

  return {
    triangleCount,
    volumeMm3: Math.abs(volumeMm3),
    boundingBoxMm: box,
    manifold,
    watertight: manifold && Math.abs(volumeMm3) >= VOLUME_EPS,
    issues,
    units: "mm",
    strengthPreview: previewStrength(mesh, rules),
  };
}

export function hasHardMeshFailure(report: PrintabilityReport): boolean {
  return report.issues.some((issue) => issue.severity === "error");
}
