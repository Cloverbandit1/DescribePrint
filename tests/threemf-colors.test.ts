import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { colorRegionsFromPrompt, defaultColorRegion, mergeColorRegionSources } from "@/lib/color-regions";
import { getJob } from "@/lib/jobs";
import { extractOpenScadColorBodies, scadWithOnlyBody } from "@/lib/openscad-colors";
import { runGeneratePipeline, runImportPipeline } from "@/lib/pipeline";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import { meshesTo3mf, meshTo3mf, parse3mfDocument } from "@/lib/threemf";
import { compileOpenScad } from "@/lib/compile";
import { vi } from "vitest";

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const mockedCompile = vi.mocked(compileOpenScad);

function compileStl(mesh: ReturnType<typeof makeAxisAlignedBoxMesh>) {
  return {
    stl: writeBinaryStl(mesh),
    stderr: "",
    stdout: "",
    workDir: "/tmp/describeprint-color-test",
  };
}

describe("color region parsing", () => {
  it("defaults to one uncolored region when no colors are mentioned", () => {
    const regions = colorRegionsFromPrompt("20mm cube with 5mm hole");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject(defaultColorRegion());
  });

  it("captures named bodies and AMS slots from a two-color prompt", () => {
    const regions = colorRegionsFromPrompt("red body, black letters");
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({
      id: "body",
      colorName: "red",
      colorHex: "#FF0000",
      filament: "pla",
      amsSlot: 1,
    });
    expect(regions[1]).toMatchObject({
      id: "letters",
      colorName: "black",
      colorHex: "#1A1A1A",
      filament: "pla",
      amsSlot: 2,
    });
  });

  it("keeps P2S/AMS indexing as metadata without needing a printer", () => {
    const regions = colorRegionsFromPrompt("red PLA plaque with black PETG letters");
    expect(regions.map((r) => r.amsSlot)).toEqual([1, 2]);
    expect(regions[0]?.filament).toBe("pla");
    expect(regions[1]?.filament).toBe("petg");
  });
});

describe("3MF multi-object color encoding", () => {
  it("writes separate objects, display colors, and extruder indices", async () => {
    const body = makeAxisAlignedBoxMesh([40, 20, 6]);
    const letters = makeAxisAlignedBoxMesh([4, 8, 1.6], [8, 6, 6]);
    const bytes = await meshesTo3mf(
      [
        { name: "body", mesh: body, colorHex: "#FF0000", colorName: "red", filament: "pla", extruder: 1 },
        { name: "letters", mesh: letters, colorHex: "#1A1A1A", colorName: "black", filament: "pla", extruder: 2 },
      ],
      "plaque",
    );

    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    const zip = await JSZip.loadAsync(bytes);
    const model = await zip.file("3D/3dmodel.model")?.async("string");
    expect(model).toContain('unit="millimeter"');
    expect(model).toMatch(/<object id="2" name="body"/);
    expect(model).toMatch(/<object id="3" name="letters"/);
    expect(model).toContain('displaycolor="#FF0000FF"');
    expect(model).toContain('displaycolor="#1A1A1AFF"');
    expect(model).toContain("<item objectid=\"2\"/>");
    expect(model).toContain("<item objectid=\"3\"/>");
    expect(model).toContain('<metadata name="slic3rpe:extruder">1</metadata>');
    expect(model).toContain('<metadata name="slic3rpe:extruder">2</metadata>');
    expect(model).toContain('<metadata name="DescribePrint:ams_slot">1</metadata>');
    expect(model).toContain('<metadata name="DescribePrint:ams_slot">2</metadata>');

    const settings = await zip.file("Metadata/model_settings.config")?.async("string");
    expect(settings).toContain('key="extruder" value="1"');
    expect(settings).toContain('key="extruder" value="2"');
    expect(settings).toContain("#FF0000");
    expect(settings).toContain("#1A1A1A");

    const parsed = await parse3mfDocument(bytes);
    expect(parsed.objects).toHaveLength(2);
    expect(parsed.objects[0]).toMatchObject({ name: "body", colorHex: "#FF0000", extruder: 1 });
    expect(parsed.objects[1]).toMatchObject({ name: "letters", colorHex: "#1A1A1A", extruder: 2 });
    expect(parsed.mesh.triangles.length).toBe(body.triangles.length + letters.triangles.length);
  });

  it("round-trips a single default object from meshTo3mf", async () => {
    const bytes = await meshTo3mf(makeAxisAlignedBoxMesh([3, 3, 3]));
    const parsed = await parse3mfDocument(bytes);
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0]?.colorHex).toBe("#C4C4C8");
    expect(parsed.objects[0]?.extruder).toBe(1);
  });
});

