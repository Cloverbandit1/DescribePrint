import type { PrintDoctorResult } from "../print-doctor";
import type { AmsAutofixResult } from "./ams-autofix";
import type { CameraDetectReport } from "./camera";
import { parseCameraStubPref } from "./camera";
import type { EmergencyRemainingReshapePlan } from "./reshape-plan";
import { parseReshapeRemainingPref } from "./reshape";
import type { CommandResult, LiveMachineStatus, MachineCredentials, MidPrintCommand } from "./types";
import type { MachineLanSource } from "./config";

export type MachineApiResponse = {
  live: boolean;
  adapterId: string;
  lanEnabled: boolean;
  source: MachineLanSource;
  hint?: string;
  host?: string;
  serial?: string;
  cameraStub: boolean;
  amsAutofix: boolean;
  reshapeRemaining: boolean;
  status: LiveMachineStatus;
  lastCommand?: CommandResult;
  diagnosis?: PrintDoctorResult;
  lastAutofix?: AmsAutofixResult;
  lastReshape?: EmergencyRemainingReshapePlan;
  /** Present only when the camera stub is on (env or checkbox). One detect per poll. */
  cameraDetect?: CameraDetectReport;
};

export type MachineConfigureRequest = {
  lan: boolean;
  credentials: MachineCredentials;
  cameraStub?: boolean;
  reshapeRemaining?: boolean;
};

export function parseMidPrintCommand(value: unknown): MidPrintCommand | null {
  if (!value || typeof value !== "object") return null;
  const command = value as { type?: unknown; percent?: unknown; celsius?: unknown; slot?: unknown };
  switch (command.type) {
    case "pause":
    case "resume":
      return { type: command.type };
    case "set-speed": {
      const percent = Number(command.percent);
      if (!Number.isFinite(percent)) return null;
      return { type: "set-speed", percent };
    }
    case "set-nozzle-temp":
    case "set-bed-temp": {
      const celsius = Number(command.celsius);
      if (!Number.isFinite(celsius)) return null;
      return { type: command.type, celsius };
    }
    case "ams-stop-feed":
    case "ams-retry-load": {
      const slot = Number(command.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > 20) return null;
      return { type: command.type, slot };
    }
    default:
      return null;
  }
}

export function parsePrintDoctorBody(
  value: unknown,
): { complaint: string; slot?: number; reshapeRemaining?: boolean; material?: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { complaint?: unknown; slot?: unknown; autofix?: unknown; reshapeRemaining?: unknown; material?: unknown };
  const complaint = typeof row.complaint === "string" ? row.complaint.trim() : "";
  if (!complaint && row.autofix !== true && row.autofix !== "ams-feed-loop") return null;
  const slotRaw = Number(row.slot);
  const slot = Number.isInteger(slotRaw) && slotRaw >= 1 && slotRaw <= 20 ? slotRaw : undefined;
  const reshapeRemaining = parseReshapeRemainingFromBody(row);
  const material = typeof row.material === "string" ? row.material.trim() : undefined;
  return {
    complaint,
    slot,
    ...(reshapeRemaining !== undefined ? { reshapeRemaining } : {}),
    ...(material ? { material } : {}),
  };
}

function readCredentialField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseCameraStubFromBody(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { cameraStub?: unknown };
  if (typeof row.cameraStub === "boolean") return row.cameraStub;
  if (typeof row.cameraStub === "string") return parseCameraStubPref(row.cameraStub);
  return undefined;
}

export function parseCameraStubFromRequest(request?: Request): boolean | undefined {
  if (!request) return undefined;
  const url = new URL(request.url);
  if (!url.searchParams.has("cameraStub")) return undefined;
  return parseCameraStubPref(url.searchParams.get("cameraStub"));
}

export function parseMachineConfigure(value: unknown): MachineConfigureRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { lan?: unknown; credentials?: unknown };
  if (typeof body.lan !== "boolean") return null;
  const row =
    body.credentials && typeof body.credentials === "object"
      ? (body.credentials as Record<string, unknown>)
      : {};
  const cameraStub = parseCameraStubFromBody(body);
  const reshapeRemaining = parseReshapeRemainingFromBody(body);
  return {
    lan: body.lan,
    credentials: {
      host: readCredentialField(row.host),
      serial: readCredentialField(row.serial),
      accessCode: readCredentialField(row.accessCode),
    },
    ...(cameraStub !== undefined ? { cameraStub } : {}),
    ...(reshapeRemaining !== undefined ? { reshapeRemaining } : {}),
  };
}

export function parseReshapeRemainingFromBody(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { reshapeRemaining?: unknown };
  if (typeof row.reshapeRemaining === "boolean") return row.reshapeRemaining;
  if (typeof row.reshapeRemaining === "string") return parseReshapeRemainingPref(row.reshapeRemaining);
  return undefined;
}

export function parseReshapeRemainingFromRequest(request?: Request): boolean | undefined {
  if (!request) return undefined;
  const url = new URL(request.url);
  if (!url.searchParams.has("reshapeRemaining")) return undefined;
  return parseReshapeRemainingPref(url.searchParams.get("reshapeRemaining"));
}

export function commandFromBody(body: unknown): MidPrintCommand | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { command?: unknown };
  return parseMidPrintCommand("command" in row ? row.command : body);
}
