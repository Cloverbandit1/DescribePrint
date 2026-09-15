import { afterEach, describe, expect, it } from "vitest";
import { getHealthReport, modelIsInstalled, openscadFixTips } from "@/lib/health";
import { DEFAULT_MODEL, DEFAULT_OPENAI_BASE_URL, LOCAL_AI_START_MESSAGE } from "@/lib/llm-config";

const TRACKED = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL", "USE_FIXTURE"] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev = new Map<string, string | undefined>();
  for (const key of TRACKED) {
    prev.set(key, process.env[key]);
    if (!(key in vars)) continue;
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const result = fn();
  if (result && typeof result === "object" && "then" in result) {
    return result.finally(restore);
  }
  restore();
  return result;
}

describe("health report", () => {
  afterEach(() => {
    delete process.env.USE_FIXTURE;
  });

  it("matches the configured MODEL exactly (32b is not satisfied by 7b)", () => {
    expect(modelIsInstalled(["qwen2.5-coder:32b"], DEFAULT_MODEL)).toBe(true);
    expect(modelIsInstalled(["qwen2.5-coder:7b", "smith-minicpm5"], DEFAULT_MODEL)).toBe(false);
    expect(modelIsInstalled(["qwen2.5-coder:32b"], "qwen2.5-coder:14b")).toBe(false);
  });

  it("explains a missing OpenSCAD with OPENSCAD_PATH / portable tips", () => {
    const tips = openscadFixTips(false, "missing", "openscad.exe");
    expect(tips.some((tip) => /openscad\.org/i.test(tip))).toBe(true);
    expect(tips.some((tip) => /OPENSCAD_PATH/.test(tip))).toBe(true);
    expect(tips.some((tip) => /vendor\/openscad/.test(tip))).toBe(true);
  });

  it("flags a downed local Ollama and keeps the default port / Agent Smith isolation", async () => {
    await withEnv(
      { OPENAI_BASE_URL: undefined, OPENAI_API_KEY: undefined, MODEL: undefined, USE_FIXTURE: undefined },
      async () => {
        const report = await getHealthReport({
          probeLocalModels: async () => ({ reachable: false, models: [] }),
          resolveOpenscad: () => ({
            command: "openscad",
            found: true,
            source: "path",
            candidates: ["/usr/bin/openscad"],
          }),
          probeOpenscadVersion: async () => "2021.01",
        });
        expect(report.localAi.mode).toBe("local");
        expect(report.localAi.model).toBe(DEFAULT_MODEL);
        expect(report.localAi.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
        expect(report.localAi.reachable).toBe(false);
        expect(report.localAi.tone).toBe("danger");
        expect(report.ready).toBe(false);
        expect(report.localAi.tips.join(" ")).toContain(LOCAL_AI_START_MESSAGE);
        expect(report.localAi.tips.join(" ")).toMatch(/11434/);
        expect(report.localAi.tips.join(" ")).toMatch(/Agent Smith/);
        expect(report.localAi.tips.join(" ")).not.toMatch(/11435/);
        expect(report.openscad.found).toBe(true);
        expect(report.printer.name).toBe("Bambu Lab P2S");
      },
    );
  });

  it("asks to pull the configured 32b model when Ollama is up but the model is missing", async () => {
    await withEnv({ MODEL: undefined, USE_FIXTURE: undefined }, async () => {
      const report = await getHealthReport({
        probeLocalModels: async () => ({ reachable: true, models: ["smith-minicpm5", "qwen2.5-coder:7b"] }),
        resolveOpenscad: () => ({
          command: "C:\\Program Files\\OpenSCAD\\openscad.exe",
          found: true,
          source: "windows-install",
          candidates: [],
        }),
        probeOpenscadVersion: async () => "2024.12",
      });
      expect(report.localAi.modelPresent).toBe(false);
      expect(report.localAi.tone).toBe("warn");
      expect(report.localAi.tips.join(" ")).toContain("ollama pull qwen2.5-coder:32b");
      expect(report.localAi.tips.join(" ")).toMatch(/Agent Smith/);
      expect(report.ready).toBe(false);
    });
  });

  it("is ready when Ollama has the 32b model and OpenSCAD is found", async () => {
    await withEnv({ MODEL: undefined, USE_FIXTURE: undefined }, async () => {
      const report = await getHealthReport({
        probeLocalModels: async () => ({ reachable: true, models: ["qwen2.5-coder:32b"] }),
        resolveOpenscad: () => ({
          command: "/usr/bin/openscad",
          found: true,
          source: "linux-install",
          candidates: [],
        }),
        probeOpenscadVersion: async () => "2021.01",
      });
      expect(report.ready).toBe(true);
      expect(report.localAi.tone).toBe("ok");
      expect(report.localAi.model).toBe("qwen2.5-coder:32b");
      expect(report.openscad.version).toBe("2021.01");
    });
  });

  it("does not require Ollama when the fixture path is forced", async () => {
    await withEnv({ USE_FIXTURE: "true" }, async () => {
      const report = await getHealthReport({
        probeLocalModels: async () => {
          throw new Error("should not probe Ollama in fixture mode");
        },
        resolveOpenscad: () => ({
          command: "openscad",
          found: true,
          source: "path",
          candidates: [],
        }),
        probeOpenscadVersion: async () => "2021.01",
      });
      expect(report.localAi.mode).toBe("fixture");
      expect(report.ready).toBe(true);
    });
  });
});
