import type { MachineCredentials } from "./types";

/** Browser-only key. Never commit the stored access code. */
export const MACHINE_LAN_STORAGE_KEY = "describeprint.machine.lan";

export type MachineLanPrefs = {
  enabled: boolean;
} & MachineCredentials;

export function defaultMachineLanPrefs(): MachineLanPrefs {
  return { enabled: false, host: "", serial: "", accessCode: "" };
}

export function parseMachineLanPrefs(raw: string | null | undefined): MachineLanPrefs {
  const empty = defaultMachineLanPrefs();
  if (!raw?.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    const row = parsed as Record<string, unknown>;
    return {
      enabled: row.enabled === true,
      host: typeof row.host === "string" ? row.host : "",
      serial: typeof row.serial === "string" ? row.serial : "",
      accessCode: typeof row.accessCode === "string" ? row.accessCode : "",
    };
  } catch {
    return empty;
  }
}

export function serializeMachineLanPrefs(prefs: MachineLanPrefs): string {
  return JSON.stringify({
    enabled: prefs.enabled === true,
    host: prefs.host,
    serial: prefs.serial,
    accessCode: prefs.accessCode,
  });
}
