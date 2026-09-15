import { describe, expect, it } from "vitest";
import { matchConversationFixture, matchFixture, shouldUseFixture } from "@/lib/fixtures";
import { BALL_FIXTURE_PROMPT, HINGE_FIXTURE_PROMPT, PIN_FIXTURE_PROMPT, SNAP_FIXTURE_PROMPT } from "@/lib/joints";
import { CUBE_FILLET_PROMPT, CUBE_STEAMPUNK_PROMPT } from "@/lib/pretty-up";
import { CUBE_GYROID_PROMPT, CUBE_HONEYCOMB_PROMPT, PHONE_HONEYCOMB_PROMPT } from "@/lib/lattice";
import {
  CHEST_CHEVRON_PROMPT,
  CUBE_ETCH_PROMPT,
  GAUNTLET_CUFF_PROMPT,
  HELMET_EMBOSS_PROMPT,
  HELMET_MULTI_RELIEF_PROMPT,
} from "@/lib/relief";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { toMillimeters } from "@/lib/units";

describe("fixtures + units", () => {
  it("matches the two-color plaque fixture with region modules", () => {
    const fixture = matchFixture("red 40mm plaque with black letters");
    expect(fixture?.id).toBe("two-color-plaque");
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    expect(fixture?.code).toMatch(/module region_body/);
    expect(fixture?.code).toMatch(/module region_letters/);
    expect(fixture?.code).toMatch(/color\("red"\)/);
  });

  it("matches hinge, pin, ball, and snap print-in-place fixtures with sanitizable OpenSCAD", () => {
    const hinge = matchFixture(HINGE_FIXTURE_PROMPT);
    expect(hinge?.id).toBe("hinged-box-lid");
    expect(sanitizeOpenScad(hinge!.code).ok).toBe(true);
    expect(hinge?.code).toMatch(/radial_mm = 0\.4/);
    expect(hinge?.code).toContain("module hinge_pin()");

    const pin = matchFixture(PIN_FIXTURE_PROMPT);
    expect(pin?.id).toBe("pin-joint");
    expect(sanitizeOpenScad(pin!.code).ok).toBe(true);
    expect(pin?.code).toContain("module rotor_and_pin()");

    const ball = matchFixture(BALL_FIXTURE_PROMPT);
    expect(ball?.id).toBe("ball-joint");
    expect(sanitizeOpenScad(ball!.code).ok).toBe(true);
    expect(ball?.code).toMatch(/radial_mm = 0\.5/);
    expect(ball?.code).toContain("module ball_and_stem()");

    const snap = matchFixture(SNAP_FIXTURE_PROMPT);
    expect(snap?.id).toBe("snap-fit");
    expect(sanitizeOpenScad(snap!.code).ok).toBe(true);
    expect(snap?.code).toContain("module snap_hook()");
    expect(matchFixture("ball joint as two pieces")?.code).toContain("park_x");
    expect(matchFixture("20mm cube with 5mm hole")?.id).toBe("cube-with-hole");

    const helmet = matchFixture(HELMET_EMBOSS_PROMPT);
    expect(helmet?.id).toBe("helmet-emboss-crest");
    expect(sanitizeOpenScad(helmet!.code).ok).toBe(true);
    const etched = matchFixture(CUBE_ETCH_PROMPT);
    expect(etched?.id).toBe("cube-etched-initials");
    expect(sanitizeOpenScad(etched!.code).ok).toBe(true);
    const pretty = matchFixture(CUBE_FILLET_PROMPT);
    expect(pretty?.id).toBe("cube-pretty-fillet");
    expect(sanitizeOpenScad(pretty!.code).ok).toBe(true);
    expect(matchFixture(CUBE_STEAMPUNK_PROMPT)?.id).toBe("cube-pretty-steampunk");
    expect(matchFixture(CHEST_CHEVRON_PROMPT)?.id).toBe("chest-chevron-emboss");
    expect(matchFixture(GAUNTLET_CUFF_PROMPT)?.id).toBe("gauntlet-cuff-etch");
    expect(matchFixture(HELMET_MULTI_RELIEF_PROMPT)?.id).toBe("helmet-multi-relief");
    expect(matchFixture(PHONE_HONEYCOMB_PROMPT)?.id).toBe("phone-stand-honeycomb");
    expect(matchFixture(CUBE_HONEYCOMB_PROMPT)?.id).toBe("cube-lattice-honeycomb");
    expect(matchFixture(CUBE_GYROID_PROMPT)?.id).toBe("cube-lattice-gyroid");
    expect(matchFixture("20mm cube with press-fit 8mm pin hole")?.code).toMatch(/hole_d = 8\.4/);
  });

  it("matches the three example prompts with sanitizable OpenSCAD", () => {
    const prompts = [
      "20mm cube with 5mm hole",
      "phone stand for iPhone 15, 60 degree tilt",
      "parametric drawer knob diameter 40mm",
    ];
    for (const prompt of prompts) {
      const fixture = matchFixture(prompt);
      expect(fixture, prompt).not.toBeNull();
      const sanitized = sanitizeOpenScad(fixture!.code);
      expect(sanitized.ok, prompt).toBe(true);
    }
  });

  it("uses a size hint in millimeters", () => {
    const fixture = matchFixture("a cube with a hole", 30, "mm");
    expect(fixture?.code).toContain("size = 30");
  });

  it("converts inch hints to millimeters", () => {
    expect(toMillimeters(1, "in")).toBeCloseTo(25.4, 6);
    const fixture = matchFixture("cube with hole", 1, "in");
    expect(fixture?.code).toContain("size = 25.4");
  });

  it("edits the last cube fixture from a chat follow-up", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    expect(previous).not.toBeNull();
    const edited = matchConversationFixture("make the hole 8mm", "20mm cube with 5mm hole", previous!.code);
    expect(edited?.code).toContain("hole_d = 8");
    expect(edited?.code).toContain("size = 20");
  });

  it("removes a hole when the user asks in chat", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    const edited = matchConversationFixture("remove the hole", "20mm cube with 5mm hole", previous!.code);
    expect(edited?.id).toBe("plain-cube");
    expect(edited?.code).toContain("cube(20");
    expect(edited?.code).not.toContain("hole_d");
  });

  it("keeps ball and snap fixtures across a chat follow-up", () => {
    const ball = matchFixture(BALL_FIXTURE_PROMPT);
    const ballEdit = matchConversationFixture("make it a bit stronger", BALL_FIXTURE_PROMPT, ball!.code);
    expect(ballEdit?.id).toBe("ball-joint");
    expect(ballEdit?.code).toContain("module ball_and_stem()");

    const snap = matchFixture(SNAP_FIXTURE_PROMPT);
    const snapEdit = matchConversationFixture("keep the same clip", SNAP_FIXTURE_PROMPT, snap!.code);
    expect(snapEdit?.id).toBe("snap-fit");
    expect(snapEdit?.code).toContain("module snap_hook()");
  });

  it("still treats a full new description as a new design", () => {
    const previous = matchFixture("20mm cube with 5mm hole");
    const next = matchConversationFixture(
      "phone stand for iPhone 15, 60 degree tilt",
      "20mm cube with 5mm hole",
      previous!.code,
    );
    expect(next?.id).toBe("phone-stand");
  });

  it("keeps the fixture/mock path available without making it the default", () => {
    const prevKey = process.env.OPENAI_API_KEY;
    const prevFixture = process.env.USE_FIXTURE;
    const prevForce = process.env.FORCE_LLM;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FORCE_LLM;
    delete process.env.USE_FIXTURE;
    // Local Ollama is the default generate path even with no cloud key.
    expect(shouldUseFixture()).toBe(false);
    expect(shouldUseFixture(true)).toBe(true);
    process.env.USE_FIXTURE = "true";
    expect(shouldUseFixture()).toBe(true);
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    if (prevFixture === undefined) delete process.env.USE_FIXTURE;
    else process.env.USE_FIXTURE = prevFixture;
    if (prevForce === undefined) delete process.env.FORCE_LLM;
    else process.env.FORCE_LLM = prevForce;
  });
});
