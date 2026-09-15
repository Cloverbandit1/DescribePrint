import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  applyChatAmsSlotAssignment,
  buildAmsSlotPlan,
  parseAmsSlotPlan,
  reassignAmsSlot,
} from "@/lib/machine/ams";
import { buildProjectPack, PROJECT_PACK_FILES } from "@/lib/machine/project-pack";
import { printPresetSummary } from "@/lib/printers";
import { diagnosePrintComplaint, looksLikeAmsSlotPlanRequest, looksLikePrintDoctorComplaint } from "@/lib/print-doctor";
import { makeAxisAlignedBoxMesh } from "@/lib/stl";
import { meshesTo3mf, parse3mfDocument, stampAmsSlotPlan } from "@/lib/threemf";

describe("AMS slot plan (disconnected / live)", () => {
  it("uses the selected material on slot 0 when disconnected and omits the rest", () => {
    const plan = buildAmsSlotPlan({ material: "petg", connected: false });
    expect(plan.slots).toEqual([{ index: 0, material: "petg", source: "preset" }]);
    expect(plan.slots.map((slot) => slot.index)).not.toContain(1);
    expect(plan.slots.map((slot) => slot.index)).not.toContain(2);
    expect(plan.slots.map((slot) => slot.index)).not.toContain(3);
  });

  it("matches two injected live AMS slots when connected", () => {
    const plan = buildAmsSlotPlan({
      material: "pla",
      connected: true,
      liveSlots: [
        { unit: 1, slot: 1, present: true, filamentType: "pla", colorHex: "#1A1A1A" },
        { unit: 1, slot: 2, present: true, filamentType: "petg", colorHex: "#2F6FED" },
        { unit: 1, slot: 3, present: false },
        { unit: 1, slot: 4, present: false },
      ],
    });
    expect(plan.slots).toEqual([
      { index: 0, material: "pla", color: "#1a1a1a", source: "live" },
      { index: 1, material: "petg", color: "#2f6fed", source: "live" },
    ]);
  });

  it("maps declared extra filaments onto live trays and omits unmapped", () => {
    const plan = buildAmsSlotPlan({
      material: "pla",
      connected: true,
      design: [
        { id: "body", type: "pla", colorHex: "#1A1A1A" },
        { id: "accent", type: "tpu" },
      ],
      liveSlots: [
        { unit: 1, slot: 1, present: true, filamentType: "pla", colorHex: "#1A1A1A" },
        { unit: 1, slot: 2, present: true, filamentType: "petg", colorHex: "#2F6FED" },
      ],
    });
    expect(plan.slots).toEqual([{ index: 0, material: "pla", color: "#1a1a1a", source: "live", designId: "body" }]);
  });

  it("assigns extra declared filaments on disconnected mock without inventing trays", () => {
    const plan = buildAmsSlotPlan({
      material: "pla",
      design: [
        { id: "body", type: "pla", colorHex: "#FF0000", name: "body" },
        { id: "accent", type: "pla", colorHex: "#1A1A1A", name: "accent" },
      ],
    });
    expect(plan.slots).toHaveLength(2);
    expect(plan.slots[0]).toMatchObject({ index: 0, material: "pla", source: "preset", designId: "body" });
    expect(plan.slots[1]).toMatchObject({ index: 1, material: "pla", source: "preset", designId: "accent" });
  });
});

