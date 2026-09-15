import { defaultPrinter, type PrinterId } from "../printers";

/**
 * In-app farm registry stub. List / select machines only — no job routing,
 * no send-across-farm, no LAN writes. Persist on the client; the server
 * keeps an in-memory copy of the selected machine so the adapter factory
 * talks to one printer at a time.
 */

export const FARM_STORAGE_KEY = "describeprint.machine.farm";
export const DEFAULT_FARM_MACHINE_ID = "p2s-1";
export const FARM_QUEUE_NOTE = "Queue (stub) · send-across-farm later";

export type FarmAdapterId = "mock" | "bambu-lan";

export type FarmMachine = {
  id: string;
  name: string;
  printerId: PrinterId;
  adapterId: FarmAdapterId;
  host?: string;
  serial?: string;
  notes?: string;
};

export type FarmJobStatus = "queued" | "active" | "done";

/** Typed queue row only. No worker, no send-to-printer. */
export type FarmJob = {
  machineId: string;
  status: FarmJobStatus;
};

export type FarmSnapshot = {
  machines: FarmMachine[];
  selectedId: string;
  jobs: FarmJob[];
};

export type FarmAdapterOptions = {
  printerId: PrinterId;
  machineId: string;
};

const FARM_ADAPTER_IDS: FarmAdapterId[] = ["mock", "bambu-lan"];
const FARM_JOB_STATUSES: FarmJobStatus[] = ["queued", "active", "done"];

export function defaultFarmMachine(): FarmMachine {
  const printer = defaultPrinter();
  return {
    id: DEFAULT_FARM_MACHINE_ID,
    name: printer.name,
    printerId: printer.id,
    adapterId: "mock",
    notes: "Default P2S",
  };
}

export function farmCountLabel(count: number): string {
  return count === 1 ? "1 machine" : `${count} machines`;
}

export function nextFarmStubName(existing: FarmMachine[]): string {
  const names = new Set(existing.map((machine) => machine.name));
  let n = 2;
  while (names.has(`P2S-${n}`)) n += 1;
  return `P2S-${n}`;
}

