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
 * DescribePrint’s dedicated local coder model.
 * Never default to Agent Smith models (smith-minicpm5, openbmb/minicpm5-*, …).
 * Override with the MODEL env var if you pulled a different DescribePrint model.
 */
export const DEFAULT_MODEL = "qwen2.5-coder:7b";

export const LOCAL_AI_START_MESSAGE = "Start local AI (Ollama)";

/** Patterns that belong to Agent Smith — must never be our compiled-in default. */
export const AGENT_SMITH_MODEL_RE = /(?:^|[/:._-])(?:smith-)?minicpm5(?:$|[/:._-])/i;

export type LlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getLlmConfig(): LlmConfig {
  return {
    apiKey: envOrDefault("OPENAI_API_KEY", DEFAULT_OPENAI_API_KEY),
    baseUrl: stripTrailingSlash(envOrDefault("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL)),
    model: envOrDefault("MODEL", DEFAULT_MODEL),
  };
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
