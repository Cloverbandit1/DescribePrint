import { colorRegionsFromPrompt } from "./color-regions";
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

const TWO_COLOR_PLAQUE = `// Fixture: two-color plaque (mm) — region_* + color() for 3MF objects
$fn = 32;
body_w = 40;
body_d = 20;
body_h = 6;
letter_h = 1.6;

module region_body() {
  cube([body_w, body_d, body_h]);
}

module region_letters() {
  // Raised bars stand in for letters (no text() / fonts)
  translate([8, 6, body_h]) cube([4, 8, letter_h]);
  translate([16, 6, body_h]) cube([4, 8, letter_h]);
  translate([24, 6, body_h]) cube([4, 8, letter_h]);
}

union() {
  color("red") region_body();
  color("black") region_letters();
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

  if (isTwoColorFixturePrompt(text)) {
    return { id: "two-color-plaque", title: "Two-color plaque", code: TWO_COLOR_PLAQUE };
  }

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

const NEW_DESIGN =
  /\b(new part|start over|something else|different part|instead make|forget that|scratch)\b/i;
const EDIT_CUE =
  /\b(make|change|update|add|remove|delete|bigger|smaller|wider|taller|shorter|without|more|less|hole|tilt|diameter)\b/i;

export function isLikelyEdit(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (NEW_DESIGN.test(text)) return false;
  if (EXAMPLE_PROMPTS.some((example) => example.toLowerCase() === text.toLowerCase())) return false;
  return EDIT_CUE.test(text) && text.length < 120;
}

function numberFrom(source: string, patterns: RegExp[], fallback: number): number {
  for (const pattern of patterns) {
    const n = numberAt(source, pattern, Number.NaN);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function paramsFromCode(code: string | null | undefined) {
  const source = code ?? "";
  return {
    size: numberAt(source, /size\s*=\s*(\d+(?:\.\d+)?)/, Number.NaN),
    hole: numberAt(source, /hole_d\s*=\s*(\d+(?:\.\d+)?)/, Number.NaN),
    tilt: numberAt(source, /tilt\s*=\s*(\d+(?:\.\d+)?)/, Number.NaN),
    diameter: numberAt(source, /^d\s*=\s*(\d+(?:\.\d+)?)/m, Number.NaN),
  };
}

/**
 * Continue a describe/chat thread: follow-ups edit the last fixture instead of
 * throwing away the plate. Fresh descriptions still match as new designs.
 */
export function matchConversationFixture(
  prompt: string,
  previousPrompt?: string | null,
  previousCode?: string | null,
  sizeHint?: number | null,
  units: Unit = "mm",
): FixtureMatch | null {
  const fresh = matchFixture(prompt, sizeHint, units);
  if (!previousPrompt?.trim() && !previousCode?.trim()) return fresh;
  if (NEW_DESIGN.test(prompt)) return fresh;
  if (fresh && !isLikelyEdit(prompt)) return fresh;

  const prev = previousPrompt?.trim() ? matchFixture(previousPrompt, sizeHint, units) : null;
  const fromCode = paramsFromCode(previousCode);
  const hinted = sizeHint && sizeHint > 0 ? toMillimeters(sizeHint, units) : null;
  const text = prompt.toLowerCase();
  const baseId = prev?.id ?? (/module\s+region_letters\s*\(/.test(previousCode ?? "") ? "two-color-plaque" : Number.isFinite(fromCode.hole) ? "cube-with-hole" : Number.isFinite(fromCode.tilt) ? "phone-stand" : Number.isFinite(fromCode.diameter) ? "drawer-knob" : Number.isFinite(fromCode.size) ? "plain-cube" : null);

  const hole = numberFrom(
    prompt,
    [/hole[^\d]{0,20}(\d+(?:\.\d+)?)/i, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/i],
    Number.NaN,
  );
  const size = hinted ?? numberFrom(prompt, [/(\d+(?:\.\d+)?)\s*mm\s+cube/i, /(?:cube|size|it)\s+[^\d]{0,12}(\d+(?:\.\d+)?)/i], Number.NaN);
  const tilt = numberFrom(prompt, [/(\d+(?:\.\d+)?)\s*degree/i, /tilt[^\d]{0,12}(\d+(?:\.\d+)?)/i], Number.NaN);
  const diameter = hinted ?? numberFrom(prompt, [/diameter\s+(\d+(?:\.\d+)?)/i, /(\d+(?:\.\d+)?)\s*mm/i], Number.NaN);

  if (baseId === "cube-with-hole" || baseId === "plain-cube") {
    const nextSize = Number.isFinite(size)
      ? size
      : Number.isFinite(fromCode.size)
        ? fromCode.size
        : prev
          ? numberAt(previousPrompt ?? "", /(\d+(?:\.\d+)?)\s*mm/, 20)
          : 20;
    if (/\bremove\b/.test(text) && /\bhole\b/.test(text)) {
      return {
        id: "plain-cube",
        title: "Cube",
        code: `$fn = 16;\ncube(${nextSize}, center = false);\n`,
      };
    }
    const nextHole = Number.isFinite(hole)
      ? hole
      : Number.isFinite(fromCode.hole)
        ? fromCode.hole
        : 5;
    if (baseId === "cube-with-hole" || (/\badd\b/.test(text) && /\bhole\b/.test(text)) || Number.isFinite(hole)) {
      return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
    }
    if (baseId === "plain-cube") {
      return {
        id: "plain-cube",
        title: "Cube",
        code: `$fn = 16;\ncube(${nextSize}, center = false);\n`,
      };
    }
  }

  if (baseId === "two-color-plaque") {
    return { id: "two-color-plaque", title: "Two-color plaque", code: TWO_COLOR_PLAQUE };
  }

  if (baseId === "phone-stand") {
    const nextTilt = Number.isFinite(tilt)
      ? tilt
      : Number.isFinite(fromCode.tilt)
        ? fromCode.tilt
        : numberAt(previousPrompt ?? "", /(\d+(?:\.\d+)?)\s*degree/, 60);
    return { id: "phone-stand", title: "Phone stand", code: PHONE_STAND(nextTilt) };
  }

  if (baseId === "drawer-knob") {
    const nextDiameter = Number.isFinite(diameter) && /diameter|mm|bigger|smaller|knob/.test(text)
      ? diameter
      : Number.isFinite(fromCode.diameter)
        ? fromCode.diameter
        : 40;
    return { id: "drawer-knob", title: "Drawer knob", code: DRAWER_KNOB(nextDiameter) };
  }

  return matchFixture(`${previousPrompt ?? ""} ${prompt}`, sizeHint, units) ?? fresh ?? prev;
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

export function isTwoColorFixturePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const regions = colorRegionsFromPrompt(text);
  if (regions.length < 2) return false;
  return /\b(letter|plaque|nameplate|sign|logo|inlay|body)\b/.test(text);
}

export const EXAMPLE_PROMPTS = [
  "20mm cube with 5mm hole",
  "phone stand for iPhone 15, 60 degree tilt",
  "parametric drawer knob diameter 40mm",
  "red 40mm plaque with black letters",
] as const;
