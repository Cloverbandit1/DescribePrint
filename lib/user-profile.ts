/**
 * Client user-profile stub.
 *
 * Remembers wearable S–XL / category, filament, P2S printer defaults, and
 * optional AMS slot labels. Persisted in localStorage on this device only —
 * not a cloud account. AMS rows are prefs, not live tray mapping.
 */

import { DEFAULT_PRINTER_ID, isFilamentId, normalizeFilamentId, type FilamentId, type PrinterId } from "./printers";
import type { Unit, WearableCategoryId, WearableSizeId } from "./types";
import {
  DEFAULT_WEARABLE_CATEGORY,
  isWearableCategoryId,
  isWearableSizeId,
  WEARABLE_SIZE_LABELS,
} from "./wearable-sizes";

export const USER_PROFILE_STORAGE_KEY = "describeprint.userProfile";

export const USER_PROFILE_NOTE =
  "Saved on this device only — not a cloud account yet. AMS labels are prefs, not live tray mapping.";

export const USER_PROFILE_AMS_SLOT_COUNT = 4;

export type UserProfileAmsSlotPref = {
  /** 0-based tray index (AMS 1–4). */
  index: number;
  label: string;
  material?: FilamentId;
  colorHex?: string;
};

export type UserProfile = {
  version: 1;
  cloudAccount: false;
  printerId: PrinterId;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId;
  filament: FilamentId;
  /** Optional More-options overall size (same units as `units`). */
  partSizeHint: number | null;
  units: Unit;
  amsSlots: UserProfileAmsSlotPref[];
};

export type UserProfileGenerateFields = {
  wearableSize?: WearableSizeId | null;
  wearableCategory?: WearableCategoryId | null;
  filament?: FilamentId | string | null;
  sizeHint?: number | null;
  units?: Unit | null;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isAmsSlotIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < USER_PROFILE_AMS_SLOT_COUNT;
}

function normalizeColorHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  return undefined;
}

function parseUnits(value: unknown): Unit {
  return value === "in" ? "in" : "mm";
}

function parseAmsSlot(value: unknown): UserProfileAmsSlotPref | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const index = asFiniteNumber(row.index);
  if (!isAmsSlotIndex(index)) return null;
  const label = asString(row.label) ?? "";
  const material = normalizeFilamentId(typeof row.material === "string" ? row.material : undefined);
  const colorHex = normalizeColorHex(row.colorHex ?? row.color);
  if (!label && !material && !colorHex) return null;
  return {
    index,
    label,
    ...(material ? { material } : {}),
    ...(colorHex ? { colorHex } : {}),
  };
}

function parseAmsSlots(value: unknown): UserProfileAmsSlotPref[] {
  if (!Array.isArray(value)) return [];
  const slots: UserProfileAmsSlotPref[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    const slot = parseAmsSlot(item);
    if (!slot || seen.has(slot.index)) continue;
    seen.add(slot.index);
    slots.push(slot);
  }
  return slots.sort((a, b) => a.index - b.index);
}

export function defaultUserProfile(): UserProfile {
  return {
    version: 1,
    cloudAccount: false,
    printerId: DEFAULT_PRINTER_ID,
    wearableSize: null,
    wearableCategory: DEFAULT_WEARABLE_CATEGORY,
    filament: "pla",
    partSizeHint: null,
    units: "mm",
    amsSlots: [],
  };
}

export function normalizeUserProfile(value: unknown): UserProfile {
  const empty = defaultUserProfile();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const row = value as Record<string, unknown>;
  const sizeRaw = row.wearableSize;
  const wearableSize =
    sizeRaw === null || sizeRaw === "" || sizeRaw === "native" ? null : isWearableSizeId(sizeRaw) ? sizeRaw : empty.wearableSize;
  const category = row.wearableCategory;
  const filament = normalizeFilamentId(typeof row.filament === "string" ? row.filament : undefined);
  const hint = asFiniteNumber(row.partSizeHint ?? row.partSizeHintMm ?? row.sizeHint);
  return {
    version: 1,
    cloudAccount: false,
    printerId: DEFAULT_PRINTER_ID,
    wearableSize,
    wearableCategory: isWearableCategoryId(category) ? category : empty.wearableCategory,
    filament: filament && isFilamentId(filament) ? filament : empty.filament,
    partSizeHint: hint != null && hint > 0 ? hint : null,
    units: parseUnits(row.units),
    amsSlots: parseAmsSlots(row.amsSlots),
  };
}

export function parseUserProfile(raw: string | null | undefined): UserProfile {
  if (!raw?.trim()) return defaultUserProfile();
  try {
    return normalizeUserProfile(JSON.parse(raw));
  } catch {
    return defaultUserProfile();
  }
}

export function serializeUserProfile(profile: UserProfile): string {
  return JSON.stringify(normalizeUserProfile(profile));
}

export function upsertUserProfileAmsSlot(
  profile: UserProfile,
  slot: Partial<UserProfileAmsSlotPref> & { index: number },
): UserProfile {
  const next = parseAmsSlot({
    index: slot.index,
    label: slot.label ?? "",
    material: slot.material,
    colorHex: slot.colorHex,
  });
  const rest = profile.amsSlots.filter((row) => row.index !== slot.index);
  return normalizeUserProfile({
    ...profile,
    amsSlots: next ? [...rest, next] : rest,
  });
}

export function hasCustomUserProfile(profile: UserProfile): boolean {
  return (
    profile.wearableSize != null ||
    profile.wearableCategory !== DEFAULT_WEARABLE_CATEGORY ||
    profile.filament !== "pla" ||
    profile.partSizeHint != null ||
    profile.units !== "mm" ||
    profile.amsSlots.length > 0
  );
}

export function formatUserProfileSummary(profile: UserProfile): string {
  const size = profile.wearableSize
    ? `${profile.wearableSize} (${WEARABLE_SIZE_LABELS[profile.wearableSize]})`
    : "native size";
  const material = profile.filament.toUpperCase();
  const slots = profile.amsSlots.length
    ? ` · AMS ${profile.amsSlots.map((slot) => slot.label || String(slot.index + 1)).join("/")}`
    : "";
  return `${size} · ${material} · P2S${slots}`;
}

/** Fill unset generate/options fields from the saved profile. Explicit values win. */
export function applyUserProfileToRequest<T extends UserProfileGenerateFields>(
  request: T,
  profile: UserProfile,
): T & {
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId;
  filament: FilamentId;
  sizeHint: number | null;
  units: Unit;
} {
  const filament =
    normalizeFilamentId(typeof request.filament === "string" ? request.filament : undefined) ?? profile.filament;
  return {
    ...request,
    wearableSize: request.wearableSize !== undefined ? request.wearableSize : profile.wearableSize,
    wearableCategory: request.wearableCategory ?? profile.wearableCategory,
    filament,
    sizeHint: request.sizeHint !== undefined ? request.sizeHint : profile.partSizeHint,
    units: request.units ?? profile.units,
  };
}

export function sessionDefaultsFromProfile(profile: UserProfile): {
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId;
  filament: FilamentId;
  sizeHint: string;
  units: Unit;
} {
  return {
    wearableSize: profile.wearableSize,
    wearableCategory: profile.wearableCategory,
    filament: profile.filament,
    sizeHint: profile.partSizeHint != null ? String(profile.partSizeHint) : "",
    units: profile.units,
  };
}
