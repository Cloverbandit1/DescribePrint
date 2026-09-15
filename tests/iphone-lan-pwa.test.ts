import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI_BASE_URL } from "@/lib/llm-config";
import manifest from "@/app/manifest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("iPhone / LAN host pack", () => {
  it("binds Next.js to 0.0.0.0 and does not retarget Ollama", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts.dev).toMatch(/next dev --hostname 0\.0\.0\.0/);
    expect(pkg.scripts.start).toMatch(/next start --hostname 0\.0\.0\.0/);
    expect(pkg.scripts["lan:url"]).toBe("node scripts/print-lan-access.mjs");
    expect(DEFAULT_OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(read("lib/llm-config.ts")).toContain("http://127.0.0.1:11434/v1");
    expect(read("scripts/lib/describeprint-env.mjs")).toContain("http://127.0.0.1:11434/v1");
  });

  it("Start scripts print LAN / Tailscale URL + QR and keep Ollama localhost", () => {
    const ps1 = read("scripts/windows/Start-DescribePrint.ps1").replace(/^\uFEFF/, "");
    const cmd = read("Start-DescribePrint.cmd");
    for (const text of [ps1, cmd]) {
      expect(text).toContain("scripts\\print-lan-access.mjs");
      expect(text).toMatch(/127\.0\.0\.1:11434/);
      expect(text).toMatch(/Agent Smith/);
      expect(text).toMatch(/npm run dev/);
      expect(text).not.toMatch(/11435/);
      expect(text).not.toMatch(/0\.0\.0\.0:11434/);
    }
    expect(ps1).toMatch(/Optional Tailscale 100\.x URL is preferred for the QR/);
    expect(cmd).toMatch(/Optional Tailscale 100\.x URL is preferred for the QR/);
  });

  it("ships a standalone PWA manifest, icons, and app-shell service worker", () => {
    const web = manifest();
    expect(web.display).toBe("standalone");
    expect(web.theme_color).toBe("#00b347");
    expect(web.start_url).toBe("/");
    expect(web.icons?.some((icon) => icon.src === "/icon-192.png")).toBe(true);
    expect(existsSync(path.join(repoRoot, "public/icon-192.png"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "public/icon-512.png"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "public/apple-touch-icon.png"))).toBe(true);
    const sw = read("public/sw.js");
    expect(sw).toMatch(/describeprint-shell-v1/);
    expect(sw).toMatch(/\/api\//);
    expect(sw).toMatch(/cache\.addAll/);
    expect(sw).toMatch(/pathname\.startsWith\("\/api\/"\)/);
  });

  it("root layout is iOS Safari / Add to Home Screen ready", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/viewportFit:\s*"cover"/);
    expect(layout).toMatch(/themeColor:\s*"#00b347"/);
    expect(layout).toMatch(/appleWebApp/);
    expect(layout).toMatch(/apple-touch-icon/);
    expect(layout).toMatch(/PwaRegister/);
    const css = read("app/globals.css");
    expect(css).toMatch(/--safe-area-inset-top:\s*env\(safe-area-inset-top/);
    expect(css).toMatch(/safe-area-inset-bottom/);
  });

  it("photo import exposes capture=environment without rebuilding Print doctor", () => {
    const ui = read("components/DescribePrintApp.tsx");
    expect(ui).toMatch(/accept="image\/\*"/);
    expect(ui).toMatch(/capture="environment"/);
    expect(ui).toMatch(/Import photo/);
    expect(ui).toMatch(/onImportPhoto/);
    expect(ui).toContain('accept=".stl,.3mf,.png,.jpg,.jpeg,.webp');
  });

  it("README documents LAN, firewall, QR, Tailscale mesh, and no App Store", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/iPhone on the same Wi/);
    expect(readme).toMatch(/http:\/\/<host-lan-ip>:3000/);
    expect(readme).toMatch(/Windows Firewall/);
    expect(readme).toMatch(/Add to Home Screen/);
    expect(readme).toMatch(/No App Store/);
    expect(readme).toMatch(/Optional: iPhone away from home \(Tailscale\)/);
    expect(readme).toMatch(/Smith must run Tailscale/);
    expect(readme).toMatch(/Laptop Tailscale alone is \*\*not\*\* enough/);
    expect(readme).toMatch(/mesh-only/);
    expect(readme).toMatch(/127\.0\.0\.1:11434/);
    expect(readme).not.toMatch(/change the Ollama port to/);
  });
});
