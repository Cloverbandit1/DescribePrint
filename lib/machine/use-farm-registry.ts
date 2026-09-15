"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FARM_STORAGE_KEY,
  FarmRegistry,
  defaultFarmSnapshot,
  parseFarmSnapshot,
  serializeFarmSnapshot,
  type FarmMachine,
} from "./farm";

function readStoredFarm(): FarmRegistry {
  if (typeof window === "undefined") return new FarmRegistry();
  try {
    return new FarmRegistry(parseFarmSnapshot(window.localStorage.getItem(FARM_STORAGE_KEY)));
  } catch {
    return new FarmRegistry();
  }
}

function writeStoredFarm(registry: FarmRegistry): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FARM_STORAGE_KEY, serializeFarmSnapshot(registry.snapshot()));
  } catch {
    // Private mode / quota — keep in-memory registry only.
  }
}

async function syncSelectedMachine(machine: FarmMachine): Promise<void> {
  try {
    await fetch("/api/machine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farm: { machine } }),
    });
  } catch {
    // Selection stays local. Monitor poll will keep talking to the last server pick.
  }
}

export function useFarmRegistry() {
  const [registry, setRegistry] = useState<FarmRegistry>(() => new FarmRegistry());
  const [hydrated, setHydrated] = useState(false);
  const [tick, setTick] = useState(0);

  const persist = useCallback((next: FarmRegistry, sync = true) => {
    writeStoredFarm(next);
    setRegistry(next);
    setTick((value) => value + 1);
    if (sync) void syncSelectedMachine(next.selected());
  }, []);

  useEffect(() => {
    const stored = readStoredFarm();
    persist(stored);
    setHydrated(true);
  }, [persist]);

  const mutate = (fn: (current: FarmRegistry) => void) => {
    const next = new FarmRegistry(registry.snapshot());
    fn(next);
    persist(next);
  };

  return {
    hydrated,
    machines: registry.list(),
    selected: registry.selected(),
    count: registry.count(),
    countLabel: registry.countLabel(),
    jobs: registry.queue(),
    revision: tick,
    addStub: () => {
      let added: FarmMachine | undefined;
      mutate((current) => {
        added = current.add();
        current.select(added.id);
      });
      return added ?? registry.selected();
    },
    select: (id: string) => {
      mutate((current) => {
        current.select(id);
      });
    },
    remove: (id: string) => {
      mutate((current) => {
        current.remove(id);
      });
    },
    snapshot: () => registry.snapshot() ?? defaultFarmSnapshot(),
  };
}
