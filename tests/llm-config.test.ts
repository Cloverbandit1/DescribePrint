import { describe, expect, it } from "vitest";
import {
  AGENT_SMITH_MODEL_RE,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_API_KEY,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_SMART_PIPELINE,
  getLlmConfig,
  getLlmTimeoutMs,
  getPlanModel,
  isLocalAiActive,
  isLocalOpenAiBaseUrl,
  isSmartPipelineEnabled,
  LIGHTER_MODELS,
} from "@/lib/llm-config";

const TRACKED = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "MODEL",
  "PLAN_MODEL",
  "SMART_PIPELINE",
  "LLM_TIMEOUT_MS",
] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev = new Map<string, string | undefined>();
  for (const key of TRACKED) {
    prev.set(key, process.env[key]);
    if (!(key in vars)) continue;
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("local LLM config defaults", () => {
  it("points at local Ollama when env is unset", () => {
    withEnv(
      {
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
        MODEL: undefined,
        PLAN_MODEL: undefined,
        SMART_PIPELINE: undefined,
        LLM_TIMEOUT_MS: undefined,
      },
      () => {
        const config = getLlmConfig();
        expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
        expect(config.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
        expect(config.apiKey).toBe("ollama");
        expect(config.apiKey).toBe(DEFAULT_OPENAI_API_KEY);
        expect(config.model).toBe("qwen2.5-coder:32b");
        expect(config.model).toBe(DEFAULT_MODEL);
        expect(getPlanModel()).toBe(DEFAULT_MODEL);
        expect(isSmartPipelineEnabled()).toBe(true);
        expect(isSmartPipelineEnabled()).toBe(DEFAULT_SMART_PIPELINE);
        expect(getLlmTimeoutMs()).toBe(DEFAULT_LLM_TIMEOUT_MS);
        expect(isLocalAiActive()).toBe(true);
      },
    );
  });

  it("treats blank env values as unset so local defaults still apply", () => {
    withEnv(
      { OPENAI_API_KEY: "  ", OPENAI_BASE_URL: "", MODEL: "", PLAN_MODEL: "", SMART_PIPELINE: "" },
      () => {
        const config = getLlmConfig();
        expect(config.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
        expect(config.apiKey).toBe(DEFAULT_OPENAI_API_KEY);
        expect(config.model).toBe(DEFAULT_MODEL);
        expect(getPlanModel()).toBe(DEFAULT_MODEL);
        expect(isSmartPipelineEnabled()).toBe(true);
      },
    );
  });

  it("never defaults to an Agent Smith model", () => {
    expect(DEFAULT_MODEL).toBe("qwen2.5-coder:32b");
    expect(DEFAULT_MODEL.toLowerCase()).not.toMatch(/minicpm5/);
    expect(DEFAULT_MODEL.toLowerCase()).not.toMatch(/smith-/);
    expect(AGENT_SMITH_MODEL_RE.test(DEFAULT_MODEL)).toBe(false);
    expect(AGENT_SMITH_MODEL_RE.test("smith-minicpm5")).toBe(true);
    expect(AGENT_SMITH_MODEL_RE.test("openbmb/minicpm5-qwen")).toBe(true);
  });

  it("documents lighter 14b and 7b MODEL overrides without making them the default", () => {
    expect(LIGHTER_MODELS).toEqual(["qwen2.5-coder:14b", "qwen2.5-coder:7b"]);
    expect(LIGHTER_MODELS).not.toContain(DEFAULT_MODEL);
  });

  it("allows qwen2.5-coder:14b and :7b as lighter MODEL overrides", () => {
    withEnv({ MODEL: "qwen2.5-coder:14b" }, () => {
      expect(getLlmConfig().model).toBe("qwen2.5-coder:14b");
      expect(DEFAULT_MODEL).toBe("qwen2.5-coder:32b");
    });
    withEnv({ MODEL: "qwen2.5-coder:7b" }, () => {
      expect(getLlmConfig().model).toBe("qwen2.5-coder:7b");
      expect(DEFAULT_MODEL).toBe("qwen2.5-coder:32b");
    });
  });

  it("keeps the default Ollama loopback URL (does not retarget the server)", () => {
    expect(DEFAULT_OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(DEFAULT_OPENAI_BASE_URL).not.toMatch(/11435|openai.com/);
  });

  it("honors MODEL and cloud overrides without changing compiled-in defaults", () => {
    withEnv(
      {
        OPENAI_BASE_URL: "https://api.openai.com/v1/",
        OPENAI_API_KEY: "sk-test",
        MODEL: "gpt-4o-mini",
      },
      () => {
        const config = getLlmConfig();
        expect(config.baseUrl).toBe("https://api.openai.com/v1");
        expect(config.apiKey).toBe("sk-test");
        expect(config.model).toBe("gpt-4o-mini");
        expect(getPlanModel()).toBe("gpt-4o-mini");
        expect(isLocalAiActive()).toBe(false);
        expect(DEFAULT_MODEL).toBe("qwen2.5-coder:32b");
      },
    );
  });

  it("lets PLAN_MODEL override the planning model only", () => {
    withEnv({ MODEL: "qwen2.5-coder:32b", PLAN_MODEL: "qwen2.5-coder:14b" }, () => {
      expect(getLlmConfig().model).toBe("qwen2.5-coder:32b");
      expect(getPlanModel()).toBe("qwen2.5-coder:14b");
    });
  });

  it("disables the two-pass pipeline when SMART_PIPELINE is off", () => {
    withEnv({ SMART_PIPELINE: "0" }, () => {
      expect(isSmartPipelineEnabled()).toBe(false);
    });
    withEnv({ SMART_PIPELINE: "false" }, () => {
      expect(isSmartPipelineEnabled()).toBe(false);
    });
    withEnv({ SMART_PIPELINE: "1" }, () => {
      expect(isSmartPipelineEnabled()).toBe(true);
    });
  });

  it("detects loopback OpenAI-compatible hosts as local AI", () => {
    expect(isLocalOpenAiBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalOpenAiBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalOpenAiBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});
