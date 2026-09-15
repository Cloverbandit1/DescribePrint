/**
 * Articulated-joint clearances for the describe → OpenSCAD path.
 *
 * Defaults are for the V0 Bambu Lab P2S stub (0.4 mm nozzle, FDM PLA-class).
 * Radial values are per-side: bore_d = pin_d + 2 × radial_mm.
 *
 * Hinge and pin emit real OpenSCAD. Ball and snap are honest stubs:
 * plan + documented gaps only — not a full gimbal / living-hinge library.
 */
import { defaultPrinter, type PrinterProfile } from "./printers";

/** Matches printRules().clearanceMm — general press/snap per-side gap. */
export const GENERAL_FIT_MM = 0.3;

export const JOINT_TYPES = ["hinge", "pin", "ball", "snap"] as const;
export type JointType = (typeof JOINT_TYPES)[number];

export const CLEARANCE_INTENTS = ["print-in-place", "multi-part"] as const;
export type ClearanceIntent = (typeof CLEARANCE_INTENTS)[number];

export type JointClearance = {
  type: JointType;
  intent: ClearanceIntent;
  /** Per-side gap pin-to-bore (mm). */
  radialMm: number;
  /** bore_d − pin_d (mm). */
  diameterDeltaMm: number;
  /** End-play along the joint axis (mm). */
  axialMm: number;
  /** Smallest recommended pin / knuckle shaft (mm). */
  minPinMm: number;
  /** Hinge/pin are real CSG. Ball/snap are clearance stubs. */
  implemented: boolean;
  notes: string;
};

export type CadJoint = {
  type: JointType;
  intent: ClearanceIntent;
  radial_mm: number;
  axial_mm: number;
  notes?: string;
};

const MOTION =
  /\b(hinge|hinged|knuckle|pintle|pivot|pivoting|pin joint|pinned|axle|clevis|ball[-\s]?joint|socket joint|snap(?:\s|-)?(?:fit|joint|hook|clip)?|living hinge|print[-\s]?in[-\s]?place|\bpip\b|articulat(?:e|ed|ion)|moving(?:\s+parts?|\s+assembl(?:y|ies))?|rotat(?:e|ing|ion)|swivel)\b/i;

const PRINT_IN_PLACE = /\b(print[-\s]?in[-\s]?place|\bpip\b|captured pin|as[-\s]?printed)\b/i;

const MULTI_PART_JOINT =
  /\b(separate parts|print separately|two pieces|three pieces|removable|multi[-\s]?part|kit of|loose parts|mating parts|hand[-\s]?assembl)\b/i;

const TYPE_PATTERNS: Array<{ type: JointType; re: RegExp }> = [
  { type: "hinge", re: /\b(hinge|hinged|knuckle|pintle|living hinge)\b/i },
  { type: "pin", re: /\b(pin joint|pinned|clevis|axle|pintle)\b/i },
  { type: "ball", re: /\b(ball[-\s]?joint|socket joint|ball[-\s]?and[-\s]?socket)\b/i },
  { type: "snap", re: /\b(snap(?:\s|-)?(?:fit|joint|hook|clip)?)\b/i },
];

export function isJointType(value: string | undefined | null): value is JointType {
  return Boolean(value && (JOINT_TYPES as readonly string[]).includes(value));
}

export function isClearanceIntent(value: string | undefined | null): value is ClearanceIntent {
  return Boolean(value && (CLEARANCE_INTENTS as readonly string[]).includes(value));
}

export function wantsMotion(prompt: string): boolean {
  return MOTION.test(prompt);
}

export function inferJointType(prompt: string): JointType | null {
  for (const { type, re } of TYPE_PATTERNS) {
    if (re.test(prompt)) return type;
  }
  if (wantsMotion(prompt)) return "hinge";
  return null;
}

/**
 * Print-in-place is preferred whenever the user asks for motion and does not
 * clearly demand a removable / multi-part kit.
 */