describe("OpenSCAD color-body isolate", () => {
  it("finds region_* modules and color() wrappers", () => {
    const bodies = extractOpenScadColorBodies(`
module region_body() { cube([40,20,6]); }
module region_letters() { cube([4,8,1.6]); }
union() {
  color("red") region_body();
  color("black") region_letters();
}
`);
    expect(bodies.map((b) => b.moduleName)).toEqual(["region_body", "region_letters"]);
    expect(scadWithOnlyBody("cube(1);", "region_body()")).toContain("!region_body();");
  });
});

describe("generate + import color fixture", () => {
  it("exports a two-color 3MF from the plaque fixture and preserves colors on import", async () => {
    mockedCompile.mockImplementation(async (code: string) => {
      if (code.includes("!region_letters")) {
        return compileStl(makeAxisAlignedBoxMesh([4, 8, 1.6], [8, 6, 6]));
      }
      if (code.includes("!region_body")) {
        return compileStl(makeAxisAlignedBoxMesh([40, 20, 6]));
      }
      return compileStl(makeAxisAlignedBoxMesh([40, 20, 7.6]));
    });

    const generated = await runGeneratePipeline({
      prompt: "red 40mm plaque with black letters",
      fixture: true,
    });
    expect(generated.usedFixture).toBe(true);
    expect(generated.colorRegions).toHaveLength(2);
    expect(generated.colorRegions[0]).toMatchObject({ colorName: "red", amsSlot: 1 });
    expect(generated.colorRegions[1]).toMatchObject({ colorName: "black", amsSlot: 2 });
    expect(generated.notes.join(" ")).toMatch(/2 color objects/i);
    expect(generated.code).toMatch(/module region_body/);
    expect(generated.code).toMatch(/color\("black"\) region_letters/);

    const job = getJob(generated.jobId);
    expect(job).toBeTruthy();
    const exported = await parse3mfDocument(job!.threemf);
    expect(exported.objects).toHaveLength(2);
    expect(exported.objects.map((o) => o.name)).toEqual(["plaque", "letters"]);
    expect(exported.objects.map((o) => o.colorHex)).toEqual(["#FF0000", "#1A1A1A"]);
    expect(exported.objects.map((o) => o.extruder)).toEqual([1, 2]);

    const imported = await runImportPipeline({
      buffer: job!.threemf,
      fileName: "plaque.3mf",
    });
    expect(imported.source).toBe("imported-mesh");
    expect(imported.colorRegions).toHaveLength(2);
    expect(imported.colorRegions[0]?.colorHex).toBe("#FF0000");
    expect(imported.colorRegions[1]?.colorHex).toBe("#1A1A1A");
    expect(imported.notes.join(" ")).toMatch(/color objects/i);

    const importedJob = getJob(imported.jobId);
    const roundTrip = await parse3mfDocument(importedJob!.threemf);
    expect(roundTrip.objects).toHaveLength(2);
    expect(roundTrip.objects[0]?.colorHex).toBe("#FF0000");
    expect(roundTrip.objects[1]?.colorHex).toBe("#1A1A1A");
    expect(roundTrip.objects[0]?.extruder).toBe(1);
    expect(roundTrip.objects[1]?.extruder).toBe(2);
  });
});

describe("plan color_regions merge", () => {
  it("fills hex and AMS slots from a planned color list", () => {
    const regions = mergeColorRegionSources("red body and black letters", [
      { name: "body", color: "red" },
      { name: "letters", color: "black", filament: "pla" },
    ]);
    expect(regions.map((r) => r.colorHex)).toEqual(["#FF0000", "#1A1A1A"]);
    expect(regions.map((r) => r.amsSlot)).toEqual([1, 2]);
  });
});
