import { describe, expect, it } from "vitest";
import { checkMesh } from "@/lib/mesh-check";
import { parseImportedMesh, safeImportFileName } from "@/lib/import-mesh";
import { runGeneratePipeline, runImportPipeline } from "@/lib/pipeline";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import { meshTo3mf } from "@/lib/threemf";

describe("STL/3MF import", () => {
  it("sanitizes upload names", () => {
    expect(safeImportFileName("../../etc/passwd.stl")).toBe("passwd.stl");
    expect(safeImportFileName("My Mask (final).3mf")).toBe("My_Mask_final_.3mf");
  });

  it("imports a binary STL onto the plate at z=0", async () => {
    const mesh = makeAxisAlignedBoxMesh([40, 20, 10], [0, 0, 8]);
    const result = await runImportPipeline({
      buffer: writeBinaryStl(mesh),
      fileName: "mask.stl",
    });
    expect(result.source).toBe("imported-mesh");
    expect(result.editMode).toBe("import");
    expect(result.fileName).toBe("mask.stl");
    expect(result.report.boundingBoxMm.size).toEqual([40, 20, 10]);
    expect(result.report.boundingBoxMm.min[2]).toBeCloseTo(0);
    expect(result.notes.join(" ")).toMatch(/partial/i);
    expect(result.code).toMatch(/imported mesh/i);
  });

  it("round-trips 3MF import in millimeters", async () => {
    const mesh = makeAxisAlignedBoxMesh([12, 6, 3]);
    const buffer = await meshTo3mf(mesh, "cube");
    const imported = await parseImportedMesh(buffer, "cube.3mf");
    expect(imported.format).toBe("3mf");
    const report = checkMesh(imported.mesh);
    expect(report.boundingBoxMm.size[0]).toBeCloseTo(12);
    expect(report.volumeMm3).toBeCloseTo(216);
  });

  it("scales an imported mesh with a wearable size follow-up (no OpenSCAD)", async () => {
    const imported = await runImportPipeline({
      buffer: writeBinaryStl(makeAxisAlignedBoxMesh([40, 20, 10])),
      fileName: "part.stl",
    });
    const scaled = await runGeneratePipeline({
      prompt: "Apply wearable size L",
      previousJobId: imported.jobId,
      previousSource: "imported-mesh",
      wearableSize: "L",
      fixture: true,
    });
    expect(scaled.source).toBe("imported-mesh");
    expect(scaled.editMode).toBe("transform");
    expect(scaled.wearableSize).toBe("L");
    expect(scaled.report.boundingBoxMm.size[0]).toBeCloseTo(44.8);
    expect(scaled.report.boundingBoxMm.min[2]).toBeCloseTo(0);
    expect(scaled.notes.join(" ")).toMatch(/Assumed size: L/);
  });
});
