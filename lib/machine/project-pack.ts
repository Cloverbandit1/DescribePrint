/**
 * Project pack export stub.
 *
 * One zip: current 3MF (+ STL), template build steps, shopping-link placeholders,
 * plus optional estimate / preset sidecars. Never a LAN send, farm enqueue,
 * slicer, or user-profile store.
 */

import JSZip from "jszip";
import type { ColorRegion } from "../color-regions";
import {
  defaultPrinter,
  filamentPreset,
  normalizeFilamentId,
  printPresetSidecarJson,
  printPresetSummary,
  type FilamentId,
  type PrintPresetSummary,
} from "../printers";
import type { PrintabilityReport } from "../types";
import {
  estimatePrintFromReport,
  formatPrintEstimateLine,
  type PrintEstimate,
} from "./print-estimate";

export const PROJECT_PACK_NOTE =
  "Project pack (stub) · 3MF + steps + shopping links";

export const PROJECT_PACK_EMPTY_ERROR = "Nothing on the plate to pack.";

export const PROJECT_PACK_FILES = {
  threemf: "describeprint.3mf",
  stl: "describeprint.stl",
  steps: "STEPS.md",
  shopping: "SHOPPING.md",
  shoppingJson: "shopping.json",
  preset: "print_preset.json",
  estimate: "estimate.json",
} as const;

/** Search placeholders only — not store URLs or affiliate claims. */
export const SHOPPING_SEARCH_TERMS: Record<FilamentId, string> = {
  pla: "Bambu PLA Basic",
  petg: "Bambu PETG Basic",
  pa: "Bambu PA / nylon",
  abs: "Bambu ABS",
  tpu: "Bambu TPU 95A",
};

export type ProjectPackInput = {
  threemf?: Buffer | Uint8Array | ArrayBuffer | null;
  stl?: Buffer | Uint8Array | ArrayBuffer | null;
  printPreset?: PrintPresetSummary | null;
  estimate?: PrintEstimate | null;
  report?: PrintabilityReport | null;
  description?: string | null;
  notes?: string[] | null;
  colorRegions?: ColorRegion[] | null;
  fileName?: string | null;
  material?: FilamentId | string | null;
};

export type ShoppingLinkStub = {
  material: FilamentId;
  name: string;
  diameterMm: number;
  search: string;
  query: string;
  line: string;
};

export class ProjectPackError extends Error {
  readonly code = "EMPTY_PLATE";

  constructor(message = PROJECT_PACK_EMPTY_ERROR) {
    super(message);
    this.name = "ProjectPackError";
  }
}

function toBytes(value: Buffer | Uint8Array | ArrayBuffer | null | undefined): Uint8Array | null {
  if (!value) return null;
  if (value instanceof ArrayBuffer) {
    return value.byteLength > 0 ? new Uint8Array(value) : null;
  }
  return value.byteLength > 0 ? new Uint8Array(value) : null;
}

export function canBuildProjectPack(input: ProjectPackInput | null | undefined): boolean {
  return Boolean(toBytes(input?.threemf));
}

export function assertCanBuildProjectPack(input: ProjectPackInput | null | undefined): Uint8Array {
  const bytes = toBytes(input?.threemf);
  if (!bytes) throw new ProjectPackError();
  return bytes;
}

function resolvePreset(input: ProjectPackInput): PrintPresetSummary {
  if (input.printPreset) return input.printPreset;
  return printPresetSummary(input.material);
}

