/**
 * OpenSCAD binary resolution for compile + health checks.
 *
 * Priority:
 *   1. OPENSCAD_PATH — file, or a folder that contains the executable
 *      (portable / bundled copies, or a custom install).
 *   2. OPENSCAD_BIN — explicit executable (legacy; still honored).
 *   3. Portable folders next to the app: vendor/openscad, tools/openscad,
 *      bundled/openscad, .local/openscad.
 *   4. Common OS install locations (Windows Program Files, macOS
 *      /Applications, Linux /usr/bin).
 *   5. PATH (`openscad` / `openscad.exe`).
 *
 * M1 does not ship a bundled binary yet. The portable folders above are the
 * intended drop-in path so a later packager can place OpenSCAD there without
 * changing resolution. Until then, install from https://openscad.org/ or set
 * OPENSCAD_PATH.
 */

import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenscadSource } from "./health-types";

export type { OpenscadSource } from "./health-types";

export const DEFAULT_OPENSCAD_COMMAND = "openscad";

export type OpenscadResolution = {
  /** Command passed to spawn — absolute path when found, else a PATH name. */
  command: string;
  found: boolean;
  source: OpenscadSource;
  /** Absolute paths that were considered (env + well-known locations). */
  candidates: string[];
};

export type OpenscadResolveOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  homedir?: string;
  isFile?: (filePath: string) => boolean;
};

const PORTABLE_DIRS = ["vendor/openscad", "tools/openscad", "bundled/openscad", ".local/openscad"];

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultIsFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function openscadExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["openscad.exe", "openscad.com", "openscad"];
  if (platform === "darwin") return ["OpenSCAD", "openscad"];
  return ["openscad"];
}

function expandToExecutable(
  raw: string,
  platform: NodeJS.Platform,
  isFile: (filePath: string) => boolean,
): string | null {
  const join = pathApi(platform).join;
  const names = openscadExecutableNames(platform);
  if (isFile(raw)) return raw;
  for (const name of names) {
    const nested = join(raw, name);
    if (isFile(nested)) return nested;
  }
  if (platform === "darwin") {
    const fromApp = join(raw, "Contents", "MacOS", "OpenSCAD");
    if (isFile(fromApp)) return fromApp;
    const wrapped = join(raw, "OpenSCAD.app", "Contents", "MacOS", "OpenSCAD");
    if (isFile(wrapped)) return wrapped;
  }
  return null;
}

export function portableOpenscadDirs(cwd: string, platform: NodeJS.Platform): string[] {
  const join = pathApi(platform).join;
  return PORTABLE_DIRS.map((rel) => join(cwd, ...rel.split("/")));
}

export function windowsInstallDirs(env: NodeJS.ProcessEnv, homedir: string): string[] {
  const join = path.win32.join;
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || join(homedir, "AppData", "Local");
  const scoop = env.SCOOP || join(homedir, "scoop");
  return [
    join(pf, "OpenSCAD"),
    join(pf, "OpenSCAD (Nightly)"),
    join(pf86, "OpenSCAD"),
    join(local, "Programs", "OpenSCAD"),
    join(local, "OpenSCAD"),
    join(scoop, "apps", "openscad", "current"),
    "C:\\ProgramData\\chocolatey\\bin",
  ];
}

export function macosInstallFiles(): string[] {
  return [
    "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
    "/Applications/OpenSCAD-nightly.app/Contents/MacOS/OpenSCAD",
  ];
}

export function linuxInstallFiles(): string[] {
  return ["/usr/bin/openscad", "/usr/local/bin/openscad", "/snap/bin/openscad"];
}

function pathSearchDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const delimiter = platform === "win32" ? ";" : ":";
  const raw = env.PATH || env.Path || "";
  return raw.split(delimiter).map((part) => part.trim()).filter(Boolean);
}

function isBareDefaultBin(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes("/")) return false;
  const base = normalized.toLowerCase();
  return base === "openscad" || base === "openscad.exe" || base === "openscad.com";
}

/**
 * Resolve the OpenSCAD executable without spawning it.
 * Cheap filesystem checks only — use `probeOpenscad` for a version ping.
 */
export function resolveOpenscad(options: OpenscadResolveOptions = {}): OpenscadResolution {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir();
  const isFile = options.isFile ?? defaultIsFile;
  const join = pathApi(platform).join;
  const names = openscadExecutableNames(platform);
  const candidates: string[] = [];

  const consider = (raw: string | null | undefined): string | null => {
    if (!raw?.trim()) return null;
    const trimmed = raw.trim();
    candidates.push(trimmed);
    return expandToExecutable(trimmed, platform, isFile);
  };

  const fromPath = env.OPENSCAD_PATH?.trim();
  if (fromPath) {
    const resolved = consider(fromPath);
    return {
      command: resolved ?? fromPath,
      found: Boolean(resolved),
      source: "OPENSCAD_PATH",
      candidates,
    };
  }

  const fromBin = env.OPENSCAD_BIN?.trim();
  if (fromBin && !isBareDefaultBin(fromBin)) {
    const resolved = consider(fromBin);
    return {
      command: resolved ?? fromBin,
      found: Boolean(resolved),
      source: "OPENSCAD_BIN",
      candidates,
    };
  }
  if (fromBin) candidates.push(fromBin);

  for (const dir of portableOpenscadDirs(cwd, platform)) {
    const resolved = consider(dir);
    if (resolved) {
      return { command: resolved, found: true, source: "portable", candidates };
    }
  }

  if (platform === "win32") {
    for (const dir of windowsInstallDirs(env, homedir)) {
      const resolved = consider(dir);
      if (resolved) {
        return { command: resolved, found: true, source: "windows-install", candidates };
      }
    }
  } else if (platform === "darwin") {
    for (const file of macosInstallFiles()) {
      candidates.push(file);
      if (isFile(file)) {
        return { command: file, found: true, source: "macos-install", candidates };
      }
    }
  } else {
    for (const file of linuxInstallFiles()) {
      candidates.push(file);
      if (isFile(file)) {
        return { command: file, found: true, source: "linux-install", candidates };
      }
    }
  }

  for (const dir of pathSearchDirs(env, platform)) {
    for (const name of names) {
      const file = join(dir, name);
      candidates.push(file);
      if (isFile(file)) {
        return { command: file, found: true, source: "path", candidates };
      }
    }
  }

  return {
    command: platform === "win32" ? "openscad.exe" : DEFAULT_OPENSCAD_COMMAND,
    found: false,
    source: "missing",
    candidates,
  };
}

/** Spawn target used by the compile path. */
export function resolveOpenscadBin(options?: OpenscadResolveOptions): string {
  return resolveOpenscad(options).command;
}
