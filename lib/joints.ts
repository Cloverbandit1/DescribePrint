/**
 * Articulated-joint clearances for the describe → OpenSCAD path.
 *
 * Defaults are for the V0 Bambu Lab P2S stub (0.4 mm nozzle, FDM PLA-class).
 * Radial values are per-side: bore_d = pin_d + 2 × radial_mm.
 *
 * Hinge, pin, ball, and snap emit real OpenSCAD. This is not a full gimbal /
 * living-hinge / multi-tooth snap library — each type has one printable fixture.
 */
import { defaultPrinter, type PrinterProfile } from "./printers";

/** Matches printRules().clearanceMm — general press/snap per-side gap. */
export const GENERAL_FIT_MM = 0.3;

/** Default ball diameter (mm). Larger than minPin so the neck can stay captive. */
export const BALL_DEFAULT_D_MM = 10;

/**
 * Cantilever deflection thickness (mm). Same band as printRules min wall
 * (4× 0.4 mm nozzle). Not a clearance-table change — the beam must flex
 * without printing as a knife-edge.
 */
export function snapBeamThicknessMm(printer: PrinterProfile = defaultPrinter()): number {
  return round2(Math.max(1.6, printer.nozzleMm * 4));
}

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
  /** Hinge, pin, ball, and snap emit real CSG fixtures. */
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
 * - Snap: 0.3 mm/side (existing press/snap band). Cantilever beam 1.6 mm
 *   (4× nozzle) — table radial/axial unchanged; thickness is printability.
 * - Ball: 0.5 mm PIP / 0.6 mm removable. Captive socket (neck < ball), not a 3-axis gimbal.
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
  const beamT = snapBeamThicknessMm(printer);

  if (type === "snap") {
    const radialMm = fit;
    return {
      type,
      intent,
      radialMm,
      diameterDeltaMm: round2(radialMm * 2),
      axialMm: intent === "print-in-place" ? pipAxial : removableAxial,
      minPinMm,
      implemented: true,
      notes:
        `Cantilever snap (annular bead+groove is the codegen alternate): ${beamT} mm beam, ${radialMm} mm/side gap. Flex in XY. Do not union hook and catch.`,
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
      implemented: true,
      notes:
        intent === "print-in-place"
          ? `Captive ball in socket: cavity = ball + 2×${radialMm} mm; neck < ball_d. Separate solids. Not a 3-axis gimbal.`
          : `Open cup + ball printed beside it: cavity = ball + 2×${radialMm} mm. Assemble after print.`,
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
    `- Pin joints use the same numbers (${pinPip.radialMm} / ${pinPip.axialMm} mm). Snap ${snap.radialMm} mm/side with a ${snapBeamThicknessMm(printer)} mm cantilever beam (flex in XY). Ball ${ball.radialMm} mm radial, captive neck < ball_d.`,
    `- Print-in-place MUST be separate solids with those gaps — do not union the pin, lid, rotor, ball, or snap hook into a fused blob.`,
    `- Ball: real CSG sphere + spherical socket (captive PIP default; open cup beside the ball when multi-part). Snap: real CSG cantilever hook + catch (or annular bead + groove). Not a full gimbal / living-hinge / multi-tooth library.`,
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

/**
 * Print-in-place ball joint: spherical socket + captive ball/stem.
 * Multi-part: open cup on the bed, ball printed beside it.
 */
export function ballFixtureScad(spec: JointClearance = jointClearance("ball", "print-in-place")): string {
  const radial = spec.radialMm;
  const axial = spec.axialMm;
  const ball = BALL_DEFAULT_D_MM;
  const cavity = ball + spec.diameterDeltaMm;
  const wall = 2.4;
  const stem = spec.minPinMm;
  const outer = cavity + wall * 2;
  const pip = spec.intent === "print-in-place";
  const neck = pip ? stem + spec.diameterDeltaMm : cavity;
  const socketW = 20;
  const socketD = 16;
  const socketH = wall + cavity + wall;
  const cx = socketW / 2;
  const cy = socketD / 2;
  const cz = wall + cavity / 2;
  const stemLen = socketD / 2 + 14;
  const parkX = socketW + 10;

  if (!pip) {
    const cupR = outer / 2;
    const axisZ = cupR;
    return `${scadHeader("multi-part ball joint", spec)}$fn = 48;
radial_mm = ${radial};
axial_mm = ${axial};
ball_d = ${ball};
cavity_d = ${cavity};
wall = ${wall};
stem_d = ${stem};
outer_d = ${outer};
axis_z = ${axisZ};
park_x = ${parkX};

module socket() {
  difference() {
    union() {
      cylinder(h = wall, d = outer_d + 6);
      translate([0, 0, axis_z])
        sphere(d = outer_d);
    }
    translate([0, 0, axis_z])
      sphere(d = cavity_d);
    translate([0, 0, axis_z])
      cylinder(h = outer_d, d = cavity_d);
    translate([-40, -40, -20])
      cube([80, 80, 20]);
  }
}

module ball_and_stem() {
  translate([park_x, 0, ball_d / 2]) {
    sphere(d = ball_d);
    rotate([-90, 0, 0])
      cylinder(h = ${stemLen}, d = stem_d);
  }
}

// Separate solids — ball is parked beside the open cup. Do not union.
socket();
ball_and_stem();
`;
  }

  return `${scadHeader("print-in-place ball joint", spec)}$fn = 48;
radial_mm = ${radial};
axial_mm = ${axial};
ball_d = ${ball};
cavity_d = ${cavity};
wall = ${wall};
stem_d = ${stem};
neck_d = ${neck};
socket_w = ${socketW};
socket_d = ${socketD};
socket_h = ${socketH};
cx = ${cx};
cy = ${cy};
cz = ${cz};

module socket() {
  difference() {
    union() {
      cube([socket_w, socket_d, socket_h]);
      translate([cx, cy, cz])
        rotate([-90, 0, 0])
          cylinder(h = socket_d / 2 + 6, d = neck_d + wall * 2);
    }
    translate([cx, cy, cz])
      sphere(d = cavity_d);
    translate([cx, cy - 1, cz])
      rotate([-90, 0, 0])
        cylinder(h = socket_d / 2 + 10, d = neck_d);
  }
}

module ball_and_stem() {
  translate([cx, cy, cz]) {
    sphere(d = ball_d);
    rotate([-90, 0, 0])
      cylinder(h = ${stemLen}, d = stem_d);
  }
}

// Separate solids — captive ball inside the socket. Do not union.
socket();
ball_and_stem();
`;
}

/**
 * Cantilever snap: catch plate with a window + hooked beam (flex in XY).
 * Print-in-place prints the head already through the window.
 * Multi-part parks the hook beside the catch; head overhang is smaller so it can snap through.
 */
export function snapFixtureScad(spec: JointClearance = jointClearance("snap", "print-in-place")): string {
  const radial = spec.radialMm;
  const axial = spec.axialMm;
  const beamT = snapBeamThicknessMm();
  const beamH = 8;
  const beamL = 20;
  const plateT = 3;
  const padL = 4;
  const pip = spec.intent === "print-in-place";
  const overhang = pip ? 1.6 : 0.8;
  const windowW = round2(beamT + radial * 2);
  const windowH = round2(beamH + radial * 2);
  const beamX = 4;
  const beamZ = 2;
  const plateY = 14;
  const headY = round2(plateY + plateT + axial);
  const headW = round2(beamT + overhang * 2);
  const headX = round2(beamX - overhang);
  const windowX = round2(beamX - radial);
  const windowZ = round2(beamZ - radial);
  const parkX = pip ? 0 : 22;
  const catchW = 14;
  const catchH = 12;

  return `${scadHeader(pip ? "print-in-place snap-fit clip" : "multi-part snap-fit clip", spec)}$fn = 48;
radial_mm = ${radial};
axial_mm = ${axial};
beam_t = ${beamT};
beam_h = ${beamH};
beam_l = ${beamL};
overhang = ${overhang};
window_w = ${windowW};
window_h = ${windowH};

module catch_body() {
  difference() {
    union() {
      translate([0, ${plateY}, 0])
        cube([${catchW}, ${plateT}, ${catchH}]);
      // Foot behind the head so it cannot fuse to the beam.
      translate([0, ${headY + 3 + radial}, 0])
        cube([${catchW}, 8, 2.4]);
    }
    translate([${windowX}, ${plateY - 0.4}, ${windowZ}])
      cube([window_w, ${plateT + 0.8}, window_h]);
  }
}

module snap_hook() {
  translate([${parkX}, 0, 0]) {
    translate([${beamX}, 0, 0])
      cube([beam_t, ${padL}, 2.4]);
    translate([${beamX}, 0, ${beamZ}])
      cube([beam_t, beam_l, beam_h]);
    translate([${headX}, ${headY}, ${beamZ}])
      cube([${headW}, 3, beam_h]);
  }
}

// Separate solids — do not union. Hook flexes in X (XY plane).
catch_body();
snap_hook();
`;
}

export const HINGE_FIXTURE_PROMPT = "hinged box lid print-in-place";
export const PIN_FIXTURE_PROMPT = "print-in-place pin joint";
export const BALL_FIXTURE_PROMPT = "print-in-place ball joint";
export const SNAP_FIXTURE_PROMPT = "snap-fit clip";

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

export function isBallFixturePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return (
    text.includes("ball joint") ||
    text.includes("ball-joint") ||
    text.includes("ball-and-socket") ||
    text.includes("ball and socket") ||
    text.includes("socket joint")
  );
}

export function isSnapFixturePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\bsnap(?:\s|-)?(?:fit|joint|hook|clip)\b/.test(text);
}

export function fixtureClearanceIntent(prompt: string): ClearanceIntent {
  return inferClearanceIntent(prompt) ?? "print-in-place";
}
