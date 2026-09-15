import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/machine/route";
import {
  CAMERA_COOL_NOZZLE_PHRASE,
  CAMERA_HELP_GUIDE_IDS,
  CAMERA_PAUSE_NOW_PHRASE,
  CAMERA_SLOW_DOWN_PHRASE,
  CONNECT_LAN_FIRST,
  MID_PRINT_CONTROL_ID,
  MockMachineAdapter,
  buildCameraHelpGuide,
  cameraDoctorBridgeOwnsPrintControlOnly,
  cameraDoctorMidPrintChips,
  cameraHelpMidPrintActions,
  cameraPauseNowIntent,
  detectFailure,
  dismissCameraDoctor,
  getSharedMachine,
  injectStubCameraScene,
  isCameraDoctorCueEnabled,
  isCameraHelpGuideId,
  mockCameraFrame,
  offersCameraPauseChip,
  parseMidPrintCommandPhrase,
  resetSharedMachine,
  shouldShowCameraOk,
  takeCameraDoctorAnnouncement,
  toCameraDetectReport,
} from "@/lib/machine";
import { diagnosisFromCameraDetect, diagnosePrintComplaint } from "@/lib/print-doctor";

const FLAG = "BAMBU_CAMERA_STUB";

afterEach(() => {
  delete process.env[FLAG];
  resetSharedMachine();
});

describe("camera-specific doctor guides", () => {
  it.each(CAMERA_HELP_GUIDE_IDS)("builds an AMS-style guide for %s", (id) => {
    expect(isCameraHelpGuideId(id)).toBe(true);
    const guide = buildCameraHelpGuide(id);
    expect(guide.id).toBe(id);
    expect(guide.steps.length).toBeGreaterThanOrEqual(4);
    expect(guide.steps.join(" ")).toMatch(/pause/i);
    expect(guide.whenToRetrySoftware).toMatch(/does not pause/i);

    const result = diagnosePrintComplaint({
      complaint: id === "spaghetti" ? "spaghetti" : id === "nozzle-scrape" ? "nozzle scrape" : "empty bed",
    });
    expect(result.defectId).toBe(id);
    expect(result.cameraGuide?.id).toBe(id);
    expect(result.physicalSteps).toEqual(guide.steps);
    expect(offersCameraPauseChip(result)).toBe(true);
    expect(guide.midPrintActions).toEqual(cameraHelpMidPrintActions(id));
  });

  it("does not attach a camera guide to unrelated defects", () => {
    const stringing = diagnosePrintComplaint({ complaint: "stringing with PETG" });
    expect(stringing.cameraGuide).toBeUndefined();
    expect(offersCameraPauseChip(stringing)).toBe(false);
    expect(cameraDoctorMidPrintChips(stringing)).toEqual([]);
  });
});

describe("camera defect → mid-print chips", () => {
  it("exposes pause, slow, and cool chips on a spaghetti doctor message", () => {
    expect(cameraHelpMidPrintActions("spaghetti")).toEqual(["pause", "slow-down", "cool-nozzle"]);
    const spaghetti = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("spaghetti")));
    expect(spaghetti?.cameraGuide?.midPrintActions).toEqual(["pause", "slow-down", "cool-nozzle"]);
    const chips = cameraDoctorMidPrintChips(spaghetti!);
    expect(chips.map((chip) => chip.id)).toEqual(["pause", "slow-down", "cool-nozzle"]);
    expect(chips.map((chip) => chip.phrase)).toEqual([
      CAMERA_PAUSE_NOW_PHRASE,
      CAMERA_SLOW_DOWN_PHRASE,
      CAMERA_COOL_NOZZLE_PHRASE,
    ]);
    expect(chips.some((chip) => /slow down/i.test(chip.label))).toBe(true);
    expect(chips.some((chip) => /cool nozzle/i.test(chip.label))).toBe(true);
    expect(parseMidPrintCommandPhrase(CAMERA_SLOW_DOWN_PHRASE)).toMatchObject({
      command: { type: "set-speed", percent: 50 },
      speedLevel: 1,
    });
    expect(parseMidPrintCommandPhrase(CAMERA_COOL_NOZZLE_PHRASE, { material: "pla" })).toMatchObject({
      command: { type: "set-nozzle-temp", celsius: 210 },
    });
  });

  it("offers pause plus optional slow on nozzle scrape, and pause only on empty bed", () => {
    const scrape = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("nozzle-scrape")));
    expect(scrape?.cameraGuide?.midPrintActions).toEqual(["pause", "slow-down"]);
    expect(cameraDoctorMidPrintChips(scrape!).map((chip) => chip.id)).toEqual(["pause", "slow-down"]);

    const empty = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("empty-bed")));
    expect(empty?.cameraGuide?.midPrintActions).toEqual(["pause"]);
    const emptyChips = cameraDoctorMidPrintChips(empty!);
    expect(emptyChips.map((chip) => chip.id)).toEqual(["pause"]);
    expect(emptyChips.some((chip) => chip.id === "cool-nozzle")).toBe(false);
    expect(emptyChips.some((chip) => /cool/i.test(chip.label))).toBe(false);
  });

  it("keeps chips on the debounced announcement, not every poll", () => {
    const detect = toCameraDetectReport(detectFailure(mockCameraFrame("spaghetti")));
    const diagnosis = diagnosisFromCameraDetect(detect);
    const first = takeCameraDoctorAnnouncement(null, detect, diagnosis);
    expect(cameraDoctorMidPrintChips(first.announce!)).toHaveLength(3);

    const second = takeCameraDoctorAnnouncement(first.held, detect, diagnosis);
    expect(second.announce).toBeUndefined();
  });

  it("clamps cool-nozzle to the material/preset safe min", () => {
    expect(parseMidPrintCommandPhrase("cool nozzle", { material: "pla", currentNozzleC: 185 })).toMatchObject({
      command: { type: "set-nozzle-temp", celsius: 190 },
    });
    expect(parseMidPrintCommandPhrase("cool nozzle -10°C", { material: "petg" })).toMatchObject({
      command: { type: "set-nozzle-temp", celsius: 240 },
    });
  });
});

