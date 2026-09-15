import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/jobs/[id]/[file]/route";
import {
  ASSEMBLY_DISCLAIMER,
  assemblyFromParts,
  explodeOffsetsMm,
  explodedMeshFromParts,
  formatAssemblyNote,
  partsFromIslands,
  partsFromObjects,
  partsZipBuffer,
} from "@/lib/assembly";
import { compileOpenScad } from "@/lib/compile";
import { HINGE_FIXTURE_PROMPT, hingeFixtureScad } from "@/lib/joints";
import { getJob, resetJobs } from "@/lib/jobs";
import { boundingBoxMm, countSolidComponents, splitSolidComponents } from "@/lib/mesh-check";
import { extractOpenScadAssemblyBodies } from "@/lib/openscad-colors";
import { runGeneratePipeline } from "@/lib/pipeline";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import { parse3mfDocument } from "@/lib/threemf";

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
    workDir: "/tmp/describeprint-assembly-test",
  };
}

afterEach(() => {
  vi.clearAllMocks();
  resetJobs();
});

describe("assembly detection", () => {
  it("finds hinge fixture solids from top-level module calls", () => {
    const bodies = extractOpenScadAssemblyBodies(hingeFixtureScad());
    expect(bodies.map((body) => body.moduleName)).toEqual(["box_body", "lid", "hinge_pin"]);
    expect(bodies.map((body) => body.name)).toEqual(["box body", "lid", "hinge pin"]);
  });

  it("does not treat a cube fixture as an assembly", () => {
    const bodies = extractOpenScadAssemblyBodies(`
$fn = 64;
size = 20;
difference() {
  cube(size);
  translate([10,10,-1]) cylinder(h=22,d=5);
}
`);
    expect(bodies.length).toBeLessThan(2);
  });

  it("names mesh islands from the joint family", () => {
    const a = makeAxisAlignedBoxMesh([40, 28, 14], [0, 0, 0]);
    const b = makeAxisAlignedBoxMesh([40, 28, 2.4], [0, -30, 0]);
    const c = makeAxisAlignedBoxMesh([20, 4, 4], [10, -2, 2]);
    const parts = partsFromIslands([a, b, c], { prompt: HINGE_FIXTURE_PROMPT });
    expect(parts.map((part) => part.name)).toEqual(["box body", "lid", "hinge pin"]);
  });
});

describe("heuristic explode offsets", () => {
  it("separates two boxes along the longest axis without claiming kinematics", () => {
    const left = makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 0]);
    const right = makeAxisAlignedBoxMesh([10, 10, 10], [12, 0, 0]);
    const boxes = [boundingBoxMm(left), boundingBoxMm(right)];
    const offsets = explodeOffsetsMm(boxes, "x", 12);
    expect(offsets).toHaveLength(2);
    expect(offsets[0]![0]).toBeLessThan(offsets[1]![0]);
    const exploded = explodedMeshFromParts(
      partsFromObjects([
        { name: "left", mesh: left, colorHex: "#C4C4C8" },
        { name: "right", mesh: right, colorHex: "#C4C4C8" },
      ]),
      "x",
      12,
    );
    const islands = splitSolidComponents(exploded);
    expect(islands).toHaveLength(2);
    const [first, second] = islands.map((mesh) => boundingBoxMm(mesh)).sort((a, b) => a.min[0] - b.min[0]);
    expect(first!.max[0]).toBeLessThanOrEqual(second!.min[0] + 1e-4);
    expect(second!.min[0] - first!.max[0]).toBeGreaterThanOrEqual(12 - 1e-4);

    const info = assemblyFromParts(
      partsFromObjects([
        { name: "left", mesh: left, colorHex: "#C4C4C8" },
        { name: "right", mesh: right, colorHex: "#C4C4C8" },
      ]),
    );
    expect(info.isAssembly).toBe(true);
    expect(info.kinematics).toBe(false);
    expect(info.method).toBe("heuristic-offset");
    expect(info.disclaimer).toMatch(/not constraint-solved kinematics/i);
    expect(formatAssemblyNote(info)).toMatch(/left, right/);
    expect(formatAssemblyNote(info)).toMatch(ASSEMBLY_DISCLAIMER);
  });

  it("splits a disconnected mesh into the same islands mesh-check counts", () => {
    const a = makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 0]);
    const b = makeAxisAlignedBoxMesh([8, 8, 8], [40, 0, 0]);
    const mesh = { triangles: [...a.triangles, ...b.triangles] };
    expect(countSolidComponents(mesh)).toBe(2);
    const islands = splitSolidComponents(mesh);
    expect(islands).toHaveLength(2);
    expect(islands[0]!.triangles.length).toBe(12);
    expect(islands[1]!.triangles.length).toBe(12);
  });
});

