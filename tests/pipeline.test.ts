import { afterEach, describe, expect, it, vi } from "vitest";
import { CompileError } from "@/lib/compile";
import { completeChat } from "@/lib/llm";
import { compileOpenScad } from "@/lib/compile";
import { MAX_COMPILE_ATTEMPTS, MAX_COMPILE_RETRIES, runGeneratePipeline, runImportPipeline } from "@/lib/pipeline";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";
import type { StatusEvent } from "@/lib/types";

vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return { ...actual, completeChat: vi.fn() };
});

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const TRACKED = ["SMART_PIPELINE", "PLAN_MODEL", "MODEL", "USE_FIXTURE", "FORCE_LLM"] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev = new Map<string, string | undefined>();
  for (const key of TRACKED) {
    prev.set(key, process.env[key]);
    if (!(key in vars)) continue;
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const result = fn();
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).finally(finish);
  }
  finish();
  return result;
}

const PLAN_JSON = JSON.stringify({
  object: "cube",
  one_piece: true,
  units: "mm",
  overall_mm: { x: 20, y: 20, z: 20 },
  features: [{ name: "body", kind: "cube", dims_mm: { s: 20 } }],
  holes: [{ d: 5, purpose: "through" }],
  min_wall_mm: 1.6,
  clearance_mm: 0.3,
  sit_on_z0: true,
});

const WEAK_PLAN_JSON = JSON.stringify({
  object: "tray",
  one_piece: false,
  units: "mm",
  overall_mm: { x: 400, y: 400, z: 8 },
  features: [{ name: "wall", kind: "shell", dims_mm: { wall: 0.4 } }],
  holes: [{ d: 1, purpose: "pilot" }],
  min_wall_mm: 0.4,
  clearance_mm: 0.3,
  sit_on_z0: false,
});

const GOOD_SCAD = `$fn = 64;
cube(20);
`;

function validStl() {
  return writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 20]));
}

function disconnectedStl() {
  const a = makeAxisAlignedBoxMesh([10, 10, 10], [0, 0, 0]);
  const b = makeAxisAlignedBoxMesh([10, 10, 10], [40, 0, 0]);
  return writeBinaryStl({ triangles: [...a.triangles, ...b.triangles] });
}

function compileOk() {
  return {
    stl: validStl(),
    stderr: "",
    stdout: "",
    workDir: "/tmp/describeprint-test",
  };
}

const mockedChat = vi.mocked(completeChat);
const mockedCompile = vi.mocked(compileOpenScad);

