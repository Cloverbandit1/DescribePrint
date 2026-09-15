#!/usr/bin/env node
/**
 * First-run setup for DescribePrint (AllosWorkstation / Windows / any OS).
 * Copies .env.local defaults, installs npm deps, prints the local-AI checklist.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envExample = path.join(root, ".env.example");
const envLocal = path.join(root, ".env.local");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
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

async function main() {
  console.log("DescribePrint setup");
  console.log("-------------------");

  if (!existsSync(envLocal)) {
    if (!existsSync(envExample)) {
      throw new Error("Missing .env.example — cannot create .env.local");
    }
    await copyFile(envExample, envLocal);
    console.log("Created .env.local from .env.example (local Ollama + qwen2.5-coder:32b).");
  } else {
    console.log(".env.local already present — left unchanged.");
  }

  const vendorDir = path.join(root, "vendor", "openscad");
  if (!existsSync(vendorDir)) {
    await mkdir(vendorDir, { recursive: true });
  }

  if (!existsSync(path.join(root, "node_modules"))) {
    console.log("Installing npm dependencies…");
    await run("npm", ["install"]);
  } else {
    console.log("node_modules present — skip npm install (run npm install yourself to refresh).");
  }

  console.log("");
  console.log("Next (one-time on this machine):");
  console.log("  1. Start Ollama (default port 11434 — do not change it).");
  console.log("  2. ollama pull qwen2.5-coder:32b");
  console.log("     Leave Agent Smith models installed and untouched.");
  console.log("     Lighter machines: MODEL=qwen2.5-coder:14b or :7b in .env.local");
  console.log("  3. Install OpenSCAD from https://openscad.org/  or set OPENSCAD_PATH");
  console.log("     Portable drop-in: vendor/openscad/openscad.exe");
  console.log("");
  console.log("Then: npm run dev   or double-click Start-DescribePrint.cmd on Windows.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