describe("AMS slot plan in 3MF metadata", () => {
  it("writes tray mapping metadata and a sidecar without breaking a single-filament zip", async () => {
    const preset = printPresetSummary("petg");
    const bytes = await meshesTo3mf(
      [{ name: "part", mesh: makeAxisAlignedBoxMesh([10, 10, 8]), colorHex: "#C4C4C8", filament: "petg", extruder: 1 }],
      "DescribePrint",
      preset,
    );

    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
    const zip = await JSZip.loadAsync(bytes);
    const model = await zip.file("3D/3dmodel.model")?.async("string");
    expect(model).toContain('<metadata name="DescribePrint:ams_tray_0">petg</metadata>');
    expect(model).toContain('<metadata name="DescribePrint:ams_plan">');
    expect(model).toMatch(/ams_plan">\{.*index.*0/);
    expect(model).not.toContain("DescribePrint:ams_tray_1");

    const sidecar = JSON.parse((await zip.file("Metadata/ams_slot_plan.json")?.async("string")) ?? "{}") as {
      slots?: Array<{ index: number; material: string }>;
    };
    expect(sidecar.slots).toEqual([{ index: 0, material: "petg", source: "preset" }]);

    const parsed = await parse3mfDocument(bytes);
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.amsSlotPlan?.slots).toEqual([{ index: 0, material: "petg", source: "preset" }]);
  });

  it("stamps a live tray mapping into an existing single-filament 3MF", async () => {
    const bytes = await meshesTo3mf(
      [{ name: "part", mesh: makeAxisAlignedBoxMesh([8, 8, 8]), colorHex: "#C4C4C8", filament: "pla", extruder: 1 }],
      "DescribePrint",
      printPresetSummary("pla"),
    );
    const live = buildAmsSlotPlan({
      material: "pla",
      connected: true,
      liveSlots: [
        { unit: 1, slot: 1, present: true, filamentType: "pla", colorHex: "#1A1A1A" },
        { unit: 1, slot: 2, present: true, filamentType: "petg", colorHex: "#2F6FED" },
      ],
    });
    const stamped = await stampAmsSlotPlan(bytes, live);
    const parsed = await parse3mfDocument(stamped);
    expect(parsed.amsSlotPlan?.slots).toEqual(live.slots);
    expect(parsed.objects).toHaveLength(1);
  });
});

describe("AMS slot plan helpers", () => {
  it("reassigns trays as manual and parses sidecar JSON", () => {
    const start = buildAmsSlotPlan({
      material: "pla",
      design: [
        { id: "body", type: "pla", colorHex: "#FF0000" },
        { id: "accent", type: "pla", colorHex: "#1A1A1A" },
      ],
    });
    const moved = reassignAmsSlot(start, 1, 2);
    expect(moved.slots.find((slot) => slot.designId === "accent")).toMatchObject({
      index: 2,
      source: "manual",
    });
    expect(parseAmsSlotPlan(JSON.stringify(moved))?.slots).toEqual(moved.slots);

    const fromChat = applyChatAmsSlotAssignment(start, { index: 1, role: "accent" });
    expect(fromChat.slots.find((slot) => slot.designId === "accent")?.index).toBe(1);
  });
});

describe("project pack AMS sidecar", () => {
  it("includes ams_slot_plan.json next to the 3MF", async () => {
    const preset = printPresetSummary("pla");
    const threemf = await meshesTo3mf(
      [{ name: "cube", mesh: makeAxisAlignedBoxMesh([20, 20, 20]), colorHex: "#C4C4C8", filament: "pla", extruder: 1 }],
      "DescribePrint",
      preset,
    );
    const pack = await buildProjectPack({ threemf, printPreset: preset });
    const zip = await JSZip.loadAsync(pack);
    expect(zip.file(PROJECT_PACK_FILES.amsPlan)).toBeTruthy();
    const plan = JSON.parse((await zip.file(PROJECT_PACK_FILES.amsPlan)!.async("string")) ?? "{}") as {
      slots?: Array<{ index: number; material: string }>;
    };
    expect(plan.slots?.[0]).toMatchObject({ index: 0, material: "pla" });
  });
});

describe("print doctor AMS slot plan phrase", () => {
  it("routes use AMS 2 for accent without stealing CAD prompts", () => {
    expect(looksLikeAmsSlotPlanRequest("use AMS 2 for accent")).toBe(true);
    expect(looksLikePrintDoctorComplaint("use AMS 2 for accent")).toBe(true);
    expect(looksLikePrintDoctorComplaint("20mm cube with 5mm hole")).toBe(false);

    const result = diagnosePrintComplaint({ complaint: "use AMS 2 for accent", material: "pla" });
    expect(result.defectId).toBe("ams-slot-assign");
    expect(result.appliedSlotPlan).toBe(true);
    expect(result.amsSlot).toBe(2);
    expect(result.slotPlanAssignment).toEqual({ index: 1, role: "accent" });
    expect(result.diagnosis).toMatch(/AMS 2/);
    expect(result.physicalSteps.join(" ")).toMatch(/not send|not a LAN/i);
  });
});
