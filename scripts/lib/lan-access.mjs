/**
 * LAN + optional Tailscale access helpers for Start scripts.
 *
 * The phone talks to Next.js on the PC. Ollama stays on 127.0.0.1:11434
 * on the host — never retargeted or exposed to LAN/mesh by these helpers.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";

export const DEFAULT_APP_PORT = 3000;

export function isIPv4(addr) {
  if (typeof addr !== "string") return false;
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function isLoopbackIPv4(addr) {
  return typeof addr === "string" && addr.startsWith("127.");
}

export function isApipaIPv4(addr) {
  return typeof addr === "string" && addr.startsWith("169.254.");
}

/** Tailscale CGNAT range 100.64.0.0/10 (not public internet). */
export function isTailscaleIPv4(addr) {
  if (!isIPv4(addr)) return false;
  const [a, b] = addr.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isPrivateLanIPv4(addr) {
  if (!isIPv4(addr) || isLoopbackIPv4(addr) || isApipaIPv4(addr) || isTailscaleIPv4(addr)) {
    return false;
  }
  const [a, b] = addr.split(".").map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function isLanIPv4(addr) {
  if (!isIPv4(addr)) return false;
  if (isLoopbackIPv4(addr) || isApipaIPv4(addr) || isTailscaleIPv4(addr)) return false;
  const a = Number(addr.split(".")[0]);
  return a > 0 && a < 224;
}

function familyIsV4(info) {
  return info.family === "IPv4" || info.family === 4;
}

export function collectInterfaceAddresses(nics = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(nics || {})) {
    for (const info of addrs || []) {
      if (!familyIsV4(info) || !info.address) continue;
      out.push({
        name,
        address: info.address,
        internal: Boolean(info.internal),
      });
    }
  }
  return out;
}

const SKIP_IFACE = /docker|veth|br-|vmnet|virtual|hyper-v|vbox|wsl|loopback|kube|cni/i;
const PREFER_IFACE = /^(eth|en|ens|enp|eno|wlan|wlp|wifi|wi-fi|local area|ethernet)/i;

function lanIfaceScore(entry) {
  let score = 0;
  if (PREFER_IFACE.test(entry.name)) score += 20;
  if (SKIP_IFACE.test(entry.name)) score -= 40;
  if (entry.address.startsWith("192.168.")) score += 15;
  else if (entry.address.startsWith("10.")) score += 10;
  else if (isPrivateLanIPv4(entry.address)) score += 8;
  return score;
}

export function listLanIPv4(nics) {
  return collectInterfaceAddresses(nics)
    .filter((entry) => !entry.internal && isLanIPv4(entry.address))
    .sort((a, b) => lanIfaceScore(b) - lanIfaceScore(a) || a.address.localeCompare(b.address));
}

export function listTailscaleIPv4(nics) {
  return collectInterfaceAddresses(nics).filter(
    (entry) => !entry.internal && isTailscaleIPv4(entry.address),
  );
}

export function pickPrimaryLanIPv4(nics) {
  return listLanIPv4(nics)[0] ?? null;
}

/** Fail soft when Tailscale is missing, logged out, or timed out. */
export function readTailscaleCliIPv4(execFn = execFileSync) {
  try {
    const out = execFn("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = String(out ?? "")
      .trim()
      .split(/\r?\n/)
      .map((row) => row.trim())
      .find(Boolean);
    if (line && isIPv4(line)) return line;
  } catch {
    // optional — LAN path still works
  }
  return null;
}

export function appPort(env = process.env) {
  const raw = Number(env.PORT);
  return Number.isFinite(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_APP_PORT;
}

export function accessUrl(ip, port = DEFAULT_APP_PORT) {
  return `http://${ip}:${port}`;
}

/**
 * Prefer a Tailscale IPv4 when present (away-from-home mesh), else primary LAN.
 * Everyday same-Wi-Fi path stays LAN; Tailscale is optional and not public internet.
 */
export function collectAccessTargets({
  nics = os.networkInterfaces(),
  tailscaleCliIp = null,
  port = DEFAULT_APP_PORT,
} = {}) {
  const lan = listLanIPv4(nics);
  const fromIfaces = listTailscaleIPv4(nics).map((entry) => entry.address);
  const tailscale = [];
  if (tailscaleCliIp && isIPv4(tailscaleCliIp)) tailscale.push(tailscaleCliIp);
  for (const ip of fromIfaces) {
    if (!tailscale.includes(ip)) tailscale.push(ip);
  }

  const preferredIp = tailscale[0] ?? lan[0]?.address ?? null;
  const preferredKind = tailscale[0] ? "tailscale" : preferredIp ? "lan" : null;

  return {
    port,
    lan,
    tailscale,
    preferred: preferredIp
      ? { kind: preferredKind, address: preferredIp, url: accessUrl(preferredIp, port) }
      : null,
    urls: {
      lan: lan.map((entry) => accessUrl(entry.address, port)),
      tailscale: tailscale.map((ip) => accessUrl(ip, port)),
    },
  };
}

export function formatAccessBanner(targets) {
  const lines = [];
  lines.push("Phone access (same app, no App Store):");
  if (targets.urls.lan.length) {
    lines.push("  Same Wi-Fi (LAN):");
    for (const url of targets.urls.lan) lines.push(`    ${url}`);
  } else {
    lines.push("  Same Wi-Fi (LAN): no IPv4 found (skipped 127.0.0.1 / 169.254.*)");
  }
  if (targets.urls.tailscale.length) {
    lines.push("  Optional Tailscale (away, same account):");
    for (const url of targets.urls.tailscale) lines.push(`    ${url}`);
  } else {
    lines.push("  Optional Tailscale: not detected (install is optional)");
  }
  if (targets.preferred) {
    lines.push(`  QR / preferred: ${targets.preferred.url} (${targets.preferred.kind})`);
  }
  lines.push("  Ollama stays on this PC at 127.0.0.1:11434 (not exposed).");
  lines.push("  Bind is 0.0.0.0 for LAN/mesh only — do not port-forward to the public internet.");
  return lines.join("\n");
}
