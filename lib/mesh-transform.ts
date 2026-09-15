import { boundingBoxMm } from "./mesh-check";
import type { Mesh, Triangle } from "./types";

function mapVertices(
  mesh: Mesh,
  map: (v: [number, number, number]) => [number, number, number],
): Mesh {
  const triangles: Triangle[] = mesh.triangles.map((tri) => {
    const vertices: Triangle["vertices"] = [map(tri.vertices[0]), map(tri.vertices[1]), map(tri.vertices[2])];
    return { normal: tri.normal, vertices };
  });
  return { triangles };
}

/** Uniform scale about the base-center so the part stays on the plate. */
export function scaleMeshUniform(mesh: Mesh, factor: number): Mesh {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("Scale factor must be a positive number");
  }
  if (Math.abs(factor - 1) < 1e-9) return mesh;
  const box = boundingBoxMm(mesh);
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const cz = box.min[2];
  return mapVertices(mesh, ([x, y, z]) => [
    cx + (x - cx) * factor,
    cy + (y - cy) * factor,
    cz + (z - cz) * factor,
  ]);
}

export function translateMesh(mesh: Mesh, delta: [number, number, number]): Mesh {
  const [dx, dy, dz] = delta;
  if (dx === 0 && dy === 0 && dz === 0) return mesh;
  return mapVertices(mesh, ([x, y, z]) => [x + dx, y + dy, z + dz]);
}

/** Translate so the lowest Z is 0 (build plate). */
export function sitMeshOnBed(mesh: Mesh): Mesh {
  const box = boundingBoxMm(mesh);
  if (!Number.isFinite(box.min[2]) || Math.abs(box.min[2]) < 1e-6) return mesh;
  return translateMesh(mesh, [0, 0, -box.min[2]]);
}

/** Rotate about +Z through the XY center of the bbox, then sit on z=0. */
export function rotateMeshZ(mesh: Mesh, degrees: number): Mesh {
  const turn = ((degrees % 360) + 360) % 360;
  if (Math.abs(turn) < 1e-9) return mesh;
  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const box = boundingBoxMm(mesh);
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const rotated = mapVertices(mesh, ([x, y, z]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos, z];
  });
  return sitMeshOnBed(rotated);
}

/** Scale so the largest bbox side becomes targetMaxMm. */
export function scaleMeshToMaxMm(mesh: Mesh, targetMaxMm: number): Mesh {
  if (!Number.isFinite(targetMaxMm) || targetMaxMm <= 0) {
    throw new Error("Target size must be a positive number of millimeters");
  }
  const box = boundingBoxMm(mesh);
  const maxDim = Math.max(...box.size);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return mesh;
  return scaleMeshUniform(mesh, targetMaxMm / maxDim);
}

export function cloneMesh(mesh: Mesh): Mesh {
  return {
    triangles: mesh.triangles.map((tri) => ({
      normal: [...tri.normal] as Triangle["normal"],
      vertices: tri.vertices.map((v) => [...v] as [number, number, number]) as Triangle["vertices"],
    })),
  };
}