describe("generate pipeline (local AI + fixtures)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixture/mock path without calling the LLM", async () => {
    mockedCompile.mockResolvedValue(compileOk());
    const events: StatusEvent[] = [];
    const result = await runGeneratePipeline(
      { prompt: "20mm cube with 5mm hole", fixture: true },
      (event) => events.push(event),
    );
    expect(result.usedFixture).toBe(true);
    expect(result.retried).toBe(false);
    expect(result.code).toMatch(/cube/);
    expect(mockedChat).not.toHaveBeenCalled();
    expect(events.some((e) => e.step === "codegen" && /fixture/i.test(e.message))).toBe(true);
  });

  it("does not retry the fixture path when compile fails", async () => {
    mockedCompile.mockRejectedValue(new CompileError("OpenSCAD exited with code 1: syntax error"));
    await expect(runGeneratePipeline({ prompt: "20mm cube with 5mm hole", fixture: true })).rejects.toThrow(
      /syntax error|OpenSCAD/,
    );
    expect(mockedChat).not.toHaveBeenCalled();
    expect(mockedCompile).toHaveBeenCalledTimes(1);
  });

  it("runs a two-pass plan → OpenSCAD when SMART_PIPELINE is on (default)", async () => {
    await withEnv({ SMART_PIPELINE: undefined, PLAN_MODEL: "qwen2.5-coder:14b", MODEL: undefined }, async () => {
      mockedChat.mockResolvedValueOnce(PLAN_JSON).mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());

      const events: StatusEvent[] = [];
      const result = await runGeneratePipeline(
        { prompt: "20mm cube with 5mm hole" },
        (event) => events.push(event),
      );

      expect(result.usedFixture).toBe(false);
      expect(result.retried).toBe(false);
      expect(result.code).toContain("cube(20)");
      expect(mockedChat).toHaveBeenCalledTimes(2);

      const [planMessages, planOpts] = mockedChat.mock.calls[0] as unknown as [
        { role: string; content: string }[],
        { model?: string },
      ];
      expect(planMessages[0]?.content).toMatch(/CAD planner/i);
      expect(planOpts?.model).toBe("qwen2.5-coder:14b");

      const [codeMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      expect(codeMessages[0]?.content).toMatch(/OpenSCAD for FDM/i);
      expect(codeMessages[1]?.content).toContain("Design plan");
      expect(codeMessages[1]?.content).toContain("20mm cube with 5mm hole");
      expect(events.some((e) => e.step === "planning" && /features and dimensions/i.test(e.message))).toBe(true);
    });
  });

  it("normalizes a weak plan to one-piece printable dims before codegen", async () => {
    await withEnv({ SMART_PIPELINE: "1" }, async () => {
      mockedChat.mockResolvedValueOnce(WEAK_PLAN_JSON).mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());
      await runGeneratePipeline({ prompt: "a sturdy tray" });
      const [codeMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      const user = codeMessages[1]?.content ?? "";
      expect(user).toContain("Design plan");
      expect(user).toMatch(/"one_piece":true/);
      expect(user).toMatch(/"min_wall_mm":1\.6/);
      expect(user).not.toMatch(/"wall":0\.4/);
      expect(user).toMatch(/"d":2\.5/);
    });
  });

  it("keeps print-in-place joints on a motion prompt and strips them otherwise", async () => {
    await withEnv({ SMART_PIPELINE: "1" }, async () => {
      const hingePlan = JSON.stringify({
        object: "box",
        one_piece: false,
        units: "mm",
        features: [{ name: "lid", kind: "hinge" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.4,
        joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
        clearance_intent: "print-in-place",
        sit_on_z0: true,
      });
      mockedChat.mockResolvedValueOnce(hingePlan).mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());
      await runGeneratePipeline({ prompt: "hinged box lid print-in-place" });
      const [codeMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      const user = codeMessages[1]?.content ?? "";
      expect(user).toMatch(/"one_piece":true/);
      expect(user).toMatch(/"clearance_intent":"print-in-place"/);
      expect(user).toMatch(/"type":"hinge"/);
      expect(user).toMatch(/do not union moving members/i);

      mockedChat.mockClear();
      mockedChat.mockResolvedValueOnce(hingePlan).mockResolvedValueOnce(GOOD_SCAD);
      await runGeneratePipeline({ prompt: "a sturdy tray" });
      const [trayMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      const trayUser = trayMessages[1]?.content ?? "";
      expect(trayUser).toMatch(/"one_piece":true/);
      expect(trayUser).not.toMatch(/"type":"hinge"/);

      mockedChat.mockClear();
      const ballPlan = JSON.stringify({
        object: "ball joint",
        one_piece: false,
        units: "mm",
        features: [{ name: "socket", kind: "ball" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.5,
        joints: [{ type: "ball", intent: "print-in-place", radial_mm: 0.5, axial_mm: 0.5 }],
        clearance_intent: "print-in-place",
        sit_on_z0: true,
      });
      mockedChat.mockResolvedValueOnce(ballPlan).mockResolvedValueOnce(GOOD_SCAD);
      await runGeneratePipeline({ prompt: "print-in-place ball joint" });
      const [ballMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      const ballUser = ballMessages[1]?.content ?? "";
      expect(ballUser).toMatch(/"type":"ball"/);
      expect(ballUser).toMatch(/real CSG/i);
      expect(ballUser).not.toMatch(/stubs with those gaps/);
    });
  });

  it("falls back to single codegen when the plan JSON is unusable", async () => {
    await withEnv({ SMART_PIPELINE: "1" }, async () => {
      mockedChat.mockResolvedValueOnce("I refuse to plan this").mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());
      const result = await runGeneratePipeline({ prompt: "20mm cube with 5mm hole" });
      expect(result.usedFixture).toBe(false);
      expect(mockedChat).toHaveBeenCalledTimes(2);
      const [codeMessages] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      expect(codeMessages[1]?.content).not.toContain("Design plan");
    });
  });

  it("skips the planning pass when SMART_PIPELINE=0", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      mockedChat.mockResolvedValue(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());
      await runGeneratePipeline({ prompt: "20mm cube with 5mm hole" });
      expect(mockedChat).toHaveBeenCalledTimes(1);
      const [messages] = mockedChat.mock.calls[0] as unknown as [{ role: string; content: string }[]];
      expect(messages[0]?.content).toMatch(/OpenSCAD for FDM/i);
      expect(messages[1]?.content).not.toContain("Design plan");
    });
  });

  it("retries up to twice with structured compiler feedback", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      expect(MAX_COMPILE_RETRIES).toBe(2);
      expect(MAX_COMPILE_ATTEMPTS).toBe(3);

      mockedChat
        .mockResolvedValueOnce("cube(20)")
        .mockResolvedValueOnce("cube(20); // retry 1")
        .mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile
        .mockRejectedValueOnce(new CompileError("ERROR: Parser error in file, line 1: syntax error"))
        .mockRejectedValueOnce(new Error("Mesh check failed: non-manifold"))
        .mockResolvedValue(compileOk());

      const events: StatusEvent[] = [];
      const result = await runGeneratePipeline(
        { prompt: "20mm cube with 5mm hole" },
        (event) => events.push(event),
      );

      expect(result.retried).toBe(true);
      expect(result.usedFixture).toBe(false);
      expect(mockedChat).toHaveBeenCalledTimes(3);
      expect(mockedCompile).toHaveBeenCalledTimes(3);

      const retry1 = mockedChat.mock.calls[1][0] as { role: string; content: string }[];
      const retry2 = mockedChat.mock.calls[2][0] as { role: string; content: string }[];
      expect(retry1[1]?.content).toMatch(/Fix instructions/i);
      expect(retry1[1]?.content).toMatch(/Parser error/i);
      expect(retry2[1]?.content).toMatch(/Mesh check failed/i);
      expect(retry2[1]?.content).toMatch(/closed solid/i);
      expect(events.filter((e) => e.step === "retry")).toHaveLength(2);
      expect(events.some((e) => e.step === "retry" && e.attempt === 3)).toBe(true);
    });
  });

  it("retries when the mesh is disconnected even if compile succeeded", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      mockedChat.mockResolvedValueOnce("cube(20);").mockResolvedValueOnce(GOOD_SCAD);
      mockedCompile
        .mockResolvedValueOnce({
          stl: disconnectedStl(),
          stderr: "",
          stdout: "",
          workDir: "/tmp/describeprint-test",
        })
        .mockResolvedValue(compileOk());

      const events: StatusEvent[] = [];
      const result = await runGeneratePipeline({ prompt: "20mm cube with 5mm hole" }, (event) =>
        events.push(event),
      );
      expect(result.retried).toBe(true);
      expect(mockedChat).toHaveBeenCalledTimes(2);
      const retry = mockedChat.mock.calls[1][0] as { role: string; content: string }[];
      expect(retry[1]?.content).toMatch(/disconnected/i);
      expect(retry[1]?.content).toMatch(/one connected solid/i);
      expect(events.some((e) => e.step === "retry" && /Printability/i.test(e.message))).toBe(true);
    });
  });

  it("keeps chat follow-up previousCode on the live path", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      mockedChat.mockResolvedValue(GOOD_SCAD);
      mockedCompile.mockResolvedValue(compileOk());
      await runGeneratePipeline({
        prompt: "make the hole 8mm",
        previousPrompt: "20mm cube with 5mm hole",
        previousCode: "cube(20);",
      });
      const [messages] = mockedChat.mock.calls[0] as unknown as [{ role: string; content: string }[]];
      expect(messages[1]?.content).toContain("follow-up");
      expect(messages[1]?.content).toContain("cube(20);");
      expect(messages[1]?.content).toContain("make the hole 8mm");
    });
  });

  it("wraps an imported mesh with OpenSCAD for a described hole", async () => {
    mockedCompile.mockResolvedValue(compileOk());
    const imported = await runImportPipeline({
      buffer: writeBinaryStl(makeAxisAlignedBoxMesh([40, 20, 10])),
      fileName: "part.stl",
    });
    const result = await runGeneratePipeline({
      prompt: "add an 8mm hole through the center",
      previousJobId: imported.jobId,
      previousSource: "imported-mesh",
      previousPrompt: "Imported part.stl",
      fixture: true,
    });
    expect(result.source).toBe("imported-mesh");
    expect(result.editMode).toBe("describe-wrapper");
    expect(result.code).toMatch(/import\("imported\.stl"/);
    expect(result.code).toMatch(/hole_d = 8/);
    expect(result.code).toMatch(/difference\(\)/);
    expect(result.code).toMatch(/cylinder\(h = 12, d = hole_d\)/);
    expect(result.notes.join(" ")).toMatch(/through-hole/i);
    expect(mockedChat).not.toHaveBeenCalled();
    expect(mockedCompile).toHaveBeenCalled();
    const compiledCode = mockedCompile.mock.calls[0]?.[0] as string;
    expect(compiledCode).toMatch(/import\("imported\.stl"/);
    expect(compiledCode.indexOf("import")).toBeLessThan(compiledCode.indexOf("cylinder"));
  });

  it("uses the engineering wrap for a simple live hole without calling the model", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      mockedCompile.mockResolvedValue(compileOk());
      const imported = await runImportPipeline({
        buffer: writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 20])),
        fileName: "cube.stl",
      });
      const result = await runGeneratePipeline({
        prompt: "add an 8 mm hole through the center",
        previousJobId: imported.jobId,
        previousSource: "imported-mesh",
        previousPrompt: "Imported cube.stl",
      });
      expect(mockedChat).not.toHaveBeenCalled();
      expect(result.code).toMatch(/difference\(\)/);
      expect(result.code).toMatch(/hole_d = 8/);
      expect(result.code).toMatch(/import\("imported\.stl"/);
    });
  });

  it("asks the live model for a complex imported-mesh wrap and repairs without starting over", async () => {
    await withEnv({ SMART_PIPELINE: "0" }, async () => {
      mockedChat
        .mockResolvedValueOnce("cube(20);")
        .mockResolvedValueOnce(
          'difference() { import("imported.stl", convexity = 10); cylinder(h=12, d=8); }',
        );
      mockedCompile.mockResolvedValue(compileOk());
      const imported = await runImportPipeline({
        buffer: writeBinaryStl(makeAxisAlignedBoxMesh([40, 20, 10])),
        fileName: "part.stl",
      });
      const events: StatusEvent[] = [];
      await runGeneratePipeline(
        {
          prompt: "fillet the edges and add an 8mm hole",
          previousJobId: imported.jobId,
          previousSource: "imported-mesh",
          previousPrompt: "Imported part.stl",
        },
        (event) => events.push(event),
      );
      expect(mockedChat).toHaveBeenCalledTimes(2);
      const [first] = mockedChat.mock.calls[0] as unknown as [{ role: string; content: string }[]];
      expect(first[0]?.content).toMatch(/imported triangle mesh/i);
      expect(first[0]?.content).toMatch(/import\("imported\.stl"/);
      expect(first[0]?.content).not.toMatch(/minicpm5|smith-/i);
      expect(first[1]?.content).toMatch(/Host solid MUST/i);
      expect(first[1]?.content).toContain("40.00");
      expect(first[1]?.content).toMatch(/Hole spec/i);

      const [retry] = mockedChat.mock.calls[1] as unknown as [{ role: string; content: string }[]];
      expect(retry[1]?.content).toMatch(/must keep import/i);
      expect(retry[1]?.content).toMatch(/do not start over/i);
      expect(retry[1]?.content).not.toMatch(/rebuild with cube\/cylinder\/sphere/i);
      expect(events.some((e) => e.step === "retry")).toBe(true);
    });
  });
});