describe("debounced camera → doctor bridge", () => {
  it("stays quiet when the stub is off or the frame is ok", () => {
    const off = takeCameraDoctorAnnouncement(null, undefined, undefined);
    expect(off.announce).toBeUndefined();
    expect(off.held).toBeNull();
    expect(isCameraDoctorCueEnabled(false, undefined)).toBe(false);

    const ok = toCameraDetectReport(detectFailure());
    const none = takeCameraDoctorAnnouncement(null, ok, undefined);
    expect(none.announce).toBeUndefined();
    expect(none.held).toBeNull();
    expect(shouldShowCameraOk(true, ok)).toBe(true);
    expect(diagnosisFromCameraDetect(detectFailure())).toBeUndefined();
  });

  it("announces spaghetti once, not on every poll, until ok or dismiss", () => {
    const detect = toCameraDetectReport(detectFailure(mockCameraFrame("spaghetti")));
    const diagnosis = diagnosisFromCameraDetect(detect);
    expect(diagnosis?.cameraGuide?.id).toBe("spaghetti");

    const first = takeCameraDoctorAnnouncement(null, detect, diagnosis);
    expect(first.announce?.defectId).toBe("spaghetti");
    expect(first.held).toBe("spaghetti");

    const second = takeCameraDoctorAnnouncement(first.held, detect, diagnosis);
    expect(second.announce).toBeUndefined();
    expect(second.held).toBe("spaghetti");

    const third = takeCameraDoctorAnnouncement(second.held, detect, diagnosis);
    expect(third.announce).toBeUndefined();

    const dismissed = dismissCameraDoctor(third.held, "spaghetti");
    const afterDismiss = takeCameraDoctorAnnouncement(dismissed, detect, diagnosis);
    expect(afterDismiss.announce).toBeUndefined();

    const cleared = takeCameraDoctorAnnouncement(afterDismiss.held, toCameraDetectReport(detectFailure()), undefined);
    expect(cleared.held).toBeNull();
    expect(cleared.announce).toBeUndefined();

    const again = takeCameraDoctorAnnouncement(cleared.held, detect, diagnosis);
    expect(again.announce?.defectId).toBe("spaghetti");
  });

  it("announces a new kind after the scene changes", () => {
    const spaghetti = toCameraDetectReport(detectFailure(mockCameraFrame("spaghetti")));
    const scrape = toCameraDetectReport(detectFailure(mockCameraFrame("nozzle-scrape")));
    const afterSpaghetti = takeCameraDoctorAnnouncement(null, spaghetti, diagnosisFromCameraDetect(spaghetti));
    const afterScrape = takeCameraDoctorAnnouncement(
      afterSpaghetti.held,
      scrape,
      diagnosisFromCameraDetect(scrape),
    );
    expect(afterScrape.announce?.defectId).toBe("nozzle-scrape");
    expect(afterScrape.held).toBe("nozzle-scrape");
  });
});

