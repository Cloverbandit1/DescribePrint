#!/usr/bin/env node
/**
 * Print LAN (and optional Tailscale) URLs plus a terminal QR for Start scripts.
 * Phone -> Next on the PC. Ollama stays on 127.0.0.1:11434.
 */
import {
  appPort,
  collectAccessTargets,
  formatAccessBanner,
  readTailscaleCliIPv4,
} from "./lib/lan-access.mjs";
import { printAsciiQr } from "./lib/qr-ascii.mjs";

const targets = collectAccessTargets({
  tailscaleCliIp: readTailscaleCliIPv4(),
  port: appPort(),
});

console.log("");
console.log(formatAccessBanner(targets));
if (targets.preferred) {
  console.log("");
  try {
    printAsciiQr(targets.preferred.url);
  } catch (err) {
    console.log(`(QR skipped: ${err instanceof Error ? err.message : err})`);
  }
  console.log("");
}
