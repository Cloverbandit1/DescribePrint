import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "../scripts/health-preflight.mjs";

describe("pack health preflight (Smith-model gate)", () => {
  afterEach(() => {
    delete process.env.MODEL;
    delete process.env.OPENAI_BASE_URL;
  });

  it("blocks an Agent Smith MODEL without probing a rewrite of Ollama", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dp-health-"));
    writeFileSync(
      path.join(dir, ".env.local"),
      "OPENAI_BASE_URL=http://127.0.0.1:11434/v1\nMODEL=smith-minicpm5\n",
    );
    const report = await runPreflight(dir, { skipNetwork: true });
    expect(report.smithBlocked).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.tips.join(" ")).toMatch(/Leave smith-minicpm5/);
    expect(report.tips.join(" ")).not.toMatch(/ollama rm/);
  });

  it("accepts qwen2.5-coder:32b as the dedicated DescribePrint model", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dp-health-"));
    writeFileSync(
      path.join(dir, ".env.local"),
      "OPENAI_BASE_URL=http://127.0.0.1:11434/v1\nMODEL=qwen2.5-coder:32b\n",
    );
    const report = await runPreflight(dir, { skipNetwork: true });
    expect(report.smithBlocked).toBe(false);
    expect(report.localAi.model).toBe("qwen2.5-coder:32b");
    expect(report.localAi.baseUrl).toContain("127.0.0.1:11434");
    expect(report.modelError).toBeNull();
  });
});
