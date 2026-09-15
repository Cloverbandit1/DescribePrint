import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUserPrompt, completeChat, LOCAL_AI_START_MESSAGE, toUserFacingLlmError } from "@/lib/llm";
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
        expect(body.model).not.toMatch(/minicpm5|smith-/i);
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