describe("live poll cues", () => {
  it("off = no camera detect or doctor cue", async () => {
    injectStubCameraScene("spaghetti");
    const body = (await (await GET()).json()) as {
      cameraStub: boolean;
      cameraDetect?: unknown;
      diagnosis?: unknown;
    };
    expect(body.cameraStub).toBe(false);
    expect(body.cameraDetect).toBeUndefined();
    expect(body.diagnosis).toBeUndefined();
    expect(isCameraDoctorCueEnabled(false, undefined)).toBe(false);
  });

  it("on + none = ok cue and no doctor announcement", async () => {
    process.env[FLAG] = "1";
    const body = (await (await GET()).json()) as {
      cameraDetect?: { kind: string; line: string; severity?: string };
      diagnosis?: unknown;
    };
    expect(body.cameraDetect?.kind).toBe("none");
    expect(body.cameraDetect?.line).toBe("ok");
    expect(body.cameraDetect?.severity).toBe("ok");
    expect(body.diagnosis).toBeUndefined();
    const bridged = takeCameraDoctorAnnouncement(null, body.cameraDetect as never, undefined);
    expect(bridged.announce).toBeUndefined();
  });

  it("on + spaghetti returns one doctor guide even across repeated polls", async () => {
    process.env[FLAG] = "1";
    injectStubCameraScene("spaghetti");

    const first = (await (await GET()).json()) as {
      cameraDetect?: { failure?: string; severity?: string };
      diagnosis?: { defectId: string; cameraGuide?: { id: string; steps: string[] } };
    };
    const second = (await (await GET()).json()) as {
      diagnosis?: { defectId: string };
    };

    expect(first.cameraDetect?.failure).toBe("spaghetti");
    expect(first.cameraDetect?.severity).toBe("suspected");
    expect(first.diagnosis?.defectId).toBe("spaghetti");
    expect(first.diagnosis?.cameraGuide?.id).toBe("spaghetti");
    expect(first.diagnosis?.cameraGuide?.steps.length).toBeGreaterThanOrEqual(4);
    expect(second.diagnosis?.defectId).toBe("spaghetti");

    const once = takeCameraDoctorAnnouncement(null, first.cameraDetect as never, first.diagnosis);
    const again = takeCameraDoctorAnnouncement(once.held, first.cameraDetect as never, second.diagnosis);
    expect(once.announce?.defectId).toBe("spaghetti");
    expect(again.announce).toBeUndefined();
  });
});

describe("Pause now chip uses the mid-print path", () => {
  it("maps the chip phrase onto sendMidPrintIfConnected via the complaint path", async () => {
    expect(CAMERA_PAUSE_NOW_PHRASE).toBe("pause now");
    expect(cameraPauseNowIntent()).toEqual({ command: { type: "pause" }, label: "pause" });
    expect(offersCameraPauseChip(diagnosisFromCameraDetect(detectFailure(mockCameraFrame("spaghetti")))!)).toBe(
      true,
    );

    const disconnected = getSharedMachine() as MockMachineAdapter;
    const refused = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: CAMERA_PAUSE_NOW_PHRASE }),
      }),
    );
    const refusedBody = (await refused.json()) as {
      diagnosis?: { defectId: string; midPrint?: { attempted: boolean; ok: boolean; message: string } };
    };
    expect(refusedBody.diagnosis?.defectId).toBe(MID_PRINT_CONTROL_ID);
    expect(refusedBody.diagnosis?.midPrint).toMatchObject({
      attempted: false,
      ok: false,
      message: CONNECT_LAN_FIRST,
    });
    expect(disconnected.sentCommands).toEqual([]);

    await disconnected.connect();
    disconnected.simulatePrinting();
    const paused = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: CAMERA_PAUSE_NOW_PHRASE }),
      }),
    );
    const pausedBody = (await paused.json()) as {
      diagnosis?: { midPrint?: { attempted: boolean; ok: boolean; command: { type: string } } };
      status: { print: string };
    };
    expect(pausedBody.diagnosis?.midPrint).toMatchObject({
      attempted: true,
      ok: true,
      command: { type: "pause" },
    });
    expect(pausedBody.status.print).toBe("paused");
    expect(disconnected.sentCommands).toEqual([{ type: "pause" }]);
  });

  it("does not send slow or cool chips while disconnected", async () => {
    const spaghetti = diagnosisFromCameraDetect(detectFailure(mockCameraFrame("spaghetti")))!;
    const chips = cameraDoctorMidPrintChips(spaghetti);
    const slow = chips.find((chip) => chip.id === "slow-down");
    const cool = chips.find((chip) => chip.id === "cool-nozzle");
    expect(slow?.phrase).toBe(CAMERA_SLOW_DOWN_PHRASE);
    expect(cool?.phrase).toBe(CAMERA_COOL_NOZZLE_PHRASE);

    const machine = getSharedMachine() as MockMachineAdapter;
    expect((await machine.status()).connection).toBe("disconnected");

    for (const phrase of [slow!.phrase, cool!.phrase]) {
      const refused = await POST(
        new Request("http://localhost/api/machine", {
          method: "POST",
          body: JSON.stringify({ complaint: phrase, material: "pla" }),
        }),
      );
      const body = (await refused.json()) as {
        diagnosis?: { midPrint?: { attempted: boolean; ok: boolean; message: string } };
      };
      expect(body.diagnosis?.midPrint).toMatchObject({
        attempted: false,
        ok: false,
        message: CONNECT_LAN_FIRST,
      });
    }
    expect(machine.sentCommands).toEqual([]);
  });
});

describe("camera doctor modules stay on Print Control", () => {
  it("does not import CAD assembly or pack files", () => {
    expect(cameraDoctorBridgeOwnsPrintControlOnly()).toBe(true);
    const root = process.cwd();
    const banned = /plate-pack|project-pack|cad-reshape|openscad|assembly|knowledge\/pack|ollama|etch/i;
    for (const file of ["camera-help.ts", "camera-doctor-bridge.ts", "camera.ts", "mid-print-commands.ts"]) {
      const imports = readFileSync(join(root, "lib/machine", file), "utf8")
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line))
        .join("\n");
      expect(imports).not.toMatch(banned);
    }
  });
});
