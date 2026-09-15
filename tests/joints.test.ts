import { describe, expect, it } from "vitest";
import {
  defaultJointClearances,
  formatClearanceTableMarkdown,
  formatJointConstraints,
  hasPrintInPlaceJoints,
  hingeFixtureScad,
  inferClearanceIntent,
  inferJointType,
  jointClearance,
  normalizeCadJoints,
  parseCadJoints,
  pinFixtureScad,
  wantsMotion,
} from "@/lib/joints";
import { defaultPrinter } from "@/lib/printers";

describe("joint clearances (P2S 0.4 mm nozzle)", () => {
  it("documents FDM print-in-place vs removable gaps from the printer nozzle", () => {
    const printer = defaultPrinter();
    expect(printer.nozzleMm).toBe(0.4);
    const hingePip = jointClearance("hinge", "print-in-place");
    const pinPip = jointClearance("pin", "print-in-place");
    const hingeKit = jointClearance("hinge", "multi-part");
    const snap = jointClearance("snap", "print-in-place");
    const ball = jointClearance("ball", "print-in-place");

    expect(hingePip.radialMm).toBe(0.4);
    expect(hingePip.diameterDeltaMm).toBe(0.8);
    expect(hingePip.axialMm).toBe(0.5);
    expect(hingePip.minPinMm).toBe(4);
    expect(hingePip.implemented).toBe(true);
    expect(pinPip.radialMm).toBe(hingePip.radialMm);
    expect(pinPip.axialMm).toBe(hingePip.axialMm);
    expect(pinPip.implemented).toBe(true);

    expect(hingeKit.radialMm).toBe(0.5);
    expect(hingeKit.axialMm).toBe(0.6);
    expect(hingeKit.radialMm).toBeGreaterThan(hingePip.radialMm);

    expect(snap.radialMm).toBe(0.3);
    expect(snap.implemented).toBe(false);
    expect(ball.radialMm).toBe(0.5);
    expect(ball.implemented).toBe(false);
    expect(defaultJointClearances()).toHaveLength(8);
  });

  it("only infers joints when the prompt asks for motion", () => {
    expect(wantsMotion("20mm cube with 5mm hole")).toBe(false);
    expect(wantsMotion("phone stand")).toBe(false);
    expect(inferClearanceIntent("a sturdy tray")).toBeNull();
    expect(inferJointType("parametric drawer knob")).toBeNull();

    expect(wantsMotion("hinged box lid print-in-place")).toBe(true);
    expect(inferJointType("hinged box lid print-in-place")).toBe("hinge");
    expect(inferClearanceIntent("hinged box lid print-in-place")).toBe("print-in-place");

    expect(inferJointType("print-in-place pin joint")).toBe("pin");
    expect(inferClearanceIntent("print-in-place pin joint")).toBe("print-in-place");
    expect(inferClearanceIntent("moving assembly")).toBe("print-in-place");
    expect(inferClearanceIntent("hinged box as two pieces")).toBe("multi-part");
    expect(inferJointType("ball joint")).toBe("ball");
    expect(inferJointType("snap fit clip")).toBe("snap");
  });

  it("parses and normalizes plan joints, stripping them when no motion is requested", () => {
    const parsed = parseCadJoints([
      { type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 },
    ]);
    expect(parsed).toEqual([
      expect.objectContaining({ type: "hinge", intent: "print-in-place", radial_mm: 0.4, axial_mm: 0.5 }),
    ]);

    expect(normalizeCadJoints(parsed, "a sturdy tray")).toEqual({ joints: [] });

    const hinged = normalizeCadJoints([], "hinged box lid print-in-place");
    expect(hinged.clearance_intent).toBe("print-in-place");
    expect(hinged.joints[0]).toMatchObject({ type: "hinge", intent: "print-in-place", radial_mm: 0.4 });

    const kit = normalizeCadJoints(parsed, "hinged lid as two pieces");
    expect(kit.clearance_intent).toBe("multi-part");
    expect(kit.joints[0]?.intent).toBe("multi-part");
    expect(kit.joints[0]?.radial_mm).toBe(0.5);

    expect(hasPrintInPlaceJoints({ joints: hinged.joints, clearance_intent: hinged.clearance_intent })).toBe(
      true,
    );
    expect(hasPrintInPlaceJoints({ joints: [], clearance_intent: undefined })).toBe(false);
  });

  it("embeds P2S joint numbers in prompt text and the markdown table", () => {
    expect(formatJointConstraints()).toMatch(/0\.4 mm\/side/);
    expect(formatJointConstraints()).toMatch(/print-in-place/);
    expect(formatJointConstraints()).toMatch(/do not union/i);
    expect(formatClearanceTableMarkdown()).toMatch(/\| hinge \| print-in-place \| 0\.40 \|/);
    expect(formatClearanceTableMarkdown()).toMatch(/\| pin \| print-in-place \| 0\.40 \|/);
  });

  it("emits hinge and pin fixtures with documented named clearances", () => {
    const hinge = hingeFixtureScad();
    expect(hinge).toMatch(/radial_mm = 0\.4/);
    expect(hinge).toMatch(/axial_mm = 0\.5/);
    expect(hinge).toMatch(/pin_d = 4/);
    expect(hinge).toMatch(/bore_d = 4\.8/);
    expect(hinge).toContain("module box_body()");
    expect(hinge).toContain("module lid()");
    expect(hinge).toContain("module hinge_pin()");
    expect(hinge).toMatch(/do not union/i);

    const pin = pinFixtureScad();
    expect(pin).toMatch(/radial_mm = 0\.4/);
    expect(pin).toMatch(/bore_d = 4\.8/);
    expect(pin).toContain("module stator()");
    expect(pin).toContain("module rotor_and_pin()");
  });
});
