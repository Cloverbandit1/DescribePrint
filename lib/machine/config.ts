import { credentialsComplete, getMachineUiSession, type MachineUiSession } from "./session";
import type { MachineCredentials } from "./types";

export const BAMBU_LAN_ADAPTER_ID = "bambu-lan";
export const INCOMPLETE_LAN_HINT = "Enter printer IP, serial, and LAN access code.";

export type MachineLanSource = "off" | "env" | "ui";

export const BAMBU_MQTT_USERNAME = "bblp";
export const DEFAULT_BAMBU_MQTT_PORT = 8883;
export const DEFAULT_BAMBU_MQTT_TIMEOUT_MS = 8_000;

export type ProcessEnvLike = Record<string, string | undefined>;

export function envFlagEnabled(raw: string | undefined, fallback = false): boolean {
  if (!raw?.trim()) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

/** LAN MQTT adapter is off unless BAMBU_LAN_MQTT is explicitly enabled. */
export function isBambuLanMqttEnabled(env: ProcessEnvLike = process.env): boolean {
  return envFlagEnabled(env.BAMBU_LAN_MQTT, false);
}

export function readBambuLanCredentials(env: ProcessEnvLike = process.env): MachineCredentials | null {
  const credentials: MachineCredentials = {
    host: env.BAMBU_HOST?.trim() ?? "",
    serial: env.BAMBU_SERIAL?.trim() ?? "",
    accessCode: env.BAMBU_ACCESS_CODE?.trim() ?? "",
  };
  if (!credentials.host || !credentials.serial || !credentials.accessCode) return null;
  return credentials;
}

/**
 * Env-only selection. LAN MQTT stays off unless BAMBU_LAN_MQTT is on and
 * BAMBU_HOST / BAMBU_SERIAL / BAMBU_ACCESS_CODE are all set.
 * MACHINE_ADAPTER=mock always wins. MACHINE_ADAPTER=bambu-lan without the
 * flag+creds still falls back to mock. The UI session is not consulted here.
 */
export function resolveMachineAdapterId(env: ProcessEnvLike = process.env): string {
  const forced = env.MACHINE_ADAPTER?.trim();
  if (forced === "mock") return "mock";
  if (isBambuLanMqttEnabled(env) && readBambuLanCredentials(env)) {
    return BAMBU_LAN_ADAPTER_ID;
  }
  if (forced === BAMBU_LAN_ADAPTER_ID) return "mock";
  return forced || "mock";
}

export function machineLanSource(
  env: ProcessEnvLike = process.env,
  session: MachineUiSession = getMachineUiSession(),
): MachineLanSource {
  if (isBambuLanMqttEnabled(env) && readBambuLanCredentials(env)) return "env";
  if (session.enabled) return "ui";
  return "off";
}

/**
 * Live adapter for the running app: env override, then the Machine-panel
 * session. MACHINE_ADAPTER=mock still wins so CI cannot be forced onto LAN.
 * Incomplete UI creds stay on mock.
 */
export function resolveActiveAdapterId(
  env: ProcessEnvLike = process.env,
  session: MachineUiSession = getMachineUiSession(),
): string {
  const forced = env.MACHINE_ADAPTER?.trim();
  if (forced === "mock") return "mock";
  if (isBambuLanMqttEnabled(env) && readBambuLanCredentials(env)) {
    return BAMBU_LAN_ADAPTER_ID;
  }
  if (session.enabled && credentialsComplete(session.credentials)) {
    return BAMBU_LAN_ADAPTER_ID;
  }
  if (forced === BAMBU_LAN_ADAPTER_ID) return "mock";
  return forced || "mock";
}

/** Env creds win when the flag is on; otherwise the UI session if complete. */
export function readLiveCredentials(
  env: ProcessEnvLike = process.env,
  session: MachineUiSession = getMachineUiSession(),
): MachineCredentials | null {
  const fromEnv = readBambuLanCredentials(env);
  if (isBambuLanMqttEnabled(env) && fromEnv) return fromEnv;
  if (session.enabled && credentialsComplete(session.credentials)) {
    return { ...session.credentials };
  }
  return null;
}

export function machineLanHint(
  env: ProcessEnvLike = process.env,
  session: MachineUiSession = getMachineUiSession(),
): string | undefined {
  if (machineLanSource(env, session) !== "ui") return undefined;
  return credentialsComplete(session.credentials) ? undefined : INCOMPLETE_LAN_HINT;
}

export function bambuMqttPort(env: ProcessEnvLike = process.env): number {
  const raw = Number(env.BAMBU_MQTT_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_BAMBU_MQTT_PORT;
}

export function bambuMqttTimeoutMs(env: ProcessEnvLike = process.env): number {
  const raw = Number(env.BAMBU_MQTT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BAMBU_MQTT_TIMEOUT_MS;
}
