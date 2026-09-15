#!/usr/bin/env node
/**
 * Write or merge .env.local with local Ollama defaults.
 * Never sets MODEL to an Agent Smith model.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeModel, ensureEnvLocal } from "./lib/describeprint-env.mjs";

function argValue(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(argValue("root", path.join(here, "..")));
const model = argValue("model", "qwen2.5-coder:32b");
assertSafeModel(model);

const result = ensureEnvLocal(root, { model, forceModel: hasFlag("force-model") });
console.log(`DescribePrint .env.local → ${result.file}`);
console.log(`MODEL=${result.model}  OPENAI_BASE_URL local Ollama (11434)`);
for (const action of result.actions) console.log(`  ${action}`);
for (const warning of result.warnings) console.warn(`  warn: ${warning}`);
if (result.actions.length === 0 && result.warnings.length === 0) {
  console.log("  already had safe local defaults (left user overrides in place).");
}
console.log("Leave Agent Smith models installed. Do not change Ollama's port.");