describe("generate + export assembly stub", () => {
  it("leaves a 20mm cube as a single solid (no explode pack)", async () => {
    mockedCompile.mockResolvedValue(compileStl(makeAxisAlignedBoxMesh([20, 20, 20])));
    const result = await runGeneratePipeline({ prompt: "20mm cube with 5mm hole", fixture: true });
    expect(result.assembly?.isAssembly).toBe(false);
    expect(result.notes.join(" ")).not.toMatch(/Assembly \(/);
    expect(result.explodedStlUrl).toMatch(/exploded\.stl$/);
    const job = getJob(result.jobId);
    const parsed = await parse3mfDocument(job!.threemf);
    expect(parsed.objects).toHaveLength(1);
  });

  it("exports a hinged box as named 3MF parts with chat notes", async () => {
    mockedCompile.mockImplementation(async (code: string) => {
      if (code.includes("!box_body")) {
        return compileStl(makeAxisAlignedBoxMesh([40, 28, 14], [0, 0, 0]));
      }
      if (code.includes("!lid")) {
        return compileStl(makeAxisAlignedBoxMesh([40, 28, 2.4], [0, -30, 0]));
      }
      if (code.includes("!hinge_pin")) {
        return compileStl(makeAxisAlignedBoxMesh([18, 4, 4], [11, -2, 2]));
      }
      return compileStl({
        triangles: [
          ...makeAxisAlignedBoxMesh([40, 28, 14], [0, 0, 0]).triangles,
          ...makeAxisAlignedBoxMesh([40, 28, 2.4], [0, -30, 0]).triangles,
          ...makeAxisAlignedBoxMesh([18, 4, 4], [11, -2, 2]).triangles,
        ],
      });
    });

    const result = await runGeneratePipeline({ prompt: HINGE_FIXTURE_PROMPT, fixture: true });
    expect(result.usedFixture).toBe(true);
    expect(result.assembly?.isAssembly).toBe(true);
    expect(result.assembly?.source).toBe("joints");
    expect(result.assembly?.parts.map((part) => part.name)).toEqual(["box body", "lid", "hinge pin"]);
    expect(result.assembly?.kinematics).toBe(false);
    expect(result.notes.join(" ")).toMatch(/3 parts: box body, lid, hinge pin/i);
    expect(result.notes.join(" ")).toMatch(/not constraint-solved kinematics/i);
    expect(result.notes.join(" ")).not.toMatch(/3 color objects/i);

    const job = getJob(result.jobId);
    const exported = await parse3mfDocument(job!.threemf);
    expect(exported.objects).toHaveLength(3);
    expect(exported.objects.map((object) => object.name)).toEqual(["box body", "lid", "hinge pin"]);

    const exploded = await GET(new Request("http://localhost/api/jobs/x/exploded.stl"), {
      params: Promise.resolve({ id: result.jobId, file: "exploded.stl" }),
    });
    expect(exploded.status).toBe(200);
    expect(exploded.headers.get("Content-Disposition")).toMatch(/exploded\.stl/);

    const zipRes = await GET(new Request("http://localhost/api/jobs/x/parts.zip"), {
      params: Promise.resolve({ id: result.jobId, file: "parts.zip" }),
    });
    expect(zipRes.status).toBe(200);
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBytes);
    expect(Object.keys(zip.files).sort()).toEqual(["box_body.stl", "hinge_pin.stl", "lid.stl"]);

    const lid = await GET(new Request("http://localhost/api/jobs/x/part-lid.stl"), {
      params: Promise.resolve({ id: result.jobId, file: "part-lid.stl" }),
    });
    expect(lid.status).toBe(200);

    const packed = await partsZipBuffer(
      partsFromObjects(exported.objects.map((object) => ({ ...object, colorHex: object.colorHex }))),
    );
    expect(packed.subarray(0, 2).toString("utf8")).toBe("PK");
  });

  it("treats a two-color plaque as a color-region assembly", async () => {
    mockedCompile.mockImplementation(async (code: string) => {
      if (code.includes("!region_letters")) {
        return compileStl(makeAxisAlignedBoxMesh([4, 8, 1.6], [8, 6, 6]));
      }
      if (code.includes("!region_body")) {
        return compileStl(makeAxisAlignedBoxMesh([40, 20, 6]));
      }
      return compileStl(makeAxisAlignedBoxMesh([40, 20, 7.6]));
    });
    const result = await runGeneratePipeline({
      prompt: "red 40mm plaque with black letters",
      fixture: true,
    });
    expect(result.colorRegions).toHaveLength(2);
    expect(result.assembly?.isAssembly).toBe(true);
    expect(result.assembly?.source).toBe("color-regions");
    expect(result.notes.join(" ")).toMatch(/2 color objects/i);
    expect(result.notes.join(" ")).toMatch(/Assembly \(2 parts/i);
  });
});
