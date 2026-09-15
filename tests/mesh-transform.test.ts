import { describe, expect, it } from "vitest";
import { boundingBoxMm } from "@/lib/mesh-check";
import {
  rotateMeshZ,
  scaleMeshToMaxMm,
  scaleMeshesUniform,
  scaleMeshUniform,
  sitMeshOnBed,
  sitMeshesOnBed,
} from "@/lib/mesh-transform";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";

describe("mesh transforms", () => {
  it("scales about the base and can sit on z=0", () => {
    const mesh = makeAxisAlignedBoxMesh([10, 20, 30], [2, 4, 6]);
    const scaled = scaleMeshUniform(mesh, 2);
    expect(boundingBoxMm(scaled).size).toEqual([20, 40, 60]);
    expect(boundingBoxMm(scaled).min[2]).toBeCloseTo(6);
    const seated = sitMeshOnBed(scaled);
    expect(boundingBoxMm(seated).min[2]).toBeCloseTo(0);
    expect(boundingBoxMm(seated).size[2]).toBeCloseTo(60);
  });

  it("scales to a target max dimension", () => {
    const mesh = makeAxisAlignedBoxMesh([40, 20, 10]);
    const next = scaleMeshToMaxMm(mesh, 80);
    expect(Math.max(...boundingBoxMm(next).size)).toBeCloseTo(80);
  });

  it("rotates 90° about Z and stays on the plate", () => {
    const mesh = sitMeshOnBed(makeAxisAlignedBoxMesh([40, 10, 8], [0, 0, 3]));
    const rotated = rotateMeshZ(mesh, 90);
    const box = boundingBoxMm(rotated);
    expect(box.min[2]).toBeCloseTo(0);
    expect(box.size[0]).toBeCloseTo(10);
    expect(box.size[1]).toBeCloseTo(40);
  });

  it("sits and scales multiple color bodies about a shared origin", () => {
    const body = makeAxisAlignedBoxMesh([40, 20, 6], [0, 0, 2]);
    const letters = makeAxisAlignedBoxMesh([4, 8, 1.6], [8, 6, 8]);
    const seated = sitMeshesOnBed([body, letters]);
    expect(boundingBoxMm(seated[0]).min[2]).toBeCloseTo(0);
    expect(boundingBoxMm(seated[1]).min[2]).toBeCloseTo(6);
    const scaled = scaleMeshesUniform(seated, 2);
    expect(boundingBoxMm(scaled[0]).size).toEqual([80, 40, 12]);
    expect(boundingBoxMm(scaled[1]).size[2]).toBeCloseTo(3.2);
  });
});
