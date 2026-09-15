import { toMillimeters } from "./units";
import type { Unit } from "./types";

export type FixtureMatch = {
  id: string;
  title: string;
  code: string;
};

const CUBE_WITH_HOLE = (size = 20, hole = 5) => `// Fixture: cube with through-hole (mm)
$fn = 64;
size = ${size};
hole_d = ${hole};

difference() {
  cube(size, center = false);
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
`;

const PHONE_STAND = (tilt = 60) => `// Fixture: phone stand, iPhone 15-ish, ${tilt}° tilt (mm)
$fn = 48;
phone_w = 76;
tilt = ${tilt};
base_d = 78;
base_t = 4;
back_h = 90;
lip = 10;
cable = 14;

difference() {
  union() {
    cube([phone_w, base_d, base_t]);
    translate([0, 16, base_t])
      rotate([-tilt, 0, 0])
        cube([phone_w, 5, back_h]);
    translate([0, 10, base_t])
      cube([phone_w, lip, 12]);
  }
  translate([phone_w / 2 - cable / 2, -1, -1])
    cube([cable, 16, 20]);
}
`;

const DRAWER_KNOB = (diameter = 40) => `// Fixture: parametric drawer knob (mm)
$fn = 64;
d = ${diameter};
stem_h = 12;
flange_h = 4;
hole = 5;

difference() {
  union() {
    cylinder(h = flange_h, d = d * 0.55);
    translate([0, 0, flange_h])
      cylinder(h = stem_h, d1 = d * 0.32, d2 = d * 0.22);
    translate([0, 0, flange_h + stem_h])
      sphere(d = d);
  }
  translate([0, 0, -1])
    cylinder(h = flange_h + stem_h + 2, d = hole);
  translate([-d, -d, -d])
    cube([d * 2, d * 2, d]);
}
`;

const numberAt = (source: string, re: RegExp, fallback: number): number => {
  const match = source.match(re);
  if (!match) return fallback;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function matchFixture(
  prompt: string,
  sizeHint?: number | null,
  units: Unit = "mm",
): FixtureMatch | null {
  const text = prompt.toLowerCase();
  const hinted = sizeHint && sizeHint > 0 ? toMillimeters(sizeHint, units) : null;

  if ((text.includes("cube") && (text.includes("hole") || text.includes("bore"))) || text.includes("cube with")) {
    const size = hinted ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+cube/, 20);
    const hole = numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/, 5);
    return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(size, hole) };
  }

  if (text.includes("phone stand") || text.includes("iphone") || (text.includes("phone") && text.includes("stand"))) {
    const tilt = numberAt(text, /(\d+(?:\.\d+)?)\s*degree/, 60);
    return { id: "phone-stand", title: "Phone stand", code: PHONE_STAND(tilt) };
  }

  if (text.includes("knob") || (text.includes("drawer") && text.includes("knob"))) {
    const diameter =
      hinted ??
      numberAt(text, /diameter\s+(\d+(?:\.\d+)?)\s*mm/, 40) ??
      numberAt(text, /(\d+(?:\.\d+)?)\s*mm/, 40);
    return { id: "drawer-knob", title: "Drawer knob", code: DRAWER_KNOB(diameter) };
  }

  if (/\bcube\b/.test(text)) {
    const size = hinted ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm/, 20);
    return {
      id: "plain-cube",
      title: "Cube",
      code: `$fn = 16;\ncube(${size}, center = false);\n`,
    };
  }

  return null;
}

export function defaultFixture(): FixtureMatch {
  return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(20, 5) };
}

export function shouldUseFixture(requestFixture?: boolean): boolean {
  if (requestFixture) return true;
  const flag = process.env.USE_FIXTURE?.trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  const forceLlm = process.env.FORCE_LLM?.trim().toLowerCase();
  if (forceLlm === "1" || forceLlm === "true") return false;
  // Default is live local Ollama (key/base/model have built-in defaults).
  // The fixture/mock path stays available via USE_FIXTURE or request.fixture.
  return false;
}

export const EXAMPLE_PROMPTS = [
  "20mm cube with 5mm hole",
  "phone stand for iPhone 15, 60 degree tilt",
  "parametric drawer knob diameter 40mm",
] as const;
