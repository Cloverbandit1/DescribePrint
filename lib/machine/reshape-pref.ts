/** Client-safe remaining-layer reshape pref — no job store / node:crypto. */

export const MACHINE_RESHAPE_STORAGE_KEY = "describeprint.machine.reshapeRemaining";

function flagEnabled(raw: string | null | undefined, fallback = false): boolean {
  if (!raw?.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

export function parseReshapeRemainingPref(raw: string | null | undefined): boolean {
  return flagEnabled(raw, false);
}

export function serializeReshapeRemainingPref(enabled: boolean): string {
  return enabled ? "1" : "0";
}
