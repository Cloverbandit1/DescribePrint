import { normalizeFilamentId } from "../printers";
import type {
  AmsMapping,
  AmsSlotAssignment,
  AmsSlotPlan,
  AmsSlotPlanSource,
  AmsSlotStatus,
  DesignFilament,
  FilamentPlan,
} from "./types";

export const AMS_TRAY_COUNT = 4;
export const AMS_SLOT_INDEX_MIN = 0;
export const AMS_SLOT_INDEX_MAX = AMS_TRAY_COUNT - 1;

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

function materialName(value: string | undefined | null, fallback = "pla"): string {
  const trimmed = value?.toString().trim();
  return normalizeFilamentId(trimmed) ?? (trimmed ? trimmed.toLowerCase() : fallback);
}

export function isAmsSlotIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= AMS_SLOT_INDEX_MIN && value <= AMS_SLOT_INDEX_MAX;
}

/** Convert a 1-based live AMS slot (1–4) to a 0-based plan index. */
export function trayIndexFromSlot(slot: number): number | undefined {
  if (!Number.isInteger(slot)) return undefined;
  if (slot >= 1 && slot <= AMS_TRAY_COUNT) return slot - 1;
  if (isAmsSlotIndex(slot)) return slot;
  return undefined;
}

export function slotFromTrayIndex(index: number): number {
  return index + 1;
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

export type DesignFilamentLike = {
  id?: string;
  name?: string;
  type?: string;
  filament?: string;
  colorHex?: string;
  colorName?: string;
};

export type BuildAmsSlotPlanInput = {
  /** Selected Machine-panel material preset. */
  material: string;
  /** Declared 3MF objects / color regions. Do not invent geometry. */
  design?: DesignFilament[];
  /** Alias for extra declared filaments (paint/objects). */
  extraFilaments?: DesignFilament[];
  liveSlots?: AmsSlotStatus[];
  /** True only when the adapter is actually connected (not mock-disconnected). */
  connected?: boolean;
  /** User / chat reassignments — win over live and preset. */
  manual?: AmsSlotAssignment[];
};

const DEFAULT_COLOR_NAMES = new Set(["default", "natural", ""]);

function asDesignFilament(item: DesignFilament | DesignFilamentLike, fallbackId: string): DesignFilament {
  return {
    id: item.id?.trim() || item.name?.trim() || fallbackId,
    type: materialName(item.type ?? item.filament, "pla"),
    colorHex: normalizeHex(item.colorHex),
    name: item.name,
  };
}

function dedupeDesign(list: Array<DesignFilament | DesignFilamentLike>): DesignFilament[] {
  const unique: DesignFilament[] = [];
  for (const [index, raw] of list.entries()) {
    const filament = asDesignFilament(raw, `filament-${index + 1}`);
    const color = filament.colorHex ?? "";
    const existing = unique.find((item) => item.type === filament.type && (item.colorHex ?? "") === color);
    if (existing) continue;
    unique.push(filament);
  }
  return unique;
}

/** Extra filaments from 3MF objects / color regions. Default-only gray is not extra. */
export function declaredDesignFilaments(
  items: Array<DesignFilament | DesignFilamentLike> | null | undefined,
): DesignFilament[] {
  if (!items?.length) return [];
  const mapped = dedupeDesign(items);
  if (mapped.length <= 1) {
    const name = (items[0]?.colorName ?? items[0]?.name ?? "").toString().trim().toLowerCase();
    if (DEFAULT_COLOR_NAMES.has(name)) return [];
    if (!mapped[0]?.colorHex || mapped[0].colorHex === "#c4c4c8") return [];
  }
  return mapped;
}

export function normalizeAmsSlotPlan(plan: AmsSlotPlan | null | undefined): AmsSlotPlan {
  const used = new Set<number>();
  const slots: AmsSlotAssignment[] = [];
  for (const raw of plan?.slots ?? []) {
    if (!isAmsSlotIndex(raw.index) || used.has(raw.index)) continue;
    const material = materialName(raw.material, "");
    if (!material) continue;
    used.add(raw.index);
    const color = normalizeHex(raw.color);
    const source: AmsSlotPlanSource =
      raw.source === "live" || raw.source === "manual" || raw.source === "preset" ? raw.source : "preset";
    const designId = raw.designId?.trim();
    slots.push({
      index: raw.index,
      material,
      source,
      ...(color ? { color } : {}),
      ...(designId ? { designId } : {}),
    });
  }
  slots.sort((a, b) => a.index - b.index);
  return { slots };
}

export function isAmsSlotPlan(value: unknown): value is AmsSlotPlan {
  if (!value || typeof value !== "object") return false;
  const slots = (value as AmsSlotPlan).slots;
  if (!Array.isArray(slots)) return false;
  return slots.every(
    (slot) =>
      slot &&
      isAmsSlotIndex(slot.index) &&
      typeof slot.material === "string" &&
      slot.material.trim() &&
      (slot.source === "live" || slot.source === "preset" || slot.source === "manual"),
  );
}

export function parseAmsSlotPlan(value: unknown): AmsSlotPlan | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return parseAmsSlotPlan(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const raw = value as { slots?: unknown };
  if (!Array.isArray(raw.slots)) return null;
  const plan = normalizeAmsSlotPlan({
    slots: raw.slots.filter((slot): slot is AmsSlotAssignment => Boolean(slot) && typeof slot === "object") as AmsSlotAssignment[],
  });
  return plan.slots.length ? plan : { slots: [] };
}

export function amsSlotPlanSidecarJson(plan: AmsSlotPlan): string {
  return `${JSON.stringify(normalizeAmsSlotPlan(plan), null, 2)}\n`;
}

/**
 * Fill an AMS slot plan from live trays when connected, else the selected
 * preset. Extra declared filaments occupy further trays. Empty trays omitted.
 */
export function buildAmsSlotPlan(input: BuildAmsSlotPlanInput): AmsSlotPlan {
  if (input.manual?.length) {
    return normalizeAmsSlotPlan({
      slots: input.manual.map((slot) => ({ ...slot, source: "manual" as const })),
    });
  }

  const extras = declaredDesignFilaments([...(input.design ?? []), ...(input.extraFilaments ?? [])]);
  const livePresent = (input.liveSlots ?? []).filter(
    (slot) => slot.present && Boolean(slot.filamentType || slot.colorHex),
  );

  if (input.connected && livePresent.length) {
    if (extras.length) {
      const mapped = mapDesignFilamentsToAms(extras, input.liveSlots ?? []);
      const slots: AmsSlotAssignment[] = [];
      for (const mapping of mapped.mappings) {
        if (mapping.match === "unmapped" || mapping.slot == null) continue;
        const index = trayIndexFromSlot(mapping.slot);
        if (index === undefined) continue;
        const live = livePresent.find(
          (slot) => slot.slot === mapping.slot && (slot.unit ?? 1) === (mapping.unit ?? 1),
        );
        const filament = extras.find((item) => item.id === mapping.designId);
        const color = normalizeHex(live?.colorHex ?? filament?.colorHex);
        slots.push({
          index,
          material: materialName(live?.filamentType ?? filament?.type, input.material),
          source: "live",
          ...(color ? { color } : {}),
          ...(mapping.designId ? { designId: mapping.designId } : {}),
        });
      }
      if (slots.length) return normalizeAmsSlotPlan({ slots });
    }

    return normalizeAmsSlotPlan({
      slots: livePresent.flatMap((slot) => {
        const index = trayIndexFromSlot(slot.slot);
        if (index === undefined) return [];
        const color = normalizeHex(slot.colorHex);
        return [
          {
            index,
            material: materialName(slot.filamentType, input.material),
            source: "live" as const,
            ...(color ? { color } : {}),
          },
        ];
      }),
    });
  }

  if (extras.length) {
    return normalizeAmsSlotPlan({
      slots: extras.slice(0, AMS_TRAY_COUNT).map((filament, index) => {
        const color = normalizeHex(filament.colorHex);
        return {
          index,
          material: materialName(filament.type, input.material),
          source: "preset" as const,
          ...(color ? { color } : {}),
          ...(filament.id ? { designId: filament.id } : {}),
        };
      }),
    });
  }

  return normalizeAmsSlotPlan({
    slots: [
      {
        index: 0,
        material: materialName(input.material),
        source: "preset",
      },
    ],
  });
}

/** Swap or move a tray assignment. Marks both as manual. */
export function reassignAmsSlot(plan: AmsSlotPlan, fromIndex: number, toIndex: number): AmsSlotPlan {
  if (!isAmsSlotIndex(fromIndex) || !isAmsSlotIndex(toIndex) || fromIndex === toIndex) {
    return normalizeAmsSlotPlan(plan);
  }
  return normalizeAmsSlotPlan({
    slots: plan.slots.map((slot) => {
      if (slot.index === fromIndex) return { ...slot, index: toIndex, source: "manual" };
      if (slot.index === toIndex) return { ...slot, index: fromIndex, source: "manual" };
      return slot;
    }),
  });
}

export type ChatAmsSlotAssignment = {
  index: number;
  role?: string;
  designId?: string;
  material?: string;
  color?: string;
};

/** Apply "use AMS 2 for accent" without inventing mesh. */
export function applyChatAmsSlotAssignment(
  plan: AmsSlotPlan,
  assignment: ChatAmsSlotAssignment,
  material?: string,
): AmsSlotPlan {
  if (!isAmsSlotIndex(assignment.index)) return normalizeAmsSlotPlan(plan);
  const role = (assignment.designId ?? assignment.role ?? "").trim().toLowerCase();
  const match = role
    ? plan.slots.find((slot) => (slot.designId ?? "").toLowerCase() === role)
    : undefined;
  const next = plan.slots.map((slot) => ({ ...slot }));
  if (match) {
    return reassignAmsSlot({ slots: next }, match.index, assignment.index);
  }
  const color = normalizeHex(assignment.color);
  const existing = next.find((slot) => slot.index === assignment.index);
  const row: AmsSlotAssignment = {
    index: assignment.index,
    material: materialName(assignment.material ?? existing?.material ?? material, "pla"),
    source: "manual",
    ...(color ? { color } : existing?.color ? { color: existing.color } : {}),
    ...(role ? { designId: role } : {}),
  };
  return normalizeAmsSlotPlan({
    slots: [...next.filter((slot) => slot.index !== assignment.index), row],
  });
}
