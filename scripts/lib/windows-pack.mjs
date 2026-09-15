/**
 * Shared helpers for the AllosWorstation / DescribePrint Windows setup pack.
 * No Electron/Tauri — zip + Start-DescribePrint.cmd.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

export const PRODUCT_FOLDER = "AllosWorstation";
export const APP_FOLDER = "DescribePrint";
export const PORTABLE_DIR_NAME = "AllosWorstation-portable";
export const DESKTOP_BAT_NAME = "Start DescribePrint.bat";

export const DEFAULT_OPENSCAD_ZIP_URL =
  process.env.OPENSCAD_PORTABLE_URL ||
  "https://files.openscad.org/OpenSCAD-2021.01-x86-64.zip";

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "generated",
  "tmp",
  ".cursor",
  ".idea",
  ".vscode",
  ".turbo",
]);

const SKIP_FILE_NAMES = new Set([".env.local", ".env", "Thumbs.db", ".DS_Store"]);

export function laptopRepoPath(userProfile) {
  return path.join(userProfile, PRODUCT_FOLDER, APP_FOLDER);
}

export function smithRepoPath(desktop) {
  return path.join(desktop, PRODUCT_FOLDER, APP_FOLDER);
}

export function desktopProductFolder(desktop) {
  return path.join(desktop, PRODUCT_FOLDER);
}

/** Desktop .bat contract: always call the repo Start-DescribePrint.cmd. */
export function desktopBatContents(repoPath) {
  const windowsPath = toWindowsPath(repoPath);
  return [
    "@echo off",
    "REM AllosWorstation / DescribePrint — one-click Start",
    "REM Contract: call the repo Start-DescribePrint.cmd (do not start Next.js here).",
    `call "${windowsPath}\\Start-DescribePrint.cmd"`,
    "",
  ].join("\r\n");
}

export function toWindowsPath(value) {
  return String(value).replace(/\//g, "\\");
}

export function shouldSkipName(name, isDirectory) {
  if (isDirectory) return SKIP_DIR_NAMES.has(name);
  if (SKIP_FILE_NAMES.has(name)) return true;
  if (name.endsWith(".stl") || name.endsWith(".3mf")) return true;
  return false;
}

function filterCopy(fromRoot) {
  return (src) => {
    const rel = path.relative(fromRoot, src);
    if (!rel || rel === ".") return true;
    const parts = rel.split(path.sep);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const full = path.join(fromRoot, ...parts.slice(0, i + 1));
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = !path.extname(part);
      }
      if (shouldSkipName(part, isDir || i < parts.length - 1)) return false;
    }
    return true;
  };
}

export async function copySourceTree(sourceRoot, destRoot) {
  await mkdir(destRoot, { recursive: true });
  const destResolved = path.resolve(destRoot);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipName(entry.name, entry.isDirectory())) continue;
    const src = path.join(sourceRoot, entry.name);
    const dest = path.join(destRoot, entry.name);
    const srcResolved = path.resolve(src);
    if (destResolved === srcResolved || destResolved.startsWith(`${srcResolved}${path.sep}`)) {
      continue;
    }
    await cp(src, dest, { recursive: true, filter: filterCopy(src) });
  }
}

export function requiredPortableFiles(root) {
  return [
    "Start-DescribePrint.cmd",
    "Setup-DescribePrint.cmd",
    "package.json",
    "package-lock.json",
    ".env.example",
    "scripts/windows/Start-DescribePrint.ps1",
    "scripts/windows/health-preflight.ts",
    "lib/health-preflight.ts",
    "scripts/health-preflight.mjs",
    "scripts/ensure-env-local.mjs",
    "scripts/install-openscad-portable.mjs",
    "vendor/openscad/README.md",
  ].map((rel) => path.join(root, rel));
}

export function assertPortableTree(root) {
  const missing = requiredPortableFiles(root).filter((file) => !existsSync(file));
  if (missing.length) {
    throw new Error(`Portable tree is missing:\n${missing.join("\n")}`);
  }
}

export async function writeDesktopBat(desktopDir, repoPath) {
  const folder = desktopProductFolder(desktopDir);
  await mkdir(folder, { recursive: true });
  const batPath = path.join(folder, DESKTOP_BAT_NAME);
  await writeFile(batPath, desktopBatContents(repoPath), "utf8");
  return batPath;
}

export async function writeStartHere(destRoot) {
  const text = `AllosWorstation / DescribePrint — portable setup pack
=====================================================

This zip is a setup pack (app sources + scripts). It does not ship node_modules
or the OpenSCAD binary (large / separate license).

1. Install Node.js LTS from https://nodejs.org if needed.
2. Double-click Setup-DescribePrint.cmd
   or:  powershell -ExecutionPolicy Bypass -File scripts\\windows\\Setup-DescribePrint.ps1
3. Double-click Start-DescribePrint.cmd
   or use Desktop \\ AllosWorstation \\ Start DescribePrint.bat
   (that bat always calls this folder's Start-DescribePrint.cmd)

Local AI: Ollama at 127.0.0.1:11434  MODEL=qwen2.5-coder:32b
  ollama pull qwen2.5-coder:32b
  (lighter: qwen2.5-coder:14b or qwen2.5-coder:7b — set MODEL in .env.local)

NEVER delete, retarget, or replace Agent Smith models
(smith-minicpm5, openbmb/minicpm5-*, …). Do not change Ollama's port.

OpenSCAD: Setup fetches the official Windows zip into vendor\\openscad
or uses Program Files\\OpenSCAD. See packaging\\windows\\README.md
`;
  await writeFile(path.join(destRoot, "START-HERE.txt"), text, "utf8");
}

