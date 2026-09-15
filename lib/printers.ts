/**
 * Printer profiles. Default target is the Bambu Lab P2S + AMS (4 slots).
 *
 * V0 still exports STL/3MF and does not embed Bambu Studio / Orca.
 * Machine I/O lives behind lib/machine (mock by default; optional LAN MQTT).
 * Specs: https://bambulab.com/en/p2s/specs and
 * https://wiki.bambulab.com/en/p2s/manual/p2s-faq
 */

export type PrinterId = "bambu-lab-p2s";

export type FilamentId = "pla" | "petg" | "pa" | "abs" | "tpu";

export type SpeedTier = "slow" | "standard" | "fast";

export type FilamentPreset = {
  id: FilamentId;
  name: string;
  nozzleC: number;
  bedC: number;
  printSpeedMms: number;
  travelSpeedMms: number;
  retractionMm: number;
  retractionSpeedMms: number;
  fanPercent: number;
  flowPercent: number;
  /** Advisory standard layer height for a 0.4 mm P2S nozzle. */
  layerHeightMm: number;
  notes?: string;
};

/** Advisory auto-best snapshot that travels with STL/3MF. Never a LAN write. */
export type PrintPresetSummary = {
  printerId: PrinterId;
  printerName: string;
  material: FilamentId;
  name: string;
  nozzleC: number;
  bedC: number;
  printSpeedMms: number;
  travelSpeedMms: number;
  speedTier: SpeedTier;
  fanPercent: number;
  coolingHint: string;
  flowPercent: number;
  retractionMm: number;
  retractionSpeedMms: number;
  notes?: string;
  advisory: true;
};

/** Browser session key for the Machine-panel material picker. */
export const MATERIAL_SESSION_KEY = "describeprint.material";

export type AmsProfile = {
  /** Slots on the attached unit this profile models (typical combo: one AMS). */
  slotsPerUnit: number;
  /** How many AMS units this profile assumes are attached. */
  units: number;
  /** Publisher maximum if more units are chained later. */
  maxSlots: number;
};

export type PrinterProfile = {
  id: PrinterId;
  name: string;
  vendor: string;
  /** Build volume W × D × H in millimeters. */
  buildVolumeMm: [number, number, number];
  nozzleMm: number;
  supportedNozzlesMm: number[];
  filamentDiameterMm: number;
  minNozzleC: number;
  maxNozzleC: number;
  minBedC: number;
  maxBedC: number;
  /** P2S is enclosed but has no active chamber heater. */
  hasActiveChamberHeat: boolean;
  ams: AmsProfile;
  defaultFilament: FilamentId;
  filamentPresets: Record<FilamentId, FilamentPreset>;
};

export const FILAMENT_IDS: FilamentId[] = ["pla", "petg", "pa", "abs", "tpu"];

/** Smart defaults for a 0.4 mm P2S nozzle. Advanced knobs stay out of the everyday UI. */
export const P2S_FILAMENT_PRESETS: Record<FilamentId, FilamentPreset> = {
  pla: {
    id: "pla",
    name: "PLA",
    nozzleC: 220,
    bedC: 55,
    printSpeedMms: 250,
    travelSpeedMms: 500,
    retractionMm: 0.8,
    retractionSpeedMms: 30,
    fanPercent: 100,
    flowPercent: 98,
    layerHeightMm: 0.2,
  },
  petg: {
    id: "petg",
    name: "PETG",
    nozzleC: 250,
    bedC: 70,
    printSpeedMms: 150,
    travelSpeedMms: 400,
    retractionMm: 0.8,
    retractionSpeedMms: 30,
    fanPercent: 40,
    flowPercent: 95,
    layerHeightMm: 0.2,
    notes: "Dry the spool. PETG strings if wet or a few degrees too hot.",
  },
  pa: {
    id: "pa",
    name: "PA",
    nozzleC: 270,
    bedC: 100,
    printSpeedMms: 80,
    travelSpeedMms: 250,
    retractionMm: 0.8,
    retractionSpeedMms: 30,
    fanPercent: 15,
    flowPercent: 96,
    layerHeightMm: 0.2,
    notes:
      "Dry thoroughly — nylon is hygroscopic. P2S has no active chamber heater; keep the door closed. Advisory only, not a LAN command.",
  },
  abs: {
    id: "abs",
    name: "ABS",
    nozzleC: 260,
    bedC: 90,
    printSpeedMms: 180,
    travelSpeedMms: 400,
    retractionMm: 0.8,
    retractionSpeedMms: 30,
    fanPercent: 20,
    flowPercent: 96,
    layerHeightMm: 0.2,
    notes: "P2S has no active chamber heater — keep the door closed and use internal circulation.",
  },
  tpu: {
    id: "tpu",
    name: "TPU",
    nozzleC: 230,
    bedC: 35,
    printSpeedMms: 40,
    travelSpeedMms: 80,
    retractionMm: 0.4,
    retractionSpeedMms: 20,
    fanPercent: 100,
    flowPercent: 100,
    layerHeightMm: 0.2,
    notes: "Print slowly. Soft TPU can struggle through AMS feed paths.",
  },
};

