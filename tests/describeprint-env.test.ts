import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SMITH_MODEL_RE,
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  assertSafeModel,
  ensureEnvLocal,
  isAgentSmithModel,
  isDescribePrintModel,
  mergeEnvLocalText,
} from "../scripts/lib/describeprint-env.mjs";

describe("DescribePrint env / Smith-model safety", () => {
  it("allows only qwen2.5-coder 32b/14b/7b as pack models", () => {
    expect(ALLOWED_MODELS).toEqual(["qwen2.5-coder:32b", "qwen2.5-coder:14b", "qwen2.5-coder:7b"]);
    expect(isDescribePrintModel(DEFAULT_MODEL)).toBe(true);
    expect(isDescribePrintModel("qwen2.5-coder:14b")).toBe(true);
    expect(isDescribePrintModel("smith-minicpm5")).toBe(false);
    expect(isAgentSmithModel("smith-minicpm5")).toBe(true);
    expect(isAgentSmithModel("openbmb/minicpm5-qwen")).toBe(true);
    expect(AGENT_SMITH_MODEL_RE.test(DEFAULT_MODEL)).toBe(false);
  });

  it("refuses to accept Agent Smith models as MODEL", () => {
    expect(() => assertSafeModel("smith-minicpm5")).toThrow(/Agent Smith/);
    expect(() => assertSafeModel("openbmb/minicpm5-latest")).toThrow(/untouched/);
    expect(assertSafeModel("qwen2.5-coder:14b")).toBe("qwen2.5-coder:14b");
  });

  it("creates local Ollama defaults and never writes a Smith MODEL", () => {
    const merged = mergeEnvLocalText("", { model: "qwen2.5-coder:32b" });
    expect(merged.values.OPENAI_BASE_URL).toBe(DEFAULT_OPENAI_BASE_URL);
    expect(merged.values.MODEL).toBe("qwen2.5-coder:32b");
    expect(merged.text).not.toMatch(/minicpm5/i);
    expect(merged.text).not.toMatch(/smith-/i);
    expect(merged.text).toMatch(/127\.0\.0\.1:11434/);
  });

  it("keeps a lighter qwen override and rewrites only a Smith MODEL key", () => {
    const lighter = mergeEnvLocalText(
      "MODEL=qwen2.5-coder:14b\nOPENAI_BASE_URL=http://127.0.0.1:11434/v1\nOPENAI_API_KEY=ollama\n",
    );
    expect(lighter.values.MODEL).toBe("qwen2.5-coder:14b");
    expect(lighter.actions).toEqual([]);

    const fromSmith = mergeEnvLocalText("MODEL=smith-minicpm5\n", { model: "qwen2.5-coder:32b" });
    expect(fromSmith.values.MODEL).toBe("qwen2.5-coder:32b");
    expect(fromSmith.text).not.toMatch(/smith-minicpm5/);
    expect(fromSmith.warnings.join(" ")).toMatch(/Agent Smith/);
    expect(fromSmith.warnings.join(" ")).toMatch(/not deleted/);
  });

  it("writes .env.local on disk without Smith names", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "describeprint-env-"));
    writeFileSync(path.join(dir, ".env.example"), "MODEL=qwen2.5-coder:32b\n");
    const result = ensureEnvLocal(dir);
    expect(result.created).toBe(true);
    const text = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(text).toContain("MODEL=qwen2.5-coder:32b");
    expect(text).not.toMatch(/minicpm5/);
  });
});
