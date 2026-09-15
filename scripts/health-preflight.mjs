#!/usr/bin/env node
/**
 * Launch health preflight: local Ollama + dedicated qwen MODEL + OpenSCAD.
 * Does not start Next.js. Does not touch Agent Smith models.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  AGENT_SMITH_MODEL_RE,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  applyEnvValues,
  assertSafeModel,
  isAgentSmithModel,
  isDescribePrintModel,
  loadEnvLocalFile,
} from "./lib/describeprint-env.mjs";
import { findSystemOpenscad, vendorOpenscadExe } from "./lib/windows-pack.mjs";

const FETCH_MS = 2_500;
const OPENSCAD_PROBE_MS = 4_000;

function argValue(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function ollamaNativeRoot(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function collectModelIds(payload) {
  const names = new Set();
  if (!payload || typeof payload !== "object") return [];
  for (const list of [payload.models, payload.data]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      for (const key of ["name", "model", "id"]) {
        if (typeof item[key] === "string") names.add(item[key]);
      }
    }
  }
  return [...names];
}

export function modelIsInstalled(installed, wanted) {
  const target = wanted.trim().toLowerCase();
  if (!target) return false;
  return installed.some((name) => name.trim().toLowerCase() === target);
}

async function probeLocalModels(baseUrl) {
  const root = ollamaNativeRoot(baseUrl);
  const urls = [`${root}/api/tags`, `${baseUrl.replace(/\/+$/, "")}/models`];
  for (const url of urls) {
    try {
      const payload = await fetchJson(url, FETCH_MS);
      return { reachable: true, models: collectModelIds(payload) };
    } catch {
      // try next
    }
  }
  return { reachable: false, models: [] };
}

function resolveOpenscadCommand(root) {
  const envPath = process.env.OPENSCAD_PATH?.trim();
  if (envPath) {
    if (existsSync(envPath) && !envPath.endsWith(path.sep)) {
      return { command: envPath, source: "OPENSCAD_PATH", found: true };
    }
    for (const name of ["openscad.exe", "openscad"]) {
      const nested = path.join(envPath, name);
      if (existsSync(nested)) return { command: nested, source: "OPENSCAD_PATH", found: true };
    }
    return { command: envPath, source: "OPENSCAD_PATH", found: false };
  }
  const vendor = vendorOpenscadExe(root);
  if (existsSync(vendor)) return { command: vendor, source: "portable", found: true };
  const posixVendor = path.join(root, "vendor", "openscad", "openscad");
  if (existsSync(posixVendor)) return { command: posixVendor, source: "portable", found: true };
  const system = findSystemOpenscad();
  if (system) return { command: system, source: "windows-install", found: true };
  for (const file of ["/usr/bin/openscad", "/usr/local/bin/openscad"]) {
    if (existsSync(file)) return { command: file, source: "linux-install", found: true };
  }
  return { command: process.platform === "win32" ? "openscad.exe" : "openscad", source: "missing", found: false };
}

function probeOpenscadVersion(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["-v"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, OPENSCAD_PROBE_MS);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const match = out.match(/OpenSCAD\s+version\s+([^\r\n]+)/i);
      resolve(match?.[1]?.trim() || null);
    });
  });
}

export async function runPreflight(root, { skipNetwork = false } = {}) {
  const envFile = path.join(root, ".env.local");
  const loaded = loadEnvLocalFile(envFile);
  applyEnvValues(loaded.values);

  // Prefer this tree's .env.local so a leftover shell MODEL cannot retarget Smith.
  const baseUrl = (loaded.values.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const model = (loaded.values.MODEL || process.env.MODEL || DEFAULT_MODEL).trim();

  const smithBlocked = isAgentSmithModel(model);
  let modelError = null;
  try {
    assertSafeModel(model, { requireDescribePrint: false });
    if (!isDescribePrintModel(model)) {
      modelError = `MODEL=${model} is not qwen2.5-coder:32b|14b|7b. Do not point DescribePrint at Agent Smith.`;
    }
  } catch (err) {
    modelError = err instanceof Error ? err.message : String(err);
  }

  let reachable = false;
  let installed = [];
  if (!skipNetwork) {
    const probe = await probeLocalModels(baseUrl);
    reachable = probe.reachable;
    installed = probe.models;
  }

  const modelPresent = modelIsInstalled(installed, model);
  const openscad = resolveOpenscadCommand(root);
  let version = null;
  if (openscad.found && !skipNetwork) {
    version = await probeOpenscadVersion(openscad.command);
  }

  const tips = [];
  if (smithBlocked) {
    tips.push("MODEL points at an Agent Smith model. Set MODEL=qwen2.5-coder:32b in .env.local.");
    tips.push("Leave smith-minicpm5 / openbmb/minicpm5-* installed. Do not delete or replace them.");
  } else if (!reachable && !skipNetwork) {
    tips.push("Start local AI (Ollama) from the Start menu, or run `ollama serve`.");
    tips.push("DescribePrint uses the default Ollama port 11434. Do not change it.");
    tips.push("Leave Agent Smith models installed and untouched.");
  } else if (!modelPresent && !skipNetwork) {
    tips.push(`In a terminal: ollama pull ${model || DEFAULT_MODEL}`);
    tips.push("Pull alongside existing models. Do not delete or retarget Agent Smith models.");
    if (model === DEFAULT_MODEL) {
      tips.push("32b needs roughly 32GB RAM. Lighter overrides: MODEL=qwen2.5-coder:14b or :7b.");
    }
  }
  if (!openscad.found) {
    tips.push("Install OpenSCAD from https://openscad.org/ or run npm run openscad:portable.");
    tips.push("Portable drop-in: vendor/openscad/openscad.exe (or set OPENSCAD_PATH).");
  }

  const ready =
    !smithBlocked &&
    !modelError &&
    openscad.found &&
    (skipNetwork || (reachable && modelPresent));

  return {
    ready,
    smithBlocked,
    modelError,
    localAi: {
      baseUrl,
      model,
      reachable,
      modelPresent,
      describePrintModel: isDescribePrintModel(model),
      agentSmith: smithBlocked,
    },
    openscad: { ...openscad, version },
    tips,
    envFile: existsSync(envFile) ? envFile : null,
  };
}

function tone(ok, warn) {
  if (ok) return "OK   ";
  if (warn) return "WARN ";
  return "FAIL ";
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(argValue("root", path.join(here, "..")));
  const soft = hasFlag("soft");
  const skipNetwork = hasFlag("skip-network");
  const report = await runPreflight(root, { skipNetwork });

  console.log("DescribePrint health preflight");
  console.log("------------------------------");
  const aiOk = report.localAi.reachable && report.localAi.modelPresent && !report.smithBlocked;
  console.log(
    `Local AI:  ${tone(aiOk, report.localAi.reachable && !report.localAi.modelPresent)} ${report.localAi.model} @ ${report.localAi.baseUrl}`,
  );
  if (skipNetwork) console.log("           (network probes skipped)");
  else if (!report.localAi.reachable) console.log("           Ollama not reachable on 127.0.0.1:11434");
  else if (!report.localAi.modelPresent) console.log(`           Ollama is up; ${report.localAi.model} is not installed.`);
  console.log(
    `OpenSCAD:  ${tone(report.openscad.found, false)} ${
      report.openscad.found
        ? `${report.openscad.command}${report.openscad.version ? ` · ${report.openscad.version}` : ""} [${report.openscad.source}]`
        : "not found"
    }`,
  );
  console.log(`Ready:     ${report.ready ? "yes" : "no"}`);
  if (report.modelError) console.log(`MODEL:     ${report.modelError}`);
  console.log("");
  if (AGENT_SMITH_MODEL_RE.test(report.localAi.model)) {
    console.log("Smith-model safety: BLOCKED — DescribePrint must not use Agent Smith models.");
  } else {
    console.log(`Smith-model safety: MODEL=${report.localAi.model} (not a Smith/minicpm5 model).`);
  }
  for (const tip of report.tips) console.log(`  tip: ${tip}`);
  console.log("");
  console.log("Never run ollama rm against Agent Smith models. Never change Ollama's port.");

  if (report.smithBlocked || report.modelError) process.exit(1);
  if (!report.ready && !soft) process.exit(1);
}

const isMain =
  process.argv[1] && path.basename(process.argv[1]) === "health-preflight.mjs";
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
