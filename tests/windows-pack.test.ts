import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_BAT_NAME,
  LOCAL_HINT_NAME,
  PRODUCT_FOLDER,
  copySourceTree,
  desktopBatContents,
  laptopRepoPath,
  localRepoHintContents,
  localRepoHintPath,
  requiredPortableFiles,
  resolveLayoutPaths,
  smithRepoPath,
  toWindowsPath,
  writeDesktopBat,
} from "../scripts/lib/windows-pack.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, "..");

function normalizeBat(text) {
  return String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "\n");
}

describe("Windows portable pack helpers", () => {
  it("desktop bat is a shared OneDrive-safe detector (not a single-machine path)", () => {
    const bat = desktopBatContents();
    expect(bat).toMatch(/call "/);
    expect(bat).toContain("%LOCALAPPDATA%\\AllosWorstation\\repo-path.txt");
    expect(bat).toContain("%COMPUTERNAME%");
    expect(bat).toContain("ALLOS_LAPTOP_HOST");
    expect(bat).toContain("ALLOS_SMITH_HOST");
    expect(bat).toContain("%USERPROFILE%\\AllosWorstation\\DescribePrint");
    expect(bat).toContain('cd /d "%TARGET%"');
    expect(bat).toContain("%~dp0DescribePrint");
    expect(bat).toContain("Start-DescribePrint.cmd");
    expect(bat).not.toMatch(/C:\\Users\\clove\\AllosWorstation\\DescribePrint\\Start-DescribePrint\.cmd/);
    expect(bat).not.toMatch(/npm run dev/);
    expect(bat).not.toMatch(/electron|tauri/i);
  });

  it("template Start bat matches desktopBatContents so pack and Install stay in sync", () => {
    const template = readFileSync(
      path.join(repoRoot, "scripts", "windows", "templates", "Start DescribePrint.bat"),
      "utf8",
    );
    expect(normalizeBat(template)).toBe(normalizeBat(desktopBatContents()));
  });

  it("Smith and Laptop layouts write the same Desktop bat (OneDrive overwrite is a no-op)", async () => {
    const desktop = await mkdtemp(path.join(os.tmpdir(), "allos-desk-same-"));
    const smith = await writeDesktopBat(desktop, "D:/OneDrive/Desktop/AllosWorstation/DescribePrint");
    const first = readFileSync(smith, "utf8");
    const laptop = await writeDesktopBat(desktop, "C:/Users/clove/AllosWorstation/DescribePrint");
    expect(laptop).toBe(smith);
    expect(readFileSync(laptop, "utf8")).toBe(first);
    expect(normalizeBat(first)).toBe(normalizeBat(desktopBatContents()));
  });

  it("uses the laptop path outside OneDrive by default", () => {
    expect(laptopRepoPath("C:\\Users\\clove")).toBe(
      path.join("C:\\Users\\clove", "AllosWorstation", "DescribePrint"),
    );
    expect(smithRepoPath("C:\\Users\\clove\\OneDrive\\Desktop")).toBe(
      path.join("C:\\Users\\clove\\OneDrive\\Desktop", "AllosWorstation", "DescribePrint"),
    );
  });

  it("Smith layout keeps the current checkout when it looks like DescribePrint", () => {
    const source = repoRoot;
    const paths = resolveLayoutPaths({
      layout: "smith",
      sourceRoot: source,
      desktop: "D:\\OneDrive\\Desktop",
      userProfile: "C:\\Users\\clove",
    });
    expect(paths.targetRoot).toBe(source);
    expect(paths.sameTree).toBe(true);
    expect(paths.desktopBat).toContain(path.join(PRODUCT_FOLDER, DESKTOP_BAT_NAME));
  });

  it("Laptop layout targets %USERPROFILE%\\AllosWorstation\\DescribePrint", () => {
    const paths = resolveLayoutPaths({
      layout: "laptop",
      sourceRoot: repoRoot,
      desktop: "D:\\OneDrive\\Desktop",
      userProfile: "C:\\Users\\clove",
    });
    expect(toWindowsPath(paths.targetRoot)).toMatch(/C:\\Users\\clove\\AllosWorstation\\DescribePrint$/);
    expect(paths.sameTree).toBe(false);
  });

  it("writes a Desktop AllosWorstation Start bat plus a machine-local hint", async () => {
    const desktop = await mkdtemp(path.join(os.tmpdir(), "allos-desk-"));
    const localAppData = await mkdtemp(path.join(os.tmpdir(), "allos-local-"));
    const repo = "C:/Users/clove/AllosWorstation/DescribePrint";
    const bat = await writeDesktopBat(desktop, repo, { localAppData });
    expect(path.basename(bat)).toBe("Start DescribePrint.bat");
    expect(existsSync(bat)).toBe(true);
    expect(readFileSync(bat, "utf8")).toContain("%~dp0DescribePrint");
    const hint = localRepoHintPath(localAppData);
    expect(path.basename(hint)).toBe(LOCAL_HINT_NAME);
    expect(readFileSync(hint, "utf8")).toBe(localRepoHintContents(repo));
    expect(toWindowsPath(readFileSync(hint, "utf8").trim())).toBe(
      "C:\\Users\\clove\\AllosWorstation\\DescribePrint",
    );
  });

  it("repo already has the files the portable pack must include", () => {
    const missing = requiredPortableFiles(repoRoot).filter((file) => !existsSync(file));
    expect(missing).toEqual([]);
  });

  it("can copy a tree into dist/ inside the source (in-repo pack)", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "allos-src-"));
    writeFileSync(path.join(src, "Start-DescribePrint.cmd"), "@echo off\r\n");
    mkdirSync(path.join(src, "dist"), { recursive: true });
    mkdirSync(path.join(src, "node_modules"), { recursive: true });
    writeFileSync(path.join(src, "node_modules", "skip.txt"), "no");
    const dest = path.join(src, "dist", "AllosWorstation-portable");
    await copySourceTree(src, dest);
    expect(existsSync(path.join(dest, "Start-DescribePrint.cmd"))).toBe(true);
    expect(existsSync(path.join(dest, "dist"))).toBe(false);
    expect(existsSync(path.join(dest, "node_modules"))).toBe(false);
  });

  it("builds a portable setup tree without node_modules", async () => {
    const out = path.join(os.tmpdir(), `allos-pack-${Date.now()}`);
    await execFileAsync("node", ["scripts/build-portable.mjs", "--out", out, "--skip-zip"], {
      cwd: repoRoot,
    });
    expect(existsSync(path.join(out, "Start-DescribePrint.cmd"))).toBe(true);
    expect(existsSync(path.join(out, "Setup-DescribePrint.cmd"))).toBe(true);
    expect(existsSync(path.join(out, "START-HERE.txt"))).toBe(true);
    expect(existsSync(path.join(out, "pack-manifest.json"))).toBe(true);
    expect(existsSync(path.join(out, "packaging", "windows", "README.md"))).toBe(true);
    expect(existsSync(path.join(out, "node_modules"))).toBe(false);
    expect(existsSync(path.join(out, ".git"))).toBe(false);
    expect(existsSync(path.join(out, ".env.local"))).toBe(false);
  }, 30_000);

  it("does not treat a nested tree as a reason to skip Start-DescribePrint.cmd", () => {
    const tmp = path.join(os.tmpdir(), `pack-src-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "Start-DescribePrint.cmd"), "@echo off\r\n");
    const paths = resolveLayoutPaths({
      layout: "current",
      sourceRoot: tmp,
      desktop: path.join(tmp, "Desktop"),
      userProfile: tmp,
    });
    expect(paths.targetRoot).toBe(tmp);
  });
});
