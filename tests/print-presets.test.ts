import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/jobs/[id]/[file]/route";
import { compileOpenScad } from "@/lib/compile";
import { parsePrintDoctorBody } from "@/lib/machine/api";
import { getJob } from "@/lib/jobs";
import { runGeneratePipeline } from "@/lib/pipeline";
import { printPresetSummary } from "@/lib/printers";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import { meshesTo3mf, parse3mfDocument } from "@/lib/threemf";

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const mockedCompile = vi.mocked(compileOpenScad);

describe("P2S auto-best export metadata", () => {
  it("writes 3MF preset fields and a package sidecar without breaking the zip", async () => {
    const preset = printPresetSummary("pa");
    const bytes = await meshesTo3mf(
      [{ name: "part", mesh: makeAxisAlignedBoxMesh([10, 10, 8]), colorHex: "#C4C4C8", filament: "pa", extruder: 1 }],
      "DescribePrint",
      preset,
    );

    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    const zip = await JSZip.loadAsync(bytes);
    const model = await zip.file("3D/3dmodel.model")?.async("string");
    expect(model).toContain("<metadata name=\"DescribePrint:preset_material\">pa</metadata>");
    expect(model).toContain("<metadata name=\"DescribePrint:preset_nozzle_c\">270</metadata>");
    expect(model).toContain("<metadata name=\"DescribePrint:preset_bed_c\">100</metadata>");
    expect(model).toContain("<metadata name=\"DescribePrint:preset_speed_tier\">slow</metadata>");
    expect(model).toContain("<metadata name=\"DescribePrint:preset_advisory\">true</metadata>");

    const sidecar = JSON.parse((await zip.file("Metadata/print_preset.json")?.async("string")) ?? "{}") as {
      material?: string;
      advisory?: boolean;
    };
    expect(sidecar.material).toBe("pa");
    expect(sidecar.advisory).toBe(true);

    const parsed = await parse3mfDocument(bytes);
    expect(parsed.printPreset?.material).toBe("pa");
    expect(parsed.printPreset?.nozzleC).toBe(270);
    expect(parsed.objects[0]?.filament).toBe("pa");
  });

  it("stamps the selected material onto fixture export + job sidecar JSON", async () => {
    mockedCompile.mockResolvedValue({
      stl: writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 20])),
      stderr: "",
      stdout: "",
      workDir: "/tmp/describeprint-preset-test",
    });
    const generated = await runGeneratePipeline({
      prompt: "20mm cube with 5mm hole",
      fixture: true,
      filament: "petg",
    });
    expect(generated.printPreset.material).toBe("petg");
    expect(generated.printPreset.advisory).toBe(true);
    expect(generated.printPreset.nozzleC).toBe(250);
    expect(generated.printPresetUrl).toMatch(/model\.print\.json$/);

    const job = getJob(generated.jobId);
    expect(job?.printPreset.material).toBe("petg");
    const parsed = await parse3mfDocument(job!.threemf);
    expect(parsed.printPreset?.material).toBe("petg");

    const response = await GET(new Request("http://localhost/api/jobs/x/model.print.json"), {
      params: Promise.resolve({ id: generated.jobId, file: "model.print.json" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { material?: string; advisory?: boolean; nozzleC?: number };
    expect(body.material).toBe("petg");
    expect(body.advisory).toBe(true);
    expect(body.nozzleC).toBe(250);

    const stl = await GET(new Request("http://localhost/api/jobs/x/model.stl"), {
      params: Promise.resolve({ id: generated.jobId, file: "model.stl" }),
    });
    expect(stl.status).toBe(200);
    expect(stl.headers.get("Content-Type")).toMatch(/sla|octet|stl/i);
  });
});

describe("material session on print-doctor API body", () => {
  it("parses a selected material without treating it as a LAN command", () => {
    expect(parsePrintDoctorBody({ complaint: "use PETG settings", material: "pla" })).toMatchObject({
      complaint: "use PETG settings",
      material: "pla",
    });
    expect(parsePrintDoctorBody({ command: { type: "pause" } })).toBeNull();
  });
});
