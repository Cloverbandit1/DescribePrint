import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/machine/route";
import {
  DEFAULT_FARM_MACHINE_ID,
  FARM_QUEUE_NOTE,
  FarmRegistry,
  applyFarmSelection,
  createMachineAdapter,
  defaultAdapterId,
  defaultFarmMachine,
  farmCountLabel,
  getFarmRegistry,
  getSharedMachine,
  nextFarmStubName,
  parseFarmConfigure,
  parseFarmMachine,
  parseFarmSnapshot,
  resetSharedMachine,
  resolveActiveAdapterId,
  serializeFarmSnapshot,
} from "@/lib/machine";
import { defaultPrinter } from "@/lib/printers";

afterEach(() => {
  resetSharedMachine();
  vi.restoreAllMocks();
});

describe("farm registry stub", () => {
  it("seeds one default P2S", () => {
    const registry = new FarmRegistry();
    expect(registry.count()).toBe(1);
    expect(registry.countLabel()).toBe("1 machine");
    expect(farmCountLabel(1)).toBe("1 machine");
    expect(farmCountLabel(2)).toBe("2 machines");
    const selected = registry.selected();
    expect(selected.id).toBe(DEFAULT_FARM_MACHINE_ID);
    expect(selected.name).toBe(defaultPrinter().name);
    expect(selected.printerId).toBe("bambu-lab-p2s");
    expect(selected.adapterId).toBe("mock");
    expect(defaultFarmMachine().id).toBe(DEFAULT_FARM_MACHINE_ID);
  });

  it("adds a P2S-2 stub without live creds, then selects and removes", () => {
    const registry = new FarmRegistry();
    const stub = registry.add();
    expect(stub.name).toBe("P2S-2");
    expect(stub.printerId).toBe("bambu-lab-p2s");
    expect(stub.adapterId).toBe("mock");
    expect(stub.host).toBeUndefined();
    expect(stub.serial).toBeUndefined();
    expect(registry.count()).toBe(2);
    expect(registry.countLabel()).toBe("2 machines");
    expect(nextFarmStubName(registry.list())).toBe("P2S-3");

    const selected = registry.select(stub.id);
    expect(selected.id).toBe(stub.id);
    expect(registry.selected().name).toBe("P2S-2");

    expect(registry.remove(stub.id)).toBe(true);
    expect(registry.count()).toBe(1);
    expect(registry.selected().id).toBe(DEFAULT_FARM_MACHINE_ID);
  });

  it("refuses to remove the last machine and ignores unknown ids", () => {
    const registry = new FarmRegistry();
    expect(registry.remove(DEFAULT_FARM_MACHINE_ID)).toBe(false);
    expect(registry.remove("missing")).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
    expect(() => registry.select("missing")).toThrow(/Unknown farm machine/);
  });

  it("round-trips the snapshot and falls back when corrupt", () => {
    const registry = new FarmRegistry();
    registry.add({ name: "P2S-2", notes: "bench" });
    registry.select("p2s-2");
    const raw = serializeFarmSnapshot(registry.snapshot());
    const parsed = parseFarmSnapshot(raw);
    expect(parsed.machines).toHaveLength(2);
    expect(parsed.selectedId).toBe("p2s-2");
    expect(parsed.jobs).toEqual([]);
    expect(parseFarmSnapshot("not-json").machines).toHaveLength(1);
    expect(parseFarmSnapshot(null).selectedId).toBe(DEFAULT_FARM_MACHINE_ID);
    expect(parseFarmMachine({ id: "p2s-2", name: "P2S-2", adapterId: "bambu-lan" })?.adapterId).toBe("bambu-lan");
    expect(parseFarmMachine({ name: "no-id" })).toBeNull();
  });

  it("enqueues onto the selected machine as queued, then ticks to active and done", () => {
    const registry = new FarmRegistry();
    expect(registry.queue()).toEqual([]);
    const job = registry.enqueue();
    expect(job).toEqual({ id: "job-1", machineId: DEFAULT_FARM_MACHINE_ID, status: "queued" });
    expect(registry.listByMachine(DEFAULT_FARM_MACHINE_ID)).toEqual([job]);
    expect(registry.queue()).toEqual([job]);

    expect(registry.tick()).toEqual([{ ...job, status: "active" }]);
    expect(registry.advance()).toEqual([{ ...job, status: "done" }]);
    expect(registry.clearDone()).toEqual([]);
    expect(FARM_QUEUE_NOTE).toMatch(/send-across-farm later/);
  });

  it("promotes one queued job per machine per tick", () => {
    const registry = new FarmRegistry();
    registry.enqueue();
    registry.enqueue();
    expect(registry.tick().map((job) => job.status)).toEqual(["active", "queued"]);
    expect(registry.tick().map((job) => job.status)).toEqual(["done", "queued"]);
    expect(registry.tick().map((job) => job.status)).toEqual(["done", "active"]);
  });

  it("assigns first-free to a machine with no active job", () => {
    const registry = new FarmRegistry();
    const second = registry.add();
    const first = registry.enqueue();
    expect(first.machineId).toBe(DEFAULT_FARM_MACHINE_ID);
    registry.tick();
    const free = registry.enqueue({ assign: "first-free" });
    expect(free.machineId).toBe(second.id);
    expect(free.status).toBe("queued");
    expect(registry.listByMachine(second.id)).toEqual([free]);
  });

  it("persists job ids in the farm snapshot", () => {
    const registry = new FarmRegistry();
    registry.enqueue();
    const raw = serializeFarmSnapshot(registry.snapshot());
    expect(JSON.parse(raw).jobs).toEqual([
      { id: "job-1", machineId: DEFAULT_FARM_MACHINE_ID, status: "queued" },
    ]);
    expect(parseFarmSnapshot(raw).jobs[0]?.id).toBe("job-1");
    expect(parseFarmSnapshot('{"machines":[{"id":"p2s-1","name":"P2S"}],"jobs":[{"machineId":"p2s-1","status":"queued"}]}').jobs[0]?.id).toBe("job-1");
  });
});

