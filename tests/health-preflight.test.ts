import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthReport, LocalAiHealth, OpenscadHealth } from "@/lib/health-types";
import {
  evaluateHealthPreflight,
  formatHealthPreflight,
  loadEnvFile,
  PREFLIGHT_EXIT,
  preflightTextIsUnsafe,
  runHealthPreflight,
} from "@/lib/health-preflight";
import { DEFAULT_MODEL, DEFAULT_OPENAI_BASE_URL } from "@/lib/llm-config";

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

function sampleReport(partial: {
  localAi?: Partial<LocalAiHealth>;
  openscad?: Partial<OpenscadHealth>;
  ready?: boolean;
}): HealthReport {
  return {
    ready: partial.ready ?? false,
    localAi: {
      mode: "local",
      configured: true,
      reachable: true,
      model: DEFAULT_MODEL,
      modelPresent: true,
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      tone: "ok",
      label: "Local AI",
      detail: `${DEFAULT_MODEL} is ready at ${DEFAULT_OPENAI_BASE_URL}.`,
      tips: [],
      ...partial.localAi,
    },
    openscad: {
      found: true,
      path: "/usr/bin/openscad",
      source: "linux-install",
      version: "2021.01",
      tone: "ok",
      label: "OpenSCAD",
      detail: "/usr/bin/openscad · version 2021.01",
      tips: [],
      ...partial.openscad,
    },
    printer: {
      id: "bambu-p2s",
      name: "Bambu Lab P2S",
      buildVolumeMm: [256, 256, 256],
    },
  };
}

function assertSmithSafe(text: string) {
  expect(preflightTextIsUnsafe(text)).toBe(false);
  expect(text).not.toMatch(/ollama\s+(rm|delete|rmi)\b/i);
  expect(text).not.toMatch(/11435/);
  expect(text).not.toMatch(/list-delete/i);
}

