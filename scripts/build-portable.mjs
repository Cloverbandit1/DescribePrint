#!/usr/bin/env node
/**
 * Build dist/AllosWorstation-portable/ + zip (setup pack, not Electron).
 *
 * Copies app sources and Windows Start/setup scripts. Skips node_modules.
 * Optionally downloads OpenSCAD into the pack (do not commit that binary).
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PORTABLE_DIR_NAME,
  assertPortableTree,
  copySourceTree,
  installOpenscadPortable,
  writePackManifest,
  writeStartHere,
  zipDirectory,
} from "./lib/windows-pack.mjs";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(argValue("root", path.join(here, "..")));
const distRoot = path.resolve(argValue("out", path.join(repoRoot, "dist", PORTABLE_DIR_NAME)));
const zipPath = path.resolve(argValue("zip", path.join(repoRoot, "dist", `${PORTABLE_DIR_NAME}.zip`)));
const fetchOpenscad = hasFlag("fetch-openscad");
const skipZip = hasFlag("skip-zip");

console.log("AllosWorstation portable setup pack");
console.log(`  source: ${repoRoot}`);
console.log(`  out:    ${distRoot}`);

if (existsSync(distRoot)) {
  await rm(distRoot, { recursive: true, force: true });
}
await mkdir(path.dirname(distRoot), { recursive: true });
await copySourceTree(repoRoot, distRoot);
await writeStartHere(distRoot);
await writePackManifest(distRoot, {
  builtAt: new Date().toISOString(),
  includesOpenscadBinary: fetchOpenscad,
});
assertPortableTree(distRoot);

if (fetchOpenscad) {
  console.log("Fetching OpenSCAD portable zip into the pack…");
  await installOpenscadPortable(distRoot);
}

if (!skipZip) {
  console.log(`Zipping ${zipPath}…`);
  await zipDirectory(distRoot, zipPath);
}

console.log("");
console.log("Done. On Windows:");
console.log(`  1. Unzip ${PORTABLE_DIR_NAME}.zip`);
console.log("  2. Run Setup-DescribePrint.cmd  (or Install-AllosWorstation.ps1 -Layout Laptop|Smith)");
console.log("  3. Start-DescribePrint.cmd  or Desktop \\ AllosWorstation \\ Start DescribePrint.bat");
console.log("");
console.log("Optional Inno Setup: compile packaging/windows/AllosWorstation.iss after this pack exists.");
console.log("MSI is a follow-up — zip + bootstrap is the supported path.");
