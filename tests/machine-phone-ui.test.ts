import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appSrc = readFileSync(join(process.cwd(), "components/DescribePrintApp.tsx"), "utf8");
const cssSrc = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

describe("iPhone Safari Machine / Print column", () => {
  it("keeps Machine in the existing Print column without rewriting the CAD studio shell", () => {
    expect(appSrc).toMatch(/type WorkspaceTab = "prepare" \| "preview";/);
    expect(appSrc).not.toMatch(/type WorkspaceTab = "prepare" \| "preview" \| "print"/);
    expect(appSrc).toContain("print-column");
    expect(appSrc).toContain("machine-panel");
    expect(appSrc).not.toContain("studio-shell");
    expect(cssSrc).not.toContain("studio-shell");
  });

  it("renders Connect LAN fields full-width and keyboard-friendly", () => {
    expect(appSrc).toContain("machine-lan-fields");
    expect(appSrc).toContain('id="machine-lan-host"');
    expect(appSrc).toContain('id="machine-lan-serial"');
    expect(appSrc).toContain('id="machine-lan-access"');
    expect(appSrc).toMatch(/id="machine-lan-host"[\s\S]{0,400}inputMode="decimal"/);
    expect(appSrc).toMatch(/id="machine-lan-serial"[\s\S]{0,400}autoCapitalize="characters"/);
    expect(appSrc).toMatch(/id="machine-lan-access"[\s\S]{0,250}type="password"/);
    expect(appSrc).toMatch(/id="machine-lan-access"[\s\S]{0,400}inputMode="numeric"/);
    expect(appSrc).toContain("LAN MQTT");
    expect(appSrc).toContain("machine-toggle-row");
  });

  it("renders critical machine / doctor / export controls as wrapping tap chips", () => {
    expect(appSrc).toContain("machine-chip-row");
    expect(appSrc).toContain("machine-panel");
    expect(appSrc).toContain("Perfect");
    expect(appSrc).toContain("Still bad");
    expect(appSrc).toContain("Pause");
    expect(appSrc).toContain("Download pack");
    expect(appSrc).toContain("Failed photo (stub)");
    expect(appSrc).toContain('id="farm-machine-select"');
    expect(appSrc).toContain("ams-plan-tray-");
    expect(appSrc).toMatch(/aria-label=\{chip\.ariaLabel\}/);
  });

  it("uses CSS media queries for 44px taps and stacked LAN fields without rewriting desktop", () => {
    expect(cssSrc).toMatch(/@media \(max-width:\s*639px\)/);
    expect(cssSrc).toMatch(/min-height:\s*44px/);
    expect(cssSrc).toMatch(/\.machine-lan-fields/);
    expect(cssSrc).toMatch(/\.machine-chip-row/);
    expect(cssSrc).toMatch(/font-size:\s*16px/);
    expect(cssSrc).toMatch(/@media \(max-width:\s*1023px\)/);
    expect(cssSrc).toMatch(/\.print-column/);
  });
});
