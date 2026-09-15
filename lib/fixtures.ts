import { colorRegionsFromPrompt } from "./color-regions";
import {
  BALL_FIXTURE_PROMPT,
  HINGE_FIXTURE_PROMPT,
  PIN_FIXTURE_PROMPT,
  SNAP_FIXTURE_PROMPT,
  ballFixtureScad,
  fixtureClearanceIntent,
  hingeFixtureScad,
  isBallFixturePrompt,
  isHingeFixturePrompt,
  isPinFixturePrompt,
  isSnapFixturePrompt,
  jointClearance,
  pinFixtureScad,
  snapFixtureScad,
} from "./joints";
import {
  CUBE_FILLET_PROMPT,
  CUBE_RIBS_PROMPT,
  CUBE_STEAMPUNK_PROMPT,
  inferPrettyUpStyle,
  isCubePrettyChamferPrompt,
  isCubePrettyFilletPrompt,
  isCubePrettyRibsPrompt,
  isCubePrettySteampunkPrompt,
  isPrettyUpFollowUp,
  prettyUpFixtureScad,
  prettyUpRefusalReason,
  type PrettyUpStyle,
} from "./pretty-up";
import {
  CUBE_GYROID_PROMPT,
  CUBE_HONEYCOMB_PROMPT,
  PHONE_HONEYCOMB_PROMPT,
  inferLatticePattern,
  isCubeLatticePrompt,
  isLatticeFollowUp,
  isPhoneStandLatticePrompt,
  latticeFixtureId,
  latticeFixtureScad,
  latticeFixtureTitle,
  latticeRefusalReason,
  type LatticePattern,
} from "./lattice";
import {
  CUBE_ETCH_PROMPT,
  HELMET_EMBOSS_PROMPT,
  chestPlateEmbossFixtureScad,
  cubeEtchFixtureScad,
  cubeEtchSizeFromPrompt,
  gauntletCuffEtchFixtureScad,
  helmetEmbossFixtureScad,
  helmetMultiReliefFixtureScad,
  initialsFromPrompt,
  isChestChevronPrompt,
  isCubeEtchPrompt,
  isEtchFollowUp,
  isGauntletCuffPrompt,
  isHelmetEmbossPrompt,
  isHelmetMultiReliefPrompt,
} from "./relief";
import {
  PRESS_FIT_CUBE_PROMPT,
  inferCadFit,
  isPressFitCubePrompt,
  parseHoleNominalMm,
  parseShaftMm,
  finishedHoleMm,
} from "./fits";
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

  if (isHelmetMultiReliefPrompt(text)) {
    return {
      id: "helmet-multi-relief",
      title: "Helmet with crest and etched initials",
      code: helmetMultiReliefFixtureScad(),
    };
  }

  if (isChestChevronPrompt(text)) {
    return {
      id: "chest-chevron-emboss",
      title: "Chest plate with embossed chevron",
      code: chestPlateEmbossFixtureScad(),
    };
  }

  if (isGauntletCuffPrompt(text)) {
    return {
      id: "gauntlet-cuff-etch",
      title: "Gauntlet with etched cuff ring",
      code: gauntletCuffEtchFixtureScad(),
    };
  }

  if (isHelmetEmbossPrompt(text)) {
    return { id: "helmet-emboss-crest", title: "Helmet with embossed crest", code: helmetEmbossFixtureScad() };
  }

  if (isCubeEtchPrompt(text)) {
    const size = hinted ?? cubeEtchSizeFromPrompt(text, 20);
    const initials = initialsFromPrompt(prompt) ?? "DP";
    return {
      id: "cube-etched-initials",
      title: "Cube with etched initials",
      code: cubeEtchFixtureScad(size, initials),
    };
  }

  if (isTwoColorFixturePrompt(text)) {
    return { id: "two-color-plaque", title: "Two-color plaque", code: TWO_COLOR_PLAQUE };
  }

  if (isHingeFixturePrompt(text)) {
    return { id: "hinged-box-lid", title: "Print-in-place hinged lid", code: hingeFixtureScad() };
  }

  if (isPinFixturePrompt(text)) {
    return { id: "pin-joint", title: "Print-in-place pin joint", code: pinFixtureScad() };
  }

  if (isBallFixturePrompt(text)) {
    const intent = fixtureClearanceIntent(text);
    return {
      id: "ball-joint",
      title: intent === "multi-part" ? "Multi-part ball joint" : "Print-in-place ball joint",
      code: ballFixtureScad(jointClearance("ball", intent)),
    };
  }

  if (isSnapFixturePrompt(text)) {
    const intent = fixtureClearanceIntent(text);
    return {
      id: "snap-fit",
      title: intent === "multi-part" ? "Multi-part snap-fit clip" : "Print-in-place snap-fit clip",
      code: snapFixtureScad(jointClearance("snap", intent)),
    };
  }

  const lattice = matchLatticeFixture(prompt, hinted);
  if (lattice) return lattice;

  const pretty = matchPrettyUpFixture(prompt, hinted);
  if (pretty) return pretty;

  if ((text.includes("cube") && (text.includes("hole") || text.includes("bore") || text.includes("pin"))) || text.includes("cube with")) {
    const size = hinted ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+cube/, 20);
    const fit = inferCadFit({ prompt });
    const shaft = parseShaftMm(prompt);
    const statedHole = parseHoleNominalMm(prompt);
    const nominal = shaft ?? statedHole ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/, 5);
    const hole = fit && (shaft !== undefined || isPressFitCubePrompt(prompt) || statedHole !== undefined)
      ? finishedHoleMm(nominal, fit)
      : nominal;
    return {
      id: isPressFitCubePrompt(prompt) ? "cube-press-fit-hole" : "cube-with-hole",
      title: isPressFitCubePrompt(prompt) ? "Cube with press-fit hole" : "Cube with hole",
      code: CUBE_WITH_HOLE(size, hole),
    };
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
  /\b(make|change|update|add|remove|delete|bigger|smaller|wider|taller|shorter|without|more|less|hole|tilt|diameter|emboss|etch|engrave|recess|raised|initials|crest|pretty|restyle|steampunk|fillet|chamfer|rib|panel|round|paint|recolor|re-colou?r|tint|dye|colou?r|lattice|honeycomb|gyroid|lightweight|lighten|lighter|press[-\s]?fit|sliding|fit grade|clearance)\b/i;

