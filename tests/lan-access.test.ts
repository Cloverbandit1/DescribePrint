import { describe, expect, it } from "vitest";
import {
  accessUrl,
  appPort,
  collectAccessTargets,
  formatAccessBanner,
  isApipaIPv4,
  isLanIPv4,
  isLoopbackIPv4,
  isTailscaleIPv4,
  listLanIPv4,
  pickPrimaryLanIPv4,
  readTailscaleCliIPv4,
} from "../scripts/lib/lan-access.mjs";
import { encodeQrMatrix, renderAsciiQr } from "../scripts/lib/qr-ascii.mjs";

const nics = {
  lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  "Ethernet 2": [{ family: "IPv4", address: "169.254.12.4", internal: false }],
  Ethernet: [{ family: "IPv4", address: "192.168.1.42", internal: false }],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
  "Tailscale Tunnel": [{ family: "IPv4", address: "100.64.12.34", internal: false }],
  wlan0: [{ family: "IPv4", address: "10.0.0.8", internal: false }],
};

describe("LAN / Tailscale address helpers", () => {
  it("skips loopback and APIPA and does not treat Tailscale as LAN", () => {
    expect(isLoopbackIPv4("127.0.0.1")).toBe(true);
    expect(isApipaIPv4("169.254.1.1")).toBe(true);
    expect(isLanIPv4("127.0.0.1")).toBe(false);
    expect(isLanIPv4("169.254.1.1")).toBe(false);
    expect(isLanIPv4("192.168.1.42")).toBe(true);
    expect(isTailscaleIPv4("100.64.12.34")).toBe(true);
    expect(isTailscaleIPv4("100.127.0.1")).toBe(true);
    expect(isTailscaleIPv4("100.63.0.1")).toBe(false);
    expect(isLanIPv4("100.64.12.34")).toBe(false);
  });

  it("picks a primary private LAN IPv4 (prefer 192.168 / ethernet over docker)", () => {
    const primary = pickPrimaryLanIPv4(nics);
    expect(primary?.address).toBe("192.168.1.42");
    expect(listLanIPv4(nics).map((row) => row.address)).not.toContain("127.0.0.1");
    expect(listLanIPv4(nics).map((row) => row.address)).not.toContain("169.254.12.4");
    expect(listLanIPv4(nics).map((row) => row.address)).not.toContain("100.64.12.34");
  });

  it("prefers Tailscale for the QR URL when present, else LAN", () => {
    const withTs = collectAccessTargets({
      nics,
      tailscaleCliIp: "100.87.1.9",
      port: 3000,
    });
    expect(withTs.preferred).toEqual({
      kind: "tailscale",
      address: "100.87.1.9",
      url: "http://100.87.1.9:3000",
    });
    expect(withTs.urls.lan).toContain("http://192.168.1.42:3000");
    expect(withTs.urls.tailscale).toContain("http://100.87.1.9:3000");
    expect(withTs.urls.tailscale).toContain("http://100.64.12.34:3000");

    const lanOnly = collectAccessTargets({
      nics: { Ethernet: [{ family: "IPv4", address: "192.168.1.42", internal: false }] },
      tailscaleCliIp: null,
      port: 3000,
    });
    expect(lanOnly.preferred).toEqual({
      kind: "lan",
      address: "192.168.1.42",
      url: "http://192.168.1.42:3000",
    });
    expect(lanOnly.urls.tailscale).toEqual([]);
  });

  it("fails soft when the Tailscale CLI is missing", () => {
    expect(
      readTailscaleCliIPv4(() => {
        throw new Error("spawn tailscale ENOENT");
      }),
    ).toBeNull();
    expect(readTailscaleCliIPv4(() => "100.111.2.3\n")).toBe("100.111.2.3");
  });

  it("uses PORT when set and keeps http:// LAN URLs", () => {
    expect(appPort({})).toBe(3000);
    expect(appPort({ PORT: "4000" })).toBe(4000);
    expect(accessUrl("192.168.0.5", 3000)).toBe("http://192.168.0.5:3000");
  });

  it("banner keeps Ollama on 127.0.0.1:11434 and warns against public port-forward", () => {
    const banner = formatAccessBanner(
      collectAccessTargets({ nics, tailscaleCliIp: "100.64.12.34", port: 3000 }),
    );
    expect(banner).toMatch(/http:\/\/192\.168\.1\.42:3000/);
    expect(banner).toMatch(/http:\/\/100\.64\.12\.34:3000/);
    expect(banner).toMatch(/QR \/ preferred: http:\/\/100\.64\.12\.34:3000 \(tailscale\)/);
    expect(banner).toMatch(/127\.0\.0\.1:11434/);
    expect(banner).toMatch(/0\.0\.0\.0/);
    expect(banner).not.toMatch(/11435/);
  });
});

describe("Start QR", () => {
  it("encodes a LAN URL with finder patterns", () => {
    const url = "http://192.168.1.42:3000";
    const matrix = encodeQrMatrix(url);
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix[0][0]).toBe(1);
    expect(matrix[0][6]).toBe(1);
    expect(matrix[6][0]).toBe(1);
    const ascii = renderAsciiQr(url);
    expect(ascii).toMatch(/██/);
    expect(ascii.split("\n").length).toBeGreaterThan(20);
  });
});
