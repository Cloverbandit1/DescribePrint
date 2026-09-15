import { describe, expect, it } from "vitest";
import { boundingBoxMm } from "@/lib/mesh-check";
import { rotateMeshZ, scaleMeshToMaxMm, scaleMeshUniform, sitMeshOnBed } from "@/lib/mesh-transform";
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
});