describe("farm selection through the adapter factory", () => {
  it("uses the selected machine on adapter status", async () => {
    const stub = getFarmRegistry().add({ name: "P2S-2" });
    getFarmRegistry().select(stub.id);
    const adapter = createMachineAdapter();
    const status = await adapter.status();
    expect(status.machineId).toBe(stub.id);
    expect(status.printerId).toBe(stub.printerId);
    expect(status.adapterId).toBe("mock");
    expect(status.connection).toBe("disconnected");

    const shared = getSharedMachine();
    expect((await shared.status()).machineId).toBe(stub.id);
  });

  it("rebuilds the shared adapter when the selected machine changes", async () => {
    const first = await getSharedMachine().status();
    expect(first.machineId).toBe(DEFAULT_FARM_MACHINE_ID);

    const stub = applyFarmSelection({
      ...getFarmRegistry().add({ name: "P2S-2" }),
    });
    const next = await getSharedMachine().status();
    expect(next.machineId).toBe(stub.id);
    expect(next.printerId).toBe("bambu-lab-p2s");
  });
});

describe("farm registry does not write LAN", () => {
  it("does not select bambu-lan or connect from add/select/remove", async () => {
    const registry = getFarmRegistry();
    const stub = registry.add({
      name: "P2S-2",
      adapterId: "bambu-lan",
      host: "192.168.1.40",
      serial: "01S00A999",
    });
    registry.select(stub.id);
    applyFarmSelection(stub);

    expect(defaultAdapterId()).toBe("mock");
    expect(resolveActiveAdapterId()).toBe("mock");
    const adapter = createMachineAdapter();
    expect(adapter.id).toBe("mock");
    const status = await adapter.status();
    expect(status.adapterId).toBe("mock");
    expect(status.connection).toBe("disconnected");

    const connect = vi.spyOn(adapter, "connect");
    const send = vi.spyOn(adapter, "send");
    registry.add({ name: "P2S-3" });
    registry.select(stub.id);
    registry.remove("p2s-3");
    expect(connect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("enqueue and tick never select bambu-lan or call connect/send", async () => {
    const registry = getFarmRegistry();
    registry.add({
      name: "P2S-2",
      adapterId: "bambu-lan",
      host: "192.168.1.40",
      serial: "01S00A999",
    });

    expect(defaultAdapterId()).toBe("mock");
    expect(resolveActiveAdapterId()).toBe("mock");
    const adapter = createMachineAdapter();
    expect(adapter.id).toBe("mock");
    const connect = vi.spyOn(adapter, "connect");
    const send = vi.spyOn(adapter, "send");

    const job = registry.enqueue();
    expect(job.status).toBe("queued");
    expect(job.machineId).toBe(DEFAULT_FARM_MACHINE_ID);
    registry.enqueue({ assign: "first-free" });
    registry.tick();
    registry.tick();
    registry.clearDone();

    expect(defaultAdapterId()).toBe("mock");
    expect(resolveActiveAdapterId()).toBe("mock");
    expect(createMachineAdapter().id).toBe("mock");
    expect(connect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("queue worker source never imports LAN send or MQTT", () => {
    const src = readFileSync(new URL("../lib/machine/farm-queue.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from ["'].*(adapter|bambu|mqtt)/);
    expect(src).not.toMatch(/\.send\(|\.connect\(/);
  });

  it("POST farm selection stays mock and never echoes secrets", async () => {
    const machine = {
      id: "p2s-2",
      name: "P2S-2",
      printerId: "bambu-lab-p2s" as const,
      adapterId: "bambu-lan" as const,
      host: "192.168.1.40",
      serial: "01S00A999",
    };
    expect(parseFarmConfigure({ farm: { machine } })).toEqual({ machine });
    expect(parseFarmConfigure({ lan: true, credentials: { host: "", serial: "", accessCode: "" } })).toBeNull();

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ farm: { machine } }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      live: boolean;
      adapterId: string;
      farm: { selectedId: string; count: number };
      status: { machineId?: string; connection: string; adapterId: string };
    };
    expect(body.live).toBe(false);
    expect(body.adapterId).toBe("mock");
    expect(body.farm.selectedId).toBe("p2s-2");
    expect(body.farm.count).toBe(2);
    expect(body.status.machineId).toBe("p2s-2");
    expect(body.status.adapterId).toBe("mock");
    expect(body.status.connection).toBe("disconnected");
    expect(JSON.stringify(body)).not.toContain("accessCode");

    const followUp = await GET();
    const again = (await followUp.json()) as { farm: { selectedId: string }; live: boolean };
    expect(again.live).toBe(false);
    expect(again.farm.selectedId).toBe("p2s-2");
  });
});
