import "./mock";
import "./bambu-lan";
import { createMachineAdapter, defaultAdapterId, type MachineAdapter } from "./adapter";
import { BAMBU_LAN_ADAPTER_ID } from "./config";

let shared: MachineAdapter | null = null;

export function isLiveMachineSelected(): boolean {
  return defaultAdapterId() === BAMBU_LAN_ADAPTER_ID;
}

export function getSharedMachine(): MachineAdapter {
  if (!shared) shared = createMachineAdapter();
  return shared;
}

export function resetSharedMachine(): void {
  shared = null;
}
