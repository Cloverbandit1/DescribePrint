import { describe, expect, it } from "vitest";
import {
  AGENT_SMITH_MODEL_RE,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_API_KEY,
  DEFAULT_OPENAI_BASE_URL,
  getLlmConfig,
  isLocalAiActive,
  isLocalOpenAiBaseUrl,
} from "@/lib/llm-config";

const TRACKED = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL"] as const;

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
      { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined, MODEL: undefined },
      () => {
        const config = getLlmConfig();
        expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
        expect(config.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
        expect(config.apiKey).toBe("ollama");
        expect(config.apiKey).toBe(DEFAULT_OPENAI_API_KEY);
        expect(config.model).toBe("qwen2.5-coder:7b");
        expect(config.model).toBe(DEFAULT_MODEL);
        expect(isLocalAiActive()).toBe(true);
      },
    );
  });

  it("treats blank env values as unset so local defaults still apply", () => {
    withEnv({ OPENAI_API_KEY: "  ", OPENAI_BASE_URL: "", MODEL: "" }, () => {
      const config = getLlmConfig();
      expect(config.baseUrl).toBe(DEFAULT_OPENAI_BASE_URL);
      expect(config.apiKey).toBe(DEFAULT_OPENAI_API_KEY);
      expect(config.model).toBe(DEFAULT_MODEL);
    });
  });

  it("never defaults to an Agent Smith model", () => {
    expect(DEFAULT_MODEL).toBe("qwen2.5-coder:7b");
    expect(DEFAULT_MODEL.toLowerCase()).not.toMatch(/minicpm5/);
    expect(DEFAULT_MODEL.toLowerCase()).not.toMatch(/smith-/);
    expect(AGENT_SMITH_MODEL_RE.test(DEFAULT_MODEL)).toBe(false);
    expect(AGENT_SMITH_MODEL_RE.test("smith-minicpm5")).toBe(true);
    expect(AGENT_SMITH_MODEL_RE.test("openbmb/minicpm5-qwen")).toBe(true);
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
        expect(isLocalAiActive()).toBe(false);
        expect(DEFAULT_MODEL).toBe("qwen2.5-coder:7b");
      },
    );
  });

  it("detects loopback OpenAI-compatible hosts as local AI", () => {
    expect(isLocalOpenAiBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalOpenAiBaseUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLocalOpenAiBaseUrl("https://api.openai.com/v1")).toBe(false);
  });
});
