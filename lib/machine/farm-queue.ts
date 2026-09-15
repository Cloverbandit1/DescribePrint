import type { FarmJob, FarmJobStatus, FarmMachine } from "./farm";

/**
 * Local farm queue worker stub. Simulation only: enqueue + tick statuses.
 * Never calls adapter send / connect / MQTT / pause / resume.
 * Real send-across-farm is later.
 */

export type FarmEnqueueAssign = "selected" | "first-free";

export type FarmEnqueueInput = {
  id?: string;
  machineId?: string;
  assign?: FarmEnqueueAssign;
};

const NEXT_STATUS: Record<FarmJobStatus, FarmJobStatus | null> = {
  queued: "active",
  active: "done",
  done: null,
};

export function nextFarmJobId(existing: FarmJob[]): string {
  const ids = new Set(existing.map((job) => job.id));
  let n = 1;
  while (ids.has(`job-${n}`)) n += 1;
  return `job-${n}`;
}

/** First machine with no `active` job. Falls back to the selected machine. */
export function firstFreeFarmMachineId(
  machines: FarmMachine[],
  jobs: FarmJob[],
  fallbackId: string,
): string {
  const busy = new Set(jobs.filter((job) => job.status === "active").map((job) => job.machineId));
  return machines.find((machine) => !busy.has(machine.id))?.id ?? fallbackId;
}

export function resolveFarmEnqueueMachineId(
  input: FarmEnqueueInput,
  machines: FarmMachine[],
  jobs: FarmJob[],
  selectedId: string,
): string {
  const explicit = input.machineId?.trim();
  if (explicit && machines.some((machine) => machine.id === explicit)) return explicit;
  const fallback = machines.some((machine) => machine.id === selectedId)
    ? selectedId
    : (machines[0]?.id ?? selectedId);
  if ((input.assign ?? "selected") === "first-free") {
    return firstFreeFarmMachineId(machines, jobs, fallback);
  }
  return fallback;
}

export function createFarmJob(jobs: FarmJob[], machineId: string, id?: string): FarmJob {
  const preferred = id?.trim();
  return {
    id: preferred && !jobs.some((job) => job.id === preferred) ? preferred : nextFarmJobId(jobs),
    machineId,
    status: "queued",
  };
}

export function listFarmJobsByMachine(jobs: FarmJob[], machineId: string): FarmJob[] {
  return jobs.filter((job) => job.machineId === machineId).map((job) => ({ ...job }));
}

/**
 * One status step per machine: active → done, else first queued → active.
 * Sync step for tests and the Machine-panel Tick button.
 */
export function tickFarmJobs(jobs: FarmJob[], machineIds?: string[]): FarmJob[] {
  const next = jobs.map((job) => ({ ...job }));
  const ids = machineIds ?? [...new Set(next.map((job) => job.machineId))];
  for (const machineId of ids) {
    const active = next.find((job) => job.machineId === machineId && job.status === "active");
    if (active) {
      const after = NEXT_STATUS[active.status];
      if (after) active.status = after;
      continue;
    }
    const queued = next.find((job) => job.machineId === machineId && job.status === "queued");
    if (queued) {
      const after = NEXT_STATUS[queued.status];
      if (after) queued.status = after;
    }
  }
  return next;
}

export const advanceFarmJobs = tickFarmJobs;

export function clearDoneFarmJobs(jobs: FarmJob[]): FarmJob[] {
  return jobs.filter((job) => job.status !== "done").map((job) => ({ ...job }));
}
