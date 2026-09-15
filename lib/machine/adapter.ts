import { defaultPrinter, type PrinterId } from "../printers";
import { resolveMachineAdapterId } from "./config";
import type {
  CommandResult,
  CommandRisk,
  LiveMachineStatus,
  MachineCredentials,
  MidPrintCommand,
} from "./types";

/**
 * Pluggable machine I/O. Mock is the default. `bambu-lan` is selected only
 * when BAMBU_LAN_MQTT is on and LAN credentials exist. Do not import this
 * seam from CAD / health / Ollama code.
 */
export interface MachineAdapter {
  readonly id: string;
  readonly printerId: PrinterId;
  connect(credentials?: MachineCredentials): Promise<LiveMachineStatus>;
  disconnect(): Promise<void>;
  status(): Promise<LiveMachineStatus>;
  send(command: MidPrintCommand): Promise<CommandResult>;
}

export type MachineAdapterFactory = () => MachineAdapter;

const registry = new Map<string, MachineAdapterFactory>();

export function registerMachineAdapter(id: string, factory: MachineAdapterFactory): void {
  registry.set(id, factory);
}

export function createMachineAdapter(id = defaultAdapterId()): MachineAdapter {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(`Unknown machine adapter: ${id}`);
  }
  return factory();
}

export function listMachineAdapters(): string[] {
  return [...registry.keys()];
}

export function defaultAdapterId(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMachineAdapterId(env);
}

export function midPrintCommandRisk(command: MidPrintCommand): CommandRisk {
  switch (command.type) {
    case "pause":
    case "resume":
    case "set-speed":
      return "safe";
    case "set-nozzle-temp":
    case "set-bed-temp":
      return "risky";
  }
}

export function validateLanCredentials(credentials: MachineCredentials): string | null {
  if (!credentials.host.trim()) return "Printer IP is required.";
  if (!credentials.serial.trim()) return "Printer serial is required.";
  if (!credentials.accessCode.trim()) return "Access code is required.";
  return null;
}

export function emptyAmsSlots(count = defaultPrinter().ams.slotsPerUnit, unit = 1) {
  return Array.from({ length: count }, (_, i) => ({
    unit,
    slot: i + 1,
    present: false as const,
  }));
}

export { BAMBU_LAN_ADAPTER_ID as RESERVED_BAMBU_LAN_ADAPTER_ID } from "./config";
