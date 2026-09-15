import { describe, expect, it } from "vitest";
import {
  createMachineAdapter,
  defaultAdapterId,
  emptyAmsSlots,
  listMachineAdapters,
  mapDesignFilamentsToAms,
  midPrintCommandRisk,
  MockMachineAdapter,
  planRemainingLayerReshape,
  RESERVED_BAMBU_LAN_ADAPTER_ID,
  validateLanCredentials,
} from "@/lib/machine";
import { defaultPrinter } from "@/lib/printers";

describe("machine adapter stubs", () => {
  it("defaults to the mock adapter; bambu-lan is registered but not selected", () => {
    expect(defaultAdapterId()).toBe("mock");
    expect(listMachineAdapters()).toContain("mock");
    expect(listMachineAdapters()).toContain(RESERVED_BAMBU_LAN_ADAPTER_ID);
    expect(createMachineAdapter().id).toBe("mock");
  });

  it("validates LAN credentials without performing I/O", () => {
    expect(validateLanCredentials({ host: "", serial: "01S", accessCode: "12345678" })).toMatch(/IP/);
    expect(validateLanCredentials({ host: "192.168.1.20", serial: "  ", accessCode: "12345678" })).toMatch(/serial/);
    expect(validateLanCredentials({ host: "192.168.1.20", serial: "01S", accessCode: "" })).toMatch(/Access code/);
    expect(validateLanCredentials({ host: "192.168.1.20", serial: "01S", accessCode: "12345678" })).toBeNull();
  });

  it("walks the mock connection state machine without a physical printer", async () => {
    const machine = new MockMachineAdapter();
    let status = await machine.status();
    expect(status.connection).toBe("disconnected");
    expect(status.amsSlots).toEqual(emptyAmsSlots(defaultPrinter().ams.slotsPerUnit));
    expect(status.amsSlots).toHaveLength(4);

    const badCreds = await machine.connect({ host: "", serial: "01S", accessCode: "secret" });
    expect(badCreds.connection).toBe("error");
    expect(badCreds.message).toMatch(/IP/);

    machine.failNextConnect("LAN unreachable (simulated)");
    status = await machine.connect({ host: "192.168.1.20", serial: "01S", accessCode: "secret" });
    expect(status.connection).toBe("error");
    expect(status.message).toMatch(/LAN unreachable/);

    status = await machine.connect();
    expect(status.connection).toBe("connected");
    expect(status.printerId).toBe("bambu-lab-p2s");
    expect(status.amsSlots.filter((slot) => slot.present)).toHaveLength(3);

    await machine.disconnect();
    status = await machine.status();
    expect(status.connection).toBe("disconnected");
    expect(status.print).toBe("idle");
  });

  it("pauses before risky mid-print temperature changes", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting({ layer: 10, totalLayers: 40 });

    expect(midPrintCommandRisk({ type: "pause" })).toBe("safe");
    expect(midPrintCommandRisk({ type: "resume" })).toBe("safe");
    expect(midPrintCommandRisk({ type: "set-speed", percent: 80 })).toBe("safe");
    expect(midPrintCommandRisk({ type: "set-nozzle-temp", celsius: 230 })).toBe("risky");
    expect(midPrintCommandRisk({ type: "set-bed-temp", celsius: 60 })).toBe("risky");

    const speed = await machine.send({ type: "set-speed", percent: 80 });
    expect(speed.ok).toBe(true);
    expect(speed.pausedFirst).toBe(false);
    expect((await machine.status()).print).toBe("printing");
    expect((await machine.status()).speedPercent).toBe(80);

    const nozzle = await machine.send({ type: "set-nozzle-temp", celsius: 230 });
    expect(nozzle.ok).toBe(true);
    expect(nozzle.pausedFirst).toBe(true);
    expect(nozzle.message).toMatch(/Paused/);
    const after = await machine.status();
    expect(after.print).toBe("paused");
    expect(after.nozzleTargetC).toBe(230);

    const resume = await machine.send({ type: "resume" });
    expect(resume.ok).toBe(true);
    expect((await machine.status()).print).toBe("printing");

    const pause = await machine.send({ type: "pause" });
    expect(pause.ok).toBe(true);
    expect((await machine.status()).print).toBe("paused");
  });

  it("rejects mid-print commands while disconnected and temps outside P2S limits", async () => {
    const machine = new MockMachineAdapter();
    const rejected = await machine.send({ type: "pause" });
    expect(rejected.ok).toBe(false);

    await machine.connect();
    const hot = await machine.send({ type: "set-nozzle-temp", celsius: 400 });
    expect(hot.ok).toBe(false);
    expect(hot.message).toMatch(/300/);

    const bed = await machine.send({ type: "set-bed-temp", celsius: 200 });
    expect(bed.ok).toBe(false);
    expect(bed.message).toMatch(/110/);
  });
});

describe("3MF filament plan → AMS mapping", () => {
  const slots = [
    { unit: 1, slot: 1, present: true, filamentType: "pla", colorHex: "#1A1A1A" },
    { unit: 1, slot: 2, present: true, filamentType: "petg", colorHex: "#2F6FED" },
    { unit: 1, slot: 3, present: true, filamentType: "abs", colorHex: "#C4C4C8" },
    { unit: 1, slot: 4, present: false },
  ];

  it("prefers exact type+color, then type-only, then unmapped", () => {
    const plan = mapDesignFilamentsToAms(
      [
        { id: "body", type: "PLA", colorHex: "#1a1a1a" },
        { id: "accent", type: "petg", colorHex: "#ff0000" },
        { id: "flex", type: "tpu" },
      ],
      slots,
    );

    expect(plan.mappings[0]).toMatchObject({ designId: "body", slot: 1, match: "exact" });
    expect(plan.mappings[1]).toMatchObject({ designId: "accent", slot: 2, match: "type" });
    expect(plan.mappings[2]).toMatchObject({ designId: "flex", match: "unmapped" });
    expect(plan.unmapped.map((f) => f.id)).toEqual(["flex"]);
  });

  it("does not assign the same AMS slot twice", () => {
    const plan = mapDesignFilamentsToAms(
      [
        { id: "a", type: "pla", colorHex: "#1A1A1A" },
        { id: "b", type: "pla", colorHex: "#FFFFFF" },
      ],
      slots,
    );
    expect(plan.mappings[0].slot).toBe(1);
    expect(plan.mappings[1].match).toBe("unmapped");
  });
});

describe("remaining-layer reshape planner stub", () => {
  it("asks CAD to restyle the unprinted remainder after a pause", () => {
    const plan = planRemainingLayerReshape({
      print: "printing",
      currentLayer: 12,
      totalLayers: 40,
      currentHeightMm: 2.4,
      objectHeightMm: 8,
    });
    expect(plan.action).toBe("pause-now");
    expect(plan.askCad).toBe(true);
    expect(plan.remainingHeightMm).toBeCloseTo(5.6);
    expect(plan.remainingLayers).toBe(28);
    expect(plan.currentZ).toBeCloseTo(2.4);
    expect(plan.message).toMatch(/Ask CAD/);
  });

  it("does not invent a reshape when idle or when height is unknown", () => {
    expect(planRemainingLayerReshape({ print: "idle" }).action).toBe("nothing-remaining");
    expect(planRemainingLayerReshape({ print: "printing" }).action).toBe("insufficient-data");
    expect(planRemainingLayerReshape({ print: "printing" }).askCad).toBe(false);
  });
});