function uniqueMaterials(input: ProjectPackInput, preset: PrintPresetSummary): FilamentId[] {
  const ids: FilamentId[] = [preset.material];
  for (const region of input.colorRegions ?? []) {
    const id = normalizeFilamentId(region.filament);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function shoppingLineFor(material: FilamentId, diameterMm = defaultPrinter().filamentDiameterMm): string {
  const name = filamentPreset(material).name;
  return `${name} ${diameterMm} mm — search: ${SHOPPING_SEARCH_TERMS[material]}`;
}

export function shoppingLinksFor(input: ProjectPackInput): ShoppingLinkStub[] {
  const preset = resolvePreset(input);
  const diameterMm = defaultPrinter().filamentDiameterMm;
  return uniqueMaterials(input, preset).map((material) => {
    const name = filamentPreset(material).name;
    const search = SHOPPING_SEARCH_TERMS[material];
    return {
      material,
      name,
      diameterMm,
      search,
      query: `${name} ${diameterMm} mm filament`,
      line: shoppingLineFor(material, diameterMm),
    };
  });
}

export function buildShoppingLinksMarkdown(input: ProjectPackInput): string {
  const links = shoppingLinksFor(input);
  const lines = [
    "# Shopping links (stub)",
    "",
    "Vendor-agnostic **search placeholders**. Not store URLs and not affiliate links.",
    "",
    ...links.map((item) => `- ${item.line}`),
    "",
    ...links.map((item) => `- Also search: \`${item.query}\``),
    "",
    "Buy from any vendor you already use. This pack does not open a shop or send LAN.",
    "",
  ];
  return lines.join("\n");
}

export function buildShoppingLinksJson(input: ProjectPackInput): {
  stub: true;
  vendorAgnostic: true;
  affiliate: false;
  items: ShoppingLinkStub[];
} {
  return {
    stub: true,
    vendorAgnostic: true,
    affiliate: false,
    items: shoppingLinksFor(input),
  };
}

function formatSize(report: PrintabilityReport | null | undefined): string | null {
  const size = report?.boundingBoxMm.size;
  if (!size) return null;
  const [x, y, z] = size;
  if (![x, y, z].every((n) => Number.isFinite(n))) return null;
  return `${roundMm(x)} × ${roundMm(y)} × ${roundMm(z)} mm`;
}

function roundMm(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function buildProjectStepsMarkdown(input: ProjectPackInput): string {
  const preset = resolvePreset(input);
  const printer = defaultPrinter();
  const table = filamentPreset(preset.material, printer);
  const estimate = input.estimate ?? estimatePrintFromReport(input.report, preset.material);
  const size = formatSize(input.report);
  const description = input.description?.trim() || null;
  const regions = (input.colorRegions ?? []).filter((region) => region.amsSlot >= 1);
  const notes = (input.notes ?? []).map((note) => note.trim()).filter(Boolean);

  const lines: string[] = [
    "# Build steps (stub)",
    "",
    "Template how-to from the current DescribePrint job. **Stub only** — not a slicer and not a send-to-printer.",
    "",
    "## Job",
  ];
  if (input.fileName) lines.push(`- File: ${input.fileName}`);
  if (description) lines.push(`- Description: ${description}`);
  if (size) lines.push(`- Size: ${size}`);
  lines.push(`- Printer: ${preset.printerName} (advisory profile)`);
  if (notes.length) {
    lines.push("- Notes:");
    for (const note of notes) lines.push(`  - ${note}`);
  }
  if (!input.fileName && !description && !size && notes.length === 0) {
    lines.push("- Current plate export");
  }

  lines.push(
    "",
    "## Print",
    "- Orientation: sit on the build plate (export is already seated)",
    `- Material: **${preset.name}** (${preset.material.toUpperCase()} auto-best, advisory)`,
    `- Nozzle / bed: ${preset.nozzleC} °C / ${preset.bedC} °C — advisory only, not a LAN command`,
    `- Speed: ${preset.speedTier} · ${preset.printSpeedMms} mm/s`,
    `- Cooling: ${preset.coolingHint} · fan ${preset.fanPercent}%`,
    `- Layer height: ${table.layerHeightMm} mm · ${printer.nozzleMm} mm nozzle`,
  );
  if (preset.notes) lines.push(`- Material note: ${preset.notes}`);

  lines.push("", "## AMS slot hints (export metadata, not a live mapping)");
  if (regions.length === 0) {
    lines.push(`- Slot 1: ${preset.name}`);
  } else {
    for (const region of regions) {
      const filament = (normalizeFilamentId(region.filament) ?? preset.material).toUpperCase();
      lines.push(`- Slot ${region.amsSlot}: ${region.name} · ${region.colorName} · ${filament}`);
    }
  }

  lines.push("", "## Estimate (stub)");
  if (estimate) {
    lines.push(`- ${formatPrintEstimateLine(estimate)}`);
    lines.push(`- ${estimate.assumptions.note}`);
  } else {
    lines.push("- No volume on the plate — estimate omitted.");
  }

  lines.push(
    "",
    "## After print",
    "- Let the plate cool, then remove the part",
    "- Trim brim or support marks if the slicer added any",
    "- This pack does not include sliced gcode and does not enqueue a farm job",
    "",
  );
  return lines.join("\n");
}

export async function buildProjectPack(input: ProjectPackInput): Promise<Buffer> {
  const threemf = assertCanBuildProjectPack(input);
  const preset = resolvePreset(input);
  const estimate = input.estimate ?? estimatePrintFromReport(input.report, preset.material);
  const stl = toBytes(input.stl);

  const zip = new JSZip();
  zip.file(PROJECT_PACK_FILES.threemf, threemf);
  if (stl) zip.file(PROJECT_PACK_FILES.stl, stl);
  zip.file(PROJECT_PACK_FILES.steps, buildProjectStepsMarkdown({ ...input, printPreset: preset, estimate }));
  zip.file(PROJECT_PACK_FILES.shopping, buildShoppingLinksMarkdown({ ...input, printPreset: preset }));
  zip.file(PROJECT_PACK_FILES.shoppingJson, `${JSON.stringify(buildShoppingLinksJson({ ...input, printPreset: preset }), null, 2)}\n`);
  zip.file(PROJECT_PACK_FILES.preset, printPresetSidecarJson(preset));
  if (estimate) {
    zip.file(PROJECT_PACK_FILES.estimate, `${JSON.stringify(estimate, null, 2)}\n`);
  }

  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(bytes);
}
