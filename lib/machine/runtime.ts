import "./mock";
import "./bambu-lan";
import { createMachineAdapter, defaultAdapterId, type MachineAdapter } from "./adapter";
import { BAMBU_LAN_ADAPTER_ID, readLiveCredentials } from "./config";
import { resetMachineUiSession } from "./session";

let shared: MachineAdapter | null = null;
let sharedKey = "";

function adapterKey(): string {
  const creds = readLiveCredentials();
  return `${defaultAdapterId()}|${creds?.host ?? ""}|${creds?.serial ?? ""}|${creds?.accessCode ?? ""}`;
}

export function isLiveMachineSelected(): boolean {
  return defaultAdapterId() === BAMBU_LAN_ADAPTER_ID;
}

export function getSharedMachine(): MachineAdapter {
  const key = adapterKey();
  if (shared && sharedKey !== key) {
    const previous = shared;
    shared = null;
    sharedKey = "";
    void previous.disconnect();
  }
  if (!shared) {
    shared = createMachineAdapter();
    sharedKey = key;
  }
  return shared;
}

export function resetSharedMachine(): void {
  shared = null;
  sharedKey = "";
  resetMachineUiSession();
}
