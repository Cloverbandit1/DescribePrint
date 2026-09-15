import { normalizeFilamentId } from "../printers";
import type { AmsMapping, AmsSlotStatus, DesignFilament, FilamentPlan } from "./types";

function normalizeHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.trim().replace(/^#/, "").toLowerCase();
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (hex.length === 6 || hex.length === 8) {
    return `#${hex.slice(0, 6)}`;
  }
  return undefined;
}

function sameType(design: DesignFilament, slot: AmsSlotStatus): boolean {
  const a = normalizeFilamentId(design.type) ?? design.type.trim().toLowerCase();
  const b =
    normalizeFilamentId(slot.filamentType) ?? (slot.filamentType ?? "").toString().trim().toLowerCase();
  return Boolean(a && b && a === b);
}

/**
 * Map a multi-filament 3MF plan onto loaded AMS slots.
 * Exact type+color wins, then type-only. Unmapped filaments stay listed.
 */
export function mapDesignFilamentsToAms(
  design: DesignFilament[],
  slots: AmsSlotStatus[],
): FilamentPlan {
  const used = new Set<string>();
  const mappings: AmsMapping[] = [];
  const unmapped: DesignFilament[] = [];

  const slotKey = (slot: AmsSlotStatus) => `${slot.unit}:${slot.slot}`;
  const loaded = slots.filter((slot) => slot.present);

  for (const filament of design) {
    const wantColor = normalizeHex(filament.colorHex);

    const exact = loaded.find((slot) => {
      if (used.has(slotKey(slot))) return false;
      if (!sameType(filament, slot)) return false;
      const have = normalizeHex(slot.colorHex);
      return Boolean(wantColor && have && wantColor === have);
    });

    if (exact) {
      used.add(slotKey(exact));
      mappings.push({
        designId: filament.id,
        unit: exact.unit,
        slot: exact.slot,
        match: "exact",
        reason: `AMS ${exact.slot} matches ${filament.type} ${wantColor ?? ""}`.trim(),
      });
      continue;
    }

    const typeOnly = loaded.find((slot) => !used.has(slotKey(slot)) && sameType(filament, slot));
    if (typeOnly) {
      used.add(slotKey(typeOnly));
      mappings.push({
        designId: filament.id,
        unit: typeOnly.unit,
        slot: typeOnly.slot,
        match: "type",
        reason: `AMS ${typeOnly.slot} has ${typeOnly.filamentType ?? filament.type} (color differs or was omitted).`,
      });
      continue;
    }

    mappings.push({
      designId: filament.id,
      match: "unmapped",
      reason: `No free AMS slot loaded with ${filament.type}.`,
    });
    unmapped.push(filament);
  }

  return { design, mappings, unmapped };
}
