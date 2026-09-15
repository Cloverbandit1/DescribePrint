import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanPrompt,
  buildRepairPrompt,
  buildUserPrompt,
  importedMeshSystemPrompt,
  classifyCompileIssue,
  completeChat,
  LOCAL_AI_START_MESSAGE,
  normalizeCadPlan,
  parseCadPlan,
  planSystemPrompt,
  REPAIR_INSTRUCTIONS,
  systemPrompt,
  toUserFacingLlmError,
} from "@/lib/llm";
import { DEFAULT_MODEL, DEFAULT_OPENAI_BASE_URL, getLlmConfig } from "@/lib/llm-config";

const TRACKED = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL"] as const;

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

describe("LLM prompt", () => {
  it("asks for a fresh part when there is no prior design", () => {
    const prompt = buildUserPrompt({ prompt: "20mm cube with 5mm hole", sizeNote: "" });
    expect(prompt).toContain("20mm cube with 5mm hole");
    expect(prompt).not.toContain("follow-up");
  });

  it("includes the current OpenSCAD on a conversation follow-up", () => {
    const prompt = buildUserPrompt({
      prompt: "make the hole 8mm",
      sizeNote: "",
      previousPrompt: "20mm cube with 5mm hole",
      previousCode: "cube(20);",
    });
    expect(prompt).toContain("follow-up");
    expect(prompt).toContain("cube(20);");
    expect(prompt).toContain("20mm cube with 5mm hole");
    expect(prompt).toMatch(/only the user's latest change/i);
  });

  it("preserves named OpenSCAD parameters on a follow-up edit", () => {
    const prompt = buildUserPrompt({
      prompt: "make the hole 8mm",
      sizeNote: "",
      previousPrompt: "20mm cube with 5mm hole",
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
    });
    expect(prompt).toContain("size=20");
    expect(prompt).toContain("hole_d=5");
    expect(prompt).toMatch(/Preserve these named parameters/i);
  });

  it("strengthens the CAD system prompt for printable engineering", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/1 unit = 1 mm/i);
    expect(prompt).toMatch(/manifold/i);
    expect(prompt).toMatch(/wall thickness/i);
    expect(prompt).toMatch(/clearance/i);
    expect(prompt).toMatch(/one piece/i);
    expect(prompt).toMatch(/import\(\)/i);
    expect(prompt).toMatch(/safe/i);
    expect(planSystemPrompt()).toMatch(/ONLY compact JSON/i);
    expect(planSystemPrompt()).toMatch(/min_wall_mm/i);
    expect(planSystemPrompt()).toMatch(/color_regions/i);
    expect(prompt).toMatch(/region_<name>/i);
    expect(prompt).toMatch(/256 × 256 × 256 mm/);
    expect(prompt).toMatch(/0\.4 mm/);
    expect(planSystemPrompt()).toMatch(/256 × 256 × 256 mm/);
    expect(planSystemPrompt()).toMatch(/through-holes fully pierce/i);
    expect(prompt).toMatch(/print-in-place/i);
    expect(prompt).toMatch(/never union/i);
    expect(planSystemPrompt()).toMatch(/"type":"hinge\|pin\|ball\|snap"/);
    expect(planSystemPrompt()).toMatch(/omit the joints array unless/i);
    expect(planSystemPrompt()).toMatch(/"kind":"emboss\|etch"/);
    expect(planSystemPrompt()).toMatch(/omit the reliefs array unless/i);
    expect(planSystemPrompt()).toMatch(/omit pretty_up unless/i);
    expect(planSystemPrompt()).toMatch(/omit lattice unless/i);
    expect(planSystemPrompt()).toMatch(/omit fit unless/i);
    expect(planSystemPrompt()).toMatch(/"kind":"snap\|press\|sliding\|wearable\|hinge"/);
    expect(planSystemPrompt()).toMatch(/omit the knowledge object unless/i);
    expect(planSystemPrompt()).toMatch(/not a live web crawl/i);
    expect(prompt).toMatch(/Raised etchings \/ emboss/i);
    expect(prompt).toMatch(/Pretty-up \/ restyle/i);
    expect(prompt).toMatch(/captive by default/i);
    expect(prompt).toMatch(/cantilever hook/i);
    expect(planSystemPrompt()).toMatch(/real CSG/i);
    expect(planSystemPrompt()).not.toMatch(/clearance stubs/);
  });

  it("embeds a design plan in the codegen prompt", () => {
    const prompt = buildUserPrompt({
      prompt: "phone stand",
      sizeNote: "",
      plan: {
        object: "phone stand",
        one_piece: true,
        units: "mm",
        features: [{ name: "base", dims_mm: { w: 76, d: 78, h: 4 } }],
        holes: [{ d: 14, purpose: "cable" }],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        sit_on_z0: true,
      },
    });
    expect(prompt).toContain("Design plan");
    expect(prompt).toContain("phone stand");
    expect(prompt).toContain("76");

    const jointed = buildUserPrompt({
      prompt: "print-in-place ball joint",
      sizeNote: "",
      plan: {
        object: "ball joint",
        one_piece: true,
        units: "mm",
        features: [{ name: "socket" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.5,
        sit_on_z0: true,
        joints: [{ type: "ball", intent: "print-in-place", radial_mm: 0.5, axial_mm: 0.5 }],
        clearance_intent: "print-in-place",
      },
    });
    expect(jointed).toMatch(/real CSG/i);
    expect(jointed).toMatch(/captive socket \+ ball/i);
    expect(jointed).not.toMatch(/stubs with those gaps/);
  });

  it("feeds compiler errors back with structured repair instructions", () => {
    const prompt = buildUserPrompt({
      prompt: "20mm cube",
      sizeNote: "",
      previousError: "ERROR: Parser error in file model.scad, line 3: syntax error",
      previousCode: "cube(20)",
    });
    expect(prompt).toContain(REPAIR_INSTRUCTIONS);
    expect(prompt).toContain("ERROR: Parser error");
    expect(prompt).toContain("cube(20)");
    expect(prompt).toMatch(/semicolons and braces/i);
    expect(prompt).toContain("User request:");
  });

  it("classifies mesh and timeout failures into repair hints", () => {
    expect(classifyCompileIssue("Mesh check failed: non-manifold")).toEqual(
      expect.arrayContaining([expect.stringMatching(/closed solid/i)]),
    );
    expect(classifyCompileIssue("Floating island: 2 disconnected solids")).toEqual(
      expect.arrayContaining([expect.stringMatching(/one connected solid/i)]),
    );
    expect(classifyCompileIssue("Floating island: 2 disconnected solids", { printInPlace: true })).toEqual(
      expect.arrayContaining([expect.stringMatching(/do not union the pin/i)]),
    );
    expect(classifyCompileIssue("Part does not sit on z=0 (lowest Z is 12.0 mm)")).toEqual(
      expect.arrayContaining([expect.stringMatching(/z=0/i)]),
    );
    expect(classifyCompileIssue("OpenSCAD timed out after 45000ms")).toEqual(
      expect.arrayContaining([expect.stringMatching(/Simplify geometry/i)]),
    );
    const repair = buildRepairPrompt({
      error: "unknown variable 'hole_d'",
      previousCode: "size = 20;\nhole_d = 5;\ncube(size);",
    });
    expect(repair).toMatch(/Define every variable/i);
    expect(repair).toContain("size=20");
    expect(repair).toContain("hole_d=5");
  });

  it("builds an imported-mesh wrapper prompt without retargeting Agent Smith", () => {
    const prompt = buildUserPrompt({
      prompt: "add an 8mm hole",
      sizeNote: "",
      importedMesh: {
        fileName: "mask.stl",
        sizeMm: [40, 20, 10],
        minMm: [0, 0, 0],
        maxMm: [40, 20, 10],
        triangleCount: 12,
        volumeMm3: 8000,
      },
    });
    expect(prompt).toMatch(/import\("imported\.stl"/);
    expect(prompt).toContain("mask.stl");
    expect(prompt).toContain("8mm hole");
    expect(importedMeshSystemPrompt()).toMatch(/imported triangle mesh/i);
    expect(importedMeshSystemPrompt()).toMatch(/256 × 256 × 256 mm/);
    expect(importedMeshSystemPrompt()).toMatch(/FIRST import/i);
    expect(importedMeshSystemPrompt()).not.toMatch(/minicpm5|smith-/i);

    const repair = buildUserPrompt({
      prompt: "add an 8mm hole",
      sizeNote: "",
      previousError: "difference() is inverted: import(\"imported.stl\") must be the first child",
      previousCode: 'difference() { cylinder(h=12, d=8); import("imported.stl"); }',
      importedMesh: {
        fileName: "mask.stl",
        sizeMm: [40, 20, 10],
        minMm: [0, 0, 0],
        maxMm: [40, 20, 10],
        triangleCount: 12,
        volumeMm3: 8000,
      },
    });
    expect(repair).toMatch(/do not start over/i);
    expect(repair).toMatch(/import\("imported\.stl"/);
    expect(repair).not.toMatch(/rebuild with cube\/cylinder\/sphere/i);
    expect(repair).not.toMatch(/rewrite a simpler one-piece solid that still matches/i);
  });

  it("builds a short planning prompt for follow-up edits", () => {
    const prompt = buildPlanPrompt({
      prompt: "make the hole 8mm",
      sizeNote: "",
      previousPrompt: "20mm cube with 5mm hole",
      previousCode: "cube(20);",
    });
    expect(prompt).toContain("compact JSON");
    expect(prompt).toContain("follow-up");
    expect(prompt).toContain("cube(20);");
    expect(prompt).toMatch(/Keep one_piece true/i);
    expect(prompt).toMatch(/Keep joints only if they still want motion/i);
    expect(prompt).toMatch(/Keep reliefs only if they still want emboss\/etch/i);
  });

  it("parses a CAD plan from raw or fenced JSON and rejects junk", () => {
    const raw = parseCadPlan(`\`\`\`json
{"object":"knob","one_piece":true,"features":[{"name":"cap","kind":"sphere","dims_mm":{"d":40}}],"holes":[{"d":5}],"min_wall_mm":1.6,"clearance_mm":0.3}
\`\`\``);
    expect(raw?.object).toBe("knob");
    expect(raw?.units).toBe("mm");
    expect(raw?.features[0]?.dims_mm?.d).toBe(40);
    expect(raw?.holes[0]?.d).toBe(5);
    expect(raw?.holes[0]?.through).toBe(true);
    expect(raw?.sit_on_z0).toBe(true);
    expect(raw?.color_regions).toBeUndefined();
    const withJoints = parseCadPlan(
      JSON.stringify({
        object: "box",
        features: [{ name: "lid" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.4,
        joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
        clearance_intent: "print-in-place",
      }),
    );
    expect(withJoints?.joints?.[0]).toMatchObject({ type: "hinge", intent: "print-in-place", radial_mm: 0.4 });
    expect(withJoints?.clearance_intent).toBe("print-in-place");
    expect(parseCadPlan("not json at all")).toBeNull();
    expect(parseCadPlan('{"hello":true}')).toBeNull();
  });

  it("normalizes plans to one-piece, printable walls, through-holes, and bed fit", () => {
    const raw = parseCadPlan(
      JSON.stringify({
        object: "tray",
        one_piece: false,
        overall_mm: { x: 400, y: 400, z: 20 },
        features: [{ name: "wall", dims_mm: { wall: 0.4 } }],
        holes: [{ d: 1.2, purpose: "screw" }],
        min_wall_mm: 0.4,
        clearance_mm: 0.3,
        sit_on_z0: false,
      }),
    );
    expect(raw).not.toBeNull();
    const plan = normalizeCadPlan(raw!, { prompt: "a sturdy tray" });
    expect(plan.one_piece).toBe(true);
    expect(plan.sit_on_z0).toBe(true);
    expect(plan.min_wall_mm).toBe(1.6);
    expect(plan.features[0]?.dims_mm?.wall).toBe(1.6);
    expect(plan.holes[0]?.d).toBe(2.5);
    expect(plan.holes[0]?.through).toBe(true);
    expect(Math.max(plan.overall_mm!.x, plan.overall_mm!.y, plan.overall_mm!.z)).toBeLessThanOrEqual(256);

    const assembly = normalizeCadPlan(raw!, { prompt: "print as an assembly with two pieces" });
    expect(assembly.one_piece).toBe(false);

    const userSized = normalizeCadPlan(raw!, { prompt: "400mm square tray" });
    expect(userSized.overall_mm?.x).toBe(400);
    expect(userSized.min_wall_mm).toBe(1.6);

    const thin = normalizeCadPlan(raw!, { prompt: "0.8mm wall clip" });
    expect(thin.min_wall_mm).toBe(0.8);
    expect(thin.features[0]?.dims_mm?.wall).toBe(0.8);

    const hallucinatedJoints = parseCadPlan(
      JSON.stringify({
        object: "tray",
        features: [{ name: "body" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        joints: [{ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }],
        clearance_intent: "print-in-place",
      }),
    );
    const stillOnePiece = normalizeCadPlan(hallucinatedJoints!, { prompt: "a sturdy tray" });
    expect(stillOnePiece.one_piece).toBe(true);
    expect(stillOnePiece.joints).toBeUndefined();
    expect(stillOnePiece.clearance_intent).toBeUndefined();

    const hinged = normalizeCadPlan(hallucinatedJoints!, { prompt: "hinged box lid print-in-place" });
    expect(hinged.one_piece).toBe(true);
    expect(hinged.clearance_intent).toBe("print-in-place");
    expect(hinged.joints?.[0]).toMatchObject({ type: "hinge", radial_mm: 0.4, axial_mm: 0.5 });
    expect(hinged.clearance_mm).toBe(0.4);

    const fromBallJson = parseCadPlan(
      JSON.stringify({
        object: "ball",
        features: [{ name: "socket" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.5,
        joints: [{ type: "ball", intent: "print-in-place", radial_mm: 0.5, axial_mm: 0.5 }],
      }),
    );
    const ball = normalizeCadPlan(fromBallJson!, { prompt: "print-in-place ball joint" });
    expect(ball.joints?.[0]).toMatchObject({ type: "ball", radial_mm: 0.5, axial_mm: 0.5 });
    const fromSnapJson = parseCadPlan(
      JSON.stringify({
        object: "clip",
        features: [{ name: "hook" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        joints: [{ type: "snap", intent: "print-in-place", radial_mm: 0.3, axial_mm: 0.5 }],
      }),
    );
    const snap = normalizeCadPlan(fromSnapJson!, { prompt: "snap-fit clip" });
    expect(snap.joints?.[0]).toMatchObject({ type: "snap", radial_mm: 0.3 });

    const colored = parseCadPlan(
      JSON.stringify({
        object: "plaque",
        features: [{ name: "body" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        color_regions: [
          { name: "body", color: "red" },
          { name: "letters", color: "black", filament: "pla", ams_slot: 2 },
        ],
      }),
    );
    expect(colored?.color_regions).toHaveLength(2);
    const normalized = normalizeCadPlan(colored!, { prompt: "red body, black letters" });
    expect(normalized.color_regions?.[0]).toMatchObject({ hex: "#FF0000", ams_slot: 1 });
    expect(normalized.color_regions?.[1]).toMatchObject({ hex: "#1A1A1A", filament: "pla" });
  });
});

describe("LLM client (Ollama / OpenAI-compatible)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("calls local Ollama with default key, model, and no org headers", async () => {
    await withEnv(
      { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, MODEL: undefined },
      async () => {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ choices: [{ message: { content: "cube(10);" } }] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const content = await completeChat([{ role: "user", content: "a cube" }]);
        expect(content).toBe("cube(10);");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`${DEFAULT_OPENAI_BASE_URL}/chat/completions`);
        const headers = init.headers as Record<string, string>;
        expect(headers).toEqual({
          Authorization: "Bearer ollama",
          "Content-Type": "application/json",
        });
        expect(headers).not.toHaveProperty("OpenAI-Organization");
        expect(headers).not.toHaveProperty("OpenAI-Project");
        expect(headers).not.toHaveProperty("OpenAI-Beta");

        const body = JSON.parse(String(init.body)) as { model: string; messages: unknown };
        expect(body.model).toBe(DEFAULT_MODEL);
        expect(body.model).toBe("qwen2.5-coder:32b");
        expect(body.model).not.toMatch(/minicpm5|smith-/i);
      },
    );
  });

  it("honors a per-call model override (PLAN_MODEL / lighter coder)", async () => {
    await withEnv(
      { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, MODEL: undefined },
      async () => {
        const fetchMock = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ choices: [{ message: { content: "{}" } }] }),
        });
        vi.stubGlobal("fetch", fetchMock);
        await completeChat([{ role: "user", content: "plan" }], { model: "qwen2.5-coder:14b", temperature: 0.1 });
        const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
          model: string;
          temperature: number;
        };
        expect(body.model).toBe("qwen2.5-coder:14b");
        expect(body.temperature).toBe(0.1);
      },
    );
  });

  it("maps a downed local Ollama to Start local AI (Ollama)", async () => {
    await withEnv(
      { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, MODEL: undefined },
      async () => {
        const err = new TypeError("fetch failed");
        (err as Error & { cause: Error }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
          code: "ECONNREFUSED",
        });
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));

        await expect(completeChat([{ role: "user", content: "a cube" }])).rejects.toThrow(
          LOCAL_AI_START_MESSAGE,
        );
        await expect(completeChat([{ role: "user", content: "a cube" }])).rejects.not.toThrow(/ECONNREFUSED|stack/i);
      },
    );
  });

  it("maps a local abort / timeout to Start local AI (Ollama)", async () => {
    await withEnv({ OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" }, async () => {
      const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
      await expect(completeChat([{ role: "user", content: "a cube" }])).rejects.toThrow(
        LOCAL_AI_START_MESSAGE,
      );
    });
  });

  it("maps a local 503 from a dead reverse-proxy to Start local AI (Ollama)", async () => {
    await withEnv({ OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" }, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          text: async () => "connection refused",
        }),
      );
      await expect(completeChat([{ role: "user", content: "a cube" }])).rejects.toThrow(
        LOCAL_AI_START_MESSAGE,
      );
    });
  });

  it("does not rewrite a cloud API error into the local Ollama hint", async () => {
    await withEnv({ OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_API_KEY: "sk-test" }, () => {
      const mapped = toUserFacingLlmError(new TypeError("fetch failed"), getLlmConfig());
      expect(mapped.message).toBe("fetch failed");
      expect(mapped.message).not.toBe(LOCAL_AI_START_MESSAGE);
    });
  });
});
