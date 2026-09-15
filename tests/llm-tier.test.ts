import { afterEach, describe, expect, it, vi } from "vitest";
import { completeChat } from "@/lib/llm";
import { getLlmConfig, getPlanModel } from "@/lib/llm-config";
import {
  ALLOWED_QWEN_MODELS,
  HOST_SIGNAL_ENV,
  QWEN_CODER_MODELS,
  QWEN_CODER_TIERS,
  isAgentSmithModel,
  parseHostSignal,
  parseQwenCoderTier,
  pickLighterQwenModel,
  refreshAdaptiveTier,
  resetAdaptiveTierForTests,
  withLlmQueue,
} from "@/lib/llm-tier";
import { runGeneratePipeline } from "@/lib/pipeline";
import { compileOpenScad } from "@/lib/compile";
import { makeAxisAlignedBoxMesh, writeBinaryStl } from "@/lib/stl";

vi.mock("@/lib/compile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compile")>();
  return { ...actual, compileOpenScad: vi.fn() };
});

const SIGNAL_ENV = [
  HOST_SIGNAL_ENV.path,
  HOST_SIGNAL_ENV.url,
  HOST_SIGNAL_ENV.contention,
  HOST_SIGNAL_ENV.load,
  HOST_SIGNAL_ENV.tier,
  "MODEL",
  "PLAN_MODEL",
  "OPENAI_BASE_URL",
  "DESCRIBEPRINT_TIER_STEP_UP_STREAK",
  "DESCRIBEPRINT_TIER_STEP_UP_COOLDOWN_MS",
] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev = new Map<string, string | undefined>();
  for (const key of SIGNAL_ENV) {
    prev.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(vars)) {
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

afterEach(() => {
  resetAdaptiveTierForTests();
  vi.unstubAllGlobals();
});

describe("qwen coder tier lock", () => {
  it("allows only qwen2.5-coder 32b/14b/7b", () => {
    expect(QWEN_CODER_TIERS).toEqual(["32b", "14b", "7b"]);
    expect(ALLOWED_QWEN_MODELS).toEqual([
      "qwen2.5-coder:32b",
      "qwen2.5-coder:14b",
      "qwen2.5-coder:7b",
    ]);
    expect(parseQwenCoderTier("qwen2.5-coder:32b")).toBe("32b");
    expect(parseQwenCoderTier("qwen2.5-coder:14b")).toBe("14b");
    expect(parseQwenCoderTier("7b")).toBe("7b");
    expect(parseQwenCoderTier("smith-minicpm5")).toBeNull();
    expect(parseQwenCoderTier("openbmb/minicpm5-qwen")).toBeNull();
    expect(isAgentSmithModel("smith-minicpm5")).toBe(true);
    expect(pickLighterQwenModel("qwen2.5-coder:32b", "qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
  });
});

describe("host contention signal", () => {
  it("parses Desktop Pack JSON and ignores Agent Smith model names", () => {
    const signal = parseHostSignal({
      version: 1,
      contention: "busy",
      load: 0.7,
      suggestedTier: "14b",
      updatedAt: "2026-09-15T19:00:00.000Z",
      model: "smith-minicpm5",
    });
    expect(signal.contention).toBe("busy");
    expect(signal.load).toBe(0.7);
    expect(signal.suggestedTier).toBe("14b");
    expect(signal.suggestedTier).not.toBeNull();
    expect(QWEN_CODER_MODELS[signal.suggestedTier!]).not.toMatch(/minicpm5|smith-/i);
  });

  it("treats a stale signal as clear", async () => {
    await withEnv({ [HOST_SIGNAL_ENV.contention]: undefined }, async () => {
      const snapshot = await refreshAdaptiveTier({
        now: Date.parse("2026-09-15T19:02:00.000Z"),
        configuredModel: "qwen2.5-coder:32b",
        signal: {
          version: 1,
          contention: "heavy",
          load: 0.95,
          suggestedTier: "7b",
          updatedAt: "2026-09-15T18:00:00.000Z",
          source: "inject",
        },
      });
      expect(snapshot.model).toBe("qwen2.5-coder:32b");
      expect(snapshot.contention).toBe("clear");
    });
  });
});

describe("adaptive throttle hysteresis", () => {
  it("defaults to 32b when the host is clear", async () => {
    await withEnv({ MODEL: undefined, [HOST_SIGNAL_ENV.contention]: undefined }, async () => {
      const snapshot = await refreshAdaptiveTier({ now: 1_000, configuredModel: "qwen2.5-coder:32b" });
      expect(snapshot.model).toBe("qwen2.5-coder:32b");
      expect(snapshot.activeTier).toBe("32b");
      expect(getLlmConfig().model).toBe("qwen2.5-coder:32b");
    });
  });

  it("steps down 32b → 14b on busy and 14b → 7b on heavy", async () => {
    const busy = await refreshAdaptiveTier({
      now: 1_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "busy", load: 0.6, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(busy.model).toBe("qwen2.5-coder:14b");
    expect(busy.reason).toMatch(/busy/);

    const heavy = await refreshAdaptiveTier({
      now: 2_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "heavy", load: 0.9, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(heavy.model).toBe("qwen2.5-coder:7b");
    expect(heavy.model).not.toMatch(/minicpm5|smith-/i);
  });

  it("jumps 32b → 7b on a single heavy sample when 7b is installed", async () => {
    resetAdaptiveTierForTests();
    const heavy = await refreshAdaptiveTier({
      now: 1_000,
      configuredModel: "qwen2.5-coder:32b",
      installedModels: ["qwen2.5-coder:32b", "qwen2.5-coder:14b", "qwen2.5-coder:7b"],
      signal: { version: 1, contention: "heavy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(heavy.model).toBe("qwen2.5-coder:7b");
  });

  it("does not thrash back to 32b on one clear sample", async () => {
    await refreshAdaptiveTier({
      now: 1_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "busy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    const once = await refreshAdaptiveTier({
      now: 20_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "clear", load: 0.1, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(once.model).toBe("qwen2.5-coder:14b");

    await refreshAdaptiveTier({
      now: 21_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "clear", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    const third = await refreshAdaptiveTier({
      now: 22_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "clear", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(third.model).toBe("qwen2.5-coder:32b");
  });

  it("steps up one tier at a time (7b → 14b, not 7b → 32b)", async () => {
    await refreshAdaptiveTier({
      now: 1_000,
      configuredModel: "qwen2.5-coder:32b",
      signal: { version: 1, contention: "heavy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(getLlmConfig().model).toBe("qwen2.5-coder:7b");
    const clear = {
      version: 1 as const,
      contention: "clear" as const,
      load: null,
      suggestedTier: null,
      updatedAt: null,
      source: "inject" as const,
    };
    await refreshAdaptiveTier({ now: 20_000, configuredModel: "qwen2.5-coder:32b", signal: clear });
    await refreshAdaptiveTier({ now: 21_000, configuredModel: "qwen2.5-coder:32b", signal: clear });
    const mid = await refreshAdaptiveTier({ now: 22_000, configuredModel: "qwen2.5-coder:32b", signal: clear });
    expect(mid.model).toBe("qwen2.5-coder:14b");
  });

  it("honors a 14b MODEL ceiling and never emits Agent Smith", async () => {
    await withEnv({ MODEL: "qwen2.5-coder:14b" }, async () => {
      const busy = await refreshAdaptiveTier({
        now: 1_000,
        configuredModel: "qwen2.5-coder:14b",
        signal: { version: 1, contention: "busy", load: null, suggestedTier: "32b", updatedAt: null, source: "inject" },
      });
      expect(busy.ceilingTier).toBe("14b");
      expect(busy.model).toBe("qwen2.5-coder:14b");
      const heavy = await refreshAdaptiveTier({
        now: 2_000,
        configuredModel: "qwen2.5-coder:14b",
        signal: { version: 1, contention: "heavy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
      });
      expect(heavy.model).toBe("qwen2.5-coder:7b");
      expect(heavy.model).not.toMatch(/minicpm5|smith-/i);
    });
  });

  it("skips a missing 14b and stays on 32b when no lighter qwen is installed", async () => {
    const busy = await refreshAdaptiveTier({
      now: 1_000,
      configuredModel: "qwen2.5-coder:32b",
      installedModels: ["qwen2.5-coder:32b", "smith-minicpm5"],
      signal: { version: 1, contention: "busy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
    });
    expect(busy.model).toBe("qwen2.5-coder:32b");
  });

  it("does not adapt a cloud MODEL", async () => {
    await withEnv({ MODEL: "gpt-4o-mini", OPENAI_BASE_URL: "https://api.openai.com/v1" }, async () => {
      const snapshot = await refreshAdaptiveTier({
        now: 1_000,
        configuredModel: "gpt-4o-mini",
        signal: { version: 1, contention: "heavy", load: 1, suggestedTier: "7b", updatedAt: null, source: "inject" },
      });
      expect(snapshot.adaptive).toBe(false);
      expect(snapshot.model).toBe("gpt-4o-mini");
      expect(getLlmConfig().model).toBe("gpt-4o-mini");
    });
  });

  it("caps PLAN_MODEL to the active lighter tier under load", async () => {
    await withEnv({ MODEL: undefined, PLAN_MODEL: "qwen2.5-coder:32b" }, async () => {
      await refreshAdaptiveTier({
        now: 1_000,
        configuredModel: "qwen2.5-coder:32b",
        signal: { version: 1, contention: "heavy", load: null, suggestedTier: null, updatedAt: null, source: "inject" },
      });
      expect(getPlanModel()).toBe("qwen2.5-coder:7b");
    });
  });

  it("reads DESCRIBEPRINT_HOST_CONTENTION from the environment", async () => {
    await withEnv({ [HOST_SIGNAL_ENV.contention]: "heavy" }, async () => {
      const snapshot = await refreshAdaptiveTier({ now: 1_000, configuredModel: "qwen2.5-coder:32b" });
      expect(snapshot.model).toBe("qwen2.5-coder:7b");
    });
  });
});

describe("generate / chat stay queued", () => {
  it("serializes overlapping completeChat calls in order", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/chat/completions")) {
        return { ok: true, json: async () => ({ contention: "clear" }) };
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
      const label = body.messages[0]?.content;
      order.push(`enter:${label}`);
      if (label === "first") await firstGate;
      order.push(`fetch:${label}`);
      return { ok: true, json: async () => ({ choices: [{ message: { content: label } }] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = completeChat([{ role: "user", content: "first" }]).catch((err: unknown) => {
      order.push(`err:first:${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
    const second = completeChat([{ role: "user", content: "second" }]).catch((err: unknown) => {
      order.push(`err:second:${err instanceof Error ? err.message : String(err)}`);
      throw err;
    });
    await vi.waitFor(
      () => expect(order.some((item) => item === "enter:first" || item.startsWith("err:"))).toBe(true),
      { timeout: 5_000 },
    );
    expect(order.filter((item) => item.startsWith("enter:"))).toEqual(["enter:first"]);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order.filter((item) => item.startsWith("fetch:"))).toEqual(["fetch:first", "fetch:second"]);
  });

  it("keeps a waiting job when the first generate fails", async () => {
    const seen: string[] = [];
    const results = await Promise.allSettled([
      withLlmQueue(async () => {
        seen.push("a-start");
        throw new Error("boom");
      }),
      withLlmQueue(async () => {
        seen.push("b-run");
        return "ok";
      }),
    ]);
    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toEqual({ status: "fulfilled", value: "ok" });
    expect(seen).toEqual(["a-start", "b-run"]);
  });

  it("emits a queued wait status for a second generate", async () => {
    vi.mocked(compileOpenScad).mockResolvedValue({
      stl: writeBinaryStl(makeAxisAlignedBoxMesh([20, 20, 20])),
      stderr: "",
      stdout: "",
      workDir: "/tmp/describeprint-test",
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withLlmQueue(async () => {
      await firstGate;
      return "one";
    });
    const second = runGeneratePipeline({ prompt: "20mm cube with 5mm hole", fixture: true }, (event) => {
      events.push(event.message);
    });
    await vi.waitFor(() => {
      expect(events.some((message) => /Waiting for the previous local AI job/i.test(message))).toBe(true);
    });
    releaseFirst();
    await first;
    const result = await second;
    expect(result.usedFixture).toBe(true);
  });
});
