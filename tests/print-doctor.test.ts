import { describe, expect, it } from "vitest";
import {
  diagnosePrintComplaint,
  extractAmsSlot,
  inferMaterial,
  looksLikeDoctorFeedback,
  looksLikeMaterialPresetRequest,
  looksLikePrintDoctorComplaint,
} from "@/lib/print-doctor";

describe("print-doctor NLP stub", () => {
  it("does not steal ordinary CAD describe prompts", () => {
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);
    expect(looksLikePrintDoctorComplaint("phone stand for iPhone 15, 60 degree tilt")).toBe(false);
    expect(looksLikePrintDoctorComplaint("parametric drawer knob diameter 40mm")).toBe(false);
    expect(looksLikePrintDoctorComplaint("reshape this cube to 20mm")).toBe(false);
    expect(looksLikePrintDoctorComplaint("a PETG phone stand")).toBe(false);
    expect(looksLikeMaterialPresetRequest("a PETG phone stand")).toBe(false);
    expect(looksLikeDoctorFeedback("a perfect cube")).toBeUndefined();
    expect(looksLikePrintDoctorComplaint("perfect")).toBe(false);
    expect(looksLikePrintDoctorComplaint("pause the hinge clearance")).toBe(false);
    expect(looksLikePrintDoctorComplaint("continue the fillet on the lid")).toBe(false);
    expect(looksLikePrintDoctorComplaint("slow the taper to 20mm")).toBe(false);
  });

  it("switches to PETG or PA auto-best tables from chat", () => {
    expect(looksLikeMaterialPresetRequest("use PETG settings")).toBe(true);
    expect(looksLikePrintDoctorComplaint("use PETG settings")).toBe(true);
    const petg = diagnosePrintComplaint({ complaint: "use PETG settings", material: "pla" });
    expect(petg.defectId).toBe("material-preset");
    expect(petg.material).toBe("petg");
    expect(petg.appliedPreset).toBe(true);
    expect(petg.diagnosis).toMatch(/PETG/i);
    expect(petg.fixes.some((fix) => fix.key === "material" && fix.value === "petg")).toBe(true);
    expect(petg.physicalSteps.join(" ")).toMatch(/not pushed|not sent/i);

    expect(looksLikeMaterialPresetRequest("best for PA")).toBe(true);
    const pa = diagnosePrintComplaint({ complaint: "best for nylon" });
    expect(pa.defectId).toBe("material-preset");
    expect(pa.material).toBe("pa");
    expect(pa.fixes.some((fix) => fix.key === "material" && fix.value === "pa")).toBe(true);
  });

  it("keeps the session material when a defect does not name one", () => {
    const result = diagnosePrintComplaint({ complaint: "stringing", material: "pa" });
    expect(result.material).toBe("pa");
    expect(result.defectId).toBe("stringing");
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
    expect(result.amsGuide?.id).toBe("ams-feed-loop");
    expect(result.fixes[0]?.id).toBe("ams-feed-loop");
    expect(result.physicalSteps.length).toBeGreaterThanOrEqual(4);
    expect(result.physicalSteps.join(" ")).toMatch(/AMS 2/);
  });

  it("diagnoses AMS load failed, empty spool, tangle, PTFE, and wet PA", () => {
    const load = diagnosePrintComplaint({ complaint: "AMS 3 can't load" });
    expect(load.defectId).toBe("ams-load-failed");
    expect(load.amsSlot).toBe(3);
    expect(load.physicalSteps.join(" ")).toMatch(/AMS 3/);

    const empty = diagnosePrintComplaint({ complaint: "filament ran out on AMS 1" });
    expect(empty.defectId).toBe("ams-spool-empty");
    expect(empty.amsGuide?.steps.join(" ")).toMatch(/AMS 1/);

    const tangle = diagnosePrintComplaint({ complaint: "tangled spool on AMS 4" });
    expect(tangle.defectId).toBe("ams-tangled-spool");

    const ptfe = diagnosePrintComplaint({ complaint: "PTFE path check AMS 2" });
    expect(ptfe.defectId).toBe("ams-ptfe-path");

    const wet = diagnosePrintComplaint({ complaint: "PA needs drying in the AMS" });
    expect(wet.defectId).toBe("ams-wet-pa");
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

  it("routes explicit mid-print phrases without treating CAD pause language as a defect", () => {
    expect(looksLikePrintDoctorComplaint("pause now")).toBe(true);
    expect(looksLikePrintDoctorComplaint("slow to 50%")).toBe(true);
    const pause = diagnosePrintComplaint({ complaint: "pause the print" });
    expect(pause.defectId).toBe("mid-print-control");
    expect(pause.diagnosis).toMatch(/pause/i);
    expect(pause.fixes.some((fix) => fix.key === "pause")).toBe(true);
  });

  it("returns a low-confidence fallback when the complaint is vague", () => {
    const result = diagnosePrintComplaint({ complaint: "the print looks weird" });
    expect(result.defectId).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.fixes[0]?.kind).toBe("physical");
  });
});
