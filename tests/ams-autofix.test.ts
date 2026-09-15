import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/machine/route";
import {
  AMS_FEED_LOOP_SENTINEL,
  MockMachineAdapter,
  amsHintFromReport,
  buildBambuCommandPayload,
  detectsAmsFeedLoop,
  getSharedMachine,
  isAmsAutofixEnabled,
  isAmsPrintError,
  maybeAutofixAmsFeedLoop,
  parseBambuPrintReport,
  resetSharedMachine,
} from "@/lib/machine";
import { diagnosePrintComplaint, looksLikePrintDoctorComplaint } from "@/lib/print-doctor";

afterEach(() => {
  delete process.env.AMS_AUTOFIX;
  resetSharedMachine();
});

describe("AMS autofix flag", () => {
  it("stays off by default", () => {
    expect(isAmsAutofixEnabled()).toBe(false);
  });

  it("turns on only when AMS_AUTOFIX is set", () => {
    process.env.AMS_AUTOFIX = "1";
    expect(isAmsAutofixEnabled()).toBe(true);
  });
});

describe("AMS feed-loop detection", () => {
  it("routes chat 'AMS 2 keeps looping' to the doctor defect", () => {
    const complaint = "AMS 2 keeps looping";
    expect(looksLikePrintDoctorComplaint(complaint)).toBe(true);
    const diagnosis = diagnosePrintComplaint({ complaint });
    expect(diagnosis.defectId).toBe("ams-feed-loop");
    expect(diagnosis.amsSlot).toBe(2);
    expect(detectsAmsFeedLoop({ diagnosis })).toBe(true);
  });

  it("reads a hopper/feed hint from ams_status + AMS-family print_error", () => {
    const parsed = parseBambuPrintReport({
      print: {
        gcode_state: "RUNNING",
        ams_status: AMS_FEED_LOOP_SENTINEL,
        print_error: 0x0c000300,
        ams: { tray_now: 1, tray_tar: 1 },
      },
    });
    expect(isAmsPrintError(0x0c000300)).toBe(true);
    expect(parsed?.statusPatch.amsHint?.kind).toBe("hopper-error");
    expect(parsed?.statusPatch.amsHint?.slot).toBe(2);
    expect(detectsAmsFeedLoop({ status: { amsHint: parsed?.statusPatch.amsHint, amsSlots: [] } as never })).toBe(true);
  });

  it("does not treat a quiet ams_status as a loop", () => {
    expect(amsHintFromReport({ amsStatus: 0 })?.kind).toBe("none");
    expect(detectsAmsFeedLoop({ status: { amsHint: { kind: "none", amsStatus: 0 }, amsSlots: [] } as never })).toBe(
      false,
    );
  });
});

describe("AMS feed-loop autofix vs diagnose-only", () => {
  it("diagnoses but sends no printer commands when the flag is off", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting();
    machine.injectAmsFeedLoop(2);

    const diagnosis = diagnosePrintComplaint({ complaint: "AMS 2 keeps looping feed/unfeed" });
    const result = await maybeAutofixAmsFeedLoop({
      adapter: machine,
      diagnosis,
      enabled: false,
    });

    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.commands).toEqual([]);
    expect((await machine.status()).print).toBe("printing");
    expect((await machine.status()).amsHint?.kind).toBe("feed-loop");
  });

  it("pauses then autofixes a mock AMS loop when the flag is on", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting();
    machine.injectAmsFeedLoop(2);

    const diagnosis = diagnosePrintComplaint({ complaint: "AMS 2 keeps looping" });
    const result = await maybeAutofixAmsFeedLoop({
      adapter: machine,
      diagnosis,
      enabled: true,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.pausedFirst).toBe(true);
    expect(result.slot).toBe(2);
    expect(result.commands.map((row) => row.message)).toEqual([
      "Paused.",
      "Stopped AMS 2 feed.",
      "Retried load on AMS 2.",
    ]);
    expect((await machine.status()).print).toBe("paused");
    expect((await machine.status()).amsHint).toBeUndefined();
  });

  it("returns physical steps when software cannot clear the loop", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting();
    machine.injectAmsFeedLoop(2, { softwareFixable: false });

    const result = await maybeAutofixAmsFeedLoop({
      adapter: machine,
      status: await machine.status(),
      enabled: true,
    });

    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.pausedFirst).toBe(true);
    expect(result.physicalSteps?.join(" ")).toMatch(/AMS 2/);
    expect(result.physicalSteps?.join(" ")).toMatch(/PTFE/i);
    expect(result.commands[0]?.message).toBe("Paused.");
    expect(result.commands.at(-1)?.ok).toBe(false);
  });

  it("builds verified LAN MQTT payloads for stop-feed and retry-load", () => {
    expect(buildBambuCommandPayload({ type: "ams-stop-feed", slot: 2 }, "9")).toEqual({
      print: { sequence_id: "9", command: "ams_control", param: "pause" },
    });
    expect(buildBambuCommandPayload({ type: "ams-retry-load", slot: 2 }, "10")).toEqual({
      print: {
        sequence_id: "10",
        command: "ams_change_filament",
        target: 1,
        curr_temp: 0,
        tar_temp: 0,
      },
    });
  });
});

describe("machine API complaint path", () => {
  it("diagnoses AMS 2 without sending commands when AMS_AUTOFIX is off", async () => {
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.simulatePrinting();
    machine.injectAmsFeedLoop(2);

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "AMS 2 keeps looping" }),
      }),
    );
    const body = (await response.json()) as {
      amsAutofix: boolean;
      cameraStub: boolean;
      diagnosis?: { defectId: string; amsSlot?: number; autofix?: { attempted: boolean } };
      lastAutofix?: { attempted: boolean; commands: unknown[] };
      status: { print: string };
    };

    expect(response.status).toBe(200);
    expect(body.amsAutofix).toBe(false);
    expect(body.cameraStub).toBe(false);
    expect(body.diagnosis?.defectId).toBe("ams-feed-loop");
    expect(body.diagnosis?.amsSlot).toBe(2);
    expect(body.diagnosis?.autofix?.attempted).toBe(false);
    expect(body.lastAutofix?.attempted).toBe(false);
    expect(body.lastAutofix?.commands).toEqual([]);
    expect(body.status.print).toBe("printing");
  });

  it("pauses then autofixes when AMS_AUTOFIX is on", async () => {
    process.env.AMS_AUTOFIX = "1";
    const machine = getSharedMachine() as MockMachineAdapter;
    await machine.connect();
    machine.simulatePrinting();
    machine.injectAmsFeedLoop(2);

    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "AMS 2 keeps looping" }),
      }),
    );
    const body = (await response.json()) as {
      amsAutofix: boolean;
      lastAutofix?: { attempted: boolean; ok: boolean; pausedFirst: boolean; commands: { message: string }[] };
      status: { print: string; amsHint?: { kind: string } };
    };

    expect(body.amsAutofix).toBe(true);
    expect(body.lastAutofix?.attempted).toBe(true);
    expect(body.lastAutofix?.ok).toBe(true);
    expect(body.lastAutofix?.pausedFirst).toBe(true);
    expect(body.lastAutofix?.commands.map((row) => row.message)).toEqual([
      "Paused.",
      "Stopped AMS 2 feed.",
      "Retried load on AMS 2.",
    ]);
    expect(body.status.print).toBe("paused");
    expect(body.status.amsHint).toBeUndefined();
  });
});
