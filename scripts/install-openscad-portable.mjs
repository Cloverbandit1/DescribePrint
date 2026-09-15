#!/usr/bin/env node
/**
 * Fetch the official OpenSCAD Windows zip into vendor/openscad/.
 * Does not commit the binary. Safe to re-run (skips if openscad.exe exists).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OPENSCAD_ZIP_URL,
  findSystemOpenscad,
  installOpenscadPortable,
  vendorOpenscadExe,
} from "./lib/windows-pack.mjs";
import { existsSync } from "node:fs";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(argValue("root", path.join(here, "..")));
const url = argValue("url", DEFAULT_OPENSCAD_ZIP_URL);
const preferSystem = hasFlag("prefer-system");
const force = hasFlag("force");

if (preferSystem) {
  const system = findSystemOpenscad();
  if (system) {
    console.log(`Using installed OpenSCAD: ${system}`);
    console.log("Skip portable download (Program Files is fine on the laptop layout).");
    process.exit(0);
  }
}

const exe = vendorOpenscadExe(root);
if (existsSync(exe) && !force) {
  console.log(`OpenSCAD already at ${exe}`);
  process.exit(0);
}

if (hasFlag("dry-run")) {
  console.log(`Would download ${url}`);
  console.log(`Would flatten into ${path.join(root, "vendor", "openscad")}`);
  process.exit(0);
}

console.log(`Downloading OpenSCAD portable zip…`);
console.log(url);
const result = await installOpenscadPortable(root, { url, force });
if (result.skipped) {
  console.log(`Already present: ${result.exe}`);
} else {
  console.log(`Installed portable OpenSCAD → ${result.exe}`);
}
console.log("DescribePrint resolveOpenscad will pick vendor/openscad automatically.");