export function inferClearanceIntent(prompt: string): ClearanceIntent | null {
  const motion = wantsMotion(prompt);
  const multi = MULTI_PART_JOINT.test(prompt);
  if (!motion && !multi) return null;
  if (PRINT_IN_PLACE.test(prompt)) return "print-in-place";
  if (multi) return "multi-part";
  if (motion) return "print-in-place";
  return "multi-part";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * P2S / 0.4 mm nozzle defaults (FDM):
 * - General fits stay 0.3 mm/side in printRules.
 * - Print-in-place pin/hinge: 0.4 mm radial (typical 0.3–0.5), 0.5 mm axial.
 * - Removable / multi-part: 0.5 mm radial, 0.6 mm axial (hand assembly).
 * - Snap: 0.3 mm/side (existing press/snap band). Stub geometry.
 * - Ball: 0.5 mm PIP / 0.6 mm removable. Stub socket, not a 3-axis gimbal.
 */
export function jointClearance(
  type: JointType,
  intent: ClearanceIntent,
  printer: PrinterProfile = defaultPrinter(),
): JointClearance {
  const nozzle = printer.nozzleMm;
  const fit = GENERAL_FIT_MM;
  const pipRadial = round2(clamp(nozzle, 0.3, 0.5));
  const removableRadial = round2(clamp(nozzle + 0.1, 0.5, 0.6));
  const pipAxial = 0.5;
  const removableAxial = 0.6;
  const minPinMm = round2(Math.max(4, nozzle * 10));
  const implemented = type === "hinge" || type === "pin";

  if (type === "snap") {
    const radialMm = fit;
    return {
      type,
      intent,
      radialMm,
      diameterDeltaMm: round2(radialMm * 2),
      axialMm: intent === "print-in-place" ? pipAxial : removableAxial,
      minPinMm,
      implemented: false,
      notes:
        "Stub: cantilever / clip with this per-side gap. Not a living-hinge or multi-tooth snap library.",
    };
  }

  if (type === "ball") {
    const radialMm = intent === "print-in-place" ? 0.5 : 0.6;
    return {
      type,
      intent,
      radialMm,
      diameterDeltaMm: round2(radialMm * 2),
      axialMm: radialMm,
      minPinMm,
      implemented: false,
      notes:
        "Stub: sphere in a socket with this radial gap. Not a captured 3-axis gimbal or spring retainer.",
    };
  }

  const radialMm = intent === "print-in-place" ? pipRadial : removableRadial;
  const axialMm = intent === "print-in-place" ? pipAxial : removableAxial;
  return {
    type,
    intent,
    radialMm,
    diameterDeltaMm: round2(radialMm * 2),
    axialMm,
    minPinMm,
    implemented: true,
    notes:
      type === "hinge"
        ? "Knuckle hinge: bore = pin + 2×radial; axial gaps between knuckles. Do not union the pin or lid."
        : "Captured pin: bore = pin + 2×radial; axial play at the heads. Pin may fuse to the rotor only.",
  };
}

export function defaultJointClearances(
  printer: PrinterProfile = defaultPrinter(),
): JointClearance[] {
  const out: JointClearance[] = [];
  for (const type of JOINT_TYPES) {
    for (const intent of CLEARANCE_INTENTS) {
      out.push(jointClearance(type, intent, printer));
    }
  }
  return out;
}

export function cadJointFromClearance(spec: JointClearance): CadJoint {
  return {
    type: spec.type,
    intent: spec.intent,
    radial_mm: spec.radialMm,
    axial_mm: spec.axialMm,
    notes: spec.notes,
  };
}

export function parseJointType(value: unknown): JointType | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isJointType(key)) return key;
  if (key.includes("hinge") || key.includes("knuckle")) return "hinge";
  if (key.includes("ball") || key.includes("socket")) return "ball";
  if (key.includes("snap") || key.includes("clip")) return "snap";
  if (key.includes("pin") || key.includes("axle") || key.includes("clevis")) return "pin";
  return undefined;
}

