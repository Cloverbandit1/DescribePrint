#!/usr/bin/env node
/**
 * Bootstrap AllosWorstation / DescribePrint on a Windows machine.
 *
 * - Smith: keep the repo (often OneDrive Desktop\\AllosWorstation\\DescribePrint)
 * - Laptop: prefer %USERPROFILE%\\AllosWorstation\\DescribePrint (outside OneDrive)
 * - Writes a shared Desktop\\AllosWorstation\\Start DescribePrint.bat (OneDrive-safe)
 *   plus %LOCALAPPDATA%\\AllosWorstation\\repo-path.txt for this machine
 * - Ensures .env.local (qwen only), optional portable OpenSCAD, npm install, health
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { assertSafeModel, ensureEnvLocal } from "./lib/describeprint-env.mjs";
import { runPreflight } from "./health-preflight.mjs";
import {
  copySourceTree,
  findSystemOpenscad,
  installOpenscadPortable,
  localRepoHintPath,
  resolveLayoutPaths,
  writeDesktopBat,
} from "./lib/windows-pack.mjs";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function defaultDesktop() {
  if (process.platform !== "win32") {
    return path.join(os.homedir(), "Desktop");
  }
  return process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, "Desktop")
    : path.join(os.homedir(), "Desktop");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(argValue("source", path.join(here, "..")));
const layout = argValue("layout", "current");
const desktop = path.resolve(argValue("desktop", defaultDesktop()));
const userProfile = path.resolve(argValue("user-profile", process.env.USERPROFILE || os.homedir()));
const localAppData = path.resolve(
  argValue(
    "local-app-data",
    process.env.LOCALAPPDATA || path.join(userProfile, "AppData", "Local"),
  ),
);
const repoPath = argValue("repo-path", "");
const model = argValue("model", "qwen2.5-coder:32b");
assertSafeModel(model);

const skipNpm = hasFlag("skip-npm");
const skipOpenscad = hasFlag("skip-openscad");
const skipHealth = hasFlag("skip-health");
const skipDesktop = hasFlag("skip-desktop");
const dryRun = hasFlag("dry-run");
const preferSystemOpenscad = hasFlag("prefer-system-openscad") || layout.toLowerCase() === "laptop";
const startApp = hasFlag("start");

const paths = resolveLayoutPaths({
  layout,
  sourceRoot,
  desktop,
  userProfile,
  repoPath: repoPath || undefined,
});

console.log("AllosWorstation / DescribePrint installer");
console.log(`  layout:  ${paths.layout}`);
console.log(`  source:  ${paths.sourceRoot}`);
console.log(`  target:  ${paths.targetRoot}`);
console.log(`  desktop: ${paths.desktopBat}`);
console.log(`  MODEL:   ${model}  (qwen only — never smith-minicpm5)`);
console.log("");

if (dryRun) {
  console.log("Dry run — no files written.");
  process.exit(0);
}

if (!existsSync(path.join(paths.sourceRoot, "Start-DescribePrint.cmd"))) {
  throw new Error(`Source is not a DescribePrint tree: ${paths.sourceRoot}`);
}

if (!paths.sameTree) {
  console.log(`Copying setup pack to ${paths.targetRoot}…`);
  await mkdir(path.dirname(paths.targetRoot), { recursive: true });
  await copySourceTree(paths.sourceRoot, paths.targetRoot);
}

const env = ensureEnvLocal(paths.targetRoot, { model });
console.log(`.env.local → ${env.file}  MODEL=${env.model}`);
for (const warning of env.warnings) console.warn(`  warn: ${warning}`);

if (!skipOpenscad) {
  const system = preferSystemOpenscad ? findSystemOpenscad() : null;
  if (system) {
    console.log(`OpenSCAD: using ${system}`);
  } else {
    try {
      const installed = await installOpenscadPortable(paths.targetRoot);
      console.log(`OpenSCAD: ${installed.exe}${installed.skipped ? " (already present)" : ""}`);
    } catch (err) {
      console.warn(`OpenSCAD download skipped: ${err instanceof Error ? err.message : err}`);
      console.warn("Install from https://openscad.org/ or drop openscad.exe in vendor\\openscad\\");
    }
  }
}

if (!skipNpm) {
  if (!existsSync(path.join(paths.targetRoot, "node_modules"))) {
    console.log("npm install…");
    await run("npm", ["install"], paths.targetRoot);
  } else {
    console.log("node_modules present — skip npm install.");
  }
}

if (!skipDesktop) {
  const bat = await writeDesktopBat(desktop, paths.targetRoot, { localAppData });
  const hint = localRepoHintPath(localAppData);
  console.log(`Desktop launcher -> ${bat}`);
  console.log("  (OneDrive-safe detector; same bat on Smith + laptop)");
  console.log(`  machine hint -> ${hint} -> ${paths.targetRoot}`);
}

if (!skipHealth) {
  console.log("");
  console.log("Health preflight (soft — Start still works if Ollama is down):");
  const report = await runPreflight(paths.targetRoot);
  console.log(`  ready=${report.ready}  model=${report.localAi.model}  openscad=${report.openscad.found}`);
  for (const tip of report.tips) console.log(`  tip: ${tip}`);
  if (report.smithBlocked) {
    throw new Error("Refusing to finish with an Agent Smith MODEL.");
  }
}

console.log("");
console.log("Next: ollama pull qwen2.5-coder:32b   (or 14b / 7b)");
console.log("Do not pull-replace or delete Agent Smith models. Keep Ollama on 11434.");
console.log("Start: double-click Start-DescribePrint.cmd or the Desktop bat.");
if (paths.layout === "smith") {
  console.log("Smith is the 24/7 AllosWorstation host. Windows Install -Layout Smith");
  console.log("  registers logon auto-start + AC sleep-never (skip with -NoAutoStart / -SkipHostPower).");
  console.log("  Install Tailscale on Smith + iPhone (same account). Laptop Tailscale alone is not enough.");
} else if (paths.layout === "laptop") {
  console.log("Laptop is not the 24/7 host. Auto-start stays off unless you pass -AutoStart.");
}

if (startApp) {
  const starter = path.join(paths.targetRoot, "Start-DescribePrint.cmd");
  if (process.platform === "win32") {
    await run("cmd.exe", ["/c", starter], paths.targetRoot);
  } else {
    console.log(`(not on Windows — start with: npm run start:windows / ${starter})`);
  }
}
