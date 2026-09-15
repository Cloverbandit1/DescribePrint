import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_BAT_NAME,
  PRODUCT_FOLDER,
  copySourceTree,
  desktopBatContents,
  laptopRepoPath,
  requiredPortableFiles,
  resolveLayoutPaths,
  smithRepoPath,
  toWindowsPath,
  writeDesktopBat,
} from "../scripts/lib/windows-pack.mjs";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("Windows portable pack helpers", () => {
  it("desktop bat always calls Start-DescribePrint.cmd", () => {
    const bat = desktopBatContents("C:\\Users\\clove\\AllosWorstation\\DescribePrint");
    expect(bat).toMatch(/call "/);
    expect(bat).toContain("C:\\Users\\clove\\AllosWorstation\\DescribePrint\\Start-DescribePrint.cmd");
    expect(bat).not.toMatch(/npm run dev/);
    expect(bat).not.toMatch(/electron|tauri/i);
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

  it("writes a Desktop AllosWorstation Start bat", async () => {
    const desktop = await mkdtemp(path.join(os.tmpdir(), "allos-desk-"));
    const bat = await writeDesktopBat(desktop, "C:/Users/clove/AllosWorstation/DescribePrint");
    expect(path.basename(bat)).toBe("Start DescribePrint.bat");
    expect(existsSync(bat)).toBe(true);
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
