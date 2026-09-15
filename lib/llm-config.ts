/**
 * Local-first LLM defaults. DescribePrint talks to Ollama’s OpenAI-compatible
 * API on the default loopback port and uses its own model name so it can share
 * a machine with Agent Smith without touching Smith’s models or server config.
 */

/** Default Ollama OpenAI-compatible endpoint. Do not change Ollama’s port/host for this app. */
export const DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";

/** Ollama accepts any non-empty key. */
export const DEFAULT_OPENAI_API_KEY = "ollama";

/**
 * DescribePrint’s dedicated local coder model — max quality on capable ~32GB machines.
 * Never default to Agent Smith models (smith-minicpm5, openbmb/minicpm5-*, …).
 * Override with the MODEL env var if you pulled a different DescribePrint model.
 */
export const DEFAULT_MODEL = "qwen2.5-coder:32b";

/**
 * Documented lighter DescribePrint MODEL overrides when 32b is too heavy.
 * These are not compiled-in defaults — set MODEL explicitly.
 */
export const LIGHTER_MODELS = ["qwen2.5-coder:14b", "qwen2.5-coder:7b"] as const;

/** Locked adaptive-throttle family. Never include Agent Smith models. */
export const QWEN_CODER_TIER_MODELS = [DEFAULT_MODEL, ...LIGHTER_MODELS] as const;

/** Two-pass plan → OpenSCAD is on by default (`SMART_PIPELINE=1`). Set `0`/`false` to skip planning. */
export const DEFAULT_SMART_PIPELINE = true;

/** Local 32b completions can be slow; override with LLM_TIMEOUT_MS. */
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;

export const LOCAL_AI_START_MESSAGE = "Start local AI (Ollama)";

/** Patterns that belong to Agent Smith — must never be our compiled-in default. */
export const AGENT_SMITH_MODEL_RE = /(?:^|[/:._-])(?:smith-)?minicpm5(?:$|[/:._-])/i;

import {
  isAgentSmithModel,
  pickLighterQwenModel,
  resolveActiveCompletionModel,
} from "./llm-tier";

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export {
  ALLOWED_QWEN_MODELS,
  HOST_SIGNAL_ENV,
  QWEN_CODER_MODELS,
  QWEN_CODER_TIERS,
  defaultHostSignalPath,
  getAdaptiveTierSnapshot,
  isQwenCoderModel,
  parseQwenCoderTier,
  pickLighterQwenModel,
  refreshAdaptiveTier,
  rememberInstalledModels,
  resetAdaptiveTierForTests,
  resolveActiveCompletionModel,
  withLlmQueue,
  type AdaptiveTierSnapshot,
  type HostContention,
  type HostContentionSignal,
  type QwenCoderTier,
} from "./llm-tier";

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

export function getConfiguredModel(): string {
  const raw = envOrDefault("MODEL", DEFAULT_MODEL);
  return AGENT_SMITH_MODEL_RE.test(raw) ? DEFAULT_MODEL : raw;
}

export function getLlmConfig(): LlmConfig {
  const configured = getConfiguredModel();
  return {
    apiKey: envOrDefault("OPENAI_API_KEY", DEFAULT_OPENAI_API_KEY),
    baseUrl: stripTrailingSlash(envOrDefault("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL)),
    model: resolveActiveCompletionModel(configured),
  };
}

/** Planning model for SMART_PIPELINE pass A. Defaults to the active completion model. */
export function getPlanModel(): string {
  const explicit = process.env.PLAN_MODEL?.trim();
  const active = getLlmConfig().model;
  if (!explicit) return active;
  if (isAgentSmithModel(explicit)) return active;
  return pickLighterQwenModel(explicit, active);
}

/**
 * Optional two-pass (plan JSON → OpenSCAD). Default on.
 * Disable with SMART_PIPELINE=0 / false / off / no.
 */
export function isSmartPipelineEnabled(): boolean {
  return parseBoolEnv("SMART_PIPELINE", DEFAULT_SMART_PIPELINE);
}

export function getLlmTimeoutMs(): number {
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_TIMEOUT_MS;
}

export function isLocalOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return /127\.0\.0\.1|localhost|\[::1\]/i.test(baseUrl);
  }
}

export function isLocalAiActive(): boolean {
  return isLocalOpenAiBaseUrl(getLlmConfig().baseUrl);
}
