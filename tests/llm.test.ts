import { describe, expect, it } from "vitest";
import { buildUserPrompt } from "@/lib/llm";

describe("LLM prompt", () => {
  it("asks for a fresh part when there is no prior design", () => {
    const prompt = buildUserPrompt({ prompt: "20mm cube with 5mm hole", sizeNote: "" });
    expect(prompt).toContain("20mm cube with 5mm hole");
    expect(prompt).not.toContain("follow-up");
  });

  it("includes the current OpenSCAD on a conversation follow-up", () => {
    const prompt = buildUserPrompt({
      prompt: "make the hole 8mm",
      sizeNote: "",
      previousPrompt: "20mm cube with 5mm hole",
      previousCode: "cube(20);",
    });
    expect(prompt).toContain("follow-up");
    expect(prompt).toContain("cube(20);");
    expect(prompt).toContain("20mm cube with 5mm hole");
  });
});
