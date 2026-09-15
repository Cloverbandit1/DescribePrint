import type { CommandResult, LiveMachineStatus, MidPrintCommand } from "./types";

export type MachineApiResponse = {
  live: boolean;
  adapterId: string;
  status: LiveMachineStatus;
  lastCommand?: CommandResult;
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
