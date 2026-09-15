import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/jobs/[id]/[file]/route";
import { compileOpenScad } from "@/lib/compile";
import { getJob } from "@/lib/jobs";
import {
  PROJECT_PACK_EMPTY_ERROR,
  PROJECT_PACK_FILES,
  ProjectPackError,
  buildProjectPack,
  buildShoppingLinksMarkdown,
  canBuildProjectPack,
  shoppingLineFor,
} from "@/lib/machine/project-pack";
import { runGeneratePipeline } from "@/lib/pipeline";
import { printPresetSummary } from "@/lib/printers";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import { meshesTo3mf } from "@/lib/threemf";

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const mockedCompile = vi.mocked(compileOpenScad);

describe("project pack export stub", () => {
  it("fails cleanly when there is no 3MF on the plate", async () => {
    expect(canBuildProjectPack({})).toBe(false);
    expect(canBuildProjectPack({ threemf: Buffer.alloc(0) })).toBe(false);
    await expect(buildProjectPack({})).rejects.toBeInstanceOf(ProjectPackError);
    await expect(buildProjectPack({ stl: writeBinaryStl(makeAxisAlignedBoxMesh([10, 10, 10])) })).rejects.toThrow(
      PROJECT_PACK_EMPTY_ERROR,
    );
  });

  it("packs 3MF, steps, and shopping links with the material name", async () => {
    const preset = printPresetSummary("pla");
    const mesh = makeAxisAlignedBoxMesh([20, 20, 20]);
    const threemf = await meshesTo3mf(
      [{ name: "cube", mesh, colorHex: "#C4C4C8", filament: "pla", extruder: 1 }],
      "DescribePrint",
      preset,
    );
    const stl = writeBinaryStl(mesh);

    const pack = await buildProjectPack({
      threemf,
      stl,
      printPreset: preset,
      report: {
        triangleCount: 12,
        volumeMm3: 8000,
        boundingBoxMm: { min: [0, 0, 0], max: [20, 20, 20], size: [20, 20, 20] },
        manifold: true,
        watertight: true,
        issues: [],
        units: "mm",
      },
      description: "20mm cube with 5mm hole",
      fileName: "cube.stl",
    });

    expect(pack.subarray(0, 2).toString("utf8")).toBe("PK");
    const zip = await JSZip.loadAsync(pack);
    expect(zip.file(PROJECT_PACK_FILES.threemf)).toBeTruthy();
    expect(zip.file(PROJECT_PACK_FILES.stl)).toBeTruthy();
    expect(zip.file(PROJECT_PACK_FILES.steps)).toBeTruthy();
    expect(zip.file(PROJECT_PACK_FILES.shopping)).toBeTruthy();
    expect(zip.file(PROJECT_PACK_FILES.shoppingJson)).toBeTruthy();

    const packed3mf = await zip.file(PROJECT_PACK_FILES.threemf)!.async("nodebuffer");
    expect(Buffer.compare(packed3mf, threemf)).toBe(0);

    const steps = await zip.file(PROJECT_PACK_FILES.steps)!.async("string");
    expect(steps).toMatch(/stub/i);
    expect(steps).toContain("PLA");
    expect(steps).toContain("sit on the build plate");
    expect(steps).toContain("20mm cube with 5mm hole");

    const shopping = await zip.file(PROJECT_PACK_FILES.shopping)!.async("string");
    expect(shopping).toContain("PLA");
    expect(shopping).toContain("1.75");
    expect(shopping).toContain("Bambu PLA Basic");
    expect(shopping).toMatch(/not affiliate/i);
    expect(shoppingLineFor("pla")).toBe("PLA 1.75 mm — search: Bambu PLA Basic");
  });

  it("puts the selected material name in the shopping stub", () => {
    const petg = buildShoppingLinksMarkdown({ printPreset: printPresetSummary("petg") });
    expect(petg).toContain("PETG");
    expect(petg).toContain("Bambu PETG Basic");
    expect(petg).not.toMatch(/https?:\/\//);

    const pa = buildShoppingLinksMarkdown({ material: "pa" });
    expect(pa).toContain("PA");
    expect(pa).toContain("nylon");
  });

  it("serves a pack zip from the job download route without breaking STL/3MF", async () => {
    mockedCompile.mockResolvedValue({
      stl: writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 20])),
      stderr: "",
      stdout: "",
      workDir: "/tmp/describeprint-project-pack-test",
    });
    const generated = await runGeneratePipeline({
      prompt: "20mm cube with 5mm hole",
      fixture: true,
      filament: "petg",
    });
    expect(generated.projectPackUrl).toMatch(/model\.pack\.zip$/);

    const job = getJob(generated.jobId);
    expect(job?.threemf.length).toBeGreaterThan(4);

    const packResponse = await GET(new Request("http://localhost/api/jobs/x/model.pack.zip"), {
      params: Promise.resolve({ id: generated.jobId, file: "model.pack.zip" }),
    });
    expect(packResponse.status).toBe(200);
    expect(packResponse.headers.get("Content-Type")).toMatch(/zip/i);
    const packBytes = Buffer.from(await packResponse.arrayBuffer());
    const zip = await JSZip.loadAsync(packBytes);
    expect(zip.file(PROJECT_PACK_FILES.threemf)).toBeTruthy();
    expect(zip.file(PROJECT_PACK_FILES.steps)).toBeTruthy();
    const shopping = await zip.file(PROJECT_PACK_FILES.shopping)!.async("string");
    expect(shopping).toContain("PETG");

    const stl = await GET(new Request("http://localhost/api/jobs/x/model.stl"), {
      params: Promise.resolve({ id: generated.jobId, file: "model.stl" }),
    });
    const threemf = await GET(new Request("http://localhost/api/jobs/x/model.3mf"), {
      params: Promise.resolve({ id: generated.jobId, file: "model.3mf" }),
    });
    expect(stl.status).toBe(200);
    expect(threemf.status).toBe(200);
  });
});
