import { spawn } from "node:child_process";
import { shouldUseFixture } from "./fixtures";
import type { HealthReport, LocalAiHealth, OpenscadHealth } from "./health-types";
import {
  DEFAULT_MODEL,
  getConfiguredModel,
  getLlmConfig,
  isLocalAiActive,
  LOCAL_AI_START_MESSAGE,
  refreshAdaptiveTier,
  rememberInstalledModels,
  type AdaptiveTierSnapshot,
  type QwenCoderTier,
} from "./llm-config";
import { resolveOpenscad } from "./openscad";
import { defaultPrinter } from "./printers";

const HEALTH_FETCH_MS = 2_500;
const OPENSCAD_PROBE_MS = 4_000;

function ollamaNativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function collectModelIds(payload: unknown): string[] {
  const names = new Set<string>();
  if (!payload || typeof payload !== "object") return [];
  const record = payload as { models?: unknown; data?: unknown };
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (item && typeof item === "object") {
        const row = item as { name?: unknown; model?: unknown };
        if (typeof row.name === "string") names.add(row.name);
        if (typeof row.model === "string") names.add(row.model);
      }
    }
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (item && typeof item === "object") {
        const row = item as { id?: unknown; name?: unknown };
        if (typeof row.id === "string") names.add(row.id);
        if (typeof row.name === "string") names.add(row.name);
      }
    }
  }
  return [...names];
}

export function modelIsInstalled(installed: string[], wanted: string): boolean {
  const target = wanted.trim().toLowerCase();
  if (!target) return false;
  return installed.some((name) => name.trim().toLowerCase() === target);
}

function localAiTips(input: {
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  activeTier?: QwenCoderTier | null;
  contention?: AdaptiveTierSnapshot["contention"] | null;
  reason?: string | null;
}): string[] {
  const tips: string[] = [];
  if (!input.reachable) {
    tips.push(LOCAL_AI_START_MESSAGE + " from the Start menu, or run `ollama serve`.");
    tips.push("DescribePrint uses the default Ollama port 11434. Do not change it.");
    tips.push("Leave Agent Smith models installed and untouched.");
  } else if (!input.modelPresent) {
    tips.push(`In a terminal: ollama pull ${input.model || DEFAULT_MODEL}`);
    tips.push("Pull alongside existing models. Do not delete or retarget Agent Smith models.");
    if (input.model === DEFAULT_MODEL) {
      tips.push("32b needs roughly 32GB RAM. Lighter overrides: MODEL=qwen2.5-coder:14b or :7b.");
    }
  }
  if (input.reachable && input.activeTier) {
    const tierLine = `Active tier: ${input.activeTier} (${input.model}).`;
    if (input.reason) {
      tips.push(
        `${tierLine} ${input.reason} Generate stays queued — jobs wait instead of failing. Will step up after the host stays clear.`,
      );
    } else {
      tips.push(`${tierLine} Default 32b when the host is clear. Adaptive throttle never retargets Agent Smith.`);
    }
  }
  return tips;
}

function localAiLabel(mode: LocalAiHealth["mode"], activeTier?: QwenCoderTier | null): string {
  if (mode === "fixture") return "Demo";
  if (mode === "cloud") return "Cloud AI";
  return activeTier ? `Local AI · ${activeTier}` : "Local AI";
}

function buildLocalAiHealth(partial: {
  mode: LocalAiHealth["mode"];
  configured: boolean;
  reachable: boolean;
  model: string;
  modelPresent: boolean;
  baseUrl: string;
  configuredModel?: string;
  activeTier?: QwenCoderTier | null;
  contention?: AdaptiveTierSnapshot["contention"] | null;
  reason?: string | null;
}): LocalAiHealth {
  const { mode, configured, reachable, model, modelPresent, baseUrl, activeTier, contention, reason } = partial;
  const healthFields = {
    mode,
    configured,
    reachable,
    model,
    modelPresent,
    baseUrl,
    configuredModel: partial.configuredModel,
    activeTier,
    contention,
  };
  const label = localAiLabel(mode, activeTier);
  const tipInput = { reachable, modelPresent, model, activeTier, contention, reason };
  if (mode === "fixture") {
    return {
      ...healthFields,
      tone: "neutral",
      label,
      detail: "Fixture / mock path is on — local AI is not required.",
      tips: ["Turn off USE_FIXTURE to use Ollama (qwen2.5-coder:32b by default)."],
    };
  }
  if (mode === "cloud") {
    return {
      ...healthFields,
      tone: "ok",
      label,
      detail: `Using ${model} at ${baseUrl}.`,
      tips: [],
    };
  }
  if (!reachable) {
    return {
      ...healthFields,
      tone: "danger",
      label,
      detail: "Ollama is not reachable on the default local port.",
      tips: localAiTips(tipInput),
    };
  }
  if (!modelPresent) {
    return {
      ...healthFields,
      tone: "warn",
      label,
      detail: `Ollama is running, but ${model} is not installed.`,
      tips: localAiTips(tipInput),
    };
  }
  const throttleNote = reason ? ` Stepped down under host contention.` : "";
  return {
    ...healthFields,
    tone: configured ? "ok" : "warn",
    label,
    detail: `${model} is ready at ${baseUrl}.${throttleNote}`,
    tips: localAiTips({ ...tipInput, modelPresent: true }),
  };
}