export const BAMBU_LAB_P2S: PrinterProfile = {
  id: "bambu-lab-p2s",
  name: "Bambu Lab P2S",
  vendor: "Bambu Lab",
  buildVolumeMm: [256, 256, 256],
  nozzleMm: 0.4,
  supportedNozzlesMm: [0.2, 0.4, 0.6, 0.8],
  filamentDiameterMm: 1.75,
  minNozzleC: 180,
  maxNozzleC: 300,
  minBedC: 0,
  maxBedC: 110,
  hasActiveChamberHeat: false,
  ams: {
    slotsPerUnit: 4,
    units: 1,
    maxSlots: 20,
  },
  defaultFilament: "pla",
  filamentPresets: P2S_FILAMENT_PRESETS,
};

export const DEFAULT_PRINTER_ID: PrinterId = "bambu-lab-p2s";

export const PRINTER_PROFILES: Record<PrinterId, PrinterProfile> = {
  "bambu-lab-p2s": BAMBU_LAB_P2S,
};

export function defaultPrinter(): PrinterProfile {
  return PRINTER_PROFILES[DEFAULT_PRINTER_ID];
}

export function getPrinter(id: PrinterId = DEFAULT_PRINTER_ID): PrinterProfile {
  return PRINTER_PROFILES[id];
}

export function isFilamentId(value: string): value is FilamentId {
  return (FILAMENT_IDS as string[]).includes(value);
}

export function normalizeFilamentId(value: string | undefined | null): FilamentId | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if (isFilamentId(key)) return key;
  if (key.includes("petg")) return "petg";
  if (/\bnylon\b|\bpa(?:6|12|ht)?\b|\bpa-?cf\b/.test(key)) return "pa";
  if (key.includes("abs")) return "abs";
  if (/\btpu\b|flex/.test(key)) return "tpu";
  if (key.includes("pla")) return "pla";
  return undefined;
}

export function parseMaterialSession(raw: string | null | undefined): FilamentId {
  return normalizeFilamentId(raw) ?? defaultPrinter().defaultFilament;
}

export function serializeMaterialSession(id: FilamentId): string {
  return id;
}

export function speedTierFor(preset: FilamentPreset): SpeedTier {
  if (preset.printSpeedMms <= 80) return "slow";
  if (preset.printSpeedMms >= 220) return "fast";
  return "standard";
}

export function coolingHintFor(preset: FilamentPreset): string {
  if (preset.fanPercent >= 80) return "full cooling";
  if (preset.fanPercent >= 35) return "moderate fan";
  return "low fan / enclosure";
}

export function printPresetSummary(
  id: FilamentId | string | undefined | null,
  printer: PrinterProfile = defaultPrinter(),
): PrintPresetSummary {
  const material = normalizeFilamentId(typeof id === "string" ? id : undefined) ?? printer.defaultFilament;
  const preset = filamentPreset(material, printer);
  return {
    printerId: printer.id,
    printerName: printer.name,
    material: preset.id,
    name: preset.name,
    nozzleC: preset.nozzleC,
    bedC: preset.bedC,
    printSpeedMms: preset.printSpeedMms,
    travelSpeedMms: preset.travelSpeedMms,
    speedTier: speedTierFor(preset),
    fanPercent: preset.fanPercent,
    coolingHint: coolingHintFor(preset),
    flowPercent: preset.flowPercent,
    retractionMm: preset.retractionMm,
    retractionSpeedMms: preset.retractionSpeedMms,
    notes: preset.notes,
    advisory: true,
  };
}

export function printPresetSidecarJson(summary: PrintPresetSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export function filamentPickerLabel(preset: FilamentPreset): string {
  return preset.id === "pa" ? "PA / nylon" : preset.name;
}

/** Auto-best settings table for the selected printer (P2S today). */
export function filamentPreset(id: FilamentId, printer: PrinterProfile = defaultPrinter()): FilamentPreset {
  return printer.filamentPresets[id];
}

/** Layer height from a selected material preset. Omit when the material is unknown. */
export function layerHeightMmFromPreset(
  id: FilamentId | string | undefined | null,
  printer: PrinterProfile = defaultPrinter(),
): number | undefined {
  const material = normalizeFilamentId(typeof id === "string" ? id : undefined);
  if (!material) return undefined;
  const height = filamentPreset(material, printer).layerHeightMm;
  return height != null && Number.isFinite(height) && height > 0 ? height : undefined;
}

export function listFilamentPresets(printer: PrinterProfile = defaultPrinter()): FilamentPreset[] {
  return FILAMENT_IDS.map((id) => printer.filamentPresets[id]);
}
