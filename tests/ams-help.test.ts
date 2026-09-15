import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/machine/route";
import {
  AMS_HELP_GUIDE_IDS,
  MockMachineAdapter,
  amsHelpPhysicalSteps,
  buildAmsHelpGuide,
  formatAmsSlotLabel,
  isAmsAutofixEnabled,
  isAmsHelpGuideId,
  maybeAutofixAmsFeedLoop,
  resetSharedMachine,
  selectAmsHelpGuideId,
} from "@/lib/machine";
import { emptyPrintDoctorMemory, memoryScopeFromResult, rememberStillBad } from "@/lib/machine/print-doctor-memory";
import { diagnosePrintComplaint, diagnosisFromAmsHint, looksLikePrintDoctorComplaint } from "@/lib/print-doctor";

afterEach(() => {
  delete process.env.AMS_AUTOFIX;
  resetSharedMachine();
});

const GUIDE_SAMPLES: Record<(typeof AMS_HELP_GUIDE_IDS)[number], string> = {
  "ams-feed-loop": "AMS 2 keeps looping feed/unfeed",
  "ams-load-failed": "AMS 3 can't load filament",
  "ams-spool-empty": "AMS 1 spool empty, filament ran out",
  "ams-tangled-spool": "AMS 4 spool is tangled",
  "ams-wet-pa": "wet nylon on AMS 2 needs drying",
  "ams-ptfe-path": "PTFE jam from AMS 2 to the toolhead",
};

describe("AMS help guide selection", () => {
  it.each(Object.entries(GUIDE_SAMPLES))("selects %s from chat", (id, complaint) => {
    expect(isAmsHelpGuideId(id)).toBe(true);
    expect(looksLikePrintDoctorComplaint(complaint)).toBe(true);
    expect(selectAmsHelpGuideId({ complaint })).toBe(id);

    const result = diagnosePrintComplaint({ complaint });
    expect(result.defectId).toBe(id);
    expect(result.amsGuide?.id).toBe(id);
    expect(result.fixes[0]?.id).toBe(id);
    expect(result.physicalSteps.length).toBeGreaterThanOrEqual(4);
    expect(result.physicalSteps.join(" ")).toMatch(/AMS \d/);
  });

  it("does not steal ordinary CAD describe prompts", () => {
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);
    expect(looksLikePrintDoctorComplaint("a tangled headphone stand")).toBe(false);
    expect(looksLikePrintDoctorComplaint("a nylon phone stand")).toBe(false);
    expect(selectAmsHelpGuideId({ complaint: "a tangled headphone stand" })).toBeUndefined();
  });

  it("uses a live remaining 0% as spool empty when chat is generic", () => {
    expect(selectAmsHelpGuideId({ remainingPercent: 0 })).toBe("ams-spool-empty");
    const result = diagnosePrintComplaint({
      complaint: "AMS problem",
      remainingPercent: 0,
      amsSlot: 2,
    });
    expect(result.defectId).toBe("ams-spool-empty");
    expect(result.amsGuide?.id).toBe("ams-spool-empty");
    expect(result.amsSlot).toBe(2);
  });

  it("uses a live hopper hint as feed-loop when chat does not name a guide", () => {
    const result = diagnosePrintComplaint({
      complaint: "AMS error",
      amsHint: { kind: "hopper-error", slot: 2 },
    });
    expect(result.defectId).toBe("ams-feed-loop");
    expect(result.amsGuide?.slot).toBe(2);
    expect(diagnosisFromAmsHint({ kind: "feed-loop", slot: 3, message: "AMS 3 feed/unfeed loop" })?.amsSlot).toBe(3);
  });
});