export function parseClearanceIntent(value: unknown): ClearanceIntent | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isClearanceIntent(key)) return key;
  if (key.includes("print-in-place") || key === "pip" || key.includes("as-printed")) {
    return "print-in-place";
  }
  if (key.includes("multi") || key.includes("removable") || key.includes("separate")) {
    return "multi-part";
  }
  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseCadJoints(raw: unknown): CadJoint[] {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const rec = item as Record<string, unknown>;
    const type = parseJointType(rec.type ?? rec.kind ?? rec.joint);
    if (!type) return [];
    const intent = parseClearanceIntent(rec.intent ?? rec.clearance_intent ?? rec.fit) ?? "print-in-place";
    const defaults = jointClearance(type, intent);
    const radial = asFiniteNumber(rec.radial_mm) ?? asFiniteNumber(rec.clearance_mm) ?? defaults.radialMm;
    const axial = asFiniteNumber(rec.axial_mm) ?? defaults.axialMm;
    return [
      {
        type,
        intent,
        radial_mm: radial > 0 ? radial : defaults.radialMm,
        axial_mm: axial > 0 ? axial : defaults.axialMm,
        notes: asString(rec.notes),
      },
    ];
  });
}

export function normalizeCadJoints(
  joints: CadJoint[],
  prompt: string,
): { joints: CadJoint[]; clearance_intent?: ClearanceIntent } {
  const intent = inferClearanceIntent(prompt);
  if (!intent) {
    return { joints: [] };
  }

  const typed = joints.length
    ? joints
    : [cadJointFromClearance(jointClearance(inferJointType(prompt) ?? "hinge", intent))];

  return {
    clearance_intent: intent,
    joints: typed.map((joint) => {
      const defaults = jointClearance(joint.type, intent);
      const sameIntent = joint.intent === intent;
      const radial = sameIntent && joint.radial_mm > 0 ? joint.radial_mm : defaults.radialMm;
      const axial = sameIntent && joint.axial_mm > 0 ? joint.axial_mm : defaults.axialMm;
      return {
        type: joint.type,
        intent,
        radial_mm: radial,
        axial_mm: axial,
        notes: joint.notes ?? defaults.notes,
      };
    }),
  };
}

export function hasPrintInPlaceJoints(
  plan:
    | {
        joints?: CadJoint[];
        clearance_intent?: ClearanceIntent;
      }
    | null
    | undefined,
): boolean {
  if (!plan) return false;
  if (plan.clearance_intent === "print-in-place") return true;
  return Boolean(plan.joints?.some((joint) => joint.intent === "print-in-place"));
}

export function formatJointConstraints(printer: PrinterProfile = defaultPrinter()): string {
  const hingePip = jointClearance("hinge", "print-in-place", printer);
  const hingeMulti = jointClearance("hinge", "multi-part", printer);
  const pinPip = jointClearance("pin", "print-in-place", printer);
  const snap = jointClearance("snap", "print-in-place", printer);
  const ball = jointClearance("ball", "print-in-place", printer);
  return [
    `Joints (only when the user asks for motion / a moving assembly — otherwise one fused solid):`,
    `- Prefer print-in-place. Hinge/pin radial ${hingePip.radialMm} mm/side (bore = pin + ${hingePip.diameterDeltaMm} mm), axial ${hingePip.axialMm} mm, min pin ${hingePip.minPinMm} mm. Removable kits use ${hingeMulti.radialMm} mm radial / ${hingeMulti.axialMm} mm axial.`,
    `- Pin joints use the same numbers (${pinPip.radialMm} / ${pinPip.axialMm} mm). Snap stub ${snap.radialMm} mm/side. Ball stub ${ball.radialMm} mm radial.`,
    `- Print-in-place MUST be separate solids with those gaps — do not union the pin, lid, or rotor into a fused blob.`,
    `- Ball and snap are stubs: simplified socket or cantilever with the documented gap, not a full mechanism library.`,
  ].join("\n");
}

