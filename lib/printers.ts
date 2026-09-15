/**
 * Printer profiles (V0 stub).
 *
 * Default target is the Bambu Lab P2S. V0 still exports STL/3MF and does not
 * embed Bambu Studio / Orca. In-app printer + print-settings UI comes later;
 * long-term the core path must not require a separate slicer app.
 */

export type PrinterId = "bambu-lab-p2s";

export type PrinterProfile = {
  id: PrinterId;
  name: string;
  vendor: string;
  /** Build volume W × D × H in millimeters. */
  buildVolumeMm: [number, number, number];
  nozzleMm: number;
  supportedNozzlesMm: number[];
  filamentDiameterMm: number;
  maxNozzleC: number;
  maxBedC: number;
};

export const BAMBU_LAB_P2S: PrinterProfile = {
  id: "bambu-lab-p2s",
  name: "Bambu Lab P2S",
  vendor: "Bambu Lab",
  buildVolumeMm: [256, 256, 256],
  nozzleMm: 0.4,
  supportedNozzlesMm: [0.2, 0.4, 0.6, 0.8],
  filamentDiameterMm: 1.75,
  maxNozzleC: 300,
  maxBedC: 110,
};

export const DEFAULT_PRINTER_ID: PrinterId = "bambu-lab-p2s";

export const PRINTER_PROFILES: Record<PrinterId, PrinterProfile> = {
  "bambu-lab-p2s": BAMBU_LAB_P2S,
};

export function defaultPrinter(): PrinterProfile {
  return PRINTER_PROFILES[DEFAULT_PRINTER_ID];
}
