"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineApiResponse } from "./api";
import {
  MACHINE_LAN_STORAGE_KEY,
  defaultMachineLanPrefs,
  parseMachineLanPrefs,
  serializeMachineLanPrefs,
  type MachineLanPrefs,
} from "./prefs";
import {
  MACHINE_CAMERA_STORAGE_KEY,
  machineMonitorPollPath,
  parseCameraStubPref,
  serializeCameraStubPref,
} from "./camera";
import {
  MACHINE_RESHAPE_STORAGE_KEY,
  parseReshapeRemainingPref,
  serializeReshapeRemainingPref,
} from "./reshape-pref";
import { credentialsComplete } from "./session";
import type { MidPrintCommand } from "./types";

export const MACHINE_MONITOR_POLL_MS = 4_000;
const CONFIGURE_DEBOUNCE_MS = 400;

function readStoredPrefs(): MachineLanPrefs {
  if (typeof window === "undefined") return defaultMachineLanPrefs();
  try {
    return parseMachineLanPrefs(window.localStorage.getItem(MACHINE_LAN_STORAGE_KEY));
  } catch {
    return defaultMachineLanPrefs();
  }
}

function writeStoredPrefs(prefs: MachineLanPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MACHINE_LAN_STORAGE_KEY, serializeMachineLanPrefs(prefs));
  } catch {
    // Private mode / quota — keep in-memory prefs only.
  }
}

async function readMachineResponse(response: Response): Promise<MachineApiResponse | null> {
  const data = (await response.json()) as MachineApiResponse & { error?: string };
  if ("accessCode" in data) delete (data as { accessCode?: string }).accessCode;
  return data;
}

function readCameraStubPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseCameraStubPref(window.localStorage.getItem(MACHINE_CAMERA_STORAGE_KEY));
  } catch {
    return false;
  }
}

function writeCameraStubPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MACHINE_CAMERA_STORAGE_KEY, serializeCameraStubPref(enabled));
  } catch {
    // Private mode / quota — keep in-memory pref only.
  }
}

function readReshapeRemainingPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseReshapeRemainingPref(window.localStorage.getItem(MACHINE_RESHAPE_STORAGE_KEY));
  } catch {
    return false;
  }
}

function writeReshapeRemainingPref(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MACHINE_RESHAPE_STORAGE_KEY, serializeReshapeRemainingPref(enabled));
  } catch {
    // Private mode / quota — keep in-memory pref only.
  }
}

export function useMachineMonitor() {
  const [prefs, setPrefs] = useState<MachineLanPrefs>(defaultMachineLanPrefs);
  const [cameraStubPref, setCameraStubPref] = useState(false);
  const [reshapeRemainingPref, setReshapeRemainingPref] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [machine, setMachine] = useState<MachineApiResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const cameraStubPrefRef = useRef(cameraStubPref);
  cameraStubPrefRef.current = cameraStubPref;
  const reshapeRemainingPrefRef = useRef(reshapeRemainingPref);
  reshapeRemainingPrefRef.current = reshapeRemainingPref;

  useEffect(() => {
    const stored = readStoredPrefs();
    setPrefs((current) => {
      if (current.enabled || current.host || current.serial || current.accessCode) {
        return current;
      }
      return stored;
    });
    setCameraStubPref(readCameraStubPref());
    setReshapeRemainingPref(readReshapeRemainingPref());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredPrefs(prefs);
  }, [hydrated, prefs]);

  useEffect(() => {
    if (!hydrated) return;
    writeCameraStubPref(cameraStubPref);
  }, [hydrated, cameraStubPref]);

  useEffect(() => {
    if (!hydrated) return;
    writeReshapeRemainingPref(reshapeRemainingPref);
  }, [hydrated, reshapeRemainingPref]);

  const configure = useCallback(async (next: MachineLanPrefs) => {
    const response = await fetch("/api/machine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lan: next.enabled,
        credentials: {
          host: next.host,
          serial: next.serial,
          accessCode: next.accessCode,
        },
        cameraStub: cameraStubPrefRef.current,
        reshapeRemaining: reshapeRemainingPrefRef.current,
      }),
    });
    const data = await readMachineResponse(response);
    if (data) setMachine(data);
  }, []);

  const poll = useCallback(async () => {
    const current = prefsRef.current;
    if (current.enabled) {
      await configure(current);
      return;
    }
    const response = await fetch(
      machineMonitorPollPath(cameraStubPrefRef.current, reshapeRemainingPrefRef.current),
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await readMachineResponse(response);
    if (data) setMachine(data);
  }, [configure]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const delay = prefs.enabled && credentialsComplete(prefs) ? CONFIGURE_DEBOUNCE_MS : 0;
    const timer = window.setTimeout(() => {
      void (prefs.enabled ? configure(prefs) : poll()).catch(() => {
        if (!cancelled) void poll();
      });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hydrated, prefs, cameraStubPref, reshapeRemainingPref, configure, poll]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setInterval(() => {
      void poll();
    }, MACHINE_MONITOR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hydrated, poll]);

  const sendCommand = async (command: MidPrintCommand) => {
    setBusy(true);
    try {
      const current = prefsRef.current;
      const response = await fetch("/api/machine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command,
          lan: current.enabled,
          credentials: {
            host: current.host,
            serial: current.serial,
            accessCode: current.accessCode,
          },
        }),
      });
      const data = await readMachineResponse(response);
      if (response.ok && data) setMachine(data);
    } catch {
      // Keep last status. Command errors are shown from lastCommand when present.
    } finally {
      setBusy(false);
    }
  };

  const patchPrefs = (patch: Partial<MachineLanPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  };

  return {
    hydrated,
    prefs,
    setLanEnabled: (enabled: boolean) => patchPrefs({ enabled }),
    setHost: (host: string) => patchPrefs({ host }),
    setSerial: (serial: string) => patchPrefs({ serial }),
    setAccessCode: (accessCode: string) => patchPrefs({ accessCode }),
    machine,
    busy,
    sendCommand,
    cameraStubPref,
    setCameraStubPref,
    reshapeRemainingPref,
    setReshapeRemainingPref,
  };
}