export function formatClearanceTableMarkdown(printer: PrinterProfile = defaultPrinter()): string {
  const rows = defaultJointClearances(printer).map((spec) => {
    const impl = spec.implemented ? "real OpenSCAD" : "honest stub";
    return `| ${spec.type} | ${spec.intent} | ${spec.radialMm.toFixed(2)} | ${spec.diameterDeltaMm.toFixed(2)} | ${spec.axialMm.toFixed(2)} | ${spec.minPinMm.toFixed(1)} | ${impl} |`;
  });
  return [
    `| Joint | Intent | Radial mm/side | Diameter Δ mm | Axial mm | Min pin mm | Status |`,
    `| --- | --- | ---: | ---: | ---: | ---: | --- |`,
    ...rows,
  ].join("\n");
}

function scadHeader(title: string, spec: JointClearance): string {
  return `// Fixture: ${title} (mm)
// Target: ${defaultPrinter().name}, ${defaultPrinter().nozzleMm} mm nozzle
// ${spec.type} / ${spec.intent}
// radial_mm = ${spec.radialMm}  (bore_d = pin_d + ${spec.diameterDeltaMm})
// axial_mm = ${spec.axialMm}   min_pin_mm = ${spec.minPinMm}
`;
}

/**
 * Print-in-place knuckle hinge: box body + lid + captured pin.
 * Three separate solids. Axis along X; knuckles rest on z=0. Lid prints open on −Y.
 */
export function hingeFixtureScad(spec: JointClearance = jointClearance("hinge", "print-in-place")): string {
  const radial = spec.radialMm;
  const axial = spec.axialMm;
  const pin = spec.minPinMm;
  const bore = pin + spec.diameterDeltaMm;
  const knuckleOd = Math.max(8, pin * 2);
  const axisZ = knuckleOd / 2;
  const boxW = 40;
  const boxD = 28;
  const boxH = 14;
  const wall = 2;
  const lidT = 2.4;
  const knuckle = 6;
  const pinR = pin / 2;
  // Lid stops pin_r + radial short of y=0 so it does not fuse to the pin.
  const lidY1 = -(pinR + radial);
  const lidY0 = lidY1 - boxD;
  const group = axial + knuckle + axial + knuckle + axial + knuckle + axial;
  const x0 = (boxW - group) / 2;
  const xA1 = x0 + axial;
  const xB = xA1 + knuckle + axial;
  const xA2 = xB + knuckle + axial;
  const span = group;

  return `${scadHeader("print-in-place hinged box lid", spec)}$fn = 48;
radial_mm = ${radial};
axial_mm = ${axial};
pin_d = ${pin};
bore_d = ${bore};
knuckle_od = ${knuckleOd};
knuckle_len = ${knuckle};
axis_y = 0;
axis_z = ${axisZ};
box_w = ${boxW};
box_d = ${boxD};
box_h = ${boxH};
wall = ${wall};
lid_t = ${lidT};
lid_y0 = ${lidY0};

module knuckle(x0) {
  translate([x0, axis_y, axis_z])
    rotate([0, 90, 0])
      cylinder(h = knuckle_len, d = knuckle_od);
}

module bore_cut(x0) {
  translate([x0 - 0.4, axis_y, axis_z])
    rotate([0, 90, 0])
      cylinder(h = knuckle_len + 0.8, d = bore_d);
}

module box_body() {
  difference() {
    union() {
      difference() {
        cube([box_w, box_d, box_h]);
        translate([wall, wall, wall])
          cube([box_w - wall * 2, box_d - wall * 2, box_h]);
      }
      knuckle(${xA1});
      knuckle(${xA2});
    }
    bore_cut(${xA1});
    bore_cut(${xA2});
  }
}

module lid() {
  difference() {
    union() {
      translate([0, lid_y0, 0])
        cube([box_w, box_d, lid_t]);
      knuckle(${xB});
    }
    bore_cut(${xB});
  }
}

module hinge_pin() {
  head_d = pin_d + 2.4;
  head_h = 1.6;
  translate([${x0} - head_h, axis_y, axis_z])
    rotate([0, 90, 0]) {
      cylinder(h = head_h, d = head_d);
      translate([0, 0, head_h])
        cylinder(h = ${span}, d = pin_d);
      translate([0, 0, head_h + ${span}])
        cylinder(h = head_h, d = head_d);
    }
}

// Separate solids — do not union. Print-in-place clearances are the gaps.
box_body();
lid();
hinge_pin();
`;
}