export async function writePackManifest(destRoot, extra = {}) {
  const pkg = JSON.parse(readFileSync(path.join(destRoot, "package.json"), "utf8"));
  const manifest = {
    name: "AllosWorstation-DescribePrint",
    kind: "setup-pack",
    version: pkg.version || "0.1.0",
    start: "Start-DescribePrint.cmd",
    setup: "Setup-DescribePrint.cmd",
    ollama: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:32b",
    lighterModels: ["qwen2.5-coder:14b", "qwen2.5-coder:7b"],
    forbiddenModels: ["smith-minicpm5", "openbmb/minicpm5-*"],
    openscadVendor: "vendor/openscad",
    ...extra,
  };
  await writeFile(path.join(destRoot, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function resolveLayoutPaths({
  layout = "current",
  sourceRoot,
  desktop,
  userProfile,
  repoPath,
}) {
  const kind = String(layout).toLowerCase();
  let target;
  if (repoPath) {
    target = repoPath;
  } else if (kind === "laptop") {
    target = laptopRepoPath(userProfile);
  } else if (kind === "smith") {
    const looksLikeRepo = sourceRoot && existsSync(path.join(sourceRoot, "Start-DescribePrint.cmd"));
    target = looksLikeRepo ? sourceRoot : smithRepoPath(desktop);
  } else {
    target = sourceRoot;
  }
  return {
    layout: kind,
    sourceRoot,
    targetRoot: target,
    desktopFolder: desktopProductFolder(desktop),
    desktopBat: path.join(desktopProductFolder(desktop), DESKTOP_BAT_NAME),
    sameTree: path.resolve(sourceRoot) === path.resolve(target),
  };
}

async function findFileByName(dir, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.has(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

export function vendorOpenscadExe(root) {
  return path.join(root, "vendor", "openscad", "openscad.exe");
}

export function windowsSystemOpenscadCandidates(env = process.env) {
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    path.join(pf, "OpenSCAD", "openscad.exe"),
    path.join(pf, "OpenSCAD (Nightly)", "openscad.exe"),
    path.join(pf86, "OpenSCAD", "openscad.exe"),
  ];
}

export function findSystemOpenscad(env = process.env) {
  return windowsSystemOpenscadCandidates(env).find((file) => existsSync(file)) || null;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

export async function downloadFile(url, destFile) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status} ${url}`);
  }
  await mkdir(path.dirname(destFile), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destFile));
}

export async function extractZip(zipFile, destDir) {
  await mkdir(destDir, { recursive: true });
  if (process.platform === "win32") {
    await run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      destDir,
    );
    return;
  }
  await run("unzip", ["-q", "-o", zipFile, "-d", destDir], destDir);
}

/**
 * Download the official OpenSCAD Windows zip and flatten so
 * vendor/openscad/openscad.exe exists (matches resolveOpenscad).
 */
export async function installOpenscadPortable(root, { url = DEFAULT_OPENSCAD_ZIP_URL, force = false } = {}) {
  const vendorDir = path.join(root, "vendor", "openscad");
  const exe = path.join(vendorDir, "openscad.exe");
  if (existsSync(exe) && !force) {
    return { exe, skipped: true, vendorDir };
  }

  const tmp = path.join(os.tmpdir(), `describeprint-openscad-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  const zipFile = path.join(tmp, "openscad-portable.zip");
  await downloadFile(url, zipFile);
  const extractDir = path.join(tmp, "extract");
  await extractZip(zipFile, extractDir);
  const found = await findFileByName(extractDir, ["openscad.exe"]);
  if (!found) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`openscad.exe not found in ${url}. Place it in vendor/openscad/ yourself.`);
  }
  const sourceDir = path.dirname(found);
  await mkdir(vendorDir, { recursive: true });
  await cp(sourceDir, vendorDir, { recursive: true });
  await rm(tmp, { recursive: true, force: true });
  if (!existsSync(exe)) {
    throw new Error(`Copied OpenSCAD but ${exe} is still missing.`);
  }
  return { exe, skipped: false, vendorDir, url };
}

export async function zipDirectory(sourceDir, zipFile) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  async function addDir(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await addDir(full, rel);
      else zip.file(rel, readFileSync(full));
    }
  }

  await addDir(sourceDir, path.basename(sourceDir));
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await mkdir(path.dirname(zipFile), { recursive: true });
  await writeFile(zipFile, buffer);
  return zipFile;
}

export { mkdirSync, existsSync };
