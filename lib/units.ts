import type { Unit } from "./types";

const INCH_TO_MM = 25.4;

export function toMillimeters(value: number, units: Unit): number {
  if (!Number.isFinite(value)) {
    throw new Error("Size hint must be a finite number");
  }
  return units === "in" ? value * INCH_TO_MM : value;
}

export function formatMm(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(digits);
  return rounded.replace(/\.?0+$/, "");
}

export function describeSizeHint(sizeHint: number | null | undefined, units: Unit): string {
  if (sizeHint == null || !Number.isFinite(sizeHint) || sizeHint <= 0) {
    return "";
  }
  const mm = toMillimeters(sizeHint, units);
  if (units === "in") {
    return `Overall size hint: ${sizeHint} in (${formatMm(mm)} mm). Treat OpenSCAD units as millimeters.`;
  }
  return `Overall size hint: ${sizeHint} mm. Treat OpenSCAD units as millimeters.`;
}