export function openscadFixTips(found: boolean, source: OpenscadHealth["source"], command: string): string[] {
  if (found) return [];
  const tips = [
    "Install OpenSCAD from https://openscad.org/ (Windows installer or ZIP).",
    "Or set OPENSCAD_PATH to openscad.exe (file or folder). OPENSCAD_BIN still works.",
    "Portable / bundled plan: drop the executable in vendor/openscad/ next to the app.",
  ];
  if (source === "OPENSCAD_PATH" || source === "OPENSCAD_BIN") {
    tips.unshift(`${source} is set to ${command}, but that file was not found.`);
  } else {
    tips.push("Common Windows locations are checked automatically (Program Files, scoop, Chocolatey).");
  }
  return tips;
}

export async function probeOpenscadVersion(
  command: string,
  timeoutMs = OPENSCAD_PROBE_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, ["-v"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    const finish = (value: string | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      const match = out.match(/OpenSCAD\s+version\s+([^\r\n]+)/i);
      finish(match?.[1]?.trim() || (out.trim() ? out.trim().split(/\r?\n/, 1)[0] : null));
    });
  });
}

async function probeLocalModels(baseUrl: string): Promise<{ reachable: boolean; models: string[] }> {
  const root = ollamaNativeRoot(baseUrl);
  const urls = [`${root}/api/tags`, `${baseUrl.replace(/\/+$/, "")}/models`];
  for (const url of urls) {
    try {
      const payload = await fetchJson(url, HEALTH_FETCH_MS);
      return { reachable: true, models: collectModelIds(payload) };
    } catch {
      // try the next probe URL
    }
  }
  return { reachable: false, models: [] };
}

export type HealthDeps = {
  probeLocalModels?: (baseUrl: string) => Promise<{ reachable: boolean; models: string[] }>;
  resolveOpenscad?: typeof resolveOpenscad;
  probeOpenscadVersion?: (command: string) => Promise<string | null>;
};

export async function getHealthReport(deps: HealthDeps = {}): Promise<HealthReport> {
  const fixture = shouldUseFixture();
  const local = isLocalAiActive();
  const mode = fixture ? "fixture" : local ? "local" : "cloud";
  const probeModels = deps.probeLocalModels ?? probeLocalModels;
  const resolveBin = deps.resolveOpenscad ?? resolveOpenscad;
  const probeVersion = deps.probeOpenscadVersion ?? probeOpenscadVersion;

  let reachable = mode !== "local";
  let modelPresent = mode !== "local";
  let installed: string[] = [];
  const preview = getLlmConfig();
  if (mode === "local") {
    const probe = await probeModels(preview.baseUrl);
    reachable = probe.reachable;
    installed = probe.models;
    rememberInstalledModels(probe.models);
  } else if (mode === "cloud") {
    reachable = true;
    modelPresent = true;
  }

  const snapshot = await refreshAdaptiveTier({
    configuredModel: getConfiguredModel(),
    installedModels: mode === "local" ? installed : undefined,
  });
  const config = getLlmConfig();
  if (mode === "local") {
    modelPresent = modelIsInstalled(installed, config.model);
  }

  const localAi = buildLocalAiHealth({
    mode,
    configured: local && !fixture,
    reachable,
    model: config.model,
    modelPresent,
    baseUrl: config.baseUrl,
    configuredModel: snapshot.configuredModel,
    activeTier: snapshot.activeTier,
    contention: snapshot.contention,
    reason: snapshot.reason,
  });

  const resolved = resolveBin();
  let version: string | null = null;
  if (resolved.found) {
    version = await probeVersion(resolved.command);
  }
  const found = resolved.found;
  const openscad: OpenscadHealth = {
    found,
    path: found ? resolved.command : null,
    source: resolved.source,
    version,
    tone: found ? "ok" : "warn",
    label: "OpenSCAD",
    detail: found
      ? [resolved.command, version ? `version ${version}` : null].filter(Boolean).join(" · ")
      : "OpenSCAD was not found. The compile step needs it to build an STL.",
    tips: openscadFixTips(found, resolved.source, resolved.command),
  };

  const printer = defaultPrinter();
  const ready =
    openscad.found &&
    (localAi.mode === "fixture" ||
      localAi.mode === "cloud" ||
      (localAi.reachable && localAi.modelPresent));

  return {
    ready,
    localAi,
    openscad,
    printer: {
      id: printer.id,
      name: printer.name,
      buildVolumeMm: printer.buildVolumeMm,
    },
  };
}
