import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const issPath = path.join(repoRoot, "packaging", "windows", "AllosWorstation.iss");
const infoAfterPath = path.join(repoRoot, "packaging", "windows", "InfoAfter.txt");
const helperPath = path.join(repoRoot, "scripts", "windows", "Build-InnoInstaller.ps1");

describe("optional Inno Setup installer", () => {
  it("keeps lowest privileges, detector bat, and localappdata hint", () => {
    const iss = readFileSync(issPath, "utf8");
    expect(iss).toContain("PrivilegesRequired=lowest");
    expect(iss).toContain("{userdesktop}\\AllosWorstation");
    expect(iss).toContain("Start DescribePrint.bat");
    expect(iss).toContain("{localappdata}\\AllosWorstation");
    expect(iss).toContain("repo-path.txt");
    expect(iss).toMatch(/Shared detector bat -- do not bake \{app\} here/);
    expect(iss).not.toMatch(/SaveStringToFile\(\s*BatPath[\s\S]*\{app\}/);
    expect(iss).toContain("%USERPROFILE%\\AllosWorstation\\DescribePrint");
    expect(iss).toContain("%~dp0DescribePrint");
    expect(iss).toContain("call \"%TARGET%\\Start-DescribePrint.cmd\"");
  });

  it("adds Start Menu and optional Desktop shortcuts to Start-DescribePrint.cmd", () => {
    const iss = readFileSync(issPath, "utf8");
    expect(iss).toMatch(/Name:\s*"desktopicon"/);
    expect(iss).toMatch(/Flags:\s*unchecked/);
    expect(iss).toContain("{group}\\Start DescribePrint");
    expect(iss).toContain("{userdesktop}\\Start DescribePrint");
    expect(iss).toMatch(
      /Name:\s*"\{group\}\\Start DescribePrint";\s*Filename:\s*"\{app\}\\Start-DescribePrint\.cmd"/,
    );
    expect(iss).toMatch(
      /Name:\s*"\{userdesktop\}\\Start DescribePrint";\s*Filename:\s*"\{app\}\\Start-DescribePrint\.cmd".*Tasks:\s*desktopicon/,
    );
  });

  it("fails closed when the portable SourceDir marker is missing", () => {
    const iss = readFileSync(issPath, "utf8");
    expect(iss).toMatch(/#ifnexist\s+"\.\.\\\.\.\\dist\\AllosWorstation-portable\\Start-DescribePrint\.cmd"/);
    expect(iss).toMatch(/#error\s+Portable folder missing/);
    expect(iss).toContain("npm run pack:windows");
    expect(iss).toContain("jrsoftware.org");
  });

  it("InfoAfter / finished tip covers Node, ollama pull, Smith, and port 11434", () => {
    const iss = readFileSync(issPath, "utf8");
    expect(iss).toContain("InfoAfterFile=InfoAfter.txt");
    const tip = readFileSync(infoAfterPath, "utf8");
    expect(tip).toMatch(/Node\.js LTS/);
    expect(tip).toContain("https://nodejs.org");
    expect(tip).toContain("127.0.0.1:11434");
    expect(tip).toContain("ollama pull qwen2.5-coder:32b");
    expect(tip).toContain("qwen2.5-coder:14b");
    expect(tip).toContain("qwen2.5-coder:7b");
    expect(tip).toMatch(/NEVER delete, replace, or retarget Agent Smith models/);
    expect(tip).toContain("smith-minicpm5");
    expect(tip).toContain("Start-DescribePrint.cmd");
    expect(tip).not.toMatch(/11435|change Ollama's port to/i);
  });

  it("exposes a Build-InnoInstaller helper and npm script", () => {
    expect(existsSync(helperPath)).toBe(true);
    const helper = readFileSync(helperPath, "utf8").replace(/^\uFEFF/, "");
    expect(helper).toContain("ISCC.exe");
    expect(helper).toContain("Inno Setup 6");
    expect(helper).toContain("https://jrsoftware.org/isinfo.php");
    expect(helper).toContain("pack:windows");
    expect(helper).toContain("AllosWorstation.iss");
    expect(helper).toContain("AllosWorstation-DescribePrint-Setup.exe");
    expect(helper).toContain("SkipAutoPack");
    expect(helper).toMatch(/does not bundle Node/i);
    expect(helper).not.toMatch(/minicpm5|smith-/i);

    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["pack:windows:installer"]).toMatch(/Build-InnoInstaller\.ps1/);
    expect(pkg.scripts["pack:windows"]).toMatch(/build-portable\.mjs/);
  });

  it("README documents the Setup.exe one-liner as optional", () => {
    const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    expect(rootReadme).toMatch(/### Build Setup\.exe \(optional\)/);
    expect(rootReadme).toContain("npm run pack:windows:installer");
    expect(rootReadme).toContain("scripts\\windows\\Build-InnoInstaller.ps1");
    expect(rootReadme).toMatch(/Portable zip is the supported Windows path/);

    const packReadme = readFileSync(path.join(repoRoot, "packaging", "windows", "README.md"), "utf8");
    expect(packReadme).toContain("npm run pack:windows:installer");
    expect(packReadme).toContain("Build-InnoInstaller.ps1");
    expect(packReadme).toMatch(/Portable zip remains the \*\*supported\*\* path/);
    expect(packReadme).toMatch(/MSI is out of scope/);
  });
});