function prettyUpFixtureId(style: PrettyUpStyle): string {
  if (style === "chamfer") return "cube-pretty-chamfer";
  if (style === "steampunk") return "cube-pretty-steampunk";
  if (style === "ribs" || style === "panels") return "cube-pretty-ribs";
  return "cube-pretty-fillet";
}

function prettyUpFixtureTitle(style: PrettyUpStyle): string {
  if (style === "chamfer") return "Cube with chamfered edges";
  if (style === "steampunk") return "Steampunk cube (keep hole)";
  if (style === "ribs" || style === "panels") return "Cube with decorative ribs";
  return "Cube with rounded edges";
}

function matchLatticeFixture(prompt: string, sizeHint?: number | null, holeHint?: number): FixtureMatch | null {
  if (latticeRefusalReason({ prompt })) return null;
  const text = prompt.toLowerCase();
  const size = sizeHint && sizeHint > 0 ? sizeHint : numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+cube/, 20);
  const hole = holeHint ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/, Number.NaN);
  const tilt = numberAt(text, /(\d+(?:\.\d+)?)\s*degree/, 60);
  if (isPhoneStandLatticePrompt(prompt)) {
    return {
      id: latticeFixtureId("honeycomb", "phone-stand"),
      title: latticeFixtureTitle("honeycomb", "phone-stand"),
      code: latticeFixtureScad("honeycomb", "phone-stand", size, undefined, tilt),
    };
  }
  if (isCubeLatticePrompt(prompt)) {
    const pattern = inferLatticePattern(prompt) ?? "honeycomb";
    const keepHole = Number.isFinite(hole) || /\bhole\b/.test(text);
    return {
      id: latticeFixtureId(pattern, "cube"),
      title: latticeFixtureTitle(pattern, "cube"),
      code: latticeFixtureScad(pattern, "cube", size, keepHole ? (Number.isFinite(hole) ? hole : 5) : undefined),
    };
  }
  return null;
}

