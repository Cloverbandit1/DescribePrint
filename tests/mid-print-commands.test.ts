import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/machine/route";
import {
  CONNECT_LAN_FIRST,
  MID_PRINT_CONTROL_ID,
  MockMachineAdapter,
  getSharedMachine,
  looksLikeMidPrintCommand,
  mapSpeedPercentToBambuTier,
  parseMidPrintCommandPhrase,
  resetSharedMachine,
  sendMidPrintIfConnected,
} from "@/lib/machine";
import { diagnosePrintComplaint, looksLikePrintDoctorComplaint } from "@/lib/print-doctor";

afterEach(() => {
  resetSharedMachine();
});

describe("mid-print chat phrases", () => {
  it("maps pause / resume / speed / temp phrases onto commands", () => {
    expect(parseMidPrintCommandPhrase("pause now")).toEqual({
      command: { type: "pause" },
      label: "pause",
    });
    expect(parseMidPrintCommandPhrase("pause the print")).toMatchObject({ command: { type: "pause" } });
    expect(parseMidPrintCommandPhrase("resume")).toMatchObject({ command: { type: "resume" } });
    expect(parseMidPrintCommandPhrase("continue printing")).toMatchObject({ command: { type: "resume" } });
    expect(parseMidPrintCommandPhrase("slow down")).toEqual({
      command: { type: "set-speed", percent: 50 },
      speedLevel: 1,
      label: "speed",
    });
    expect(parseMidPrintCommandPhrase("slow to 50%")).toMatchObject({
      command: { type: "set-speed", percent: 50 },
      speedLevel: 1,
    });
    expect(parseMidPrintCommandPhrase("speed 2")).toMatchObject({
      command: { type: "set-speed", percent: 100 },
      speedLevel: 2,
    });
    expect(parseMidPrintCommandPhrase("nozzle 220")).toEqual({
      command: { type: "set-nozzle-temp", celsius: 220 },
      label: "nozzle-temp",
    });
    expect(parseMidPrintCommandPhrase("bed 60")).toEqual({
      command: { type: "set-bed-temp", celsius: 60 },
      label: "bed-temp",
    });
  });

  it("snaps speed percent onto Bambu 1–4 tiers", () => {
    expect(mapSpeedPercentToBambuTier(50)).toMatchObject({ level: 1, percent: 50, name: "silent" });
    expect(mapSpeedPercentToBambuTier(100)).toMatchObject({ level: 2, percent: 100, name: "standard" });
    expect(mapSpeedPercentToBambuTier(124)).toMatchObject({ level: 3, percent: 124, name: "sport" });
    expect(mapSpeedPercentToBambuTier(166)).toMatchObject({ level: 4, percent: 166, name: "ludicrous" });
    expect(mapSpeedPercentToBambuTier(55)).toMatchObject({ level: 1, percent: 50 });
    expect(mapSpeedPercentToBambuTier(90)).toMatchObject({ level: 2, percent: 100 });
    expect(parseMidPrintCommandPhrase("speed 80%")?.speedLevel).toBe(2);
    expect(parseMidPrintCommandPhrase("print speed 3")).toMatchObject({
      command: { type: "set-speed", percent: 124 },
      speedLevel: 3,
    });
  });

  it("does not steal CAD prompts", () => {
    for (const prompt of [
      "pause the hinge clearance",
      "continue the fillet on the lid",
      "slow the taper to 20mm",
      "20mm cube with 5mm hole",
      "reshape this cube to 20mm",
      "bed 60mm tray",
      "nozzle scrape on the plate",
    ]) {
      expect(parseMidPrintCommandPhrase(prompt)).toBeNull();
      expect(looksLikeMidPrintCommand(prompt)).toBe(false);
    }
    expect(looksLikePrintDoctorComplaint("pause the hinge clearance")).toBe(false);
    expect(looksLikePrintDoctorComplaint("pause now")).toBe(true);
    expect(diagnosePrintComplaint({ complaint: "pause the print" }).defectId).toBe(MID_PRINT_CONTROL_ID);
    expect(diagnosePrintComplaint({ complaint: "nozzle scrape on the plate" }).defectId).toBe("nozzle-scrape");
  });
});

describe("mid-print send gate", () => {
  it("records phrase commands on a connected mock and refuses when disconnected", async () => {
    const machine = new MockMachineAdapter();
    const disconnected = await sendMidPrintIfConnected(machine, { type: "pause" });
    expect(disconnected.ok).toBe(false);
    expect(disconnected.message).toBe(CONNECT_LAN_FIRST);
    expect(disconnected.physicalSteps?.join(" ")).toMatch(/Pause/);
    expect(machine.sentCommands).toEqual([]);

    await machine.connect();
    machine.simulatePrinting();
    const paused = await sendMidPrintIfConnected(machine, { type: "pause" });
    expect(paused.ok).toBe(true);
    expect(machine.sentCommands).toEqual([{ type: "pause" }]);

    const resumed = await sendMidPrintIfConnected(machine, { type: "resume" });
    expect(resumed.ok).toBe(true);
    expect(machine.sentCommands).toEqual([{ type: "pause" }, { type: "resume" }]);
  });
});

describe("machine API mid-print chat path", () => {
  it("sends pause on a connected mock and leaves reshape resume manual", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.simulatePrinting();

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "pause now" }),
      }),
    );
    const body = (await response.json()) as {
      diagnosis?: {
        defectId: string;
        midPrint?: { attempted: boolean; ok: boolean; command: { type: string } };
      };
      lastCommand?: { ok: boolean; message: string };
      lastReshape?: { commands: unknown[] };
      status: { print: string };
    };

    expect(response.status).toBe(200);
    expect(body.diagnosis?.defectId).toBe(MID_PRINT_CONTROL_ID);
    expect(body.diagnosis?.midPrint).toMatchObject({
      attempted: true,
      ok: true,
      command: { type: "pause" },
    });
    expect(body.lastCommand?.ok).toBe(true);
    expect(body.lastReshape).toBeUndefined();
    expect(body.status.print).toBe("paused");
    expect(machine.sentCommands).toEqual([{ type: "pause" }]);
  });

  it("does not send when disconnected and does not claim success", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    expect((await machine.status()).connection).toBe("disconnected");

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "slow to 50%" }),
      }),
    );
    const body = (await response.json()) as {
      diagnosis?: { midPrint?: { attempted: boolean; ok: boolean; message: string } };
      lastCommand?: { ok: boolean; message: string; physicalSteps?: string[] };
    };

    expect(body.diagnosis?.midPrint?.attempted).toBe(false);
    expect(body.diagnosis?.midPrint?.ok).toBe(false);
    expect(body.diagnosis?.midPrint?.message).toBe(CONNECT_LAN_FIRST);
    expect(body.lastCommand?.ok).toBe(false);
    expect(body.lastCommand?.message).toBe(CONNECT_LAN_FIRST);
    expect(body.lastCommand?.physicalSteps?.join(" ")).toMatch(/Silent|speed/i);
    expect(machine.sentCommands).toEqual([]);
  });

  it("maps speed 2 through the complaint path onto the mock", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.simulatePrinting();

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "speed 2" }),
      }),
    );
    const body = (await response.json()) as {
      lastCommand?: { ok: boolean };
      status: { speedPercent?: number; print: string };
    };
    expect(body.lastCommand?.ok).toBe(true);
    expect(body.status.speedPercent).toBe(100);
    expect(body.status.print).toBe("printing");
    expect(machine.sentCommands).toEqual([{ type: "set-speed", percent: 100 }]);
  });
});
