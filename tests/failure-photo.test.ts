import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/machine/route";
import {
  FAILURE_PHOTO_ASK,
  diagnosisFromFailurePhoto,
  failurePhotoAskResult,
  failurePhotoOwnsPrintControlOnly,
  looksLikeFailurePhotoCaption,
  replayFailurePhoto,
  resetSharedMachine,
} from "@/lib/machine";
import { diagnosePrintComplaint, looksLikePrintDoctorComplaint } from "@/lib/print-doctor";

afterEach(() => {
  resetSharedMachine();
});

describe("failure-photo filename / hint mapping", () => {
  it("maps spaghetti / string / blob onto spaghetti", () => {
    expect(replayFailurePhoto({ filename: "spaghetti_blob.jpg" })).toMatchObject({
      kind: "spaghetti",
      doctorSymptom: "spaghetti, print detached",
      confidence: "stub",
    });
    expect(replayFailurePhoto({ hint: "spaghetti blob" }).kind).toBe("spaghetti");
    expect(replayFailurePhoto({ filename: "string.jpg" }).kind).toBe("spaghetti");
    expect(replayFailurePhoto({ hint: "nest of blob" }).kind).toBe("spaghetti");
  });

  it("maps stringing as its own doctor symptom", () => {
    const replay = replayFailurePhoto({ filename: "PETG-stringing.png" });
    expect(replay.kind).toBe("stringing");
    expect(replay.doctorSymptom).toBe("stringing");
    expect(replay.cadSuggestion).toBe("print doctor settings");
  });

  it("maps scrape / crash onto scrape", () => {
    expect(replayFailurePhoto({ filename: "nozzle-scrape.jpeg" }).kind).toBe("scrape");
    expect(replayFailurePhoto({ hint: "toolhead crash" }).kind).toBe("scrape");
    expect(replayFailurePhoto({ hint: "scrape" }).doctorSymptom).toBe("nozzle scrape");
  });

  it("maps empty / nothing onto empty bed", () => {
    expect(replayFailurePhoto({ filename: "empty_bed.webp" }).kind).toBe("empty-bed");
    expect(replayFailurePhoto({ hint: "nothing on the plate" }).kind).toBe("empty-bed");
    expect(replayFailurePhoto({ hint: "empty" }).doctorSymptom).toBe("empty bed");
  });

  it("maps ams / loop onto AMS feed loop", () => {
    expect(replayFailurePhoto({ filename: "ams_loop.jpg" }).kind).toBe("ams-feed-loop");
    expect(replayFailurePhoto({ hint: "AMS 2 loop" }).kind).toBe("ams-feed-loop");
    expect(replayFailurePhoto({ hint: "loop" }).doctorSymptom).toBe("AMS feed/unfeed loop");
  });

  it("does not invent a kind from an unknown filename, empty upload, or mime", () => {
    expect(replayFailurePhoto({ filename: "IMG_1234.jpg" })).toMatchObject({
      kind: "unknown",
      doctorSymptom: "",
      confidence: "stub",
      ask: FAILURE_PHOTO_ASK,
    });
    expect(replayFailurePhoto({})).toMatchObject({ kind: "unknown", doctorSymptom: "" });
    expect(replayFailurePhoto({ mime: "image/jpeg" }).kind).toBe("unknown");
    expect(replayFailurePhoto({ filename: "photo.png", hint: "  " }).kind).toBe("unknown");
    expect(diagnosisFromFailurePhoto({ filename: "IMG_1234.jpg" })).toBeUndefined();
    expect(failurePhotoAskResult().diagnosis).toBe(FAILURE_PHOTO_ASK);
    expect(failurePhotoAskResult().fixes).toEqual([]);
  });
});

describe("failure-photo chat captions", () => {
  it("accepts a short caption and leaves CAD prompts alone", () => {
    expect(looksLikeFailurePhotoCaption("crash")).toBe(true);
    expect(looksLikeFailurePhotoCaption("nothing on bed")).toBe(true);
    expect(looksLikeFailurePhotoCaption("spaghetti blob")).toBe(true);
    expect(looksLikeFailurePhotoCaption("20mm cube with 5mm hole")).toBe(false);
    expect(looksLikeFailurePhotoCaption("phone stand for iPhone 15")).toBe(false);
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);
  });
});

describe("failure-photo invokes the existing doctor path", () => {
  it("runs Print doctor guides and chips — no CAD reshape plan", () => {
    const spaghetti = diagnosisFromFailurePhoto({ filename: "spaghetti_blob.jpg" });
    expect(spaghetti?.defectId).toBe("spaghetti");
    expect(spaghetti?.cameraGuide?.id).toBe("spaghetti");
    expect(spaghetti?.diagnosis).toMatch(/Failed photo \(stub\)/i);
    expect(spaghetti?.diagnosis).toMatch(/try reshape remaining/i);
    expect(spaghetti?.diagnosis).toMatch(/not running CAD/i);
    expect(spaghetti?.reshape).toBeUndefined();
    expect(spaghetti?.physicalSteps.length).toBeGreaterThanOrEqual(4);

    const scrape = diagnosisFromFailurePhoto({ hint: "crash" });
    expect(scrape?.defectId).toBe("nozzle-scrape");
    expect(scrape?.cameraGuide?.id).toBe("nozzle-scrape");
    expect(scrape?.diagnosis).toMatch(/print doctor settings/i);

    const empty = diagnosisFromFailurePhoto({ filename: "empty-bed.jpg" });
    expect(empty?.defectId).toBe("empty-bed");
    expect(empty?.cameraGuide?.id).toBe("empty-bed");

    const ams = diagnosisFromFailurePhoto({ filename: "ams-loop.png" });
    expect(ams?.defectId).toBe("ams-feed-loop");
    expect(ams?.amsGuide?.id).toBe("ams-feed-loop");

    const stringing = diagnosisFromFailurePhoto({ hint: "stringing" });
    expect(stringing?.defectId).toBe("stringing");
    expect(stringing?.cameraGuide).toBeUndefined();
    expect(stringing?.fixes.some((fix) => fix.key === "nozzleC")).toBe(true);

    const samePath = diagnosePrintComplaint({ complaint: replayFailurePhoto({ hint: "spaghetti" }).doctorSymptom });
    expect(samePath.defectId).toBe("spaghetti");
    expect(samePath.cameraGuide?.id).toBe(spaghetti?.cameraGuide?.id);
  });

  it("posts the doctor symptom so pause/slow stay on the existing path", async () => {
    const replay = replayFailurePhoto({ filename: "spaghetti.jpg" });
    const refused = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ complaint: replay.doctorSymptom }),
      }),
    );
    const body = (await refused.json()) as {
      diagnosis?: { defectId: string; cameraGuide?: { id: string } };
    };
    expect(body.diagnosis?.defectId).toBe("spaghetti");
    expect(body.diagnosis?.cameraGuide?.id).toBe("spaghetti");
  });
});

describe("failure-photo stays on Print Control", () => {
  it("does not import CAD fit-wizard, reshape generate, etch, or lattice", () => {
    expect(failurePhotoOwnsPrintControlOnly()).toBe(true);
    const src = readFileSync(join(process.cwd(), "lib/machine/failure-photo.ts"), "utf8");
    const imports = src
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(imports).not.toMatch(
      /fits|fit-wizard|fitWizard|cad-reshape|lattice|openscad|assembly|etch|ollama|plate-pack|project-pack/i,
    );
    expect(src).toMatch(/later classifier|no pixel|not invent/i);
  });
});
