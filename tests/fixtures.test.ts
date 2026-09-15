import { describe, expect, it } from "vitest";
import { matchFixture, shouldUseFixture } from "@/lib/fixtures";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { toMillimeters } from "@/lib/units";

describe("fixtures + units", () => {
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

  it("uses the fixture path when no API key is set", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FORCE_LLM;
    delete process.env.USE_FIXTURE;
    expect(shouldUseFixture()).toBe(true);
    expect(shouldUseFixture(true)).toBe(true);
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  });
});
