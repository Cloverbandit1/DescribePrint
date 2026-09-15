import type { MachineCredentials } from "./types";

export type MachineUiSession = {
  enabled: boolean;
  credentials: MachineCredentials;
};

function emptyCredentials(): MachineCredentials {
  return { host: "", serial: "", accessCode: "" };
}

function emptySession(): MachineUiSession {
  return { enabled: false, credentials: emptyCredentials() };
}

let session: MachineUiSession = emptySession();

export function credentialsComplete(credentials: MachineCredentials): boolean {
  return Boolean(credentials.host.trim() && credentials.serial.trim() && credentials.accessCode.trim());
}

export function getMachineUiSession(): MachineUiSession {
  return {
    enabled: session.enabled,
    credentials: { ...session.credentials },
  };
}

export function setMachineUiSession(next: {
  enabled?: boolean;
  credentials?: Partial<MachineCredentials>;
}): MachineUiSession {
  const credentials = {
    host: next.credentials?.host ?? session.credentials.host,
    serial: next.credentials?.serial ?? session.credentials.serial,
    accessCode: next.credentials?.accessCode ?? session.credentials.accessCode,
  };
  session = {
    enabled: next.enabled ?? session.enabled,
    credentials: {
      host: typeof credentials.host === "string" ? credentials.host.trim() : "",
      serial: typeof credentials.serial === "string" ? credentials.serial.trim() : "",
      accessCode: typeof credentials.accessCode === "string" ? credentials.accessCode.trim() : "",
    },
  };
  return getMachineUiSession();
}

export function resetMachineUiSession(): void {
  session = emptySession();
}