function slugId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueFarmId(base: string, existing: FarmMachine[]): string {
  const slug = slugId(base) || "machine";
  if (!existing.some((machine) => machine.id === slug)) return slug;
  let n = 2;
  while (existing.some((machine) => machine.id === `${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

function isFarmAdapterId(value: unknown): value is FarmAdapterId {
  return typeof value === "string" && (FARM_ADAPTER_IDS as string[]).includes(value);
}

function isPrinterId(value: unknown): value is PrinterId {
  return value === defaultPrinter().id;
}

function isFarmJobStatus(value: unknown): value is FarmJobStatus {
  return typeof value === "string" && (FARM_JOB_STATUSES as string[]).includes(value);
}

function optionalTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeFarmMachine(input: Partial<FarmMachine> & { id: string; name: string }): FarmMachine {
  const printerId = isPrinterId(input.printerId) ? input.printerId : defaultPrinter().id;
  const adapterId = isFarmAdapterId(input.adapterId) ? input.adapterId : "mock";
  const host = optionalTrimmed(input.host);
  const serial = optionalTrimmed(input.serial);
  const notes = optionalTrimmed(input.notes);
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    printerId,
    adapterId,
    ...(host ? { host } : {}),
    ...(serial ? { serial } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function parseFarmMachine(value: unknown): FarmMachine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!id || !name) return null;
  return normalizeFarmMachine({
    id,
    name,
    printerId: isPrinterId(row.printerId) ? row.printerId : undefined,
    adapterId: isFarmAdapterId(row.adapterId) ? row.adapterId : undefined,
    host: optionalTrimmed(row.host),
    serial: optionalTrimmed(row.serial),
    notes: optionalTrimmed(row.notes),
  });
}

function parseFarmJob(value: unknown): FarmJob | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { machineId?: unknown; status?: unknown };
  const machineId = typeof row.machineId === "string" ? row.machineId.trim() : "";
  if (!machineId || !isFarmJobStatus(row.status)) return null;
  return { machineId, status: row.status };
}

export function defaultFarmSnapshot(): FarmSnapshot {
  const machine = defaultFarmMachine();
  return { machines: [machine], selectedId: machine.id, jobs: [] };
}

export function parseFarmSnapshot(raw: string | null | undefined): FarmSnapshot {
  const fallback = defaultFarmSnapshot();
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const row = parsed as { machines?: unknown; selectedId?: unknown; jobs?: unknown };
    const machines = Array.isArray(row.machines)
      ? row.machines.map(parseFarmMachine).filter((machine): machine is FarmMachine => machine !== null)
      : [];
    if (machines.length === 0) return fallback;
    const selectedId =
      typeof row.selectedId === "string" && machines.some((machine) => machine.id === row.selectedId)
        ? row.selectedId
        : machines[0].id;
    const jobs = Array.isArray(row.jobs)
      ? row.jobs.map(parseFarmJob).filter((job): job is FarmJob => job !== null)
      : [];
    return { machines, selectedId, jobs };
  } catch {
    return fallback;
  }
}

export function serializeFarmSnapshot(snapshot: FarmSnapshot): string {
  return JSON.stringify({
    machines: snapshot.machines.map((machine) => normalizeFarmMachine(machine)),
    selectedId: snapshot.selectedId,
    jobs: snapshot.jobs.map((job) => ({ machineId: job.machineId, status: job.status })),
  });
}

function cloneMachine(machine: FarmMachine): FarmMachine {
  return { ...machine };
}

export class FarmRegistry {
  private machines: FarmMachine[];
  private selectedId: string;
  private jobs: FarmJob[];

  constructor(snapshot?: Partial<FarmSnapshot>) {
    const parsed = snapshot
      ? parseFarmSnapshot(JSON.stringify({
          machines: snapshot.machines ?? defaultFarmSnapshot().machines,
          selectedId: snapshot.selectedId ?? defaultFarmSnapshot().selectedId,
          jobs: snapshot.jobs ?? [],
        }))
      : defaultFarmSnapshot();
    this.machines = parsed.machines.map(cloneMachine);
    this.selectedId = parsed.selectedId;
    this.jobs = parsed.jobs.map((job) => ({ ...job }));
  }

  list(): FarmMachine[] {
    return this.machines.map(cloneMachine);
  }

  get(id: string): FarmMachine | undefined {
    const found = this.machines.find((machine) => machine.id === id);
    return found ? cloneMachine(found) : undefined;
  }

  selected(): FarmMachine {
    return this.get(this.selectedId) ?? cloneMachine(this.machines[0] ?? defaultFarmMachine());
  }

  count(): number {
    return this.machines.length;
  }

  countLabel(): string {
    return farmCountLabel(this.count());
  }

  add(input: Partial<FarmMachine> = {}): FarmMachine {
    const name = input.name?.trim() || nextFarmStubName(this.machines);
    const id = input.id?.trim() || uniqueFarmId(name, this.machines);
    if (this.machines.some((machine) => machine.id === id)) {
      throw new Error(`Farm machine already exists: ${id}`);
    }
    const machine = normalizeFarmMachine({
      ...input,
      id,
      name,
      printerId: input.printerId ?? defaultPrinter().id,
      adapterId: input.adapterId ?? "mock",
    });
    this.machines.push(machine);
    return cloneMachine(machine);
  }

  upsert(input: FarmMachine): FarmMachine {
    const machine = normalizeFarmMachine(input);
    const index = this.machines.findIndex((row) => row.id === machine.id);
    if (index >= 0) this.machines[index] = machine;
    else this.machines.push(machine);
    return cloneMachine(machine);
  }

  remove(id: string): boolean {
    if (this.machines.length <= 1) return false;
    const index = this.machines.findIndex((machine) => machine.id === id);
    if (index < 0) return false;
    this.machines.splice(index, 1);
    this.jobs = this.jobs.filter((job) => job.machineId !== id);
    if (this.selectedId === id) this.selectedId = this.machines[0].id;
    return true;
  }

  select(id: string): FarmMachine {
    const machine = this.machines.find((row) => row.id === id);
    if (!machine) throw new Error(`Unknown farm machine: ${id}`);
    this.selectedId = id;
    return cloneMachine(machine);
  }

  queue(): FarmJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  /** Type-only enqueue. Does not send, connect, or start a worker. */
  enqueueStub(job: FarmJob): FarmJob {
    const row: FarmJob = { machineId: job.machineId, status: job.status };
    this.jobs.push(row);
    return { ...row };
  }

  snapshot(): FarmSnapshot {
    return {
      machines: this.list(),
      selectedId: this.selected().id,
      jobs: this.queue(),
    };
  }
}

let sharedRegistry: FarmRegistry | null = null;

export function getFarmRegistry(): FarmRegistry {
  if (!sharedRegistry) sharedRegistry = new FarmRegistry();
  return sharedRegistry;
}

export function resetFarmRegistry(): void {
  sharedRegistry = null;
}

export function applyFarmSelection(machine: FarmMachine): FarmMachine {
  const registry = getFarmRegistry();
  registry.upsert(machine);
  return registry.select(machine.id);
}

export function selectedFarmAdapterOptions(): FarmAdapterOptions {
  const machine = getFarmRegistry().selected();
  return { printerId: machine.printerId, machineId: machine.id };
}