/**
 * Print-in-place pin joint: stator (base + two cheeks) + rotor fused to a captured pin.
 */
export function pinFixtureScad(spec: JointClearance = jointClearance("pin", "print-in-place")): string {
  const radial = spec.radialMm;
  const axial = spec.axialMm;
  const pin = spec.minPinMm;
  const bore = pin + spec.diameterDeltaMm;
  const cheekT = 4;
  const rotorT = 6;
  const rotorOd = 12;
  const axisZ = rotorOd / 2;
  const cheekW = 16;
  const baseT = 3;
  const cheek1Y = axial;
  const rotorY = cheek1Y + cheekT + radial;
  const cheek2Y = rotorY + rotorT + radial;
  const span = cheek2Y + cheekT + axial;
  const baseY = span;
  const leverL = 18;

  return `${scadHeader("print-in-place pin joint", spec)}$fn = 48;
radial_mm = ${radial};
axial_mm = ${axial};
pin_d = ${pin};
bore_d = ${bore};
cheek_t = ${cheekT};
rotor_t = ${rotorT};
rotor_od = ${rotorOd};
axis_x = 10;
axis_z = ${axisZ};
cheek_w = ${cheekW};
base_t = ${baseT};
lever_l = ${leverL};

module cheek(y0) {
  translate([2, y0, 0])
    cube([cheek_w, cheek_t, rotor_od]);
}

module stator() {
  difference() {
    union() {
      cube([20, ${baseY}, base_t]);
      cheek(${cheek1Y});
      cheek(${cheek2Y});
    }
    translate([axis_x, -1, axis_z])
      rotate([-90, 0, 0])
        cylinder(h = ${baseY} + 2, d = bore_d);
  }
}

module rotor_and_pin() {
  head_d = pin_d + 2.4;
  head_h = 1.6;
  union() {
    translate([axis_x, -head_h, axis_z])
      rotate([-90, 0, 0]) {
        cylinder(h = head_h, d = head_d);
        translate([0, 0, head_h])
          cylinder(h = ${span}, d = pin_d);
        translate([0, 0, head_h + ${span}])
          cylinder(h = head_h, d = head_d);
      }
    translate([axis_x, ${rotorY}, axis_z])
      rotate([-90, 0, 0])
        cylinder(h = rotor_t, d = rotor_od);
    translate([axis_x, ${rotorY}, 0])
      cube([lever_l, rotor_t, base_t]);
  }
}

// Separate solids — pin is fused to the rotor only, not the cheeks.
stator();
rotor_and_pin();
`;
}

export const HINGE_FIXTURE_PROMPT = "hinged box lid print-in-place";
export const PIN_FIXTURE_PROMPT = "print-in-place pin joint";

export function isHingeFixturePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    (text.includes("hinge") || text.includes("hinged")) &&
    (text.includes("lid") || text.includes("box") || text.includes("print-in-place") || text.includes("print in place"))
  );
}

export function isPinFixturePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    (text.includes("pin joint") || (text.includes("pin") && text.includes("joint"))) &&
    (text.includes("print-in-place") || text.includes("print in place") || text.includes("captured"))
  );
}
