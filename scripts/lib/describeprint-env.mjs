/**
 * .env.local merge + DescribePrint / Agent Smith model safety.
 * Used by setup, health preflight, and the Windows portable pack.
 *
 * Isolation is by model name only. Never write, delete, or retarget
 * Agent Smith models (smith-minicpm5, openbmb/minicpm5-*, …).
 * Ollama stays on 127.0.0.1:11434.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
export const DEFAULT_OPENAI_API_KEY = "ollama";
export const DEFAULT_MODEL = "qwen2.5-coder:32b";
export const LIGHTER_MODELS = ["qwen2.5-coder:14b", "qwen2.5-coder:7b"];
export const ALLOWED_MODELS = [DEFAULT_MODEL, ...LIGHTER_MODELS];

/** Same family as lib/llm-config.ts AGENT_SMITH_MODEL_RE — keep in sync. */
export const AGENT_SMITH_MODEL_RE = /(?:^|[/:._-])(?:smith-)?minicpm5(?:$|[/:._-])/i;

export const REQUIRED_LOCAL_DEFAULTS = {
  OPENAI_BASE_URL: DEFAULT_OPENAI_BASE_URL,
  OPENAI_API_KEY: DEFAULT_OPENAI_API_KEY,
  MODEL: DEFAULT_MODEL,
};

export function isAgentSmithModel(model) {
  return typeof model === "string" && AGENT_SMITH_MODEL_RE.test(model.trim());
}

export function isDescribePrintModel(model) {
  if (typeof model !== "string") return false;
  return /^qwen2\.5-coder:(32b|14b|7b)$/i.test(model.trim());
}

/**
 * Reject Agent Smith models. Allowed DescribePrint models are qwen2.5-coder:32b|14b|7b.
 * Other values (e.g. a cloud override already in a file) are not written by the pack.
 */
export function assertSafeModel(model, { requireDescribePrint = true } = {}) {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    throw new Error("MODEL is empty. Use qwen2.5-coder:32b (or 14b / 7b).");
  }
  if (isAgentSmithModel(trimmed)) {
    throw new Error(
      `Refusing Agent Smith model ${trimmed}. DescribePrint uses qwen2.5-coder:32b|14b|7b only. Leave smith-minicpm5 / openbmb/minicpm5-* installed and untouched.`,
    );
  }
  if (requireDescribePrint && !isDescribePrintModel(trimmed)) {
    throw new Error(
      `MODEL must be a DescribePrint qwen2.5-coder model (32b, 14b, or 7b), not ${trimmed}.`,
    );
  }
  return trimmed;
}

export function parseEnvText(text) {
  /** @type {{ kind: "pair", key: string, value: string, raw: string, disabled?: boolean } | { kind: "other", raw: string }[]} */
  const lines = [];
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const match = raw.match(/^(\s*)(?:#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      lines.push({ kind: "other", raw });
      continue;
    }
    const disabled = /^\s*#/.test(raw);
    let value = match[3] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const key = match[2];
    lines.push({ kind: "pair", key, value, raw, disabled });
    if (!disabled) values[key] = value;
  }
  return { lines, values };
}

function formatPair(key, value) {
  return `${key}=${value}`;
}

/**
 * Merge local Ollama defaults into an existing .env.local (or create one).
 * - Fills missing OPENAI_BASE_URL / OPENAI_API_KEY / MODEL
 * - Replaces a Smith MODEL with the requested qwen model (does not delete Ollama models)
 * - Does not rewrite a safe existing qwen 14b/7b override
 * - Does not change Ollama’s server port; DescribePrint always talks to 11434 when we write BASE_URL
 */
export function mergeEnvLocalText(existingText, { model = DEFAULT_MODEL, forceModel = false } = {}) {
  const wantedModel = assertSafeModel(model);
  const parsed = existingText ? parseEnvText(existingText) : { lines: [], values: {} };
  const warnings = [];
  const actions = [];
  const nextValues = { ...parsed.values };

  const setKey = (key, value, reason) => {
    nextValues[key] = value;
    const idx = parsed.lines.findIndex((line) => line.kind === "pair" && line.key === key && !line.disabled);
    if (idx === -1) {
      parsed.lines.push({ kind: "pair", key, value, raw: formatPair(key, value) });
      actions.push(`set ${key} (${reason})`);
      return;
    }
    const current = parsed.lines[idx];
    if (current.value === value) return;
    parsed.lines[idx] = { kind: "pair", key, value, raw: formatPair(key, value) };
    actions.push(`updated ${key} (${reason})`);
  };

  if (!nextValues.OPENAI_BASE_URL) {
    setKey("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL, "local Ollama default");
  } else if (!/127\.0\.0\.1:11434|localhost:11434/i.test(nextValues.OPENAI_BASE_URL)) {
    warnings.push(
      `OPENAI_BASE_URL is ${nextValues.OPENAI_BASE_URL}. DescribePrint expects http://127.0.0.1:11434/v1. Not rewriting a custom URL; do not change Ollama’s port for Agent Smith.`,
    );
  }

  if (!nextValues.OPENAI_API_KEY) {
    setKey("OPENAI_API_KEY", DEFAULT_OPENAI_API_KEY, "Ollama accepts any non-empty key");
  }

  const currentModel = nextValues.MODEL?.trim();
  if (!currentModel) {
    setKey("MODEL", wantedModel, "DescribePrint dedicated qwen model");
  } else if (isAgentSmithModel(currentModel)) {
    warnings.push(
      `Existing MODEL=${currentModel} belongs to Agent Smith. DescribePrint will use ${wantedModel} instead. Smith models are left installed — they are not deleted or replaced in Ollama.`,
    );
    setKey("MODEL", wantedModel, "replaced Agent Smith model name in .env.local only");
  } else if (forceModel && currentModel !== wantedModel) {
    assertSafeModel(wantedModel);
    setKey("MODEL", wantedModel, "requested MODEL override");
  } else if (!isDescribePrintModel(currentModel) && !forceModel) {
    warnings.push(
      `Existing MODEL=${currentModel} is not a DescribePrint qwen2.5-coder model. Left unchanged. Do not point MODEL at Agent Smith.`,
    );
  }

  const text =
    parsed.lines
      .map((line) => (line.kind === "pair" ? line.raw : line.raw))
      .join("\n")
      .replace(/\n*$/, "\n");

  return {
    text,
    values: nextValues,
    warnings,
    actions,
    model: nextValues.MODEL || wantedModel,
  };
}

export function applyEnvValues(values, env = process.env) {
  for (const [key, value] of Object.entries(values)) {
    if (env[key] == null || env[key] === "") env[key] = value;
  }
  return env;
}

export function loadEnvLocalFile(filePath) {
  if (!existsSync(filePath)) return { values: {}, text: "" };
  const text = readFileSync(filePath, "utf8");
  return { ...parseEnvText(text), text };
}

export function ensureEnvLocal(root, options = {}) {
  const envLocal = path.join(root, ".env.local");
  const envExample = path.join(root, ".env.example");
  const existed = existsSync(envLocal);
  let existing = "";
  if (existed) {
    existing = readFileSync(envLocal, "utf8");
  } else if (existsSync(envExample)) {
    existing = readFileSync(envExample, "utf8");
  }
  const merged = mergeEnvLocalText(existing, options);
  writeFileSync(envLocal, merged.text, "utf8");
  return { file: envLocal, created: !existed, ...merged };
}
