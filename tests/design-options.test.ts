import { describe, expect, it } from "vitest";
import {
  applyChoicesToGenerateFields,
  applyDesignChoiceToPrompt,
  choicePhrase,
  designChoiceFollowUp,
  flattenDesignOptions,
  parseAppliedChoices,
  parseDesignOptionGroups,
  resolveDesignOptions,
  upsertAppliedChoice,
} from "@/lib/design-options";
import { STORMTROOPER_HELMET_PROMPT, UNKNOWN_CHARACTER_PROMPT } from "@/lib/knowledge";
import { HINGE_FIXTURE_PROMPT } from "@/lib/joints";
import { HELMET_EMBOSS_PROMPT } from "@/lib/relief";
import { normalizeCadPlan, parseCadPlan } from "@/lib/llm";

const CUBE = "20mm cube with 5mm hole";

describe("design options model", () => {
  it("keeps the option shape small (id, label, value, optional description)", () => {
    const resolved = resolveDesignOptions({ prompt: STORMTROOPER_HELMET_PROMPT });
    const option = flattenDesignOptions(resolved.options)[0];
    expect(option).toMatchObject({
      id: expect.stringMatching(/^[a-z_]+:[a-z0-9_-]+$/i),
      label: expect.any(String),
      value: expect.any(String),
    });
    expect(option?.description).toEqual(expect.any(String));
    expect(Object.keys(option ?? {}).sort()).toEqual(["description", "id", "label", "value"]);
  });

  it("drops unknown ids and junk values", () => {
    expect(
      parseAppliedChoices([
        { id: "scale_mode", value: "wearable" },
        { id: "scale_mode", value: "tiny" },
        { id: "nozzle", value: "0.4" },
        { id: "material", value: "petg" },
        "nope",
      ]),
    ).toEqual([
      { id: "scale_mode", value: "wearable" },
      { id: "material", value: "petg" },
    ]);
    expect(parseDesignOptionGroups([{ id: "wizard_mode", options: [] }])).toEqual([]);
  });

  it("upserts one value per group", () => {
    const next = upsertAppliedChoice([{ id: "scale_mode", value: "display" }], {
      id: "scale_mode",
      value: "wearable",
    });
    expect(next).toEqual([{ id: "scale_mode", value: "wearable" }]);
  });
});

describe("fork stubs (do not ask on every prompt)", () => {
  it("does not block a fully specified cube", () => {
    const resolved = resolveDesignOptions({ prompt: CUBE });
    expect(resolved.needs_user_choice).toBe(false);
    expect(resolved.options).toEqual([]);
  });

  it("asks scale when a character pack hit omits display vs 1:1", () => {
    const resolved = resolveDesignOptions({ prompt: STORMTROOPER_HELMET_PROMPT });
    expect(resolved.needs_user_choice).toBe(true);
    expect(resolved.options.map((group) => group.id)).toEqual(["scale_mode"]);
    expect(resolved.options[0]?.options.map((option) => option.value)).toEqual(["display", "wearable"]);
  });

  it("does not re-ask scale after a wearable / display choice", () => {
    expect(resolveDesignOptions({ prompt: "wearable stormtrooper helmet" }).options.map((g) => g.id)).toEqual([
      "wearable_size",
    ]);
    expect(
      resolveDesignOptions({
        prompt: STORMTROOPER_HELMET_PROMPT,
        choices: [{ id: "scale_mode", value: "display" }],
      }).needs_user_choice,
    ).toBe(false);
    expect(resolveDesignOptions({ prompt: "stormtrooper helmet fit P2S" }).needs_user_choice).toBe(false);
  });

  it("does not invent a scale fork for an unknown character", () => {
    const resolved = resolveDesignOptions({ prompt: UNKNOWN_CHARACTER_PROMPT });
    expect(resolved.options.some((group) => group.id === "scale_mode")).toBe(false);
  });

  it("asks wearable S–XL only after a 1:1 / wearable intent", () => {
    const resolved = resolveDesignOptions({
      prompt: STORMTROOPER_HELMET_PROMPT,
      choices: [{ id: "scale_mode", value: "wearable" }],
    });
    expect(resolved.options.map((group) => group.id)).toEqual(["wearable_size"]);
    expect(
      resolveDesignOptions({
        prompt: "wearable stormtrooper helmet size L",
        wearableSize: "L",
      }).needs_user_choice,
    ).toBe(false);
  });

  it("asks material only when the prompt is ambiguous about filament", () => {
    expect(resolveDesignOptions({ prompt: "which material should I use for this clip?" }).options[0]?.id).toBe(
      "material",
    );
    expect(resolveDesignOptions({ prompt: `${CUBE} in PETG` }).needs_user_choice).toBe(false);
    expect(resolveDesignOptions({ prompt: CUBE }).options.some((group) => group.id === "material")).toBe(false);
  });

  it("asks PIP vs multi-part when a joint is named without an intent", () => {
    expect(resolveDesignOptions({ prompt: "hinged box lid" }).options.map((group) => group.id)).toEqual(["clearance"]);
    expect(resolveDesignOptions({ prompt: HINGE_FIXTURE_PROMPT }).needs_user_choice).toBe(false);
  });

  it("asks emboss face when relief has no named face", () => {
    expect(resolveDesignOptions({ prompt: "helmet with embossed crest" }).options.map((g) => g.id)).toEqual([
      "emboss_face",
    ]);
    expect(resolveDesignOptions({ prompt: HELMET_EMBOSS_PROMPT }).needs_user_choice).toBe(false);
  });

  it("asks color regions only for a vague color request", () => {
    expect(resolveDesignOptions({ prompt: "make it multi-color" }).options.map((g) => g.id)).toEqual(["color_regions"]);
    expect(resolveDesignOptions({ prompt: "red 40mm plaque with black letters" }).needs_user_choice).toBe(false);
  });
});

