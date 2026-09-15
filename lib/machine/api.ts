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
  status: LiveMachineStatus;
  lastCommand?: CommandResult;
};

export type MachineConfigureRequest = {
  lan: boolean;
  credentials: MachineCredentials;
};

export function parseMidPrintCommand(value: unknown): MidPrintCommand | null {
  if (!value || typeof value !== "object") return null;
  const command = value as { type?: unknown; percent?: unknown; celsius?: unknown };
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
    default:
      return null;
  }
}

function readCredentialField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseMachineConfigure(value: unknown): MachineConfigureRequest | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { lan?: unknown; credentials?: unknown };
  if (typeof body.lan !== "boolean") return null;
  const row =
    body.credentials && typeof body.credentials === "object"
      ? (body.credentials as Record<string, unknown>)
      : {};
  return {
    lan: body.lan,
    credentials: {
      host: readCredentialField(row.host),
      serial: readCredentialField(row.serial),
      accessCode: readCredentialField(row.accessCode),
    },
  };
}

export function commandFromBody(body: unknown): MidPrintCommand | null {
  if (!body || typeof body !== "object") return null;
  const row = body as { command?: unknown };
  return parseMidPrintCommand("command" in row ? row.command : body);
}