describe("AMS help slot interpolation", () => {
  it("names AMS 2 in every guide and falls back when the slot is unknown", () => {
    expect(formatAmsSlotLabel(2)).toBe("AMS 2");
    expect(formatAmsSlotLabel(undefined)).toBe("that AMS slot");

    for (const id of AMS_HELP_GUIDE_IDS) {
      const named = buildAmsHelpGuide(id, 2);
      expect(named.slot).toBe(2);
      expect(named.symptom).toMatch(/AMS 2/);
      expect(named.steps.join(" ")).toMatch(/AMS 2/);
      expect(named.steps.join(" ")).not.toContain("{slot}");
      expect(named.whenToRetrySoftware).toMatch(/AMS 2/);

      const generic = buildAmsHelpGuide(id);
      expect(generic.slot).toBeUndefined();
      expect(generic.steps.join(" ")).toMatch(/that AMS slot/);
      expect(amsHelpPhysicalSteps(id, 4).join(" ")).toMatch(/AMS 4/);
    }
  });

  it("prefers a live slot from status when chat omits the number", () => {
    const result = diagnosePrintComplaint({
      complaint: "can't load filament",
      amsSlot: 2,
    });
    expect(result.defectId).toBe("ams-load-failed");
    expect(result.amsSlot).toBe(2);
    expect(result.physicalSteps.join(" ")).toMatch(/AMS 2/);
  });
});

describe("AMS help + autofix flag", () => {
  it("stays off by default and never sends commands when diagnosing", async () => {
    expect(isAmsAutofixEnabled()).toBe(false);

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
    expect(result.physicalSteps?.join(" ")).toMatch(/AMS 2/);
    expect(result.physicalSteps?.length).toBeGreaterThanOrEqual(4);
    expect((await machine.status()).print).toBe("printing");
  });

  it("does not send commands for non-loop AMS guides even when the flag is on", async () => {
    const machine = new MockMachineAdapter();
    await machine.connect();
    machine.simulatePrinting();

    const diagnosis = diagnosePrintComplaint({ complaint: "AMS 2 can't load filament" });
    const result = await maybeAutofixAmsFeedLoop({
      adapter: machine,
      diagnosis,
      enabled: true,
    });

    expect(diagnosis.defectId).toBe("ams-load-failed");
    expect(result.attempted).toBe(false);
    expect(result.commands).toEqual([]);
    expect((await machine.status()).print).toBe("printing");
  });

  it("returns richer steps when software cannot clear a loop", async () => {
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
    expect(result.physicalSteps?.join(" ")).toMatch(/AMS 2/);
    expect(result.physicalSteps?.join(" ")).toMatch(/PTFE/i);
    expect(result.physicalSteps?.length).toBeGreaterThanOrEqual(4);
  });

  it("diagnoses AMS 2 without sending commands on the API when AMS_AUTOFIX is off", async () => {
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: "AMS 2 PTFE is jammed" }),
      }),
    );
    const body = (await response.json()) as {
      amsAutofix: boolean;
      diagnosis?: { defectId: string; amsSlot?: number; amsGuide?: { id: string; steps: string[] }; autofix?: { attempted: boolean; commands?: unknown[] } };
      lastAutofix?: { attempted: boolean; commands: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.amsAutofix).toBe(false);
    expect(body.diagnosis?.defectId).toBe("ams-ptfe-path");
    expect(body.diagnosis?.amsSlot).toBe(2);
    expect(body.diagnosis?.amsGuide?.id).toBe("ams-ptfe-path");
    expect(body.diagnosis?.amsGuide?.steps.join(" ")).toMatch(/AMS 2/);
    expect(body.diagnosis?.autofix?.attempted).toBe(false);
    expect(body.lastAutofix?.attempted).toBe(false);
    expect(body.lastAutofix?.commands).toEqual([]);
  });
});

describe("AMS help + Perfect/Still bad memory", () => {
  it("keys Still bad off the guide id and keeps the slot", () => {
    const first = diagnosePrintComplaint({ complaint: "AMS 2 keeps looping feed/unfeed" });
    expect(memoryScopeFromResult(first).symptom).toBe("ams-feed-loop");
    expect(first.fixes[0]?.id).toBe("ams-feed-loop");

    const { next } = rememberStillBad(emptyPrintDoctorMemory(), first);
    expect(next.defectId).toBe("ams-ptfe-path");
    expect(next.amsGuide?.id).toBe("ams-ptfe-path");
    expect(next.amsSlot).toBe(2);
    expect(next.physicalSteps.join(" ")).toMatch(/AMS 2/);
    expect(next.autofix).toBeUndefined();
  });
});