describe("applying a choice", () => {
  it("threads the phrase into the next prompt and request fields", () => {
    const choice = { id: "scale_mode" as const, value: "wearable" };
    expect(applyDesignChoiceToPrompt(STORMTROOPER_HELMET_PROMPT, choice)).toBe(
      "stormtrooper helmet. 1:1 wearable",
    );
    expect(choicePhrase(choice)).toBe("1:1 wearable");
    expect(designChoiceFollowUp(choice)).toMatch(/1:1 wearable/i);
    const fields = applyChoicesToGenerateFields({
      prompt: STORMTROOPER_HELMET_PROMPT,
      choices: [
        { id: "scale_mode", value: "wearable" },
        { id: "wearable_size", value: "L" },
        { id: "material", value: "petg" },
      ],
    });
    expect(fields.prompt).toMatch(/1:1 wearable/);
    expect(fields.prompt).toMatch(/size L/);
    expect(fields.prompt).toMatch(/in PETG/);
    expect(fields.wearableSize).toBe("L");
    expect(fields.filament).toBe("petg");
  });
});

describe("plan parse + normalize", () => {
  it("seeds needs_user_choice + scale options for a character pack hit", () => {
    const plan = normalizeCadPlan(
      parseCadPlan(
        JSON.stringify({
          object: "part",
          one_piece: true,
          units: "mm",
          features: [],
          holes: [],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          sit_on_z0: true,
          needs_user_choice: true,
          options: [
            {
              id: "scale_mode",
              options: [{ id: "scale_mode:display", label: "Fit P2S", value: "display" }],
            },
          ],
        }),
      )!,
      { prompt: STORMTROOPER_HELMET_PROMPT },
    );
    expect(plan.needs_user_choice).toBe(true);
    expect(plan.options?.[0]?.id).toBe("scale_mode");
    expect(plan.options?.[0]?.options.map((option) => option.value)).toEqual(["display", "wearable"]);
  });

  it("does not mark a cube plan as needing a choice even if the LLM said so", () => {
    const plan = normalizeCadPlan(
      parseCadPlan(
        JSON.stringify({
          object: "cube",
          one_piece: true,
          units: "mm",
          features: [{ name: "body" }],
          holes: [{ d: 5 }],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          sit_on_z0: true,
          needs_user_choice: true,
        }),
      )!,
      { prompt: CUBE },
    );
    expect(plan.needs_user_choice).toBe(false);
    expect(plan.options).toBeUndefined();
  });
});