describe("health preflight", () => {
  afterEach(() => {
    delete process.env.USE_FIXTURE;
  });

  it("exits 0 when Ollama has MODEL and OpenSCAD is found", () => {
    const result = evaluateHealthPreflight(sampleReport({ ready: true }));
    expect(result.overall).toBe("PASS");
    expect(result.exitCode).toBe(PREFLIGHT_EXIT.ok);
    expect(result.continueStart).toBe(true);
    expect(result.checks.map((c) => c.status)).toEqual(["PASS", "PASS"]);
    const printed = formatHealthPreflight(result);
    expect(printed).toMatch(/\[PASS].*Local AI/);
    expect(printed).toMatch(/\[PASS].*OpenSCAD/);
    expect(printed).toMatch(/Overall: PASS/);
    assertSmithSafe(printed);
  });

  it("warns (exit 2) when Ollama is up but MODEL is missing — pull only, never delete", () => {
    const result = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          modelPresent: false,
          tone: "warn",
          detail: `Ollama is running, but ${DEFAULT_MODEL} is not installed.`,
          tips: [
            `In a terminal: ollama pull ${DEFAULT_MODEL}`,
            "Pull alongside existing models. Do not delete or retarget Agent Smith models.",
          ],
        },
      }),
    );
    expect(result.checks[0]?.status).toBe("WARN");
    expect(result.overall).toBe("WARN");
    expect(result.exitCode).toBe(PREFLIGHT_EXIT.soft);
    expect(result.continueStart).toBe(true);
    const printed = formatHealthPreflight(result);
    expect(printed).toContain(`ollama pull ${DEFAULT_MODEL}`);
    expect(printed).toMatch(/Agent Smith/);
    assertSmithSafe(printed);
  });

  it("warns (exit 2) when OpenSCAD is missing and still continues", () => {
    const result = evaluateHealthPreflight(
      sampleReport({
        openscad: {
          found: false,
          path: null,
          source: "missing",
          version: null,
          tone: "warn",
          detail: "OpenSCAD was not found. The compile step needs it to build an STL.",
          tips: [
            "Install OpenSCAD from https://openscad.org/ (Windows installer or ZIP).",
            "Or set OPENSCAD_PATH to openscad.exe (file or folder). OPENSCAD_BIN still works.",
            "Portable / bundled plan: drop the executable in vendor/openscad/ next to the app.",
          ],
        },
      }),
    );
    expect(result.checks[1]?.status).toBe("WARN");
    expect(result.overall).toBe("WARN");
    expect(result.exitCode).toBe(PREFLIGHT_EXIT.soft);
    expect(result.continueStart).toBe(true);
    const printed = formatHealthPreflight(result);
    expect(printed).toMatch(/openscad\.org/i);
    expect(printed).toMatch(/OPENSCAD_PATH/);
    assertSmithSafe(printed);
  });

  it("prints FAIL for unreachable Ollama but exits 2 so Start stays one-click", () => {
    const result = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          reachable: false,
          modelPresent: false,
          tone: "danger",
          detail: "Ollama is not reachable on the default local port.",
          tips: [
            "Start local AI (Ollama) from the Start menu, or run `ollama serve`.",
            "DescribePrint uses the default Ollama port 11434. Do not change it.",
            "Leave Agent Smith models installed and untouched.",
          ],
        },
      }),
    );
    expect(result.checks[0]?.status).toBe("FAIL");
    expect(result.overall).toBe("FAIL");
    expect(result.exitCode).toBe(PREFLIGHT_EXIT.soft);
    expect(result.exitCode).not.toBe(PREFLIGHT_EXIT.hard);
    expect(result.continueStart).toBe(true);
    const printed = formatHealthPreflight(result);
    expect(printed).toMatch(/\[FAIL].*Local AI/);
    expect(printed).toMatch(/11434/);
    expect(printed).toMatch(/starting the app anyway/i);
    assertSmithSafe(printed);
  });

  it("passes Local AI in fixture or cloud mode without probing Ollama", () => {
    const fixture = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          mode: "fixture",
          configured: false,
          reachable: true,
          modelPresent: true,
          tone: "neutral",
          label: "Demo",
          detail: "Fixture / mock path is on — local AI is not required.",
          tips: ["Turn off USE_FIXTURE to use Ollama (qwen2.5-coder:32b by default)."],
        },
        ready: true,
      }),
    );
    expect(fixture.checks[0]?.status).toBe("PASS");
    expect(fixture.exitCode).toBe(PREFLIGHT_EXIT.ok);

    const cloud = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          mode: "cloud",
          reachable: true,
          modelPresent: true,
          tone: "ok",
          label: "Cloud AI",
          detail: "Using gpt-4o-mini at https://api.openai.com/v1.",
          tips: [],
        },
        ready: true,
      }),
    );
    expect(cloud.checks[0]?.status).toBe("PASS");
    expect(cloud.exitCode).toBe(PREFLIGHT_EXIT.ok);
  });

  it("uses the worse of Local AI FAIL and OpenSCAD WARN, still exit 2", () => {
    const result = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          reachable: false,
          modelPresent: false,
          tone: "danger",
          detail: "Ollama is not reachable on the default local port.",
          tips: ["DescribePrint uses the default Ollama port 11434. Do not change it."],
        },
        openscad: {
          found: false,
          path: null,
          source: "missing",
          tone: "warn",
          detail: "OpenSCAD was not found.",
          tips: ["Install OpenSCAD from https://openscad.org/."],
        },
      }),
    );
    expect(result.overall).toBe("FAIL");
    expect(result.exitCode).toBe(PREFLIGHT_EXIT.soft);
    expect(result.continueStart).toBe(true);
  });

  it("strips unsafe ollama-delete tips if they ever appear", () => {
    const result = evaluateHealthPreflight(
      sampleReport({
        localAi: {
          modelPresent: false,
          tone: "warn",
          detail: "model missing",
          tips: ["ollama rm smith-minicpm5", `ollama pull ${DEFAULT_MODEL}`, "use port 11435"],
        },
      }),
    );
    const printed = formatHealthPreflight(result);
    expect(printed).toContain(`ollama pull ${DEFAULT_MODEL}`);
    assertSmithSafe(printed);
  });

  it("loadEnvFile applies new keys and does not override existing ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-preflight-"));
    const file = path.join(dir, ".env.local");
    writeFileSync(file, "MODEL=qwen2.5-coder:14b\nOPENSCAD_PATH=C:\\OpenSCAD\\openscad.exe\n", "utf8");
    const env: NodeJS.ProcessEnv = { MODEL: "already-set" };
    const applied = loadEnvFile(file, env);
    expect(applied).toBe(1);
    expect(env.MODEL).toBe("already-set");
    expect(env.OPENSCAD_PATH).toBe("C:\\OpenSCAD\\openscad.exe");
  });

  it("runHealthPreflight wires getHealthReport and keeps Smith models untouched", async () => {
    await withEnv({ MODEL: undefined, USE_FIXTURE: undefined }, async () => {
      const result = await runHealthPreflight({
        probeLocalModels: async () => ({
          reachable: true,
          models: ["smith-minicpm5", "qwen2.5-coder:7b"],
        }),
        resolveOpenscad: () => ({
          command: "C:\\Program Files\\OpenSCAD\\openscad.exe",
          found: true,
          source: "windows-install",
          candidates: [],
        }),
      });
      expect(result.checks[0]?.status).toBe("WARN");
      expect(result.exitCode).toBe(PREFLIGHT_EXIT.soft);
      const printed = formatHealthPreflight(result);
      expect(printed).toContain("ollama pull qwen2.5-coder:32b");
      expect(printed).not.toMatch(/smith-minicpm5/);
      assertSmithSafe(printed);
    });
  });

  it("runHealthPreflight skips the OpenSCAD version spawn by default", async () => {
    await withEnv({ MODEL: undefined, USE_FIXTURE: undefined }, async () => {
      const result = await runHealthPreflight({
        probeLocalModels: async () => ({ reachable: true, models: [DEFAULT_MODEL] }),
        resolveOpenscad: () => ({
          command: "/usr/bin/openscad",
          found: true,
          source: "linux-install",
          candidates: [],
        }),
      });
      expect(result.overall).toBe("PASS");
      expect(result.exitCode).toBe(PREFLIGHT_EXIT.ok);
      expect(result.checks[1]?.status).toBe("PASS");
    });
  });
});
