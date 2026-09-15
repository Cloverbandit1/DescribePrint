/**
 * Adaptive qwen2.5-coder tier throttle + generate queue.
 *
 * Desktop Pack (or any host) publishes a contention signal. CAD Core reads it
 * and steps `qwen2.5-coder:32b` ↔ `14b` ↔ `7b`. Agent Smith models are never
 * selected. Generate stays queueable: overlapping jobs wait in order instead
 * of being dropped when the host is busy or the tier is switching.
 *
 * Contract: docs/adaptive-tier-signal.md
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_SMITH_MODEL_RE, DEFAULT_MODEL } from "./llm-config";

export const QWEN_CODER_TIERS = ["32b", "14b", "7b"] as const;
export type QwenCoderTier = (typeof QWEN_CODER_TIERS)[number];

export const QWEN_CODER_MODELS = {
  "32b": "qwen2.5-coder:32b",
  "14b": "qwen2.5-coder:14b",
  "7b": "qwen2.5-coder:7b",
} as const;

export const ALLOWED_QWEN_MODELS = [
  QWEN_CODER_MODELS["32b"],
  QWEN_CODER_MODELS["14b"],
  QWEN_CODER_MODELS["7b"],
] as const;

export type HostContention = "clear" | "busy" | "heavy";

export type HostContentionSignal = {
  version: 1;
  contention: HostContention;
  load: number | null;
  suggestedTier: QwenCoderTier | null;
  updatedAt: string | null;
  source: "default" | "file" | "http" | "env" | "inject";
};

export type AdaptiveTierSnapshot = {
  configuredModel: string;
  model: string;
  activeTier: QwenCoderTier | null;
  ceilingTier: QwenCoderTier | null;
  contention: HostContention;
  reason: string | null;
  adaptive: boolean;
};

export const HOST_SIGNAL_ENV = {
  path: "DESCRIBEPRINT_HOST_SIGNAL_PATH",
  url: "DESCRIBEPRINT_HOST_SIGNAL_URL",
  contention: "DESCRIBEPRINT_HOST_CONTENTION",
  load: "DESCRIBEPRINT_HOST_LOAD",
  tier: "DESCRIBEPRINT_TIER",
  staleMs: "DESCRIBEPRINT_HOST_SIGNAL_STALE_MS",
} as const;

export const DEFAULT_HOST_SIGNAL_STALE_MS = 90_000;
export const DEFAULT_STEP_DOWN_STREAK = 1;
export const DEFAULT_STEP_UP_STREAK = 3;
export const DEFAULT_STEP_UP_COOLDOWN_MS = 15_000;
export const DEFAULT_BUSY_LOAD = 0.55;
export const DEFAULT_HEAVY_LOAD = 0.8;

const TIER_INDEX: Record<QwenCoderTier, number> = { "32b": 0, "14b": 1, "7b": 2 };

type ThrottleState = {
  activeTier: QwenCoderTier;
  lastChangeAt: number;
  clearStreak: number;
  busyStreak: number;
  lastSnapshot: AdaptiveTierSnapshot | null;
  pinnedModel: string | null;
  installedModels: string[] | null;
};

const llmQueueHeld = new AsyncLocalStorage<boolean>();
let llmQueueTail: Promise<unknown> = Promise.resolve();
let llmQueueAhead = 0;

function emptySignal(source: HostContentionSignal["source"] = "default"): HostContentionSignal {
  return {
    version: 1,
    contention: "clear",
    load: null,
    suggestedTier: null,
    updatedAt: null,
    source,
  };
}

function createState(): ThrottleState {
  return {
    activeTier: "32b",
    lastChangeAt: 0,
    clearStreak: 0,
    busyStreak: 0,
    lastSnapshot: null,
    pinnedModel: null,
    installedModels: null,
  };
}

let state = createState();

export function isAgentSmithModel(model: string): boolean {
  return AGENT_SMITH_MODEL_RE.test(model.trim());
}

export function isQwenCoderModel(model: string): boolean {
  return parseQwenCoderTier(model) !== null;
}

export function parseQwenCoderTier(model: string | null | undefined): QwenCoderTier | null {
  if (!model) return null;
  const trimmed = model.trim().toLowerCase();
  if (isAgentSmithModel(trimmed)) return null;
  const full = trimmed.match(/^qwen2\.5-coder:(32b|14b|7b)$/);
  if (full) return full[1] as QwenCoderTier;
  const bare = trimmed.match(/^(32b|14b|7b)$/);
  if (bare) return bare[1] as QwenCoderTier;
  return null;
}

export function modelForQwenTier(tier: QwenCoderTier): string {
  return QWEN_CODER_MODELS[tier];
}

export function lighterQwenTier(a: QwenCoderTier, b: QwenCoderTier): QwenCoderTier {
  return TIER_INDEX[a] >= TIER_INDEX[b] ? a : b;
}

export function heavierQwenTier(a: QwenCoderTier, b: QwenCoderTier): QwenCoderTier {
  return TIER_INDEX[a] <= TIER_INDEX[b] ? a : b;
}

export function pickLighterQwenModel(explicit: string, active: string): string {
  const explicitTier = parseQwenCoderTier(explicit);
  const activeTier = parseQwenCoderTier(active);
  if (!explicitTier || !activeTier) return explicit;
  return modelForQwenTier(lighterQwenTier(explicitTier, activeTier));
}

export function parseHostContention(raw: string | null | undefined): HostContention | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (["clear", "ok", "idle", "0", "false", "no", "off", "none"].includes(value)) return "clear";
  if (["busy", "contend", "contention", "1", "true", "yes", "on", "medium"].includes(value)) {
    return "busy";
  }
  if (["heavy", "high", "critical", "2", "swap", "thrash"].includes(value)) return "heavy";
  return null;
}

export function parseHostSignal(raw: unknown, source: HostContentionSignal["source"] = "file"): HostContentionSignal {
  const signal = emptySignal(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return signal;
  const rec = raw as Record<string, unknown>;
  const contention =
    parseHostContention(typeof rec.contention === "string" ? rec.contention : null) ??
    parseHostContention(typeof rec.status === "string" ? rec.status : null);
  if (contention) signal.contention = contention;
  const load = typeof rec.load === "number" ? rec.load : typeof rec.load === "string" ? Number(rec.load) : Number.NaN;
  if (Number.isFinite(load)) signal.load = Math.min(1, Math.max(0, load));
  const suggested =
    parseQwenCoderTier(typeof rec.suggestedTier === "string" ? rec.suggestedTier : null) ??
    parseQwenCoderTier(typeof rec.tier === "string" ? rec.tier : null) ??
    parseQwenCoderTier(typeof rec.model === "string" ? rec.model : null);
  if (suggested) signal.suggestedTier = suggested;
  if (typeof rec.updatedAt === "string" && rec.updatedAt.trim()) {
    signal.updatedAt = rec.updatedAt.trim();
  }
  return signal;
}

export function defaultHostSignalPath(): string {
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(root, "DescribePrint", "host-signal.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "DescribePrint", "host-signal.json");
  }
  const xdg = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
  return path.join(xdg, "describeprint", "host-signal.json");
}

function isLocalBaseUrl(): boolean {
  const url = process.env.OPENAI_BASE_URL?.trim() || "http://127.0.0.1:11434/v1";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return /127\.0\.0\.1|localhost|\[::1\]/i.test(url);
  }
}

function staleMs(): number {
  const raw = Number(process.env[HOST_SIGNAL_ENV.staleMs]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOST_SIGNAL_STALE_MS;
}

function isFresh(signal: HostContentionSignal, now: number): boolean {
  if (!signal.updatedAt) return true;
  const at = Date.parse(signal.updatedAt);
  if (!Number.isFinite(at)) return true;
  return now - at <= staleMs();
}

function readSignalFile(filePath: string): HostContentionSignal | null {
  try {
    if (!existsSync(filePath)) return null;
    const text = readFileSync(filePath, "utf8").trim();
    if (!text) return null;
    return parseHostSignal(JSON.parse(text), "file");
  } catch {
    return null;
  }
}

function signalFromEnv(): HostContentionSignal {
  const signal = emptySignal("env");
  const contention = parseHostContention(process.env[HOST_SIGNAL_ENV.contention]);
  if (contention) signal.contention = contention;
  const load = Number(process.env[HOST_SIGNAL_ENV.load]);
  if (Number.isFinite(load)) signal.load = Math.min(1, Math.max(0, load));
  const tier = parseQwenCoderTier(process.env[HOST_SIGNAL_ENV.tier]);
  if (tier) signal.suggestedTier = tier;
  return signal;
}

function envOverridesPresent(): boolean {
  return Boolean(
    process.env[HOST_SIGNAL_ENV.contention]?.trim() ||
      process.env[HOST_SIGNAL_ENV.load]?.trim() ||
      process.env[HOST_SIGNAL_ENV.tier]?.trim(),
  );
}

async function readHttpSignal(url: string): Promise<HostContentionSignal | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!response.ok) return null;
    return parseHostSignal(await response.json(), "http");
  } catch {
    return null;
  }
}

export async function readHostContentionSignal(opts?: {
  now?: number;
  signal?: HostContentionSignal;
}): Promise<HostContentionSignal> {
  if (opts?.signal) {
    const injected = { ...opts.signal, source: "inject" as const };
    return isFresh(injected, opts.now ?? Date.now()) ? injected : emptySignal();
  }
  const now = opts?.now ?? Date.now();
  const envSignal = signalFromEnv();
  const explicitPath = process.env[HOST_SIGNAL_ENV.path]?.trim();
  const filePath = explicitPath || (process.env.VITEST ? "" : defaultHostSignalPath());
  const fileSignal = filePath ? readSignalFile(filePath) : null;
  const url = process.env[HOST_SIGNAL_ENV.url]?.trim();
  const httpSignal = !fileSignal && url ? await readHttpSignal(url) : null;
  let merged = emptySignal();
  if (fileSignal && isFresh(fileSignal, now)) merged = fileSignal;
  else if (httpSignal && isFresh(httpSignal, now)) merged = httpSignal;
  if (envOverridesPresent()) {
    if (process.env[HOST_SIGNAL_ENV.contention]?.trim()) merged.contention = envSignal.contention;
    if (process.env[HOST_SIGNAL_ENV.load]?.trim() && envSignal.load !== null) merged.load = envSignal.load;
    if (process.env[HOST_SIGNAL_ENV.tier]?.trim()) merged.suggestedTier = envSignal.suggestedTier;
    merged.source = fileSignal || httpSignal ? merged.source : "env";
  }
  if (!isFresh(merged, now)) return emptySignal();
  return merged;
}

function targetTierFromSignal(signal: HostContentionSignal, ceiling: QwenCoderTier): QwenCoderTier {
  if (signal.suggestedTier) {
    return lighterQwenTier(signal.suggestedTier, ceiling);
  }
  const load = signal.load;
  if (signal.contention === "heavy" || (load !== null && load >= DEFAULT_HEAVY_LOAD)) {
    return lighterQwenTier("7b", ceiling);
  }
  if (signal.contention === "busy" || (load !== null && load >= DEFAULT_BUSY_LOAD)) {
    return lighterQwenTier("14b", ceiling);
  }
  return ceiling;
}

function stepToward(current: QwenCoderTier, target: QwenCoderTier): QwenCoderTier {
  if (current === target) return current;
  const dir = TIER_INDEX[target] > TIER_INDEX[current] ? 1 : -1;
  const nextIndex = TIER_INDEX[current] + dir;
  return QWEN_CODER_TIERS[nextIndex] ?? current;
}

function modelIsInstalled(installed: string[] | null, wanted: string): boolean {
  if (!installed) return true;
  const target = wanted.trim().toLowerCase();
  return installed.some((name) => name.trim().toLowerCase() === target);
}

function firstInstalledToward(
  from: QwenCoderTier,
  target: QwenCoderTier,
  installed: string[] | null,
  allowJump = false,
): QwenCoderTier {
  if (!installed) return allowJump ? target : stepToward(from, target);
  if (allowJump && modelIsInstalled(installed, modelForQwenTier(target))) return target;
  const dir = TIER_INDEX[target] >= TIER_INDEX[from] ? 1 : -1;
  if (dir > 0) {
    for (let i = TIER_INDEX[from] + 1; i <= TIER_INDEX[target]; i++) {
      const tier = QWEN_CODER_TIERS[i];
      if (tier && modelIsInstalled(installed, modelForQwenTier(tier))) return tier;
    }
    return from;
  }
  for (let i = TIER_INDEX[from] - 1; i >= TIER_INDEX[target]; i--) {
    const tier = QWEN_CODER_TIERS[i];
    if (tier && modelIsInstalled(installed, modelForQwenTier(tier))) return tier;
  }
  return from;
}

function applyHysteresis(
  current: QwenCoderTier,
  target: QwenCoderTier,
  now: number,
  installed: string[] | null,
  ceiling: QwenCoderTier,
): QwenCoderTier {
  if (target === current) {
    state.busyStreak = 0;
    if (target === ceiling) state.clearStreak += 1;
    else state.clearStreak = 0;
    return current;
  }
  if (TIER_INDEX[target] > TIER_INDEX[current]) {
    state.busyStreak += 1;
    state.clearStreak = 0;
    const need = Number(process.env.DESCRIBEPRINT_TIER_STEP_DOWN_STREAK) || DEFAULT_STEP_DOWN_STREAK;
    if (state.busyStreak >= need) {
      const jump = TIER_INDEX[target] - TIER_INDEX[current] > 1;
      const next = firstInstalledToward(current, target, installed, jump);
      if (next !== current) {
        state.activeTier = next;
        state.lastChangeAt = now;
        state.busyStreak = 0;
      }
      return state.activeTier;
    }
    return current;
  }
  state.clearStreak += 1;
  state.busyStreak = 0;
  const need = Number(process.env.DESCRIBEPRINT_TIER_STEP_UP_STREAK) || DEFAULT_STEP_UP_STREAK;
  const cooldown = Number(process.env.DESCRIBEPRINT_TIER_STEP_UP_COOLDOWN_MS) || DEFAULT_STEP_UP_COOLDOWN_MS;
  if (state.clearStreak >= need && now - state.lastChangeAt >= cooldown) {
    const next = firstInstalledToward(current, target, installed);
    if (next !== current) {
      state.activeTier = next;
      state.lastChangeAt = now;
      state.clearStreak = 0;
    }
  }
  return state.activeTier;
}

function ceilingFromConfigured(configuredModel: string): QwenCoderTier | null {
  if (isAgentSmithModel(configuredModel)) return "32b";
  return parseQwenCoderTier(configuredModel);
}

export function rememberInstalledModels(models: string[] | null): void {
  state.installedModels = models;
}

export function getAdaptiveTierSnapshot(): AdaptiveTierSnapshot | null {
  return state.lastSnapshot;
}

export function resolveActiveCompletionModel(configuredModel: string): string {
  if (state.pinnedModel) return state.pinnedModel;
  if (state.lastSnapshot) return state.lastSnapshot.model;
  if (isAgentSmithModel(configuredModel)) return DEFAULT_MODEL;
  return configuredModel;
}

export async function refreshAdaptiveTier(opts?: {
  now?: number;
  installedModels?: string[];
  signal?: HostContentionSignal;
  configuredModel?: string;
}): Promise<AdaptiveTierSnapshot> {
    const configuredModel = opts?.configuredModel ?? (process.env.MODEL?.trim() || DEFAULT_MODEL);
  const safeConfigured = isAgentSmithModel(configuredModel) ? DEFAULT_MODEL : configuredModel;
  const ceiling = ceilingFromConfigured(safeConfigured);
  const signal = await readHostContentionSignal({ now: opts?.now, signal: opts?.signal });
  const installed = opts?.installedModels ?? state.installedModels;
  if (opts?.installedModels) state.installedModels = opts.installedModels;

  const localBase = isLocalBaseUrl();
  if (!ceiling || !localBase) {
    const snapshot: AdaptiveTierSnapshot = {
      configuredModel: safeConfigured,
      model: safeConfigured,
      activeTier: localBase ? ceiling : null,
      ceilingTier: localBase ? ceiling : null,
      contention: signal.contention,
      reason: null,
      adaptive: false,
    };
    state.lastSnapshot = snapshot;
    return snapshot;
  }

  const now = opts?.now ?? Date.now();
  if (!state.lastSnapshot) {
    const start = modelIsInstalled(installed, modelForQwenTier(ceiling)) ? ceiling : ceiling;
    state.activeTier = start;
  }

  const target = targetTierFromSignal(signal, ceiling);
  const nextTier = applyHysteresis(state.activeTier, target, now, installed, ceiling);
  const clamped = lighterQwenTier(nextTier, ceiling);
  if (clamped !== state.activeTier) state.activeTier = clamped;
  const model = modelForQwenTier(state.activeTier);
  const throttled = state.activeTier !== ceiling;
  const reason = throttled
    ? `Host ${signal.contention}${signal.load !== null ? ` (load ${signal.load})` : ""} — active ${state.activeTier}, ceiling ${ceiling}.`
    : null;
  const snapshot: AdaptiveTierSnapshot = {
    configuredModel: safeConfigured,
    model,
    activeTier: state.activeTier,
    ceilingTier: ceiling,
    contention: signal.contention,
    reason,
    adaptive: true,
  };
  state.lastSnapshot = snapshot;
  return snapshot;
}

export async function withLlmQueue<T>(
  work: () => Promise<T>,
  onWait?: (ahead: number) => void,
): Promise<T> {
  if (llmQueueHeld.getStore()) {
    return work();
  }
  const ahead = llmQueueAhead;
  llmQueueAhead += 1;
  const previous = llmQueueTail;
  let release!: () => void;
  llmQueueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    if (ahead > 0) onWait?.(ahead);
    await previous;
    return await llmQueueHeld.run(true, async () => {
      const snapshot = await refreshAdaptiveTier();
      state.pinnedModel = snapshot.model;
      try {
        return await work();
      } finally {
        state.pinnedModel = null;
      }
    });
  } finally {
    llmQueueAhead = Math.max(0, llmQueueAhead - 1);
    release();
  }
}

export function resetAdaptiveTierForTests(): void {
  state = createState();
  llmQueueTail = Promise.resolve();
  llmQueueAhead = 0;
}

export function llmQueueAheadForTests(): number {
  return llmQueueAhead;
}
