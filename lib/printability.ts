/**
 * Printer-aware printability rules for the describe → OpenSCAD path.
 * Defaults come from the V0 P2S stub in printers.ts (256³ mm, 0.4 mm nozzle).
 */
import { formatJointConstraints } from "./joints";
import { defaultPrinter, type PrinterProfile } from "./printers";
import type { PrintabilityReport } from "./types";

export type PrintRules = {
  printerName: string;
  bedMm: [number, number, number];
  nozzleMm: number;
  /** 4× nozzle — reliable FDM wall. */
  minWallMm: number;
  /** 2× nozzle — knife-edge / unprintable sliver. */
  minFeatureMm: number;
  minHoleMm: number;
  clearanceMm: number;
  /** z-min above this (mm) means the solid is floating off the plate. */
  offBedMm: number;
  /** Hard fail: nonsense geometry, not just "won't fit this printer". */
  failMaxMm: number;
};

const MULTI_PART =
  /\b(assembl(?:y|ies)|multi[-\s]?part|multiple parts|separate parts|print separately|two pieces|three pieces|kit of|exploded|loose parts|mating parts)\b/i;

const NEW_DESIGN =
  /\b(new part|start over|something else|different part|instead make|forget that|from scratch)\b/i;

const WALL_DIM_KEYS = /wall|thick|^t$/i;

export function printRules(printer: PrinterProfile = defaultPrinter()): PrintRules {
  const nozzleMm = printer.nozzleMm;
  return {
    printerName: printer.name,
    bedMm: printer.buildVolumeMm,
    nozzleMm,
    minWallMm: Math.max(1.6, nozzleMm * 4),
    minFeatureMm: Math.max(0.8, nozzleMm * 2),
    minHoleMm: 2.5,
    clearanceMm: 0.3,
    offBedMm: 1,
    failMaxMm: 2_000,
  };
}

export function bedMaxMm(rules: PrintRules = printRules()): number {
  return Math.max(...rules.bedMm);
}

export function wantsMultiPart(prompt: string): boolean {
  return MULTI_PART.test(prompt);
}

export function wantsNewDesign(prompt: string): boolean {
  return NEW_DESIGN.test(prompt);
}

export function statedWallMm(prompt: string): number | undefined {
  const named = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+walls?\b/i);
  if (!named) return undefined;
  const n = Number(named[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function allowsThinWalls(prompt: string): boolean {
  const stated = statedWallMm(prompt);
  if (stated !== undefined) return stated < printRules().minWallMm;
  return /\bthin walls?\b/i.test(prompt);
}

export function promptAllowsOversize(prompt: string, dimMm: number): boolean {
  return statedMillimeters(prompt).some((n) => n >= dimMm - 0.05);
}

export function promptAllowsSmallHole(prompt: string, diameterMm: number): boolean {
  const match = prompt.match(/(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore|id)\b/i);
  if (!match) return false;
  const n = Number(match[1]);
  return Number.isFinite(n) && Math.abs(n - diameterMm) < 0.05;
}

/** Millimeter quantities the user actually wrote (inches converted). */
export function statedMillimeters(prompt: string): number[] {
  const out: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*(mm|millimeters?|in(?:ch(?:es)?)?)?\b/gi;
  for (const match of prompt.matchAll(re)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = (match[2] ?? "").toLowerCase();
    out.push(unit.startsWith("in") ? n * 25.4 : n);
  }
  return out;
}

export function isWallDimKey(key: string): boolean {
  return WALL_DIM_KEYS.test(key);
}

const SCAD_ASSIGN = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/gm;
const SKIP_PARAMS = new Set(["fn", "fa", "fs"]);

/** Named numeric parameters from prior OpenSCAD (`size = 20;`). Skips $fn / $fa / $fs. */
export function extractScadParams(code: string | null | undefined): Record<string, number> {
  if (!code) return {};
  const params: Record<string, number> = {};
  for (const match of code.matchAll(SCAD_ASSIGN)) {
    const name = match[1];
    if (!name || SKIP_PARAMS.has(name.toLowerCase())) continue;
    const n = Number(match[2]);
    if (Number.isFinite(n)) params[name] = n;
  }
  return params;
}

export function formatScadParams(params: Record<string, number>): string {
  return Object.entries(params)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}

export function formatPrinterConstraints(rules: PrintRules = printRules()): string {
  const [x, y, z] = rules.bedMm;
  return [
    `Printer target: ${rules.printerName}. Build volume ${x} × ${y} × ${z} mm. Nozzle ${rules.nozzleMm} mm.`,
    `- Fit every dimension on that bed unless the user asks for a larger object.`,
    `- Minimum wall ${rules.minWallMm} mm (4× nozzle). Minimum through-hole ${rules.minHoleMm} mm unless they ask smaller.`,
    `- Clearance ~${rules.clearanceMm} mm per side on fits. One connected solid on z=0 unless the user asked for a joint / moving assembly.`,
    formatJointConstraints(),
  ].join("\n");
}

const RETRY_CODES = new Set(["disconnected", "off-bed", "non-manifold"]);
/** STL CSG wrappers are often not edge-manifold; that alone must not trigger a from-scratch rewrite. */
const IMPORTED_WRAP_RETRY_CODES = new Set(["disconnected", "off-bed"]);

export function shouldRetryPrintability(
  report: PrintabilityReport,
  rules: PrintRules = printRules(),
  opts: { importedWrap?: boolean; allowDisconnected?: boolean } = {},
): boolean {
  const retryCodes = new Set(opts.importedWrap ? IMPORTED_WRAP_RETRY_CODES : RETRY_CODES);
  if (opts.allowDisconnected) retryCodes.delete("disconnected");
  if (report.issues.some((issue) => retryCodes.has(issue.code))) return true;
  if (!report.issues.some((issue) => issue.code === "thin-wall" || issue.code === "undersized")) {
    return false;
  }
  const min = Math.min(...report.boundingBoxMm.size.filter((n) => n > 0), Infinity);
  return Number.isFinite(min) && min < rules.minFeatureMm;
}

export function formatPrintabilityFeedback(report: PrintabilityReport): string {
  const lines = report.issues
    .filter((issue) => issue.code !== "huge-triangles" || issue.severity === "error")
    .map((issue) => `- ${issue.message}`);
  if (!lines.length) return "Mesh check failed: printability issues";
  return `Mesh check failed: printability issues\n${lines.join("\n")}`;
}
