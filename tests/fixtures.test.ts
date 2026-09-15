import { describe, expect, it } from "vitest";
import { matchConversationFixture, matchFixture, shouldUseFixture } from "@/lib/fixtures";
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
