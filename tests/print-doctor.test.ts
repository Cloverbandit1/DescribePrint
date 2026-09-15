import { describe, expect, it } from "vitest";
import {
  diagnosePrintComplaint,
  extractAmsSlot,
  inferMaterial,
  looksLikePrintDoctorComplaint,
} from "@/lib/print-doctor";

describe("print-doctor NLP stub", () => {
  it("does not steal ordinary CAD describe prompts", () => {
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);
    expect(looksLikePrintDoctorComplaint("phone stand for iPhone 15, 60 degree tilt")).toBe(false);
    expect(looksLikePrintDoctorComplaint("parametric drawer knob diameter 40mm")).toBe(false);
    expect(looksLikePrintDoctorComplaint("reshape this cube to 20mm")).toBe(false);
  });

  it("diagnoses PETG stringing with a cooler P2S setting", () => {
    const complaint = "stringing with PETG";
    expect(looksLikePrintDoctorComplaint(complaint)).toBe(true);
    expect(inferMaterial(complaint)).toBe("petg");

    const result = diagnosePrintComplaint({ complaint });
    expect(result.printerId).toBe("bambu-lab-p2s");
    expect(result.defectId).toBe("stringing");
    expect(result.material).toBe("petg");
    expect(result.confidence).toBe("high");
    expect(result.diagnosis).toMatch(/PETG/i);
    const nozzle = result.fixes.find((fix) => fix.key === "nozzleC");
    expect(nozzle?.kind).toBe("setting");
    expect(nozzle?.autoApplicable).toBe(true);
    expect(nozzle?.value).toBe(240);
    expect(result.physicalSteps.some((step) => /dry/i.test(step))).toBe(true);
  });

  it("diagnoses an AMS 2 feed/unfeed loop as a physical fault", () => {
    const complaint = "AMS 2 keeps looping feed/unfeed";
    expect(looksLikePrintDoctorComplaint(complaint)).toBe(true);
    expect(extractAmsSlot(complaint)).toBe(2);

    const result = diagnosePrintComplaint({ complaint });
    expect(result.defectId).toBe("ams-feed-loop");
    expect(result.amsSlot).toBe(2);
    expect(result.diagnosis).toMatch(/AMS 2/);
    expect(result.fixes.some((fix) => fix.kind === "physical" && !fix.autoApplicable)).toBe(true);
    expect(result.physicalSteps.join(" ")).toMatch(/PTFE|spool|tip/i);
  });

  it("stays printer-aware for ABS warp on a P2S without chamber heat", () => {
    const result = diagnosePrintComplaint({ complaint: "corners lifting and warping", material: "abs" });
    expect(result.defectId).toBe("warping");
    expect(result.material).toBe("abs");
    expect(result.diagnosis).toMatch(/chamber/i);
    const bed = result.fixes.find((fix) => fix.key === "bedC");
    expect(bed?.value).toBe(95);
  });

  it("routes emergency remaining-layer reshape phrases to the doctor", () => {
    expect(looksLikePrintDoctorComplaint("reshape the rest")).toBe(true);
    const result = diagnosePrintComplaint({ complaint: "emergency reshape remaining layers" });
    expect(result.defectId).toBe("emergency-reshape");
    expect(result.diagnosis).toMatch(/Resume is manual|CAD Core/i);
  });

  it("returns a low-confidence fallback when the complaint is vague", () => {
    const result = diagnosePrintComplaint({ complaint: "the print looks weird" });
    expect(result.defectId).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.fixes[0]?.kind).toBe("physical");
  });
});