function matchPrettyUpFixture(prompt: string, sizeHint?: number | null, holeHint?: number): FixtureMatch | null {
  if (prettyUpRefusalReason({ prompt })) return null;
  const text = prompt.toLowerCase();
  const size = sizeHint && sizeHint > 0 ? sizeHint : numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+cube/, 20);
  const hole = holeHint ?? numberAt(text, /(\d+(?:\.\d+)?)\s*mm\s+(?:hole|bore)/, 5);
  if (isCubePrettySteampunkPrompt(text)) {
    return { id: "cube-pretty-steampunk", title: prettyUpFixtureTitle("steampunk"), code: prettyUpFixtureScad("steampunk", size, hole) };
  }
  if (isCubePrettyRibsPrompt(text)) {
    return { id: "cube-pretty-ribs", title: prettyUpFixtureTitle("ribs"), code: prettyUpFixtureScad("ribs", size, hole) };
  }
  if (isCubePrettyChamferPrompt(text)) {
    return { id: "cube-pretty-chamfer", title: prettyUpFixtureTitle("chamfer"), code: prettyUpFixtureScad("chamfer", size, hole) };
  }
  if (isCubePrettyFilletPrompt(text)) {
    return { id: "cube-pretty-fillet", title: prettyUpFixtureTitle("fillet"), code: prettyUpFixtureScad("fillet", size, hole) };
  }
  const style = inferPrettyUpStyle(prompt);
  if (style) {
    return {
      id: prettyUpFixtureId(style),
      title: prettyUpFixtureTitle(style),
      code: prettyUpFixtureScad(style, size, hole),
    };
  }
  return null;
}

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
  const baseId =
    prev?.id ??
    (/module\s+box_body\s*\(/.test(previousCode ?? "")
      ? "hinged-box-lid"
      : /module\s+rotor_and_pin\s*\(/.test(previousCode ?? "")
        ? "pin-joint"
        : /module\s+ball_and_stem\s*\(/.test(previousCode ?? "")
          ? "ball-joint"
          : /module\s+snap_hook\s*\(/.test(previousCode ?? "")
            ? "snap-fit"
            : /module\s+chest_plate\s*\(/.test(previousCode ?? "")
            ? "chest-chevron-emboss"
            : /module\s+gauntlet_cuff\s*\(/.test(previousCode ?? "")
            ? "gauntlet-cuff-etch"
            : /etch_depth\s*=/.test(previousCode ?? "") && /module\s+helmet_shell\s*\(/.test(previousCode ?? "")
            ? "helmet-multi-relief"
            : /module\s+helmet_shell\s*\(/.test(previousCode ?? "")
            ? "helmet-emboss-crest"
            : /latticed_box\s*\(/.test(previousCode ?? "")
            ? "phone-stand-honeycomb"
            : /module\s+lattice_voids\s*\(/.test(previousCode ?? "") && /hole_d\s*=/.test(previousCode ?? "") && /gyroid/.test(previousCode ?? "")
            ? "cube-lattice-gyroid"
            : /module\s+lattice_voids\s*\(/.test(previousCode ?? "") && /hole_d\s*=/.test(previousCode ?? "") && /cubic/.test(previousCode ?? "")
            ? "cube-lattice-cubic"
            : /module\s+lattice_voids\s*\(/.test(previousCode ?? "") && /hole_d\s*=/.test(previousCode ?? "") && /diagonal/.test(previousCode ?? "")
            ? "cube-lattice-diagonal"
            : /module\s+lattice_voids\s*\(/.test(previousCode ?? "")
            ? "cube-lattice-honeycomb"
            : /steampunk_disc\s*\(/.test(previousCode ?? "")
              ? "cube-pretty-steampunk"
              : /module\s+decorative_ribs\s*\(/.test(previousCode ?? "")
                ? "cube-pretty-ribs"
                : /chamfer\s*=/.test(previousCode ?? "")
                  ? "cube-pretty-chamfer"
                  : /fillet_r\s*=/.test(previousCode ?? "")
                    ? "cube-pretty-fillet"
                    : /etch_depth\s*=/.test(previousCode ?? "")
              ? "cube-etched-initials"
              : /module\s+region_letters\s*\(/.test(previousCode ?? "")
              ? "two-color-plaque"
              : Number.isFinite(fromCode.hole)
            ? "cube-with-hole"
            : Number.isFinite(fromCode.tilt)
              ? "phone-stand"
              : Number.isFinite(fromCode.diameter)
                ? "drawer-knob"
                : Number.isFinite(fromCode.size)
                  ? "plain-cube"
                  : null);

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
    if (isCubeEtchPrompt(text) || isEtchFollowUp(prompt)) {
      const initials = initialsFromPrompt(prompt) ?? "DP";
      const keepHole =
        baseId === "cube-with-hole" &&
        !( /\bremove\b/.test(text) && /\bhole\b/.test(text) );
      const nextHole = keepHole
        ? Number.isFinite(hole)
          ? hole
          : Number.isFinite(fromCode.hole)
            ? fromCode.hole
            : 5
        : undefined;
      return {
        id: "cube-etched-initials",
        title: "Cube with etched initials",
        code: cubeEtchFixtureScad(nextSize, initials, nextHole),
      };
    }
    if (isLatticeFollowUp(prompt)) {
      const refuse = latticeRefusalReason({
        prompt,
        previousPrompt,
        previousCode,
      });
      if (refuse) {
        const nextHole = Number.isFinite(hole)
          ? hole
          : Number.isFinite(fromCode.hole)
            ? fromCode.hole
            : 5;
        return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
      }
      const pattern = inferLatticePattern(prompt) ?? "honeycomb";
      const keepHole = baseId === "cube-with-hole" && !( /\bremove\b/.test(text) && /\bhole\b/.test(text) );
      const nextHole = keepHole
        ? Number.isFinite(hole)
          ? hole
          : Number.isFinite(fromCode.hole)
            ? fromCode.hole
            : 5
        : undefined;
      return {
        id: latticeFixtureId(pattern, "cube"),
        title: latticeFixtureTitle(pattern, "cube"),
        code: latticeFixtureScad(pattern, "cube", nextSize, nextHole),
      };
    }
    if (isPrettyUpFollowUp(prompt)) {
      const refuse = prettyUpRefusalReason({
        prompt,
        previousPrompt,
        previousCode,
      });
      if (refuse) {
        const nextHole = Number.isFinite(hole)
          ? hole
          : Number.isFinite(fromCode.hole)
            ? fromCode.hole
            : 5;
        return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
      }
      const style = inferPrettyUpStyle(prompt) ?? "fillet";
      const nextHole = Number.isFinite(hole)
        ? hole
        : Number.isFinite(fromCode.hole)
          ? fromCode.hole
          : 5;
      return {
        id: prettyUpFixtureId(style),
        title: prettyUpFixtureTitle(style),
        code: prettyUpFixtureScad(style, nextSize, nextHole),
      };
    }
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

  if (baseId === "helmet-multi-relief") {
    return {
      id: "helmet-multi-relief",
      title: "Helmet with crest and etched initials",
      code: helmetMultiReliefFixtureScad(),
    };
  }

  if (baseId === "chest-chevron-emboss") {
    return {
      id: "chest-chevron-emboss",
      title: "Chest plate with embossed chevron",
      code: chestPlateEmbossFixtureScad(),
    };
  }

  if (baseId === "gauntlet-cuff-etch") {
    return {
      id: "gauntlet-cuff-etch",
      title: "Gauntlet with etched cuff ring",
      code: gauntletCuffEtchFixtureScad(),
    };
  }

  if (baseId === "helmet-emboss-crest") {
    if (isHelmetMultiReliefPrompt(text)) {
      return {
        id: "helmet-multi-relief",
        title: "Helmet with crest and etched initials",
        code: helmetMultiReliefFixtureScad(),
      };
    }
    return { id: "helmet-emboss-crest", title: "Helmet with embossed crest", code: helmetEmbossFixtureScad() };
  }

  if (
    baseId === "cube-pretty-fillet" ||
    baseId === "cube-pretty-chamfer" ||
    baseId === "cube-pretty-ribs" ||
    baseId === "cube-pretty-steampunk"
  ) {
    const nextSize = Number.isFinite(size)
      ? size
      : Number.isFinite(fromCode.size)
        ? fromCode.size
        : 20;
    const nextHole = Number.isFinite(hole)
      ? hole
      : Number.isFinite(fromCode.hole)
        ? fromCode.hole
        : 5;
    if (prettyUpRefusalReason({ prompt, previousPrompt, previousCode })) {
      return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
    }
    if (/\bremove\b/.test(text) && /\bhole\b/.test(text)) {
      return {
        id: "plain-cube",
        title: "Cube",
        code: `$fn = 16;\ncube(${nextSize}, center = false);\n`,
      };
    }
    const style = inferPrettyUpStyle(prompt) ?? (
      baseId === "cube-pretty-chamfer"
        ? "chamfer"
        : baseId === "cube-pretty-steampunk"
          ? "steampunk"
          : baseId === "cube-pretty-ribs"
            ? "ribs"
            : "fillet"
    );
    return {
      id: prettyUpFixtureId(style),
      title: prettyUpFixtureTitle(style),
      code: prettyUpFixtureScad(style, nextSize, nextHole),
    };
  }

  if (baseId === "cube-etched-initials" || (baseId === "plain-cube" && isCubeEtchPrompt(text))) {
    const nextSize = Number.isFinite(size)
      ? size
      : Number.isFinite(fromCode.size)
        ? fromCode.size
        : 20;
    const initials = initialsFromPrompt(prompt) ?? "DP";
    return {
      id: "cube-etched-initials",
      title: "Cube with etched initials",
      code: cubeEtchFixtureScad(nextSize, initials),
    };
  }

  if (baseId === "two-color-plaque") {
    return { id: "two-color-plaque", title: "Two-color plaque", code: TWO_COLOR_PLAQUE };
  }

  if (baseId === "hinged-box-lid") {
    return { id: "hinged-box-lid", title: "Print-in-place hinged lid", code: hingeFixtureScad() };
  }

  if (baseId === "pin-joint") {
    return { id: "pin-joint", title: "Print-in-place pin joint", code: pinFixtureScad() };
  }

  if (baseId === "ball-joint") {
    const intent = fixtureClearanceIntent(`${previousPrompt ?? ""} ${prompt}`);
    return {
      id: "ball-joint",
      title: intent === "multi-part" ? "Multi-part ball joint" : "Print-in-place ball joint",
      code: ballFixtureScad(jointClearance("ball", intent)),
    };
  }

  if (baseId === "snap-fit") {
    const intent = fixtureClearanceIntent(`${previousPrompt ?? ""} ${prompt}`);
    return {
      id: "snap-fit",
      title: intent === "multi-part" ? "Multi-part snap-fit clip" : "Print-in-place snap-fit clip",
      code: snapFixtureScad(jointClearance("snap", intent)),
    };
  }

  if (
    baseId === "cube-lattice-honeycomb" ||
    baseId === "cube-lattice-gyroid" ||
    baseId === "cube-lattice-cubic" ||
    baseId === "cube-lattice-diagonal"
  ) {
    const nextSize = Number.isFinite(size)
      ? size
      : Number.isFinite(fromCode.size)
        ? fromCode.size
        : 20;
    const nextHole = Number.isFinite(hole)
      ? hole
      : Number.isFinite(fromCode.hole)
        ? fromCode.hole
        : 5;
    if (latticeRefusalReason({ prompt, previousPrompt, previousCode })) {
      return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
    }
    if (/\bremove\b/.test(text) && /\b(lattice|honeycomb|gyroid)\b/.test(text)) {
      return { id: "cube-with-hole", title: "Cube with hole", code: CUBE_WITH_HOLE(nextSize, nextHole) };
    }
    const pattern = (inferLatticePattern(prompt) ??
      (baseId === "cube-lattice-gyroid"
        ? "gyroid"
        : baseId === "cube-lattice-cubic"
          ? "cubic"
          : baseId === "cube-lattice-diagonal"
            ? "diagonal"
            : "honeycomb")) as LatticePattern;
    return {
      id: latticeFixtureId(pattern, "cube"),
      title: latticeFixtureTitle(pattern, "cube"),
      code: latticeFixtureScad(pattern, "cube", nextSize, nextHole),
    };
  }

  if (baseId === "phone-stand-honeycomb") {
    const nextTilt = Number.isFinite(tilt)
      ? tilt
      : Number.isFinite(fromCode.tilt)
        ? fromCode.tilt
        : 60;
    if (latticeRefusalReason({ prompt, previousPrompt, previousCode })) {
      return { id: "phone-stand", title: "Phone stand", code: PHONE_STAND(nextTilt) };
    }
    return {
      id: "phone-stand-honeycomb",
      title: latticeFixtureTitle("honeycomb", "phone-stand"),
      code: latticeFixtureScad("honeycomb", "phone-stand", 20, undefined, nextTilt),
    };
  }

  if (baseId === "phone-stand") {
    const nextTilt = Number.isFinite(tilt)
      ? tilt
      : Number.isFinite(fromCode.tilt)
        ? fromCode.tilt
        : numberAt(previousPrompt ?? "", /(\d+(?:\.\d+)?)\s*degree/, 60);
    if (isLatticeFollowUp(prompt) && !latticeRefusalReason({ prompt, previousPrompt, previousCode })) {
      return {
        id: "phone-stand-honeycomb",
        title: latticeFixtureTitle("honeycomb", "phone-stand"),
        code: latticeFixtureScad("honeycomb", "phone-stand", 20, undefined, nextTilt),
      };
    }
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
  HINGE_FIXTURE_PROMPT,
  PIN_FIXTURE_PROMPT,
  BALL_FIXTURE_PROMPT,
  SNAP_FIXTURE_PROMPT,
  HELMET_EMBOSS_PROMPT,
  CUBE_ETCH_PROMPT,
  CUBE_FILLET_PROMPT,
  CUBE_STEAMPUNK_PROMPT,
  CUBE_RIBS_PROMPT,
  PHONE_HONEYCOMB_PROMPT,
  CUBE_HONEYCOMB_PROMPT,
  CUBE_GYROID_PROMPT,
  PRESS_FIT_CUBE_PROMPT,
  "stormtrooper helmet",
] as const;
