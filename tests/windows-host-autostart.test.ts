import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopBatContents, requiredPortableFiles } from "../scripts/lib/windows-pack.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const windowsDir = path.join(repoRoot, "scripts", "windows");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8").replace(/^\uFEFF/, "");
}

function readWindows(name: string) {
  return read(path.join("scripts", "windows", name));
}

describe("Smith 24/7 host auto-start + power", () => {
  it("ships maintainable auto-start and host-power scripts", () => {
    for (const name of [
      "Install-AutoStart.ps1",
      "Uninstall-AutoStart.ps1",
      "Configure-HostPower.ps1",
    ]) {
      expect(existsSync(path.join(windowsDir, name)), name).toBe(true);
    }

    const install = readWindows("Install-AutoStart.ps1");
    expect(install).toMatch(/param\(/);
    expect(install).toMatch(/\$Method = 'Task'/);
    expect(install).toMatch(/ValidateSet\('Task', 'Startup'\)/);
    expect(install).toMatch(/\[switch\]\$Remove/);
    expect(install).toMatch(/Start-DescribePrint\.cmd/);
    expect(install).toMatch(/New-ScheduledTaskTrigger -AtLogOn/);
    expect(install).toMatch(/Register-ScheduledTask/);
    expect(install).toMatch(/ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    expect(install).toMatch(/GetFolderPath\('Startup'\)/);
    expect(install).toMatch(/CreateShortcut/);
    expect(install).toMatch(/AllosWorstation-DescribePrint/);
    expect(install).not.toMatch(/npm run dev/);
    expect(install).not.toMatch(/11435/);
    expect(install).toMatch(/127\.0\.0\.1:11434/);
    expect(install).toMatch(/print-lan-access\.mjs/);

    const uninstall = readWindows("Uninstall-AutoStart.ps1");
    expect(uninstall).toMatch(/Install-AutoStart\.ps1/);
    expect(uninstall).toMatch(/-Remove/);

    const power = readWindows("Configure-HostPower.ps1");
    expect(power).toMatch(/ValidateSet\('Smith', 'Laptop', 'Current'\)/);
    expect(power).toMatch(/\[switch\]\$ForceHost/);
    expect(power).toMatch(/\$Layout -ne 'Smith' -and -not \$ForceHost/);
    expect(power).toMatch(/exit 2/);
    expect(power).toMatch(/standby-timeout-ac 0/);
    expect(power).toMatch(/hibernate-timeout-ac 0/);
    expect(power).toMatch(/RTCWAKE/);
    expect(power).toMatch(/Battery \(DC\)/);
    expect(power).not.toMatch(/standby-timeout-dc/);
    expect(power).toMatch(/127\.0\.0\.1:11434/);
    expect(power).toMatch(/does not touch Agent Smith models/);
  });

  it("Install -Layout Smith defaults auto-start and host power ON; laptop does not", () => {
    const install = readWindows("Install-AllosWorstation.ps1");
    expect(install).toMatch(/\[switch\]\$AutoStart/);
    expect(install).toMatch(/\[switch\]\$NoAutoStart/);
    expect(install).toMatch(/\[switch\]\$RemoveAutoStart/);
    expect(install).toMatch(/\[switch\]\$SkipHostPower/);
    expect(install).toMatch(/\$Layout -eq 'Smith'/);
    expect(install).toMatch(/\$enableAutoStart = \$true/);
    expect(install).toMatch(/Laptop is not the 24\/7 host/);
    expect(install).toMatch(/Current layout does not auto-enable/);
    expect(install).toMatch(/Install-AutoStart\.ps1/);
    expect(install).toMatch(/Configure-HostPower\.ps1/);
    expect(install).toMatch(/Host power tweaks are Smith-only/);
    expect(install).toMatch(/Keep Ollama on 127\.0\.0\.1:11434/);
    expect(install).toMatch(/Do not auto-kill Agent Smith models/);
    expect(install).toMatch(/Smith desktop is the 24\/7 AllosWorstation host/);

    const setup = readWindows("Setup-DescribePrint.ps1");
    expect(setup).toMatch(/\[switch\]\$AutoStart/);
    expect(setup).toMatch(/\[switch\]\$NoAutoStart/);
    expect(setup).toMatch(/\[switch\]\$RemoveAutoStart/);
    expect(setup).toMatch(/\[switch\]\$SkipHostPower/);

    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["autostart:windows"]).toMatch(/Install-AutoStart\.ps1/);
    expect(pkg.scripts["autostart:windows:remove"]).toMatch(/Uninstall-AutoStart\.ps1/);
    expect(pkg.scripts["host-power:windows"]).toMatch(/Configure-HostPower\.ps1 -Layout Smith/);
  });

  it("does not regress Start LAN/Tailscale QR or the OneDrive-safe Desktop bat", () => {
    const start = readWindows("Start-DescribePrint.ps1");
    const cmd = read("Start-DescribePrint.cmd");
    for (const text of [start, cmd]) {
      expect(text).toContain("scripts\\print-lan-access.mjs");
      expect(text).toMatch(/127\.0\.0\.1:11434/);
      expect(text).not.toMatch(/11435/);
      expect(text).not.toMatch(/0\.0\.0\.0:11434/);
    }
    expect(start).toMatch(/Optional Tailscale 100\.x URL is preferred for the QR/);

    const bat = desktopBatContents();
    expect(bat).toContain("%LOCALAPPDATA%\\AllosWorstation\\repo-path.txt");
    expect(bat).toContain("%~dp0DescribePrint");
    expect(bat).toContain("%USERPROFILE%\\AllosWorstation\\DescribePrint");
    expect(bat).toContain("Start-DescribePrint.cmd");
    expect(bat).not.toMatch(/npm run dev/);

    const missing = requiredPortableFiles(repoRoot).filter((file) => !existsSync(file));
    expect(missing).toEqual([]);
    expect(
      requiredPortableFiles(repoRoot).some((file) => file.endsWith("Install-AutoStart.ps1")),
    ).toBe(true);
  });

  it("README + pack docs: Smith is 24/7 host, Tailscale on Smith, laptop optional", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/Smith desktop is the 24\/7 AllosWorstation host/);
    expect(readme).toMatch(/Smith = 24\/7 host/);
    expect(readme).toMatch(/Install-AutoStart\.ps1/);
    expect(readme).toMatch(/Configure-HostPower\.ps1/);
    expect(readme).toMatch(/not the always-on remote host/);
    expect(readme).toMatch(/Smith must run Tailscale/);
    expect(readme).toMatch(/Laptop Tailscale alone is \*\*not\*\* enough/);
    expect(readme).toMatch(/GPU \/ RAM contention/);
    expect(readme).toMatch(/Do \*\*not\*\* auto-kill Agent Smith models/);
    expect(readme).toMatch(/127\.0\.0\.1:11434/);
    expect(readme).not.toMatch(/change the Ollama port to/);

    const pack = read("packaging/windows/README.md");
    expect(pack).toMatch(/24\/7 AllosWorstation host/);
    expect(pack).toMatch(/Laptop Tailscale alone is not enough/);
    expect(pack).toMatch(/Install-AutoStart\.ps1/);
    expect(pack).toMatch(/Configure-HostPower\.ps1/);
    expect(pack).toMatch(/auto-kill Smith models or change Ollama/);
    expect(pack).toMatch(/Start-DescribePrint\.cmd/);
    expect(pack).toMatch(/LAN URL \+ QR/);

    const startHere = read("scripts/lib/windows-pack.mjs");
    expect(startHere).toMatch(/Smith desktop is the 24\/7 AllosWorstation host/);
    expect(startHere).toMatch(/Laptop Tailscale alone is not enough/);

    const after = read("packaging/windows/InfoAfter.txt");
    expect(after).toMatch(/24\/7 AllosWorstation host/);
    expect(after).toMatch(/Laptop Tailscale/);
    expect(after).toContain("127.0.0.1:11434");
  });
});
