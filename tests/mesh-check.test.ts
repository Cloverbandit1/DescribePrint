import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { checkMesh, countSolidComponents, signedVolumeMm3, splitSolidComponents } from "@/lib/mesh-check";
import { makeAxisAlignedBoxMesh, parseStl, writeBinaryStl } from "@/lib/stl";
import { meshTo3mf } from "@/lib/threemf";

describe("mesh-check", () => {
  it("accepts a watertight 10 mm cube", () => {
    const mesh = makeAxisAlignedBoxMesh([10, 10, 10]);
    const report = checkMesh(mesh);
    expect(report.triangleCount).toBe(12);
    expect(report.volumeMm3).toBeCloseTo(1000, 4);
    expect(report.boundingBoxMm.size).toEqual([10, 10, 10]);
    expect(report.units).toBe("mm");
    expect(report.manifold).toBe(true);
    expect(report.watertight).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
  });

  it("round-trips binary STL and still measures volume", () => {
    const mesh = makeAxisAlignedBoxMesh([8, 4, 2], [1, 1, 1]);
    const parsed = parseStl(writeBinaryStl(mesh));
    expect(signedVolumeMm3(parsed)).toBeCloseTo(64, 4);
    expect(checkMesh(parsed).boundingBoxMm.size).toEqual([8, 4, 2]);
  });

  it("flags an empty mesh", () => {
    const report = checkMesh({ triangles: [] });
    expect(report.issues.some((i) => i.code === "empty" && i.severity === "error")).toBe(true);
    expect(report.watertight).toBe(false);
  });

  it("flags zero-volume geometry", () => {
    const report = checkMesh({
      triangles: [
        {
          normal: [0, 0, 1],
          vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
        },
      ],
    });
    expect(report.issues.some((i) => i.code === "zero-volume")).toBe(true);
    expect(report.watertight).toBe(false);
  });

  it("flags a non-manifold open surface", () => {
    const report = checkMesh({
      triangles: [
        {
          normal: [0, 0, 1],
          vertices: [
            [0, 0, 0],
            [2, 0, 0],
            [0, 2, 1],
          ],
        },
      ],
    });
    expect(report.manifold).toBe(false);
    expect(report.issues.some((i) => i.code === "non-manifold")).toBe(true);
  });

  it("flags a huge triangle count", () => {
    const cube = makeAxisAlignedBoxMesh([1, 1, 1]);
    const triangles = Array.from({ length: 250_000 }, () => cube.triangles[0]);
    const report = checkMesh({ triangles });
    expect(report.issues.some((i) => i.code === "huge-triangles")).toBe(true);
  });

  it("flags a part larger than the P2S 256 mm bed", () => {
    const report = checkMesh(makeAxisAlignedBoxMesh([300, 40, 20]));
    const oversized = report.issues.find((i) => i.code === "oversized");
    expect(oversized?.severity).toBe("warning");
    expect(oversized?.message).toMatch(/256/);
    expect(oversized?.message).toMatch(/300/);
  });

  it("flags thin walls relative to the 0.4 mm nozzle", () => {
    const report = checkMesh(makeAxisAlignedBoxMesh([30, 20, 1.2]));
    expect(report.issues.some((i) => i.code === "thin-wall" && /1\.6 mm/.test(i.message))).toBe(true);
    expect(report.issues.some((i) => i.code === "undersized")).toBe(false);
  });

  it("flags a solid that does not sit on the build plate", () => {
    const report = checkMesh(makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 8]));
    expect(report.issues.some((i) => i.code === "off-bed" && /8\.0 mm/.test(i.message))).toBe(true);
  });

  it("flags disconnected solids as floating islands", () => {
    const a = makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 0]);
    const b = makeAxisAlignedBoxMesh([10, 10, 10], [40, 0, 0]);
    const mesh = { triangles: [...a.triangles, ...b.triangles] };
    expect(countSolidComponents(mesh)).toBe(2);
    const report = checkMesh(mesh);
    expect(report.issues.some((i) => i.code === "disconnected" && /2 disconnected/.test(i.message))).toBe(
      true,
    );
    expect(countSolidComponents(makeAxisAlignedBoxMesh([10, 10, 10]))).toBe(1);
    expect(splitSolidComponents(mesh)).toHaveLength(2);
  });

  it("writes a 3MF zip with millimeter units", async () => {
    const bytes = await meshTo3mf(makeAxisAlignedBoxMesh([3, 3, 3]));
    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toContain("3D/3dmodel.model");
    const model = await zip.file("3D/3dmodel.model")?.async("string");
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain("<vertex");
    expect(model).toContain("<triangle");
  });
});
