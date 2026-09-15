import { describe, expect, it } from "vitest";
import {
  EMPTY_KNOWLEDGE_PACK,
  PETG_TECH_PROMPT,
  STORMTROOPER_HELMET_PROMPT,
  UNKNOWN_CHARACTER_PROMPT,
  cadKnowledgeFromPrompt,
  formatKnowledgeConstraints,
  formatKnowledgeNote,
  knowledgeOverallMm,
  loadKnowledgePack,
  matchKnowledge,
  mergeKnowledgeFeatures,
  validateKnowledgePack,
  wantsWearableScale,
} from "@/lib/knowledge";
import { buildPlanPrompt, buildUserPrompt, normalizeCadPlan, parseCadPlan, planSystemPrompt, systemPrompt } from "@/lib/llm";

const shipped = loadKnowledgePack();

describe("knowledge pack schema", () => {
  it("validates the shipped curated stub", () => {
    const result = validateKnowledgePack(shipped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.meta.kind).toBe("describeprint-knowledge-pack");
    expect(result.pack.meta.live_web_crawl).toBe(false);
    expect(result.pack.meta.curated).toBe(true);
    expect(result.pack.characters.length).toBeGreaterThanOrEqual(4);
    expect(result.pack.tech.some((entry) => entry.id === "petg")).toBe(true);
    expect(result.pack.characters.some((entry) => entry.id === "stormtrooper-helmet")).toBe(true);
  });

  it("rejects a pack that claims to be a live crawl", () => {
    const result = validateKnowledgePack({
      ...shipped,
      meta: { ...shipped.meta, live_web_crawl: true },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === "meta.live_web_crawl")).toBe(true);
  });

  it("fails open to an empty pack when JSON is garbage", () => {
    expect(loadKnowledgePack({ nope: true })).toEqual(EMPTY_KNOWLEDGE_PACK);
    expect(matchKnowledge(STORMTROOPER_HELMET_PROMPT, EMPTY_KNOWLEDGE_PACK).characters).toEqual([]);
  });
});

describe("character + tech matching", () => {
  it("pulls pack display dims for a known character", () => {
    const match = matchKnowledge(STORMTROOPER_HELMET_PROMPT);
    expect(match.characters.map((entry) => entry.id)).toEqual(["stormtrooper-helmet"]);
    const trooper = match.characters[0]!;
    expect(knowledgeOverallMm(STORMTROOPER_HELMET_PROMPT)).toEqual(trooper.printable_mm);
    expect(trooper.printable_mm).toEqual({ x: 165, y: 195, z: 200 });
    const features = mergeKnowledgeFeatures(STORMTROOPER_HELMET_PROMPT, []);
    expect(features.map((feature) => feature.name)).toEqual(expect.arrayContaining(["dome", "visor", "neck_ring"]));
    expect(features.find((feature) => feature.name === "visor")?.dims_mm?.w).toBe(110);
  });

  it("uses 1:1 reference millimeters when the user asks wearable / life-size", () => {
    expect(wantsWearableScale("wearable 1:1 stormtrooper helmet")).toBe(true);
    const trooper = matchKnowledge("wearable stormtrooper helmet").characters[0]!;
    expect(knowledgeOverallMm("wearable stormtrooper helmet")).toEqual(trooper.reference_mm);
    expect(trooper.reference_mm.z).toBeGreaterThan(256);
  });

  it("does not crash or attach a character for an unknown name", () => {
    const match = matchKnowledge(UNKNOWN_CHARACTER_PROMPT);
    expect(match.characters).toEqual([]);
    expect(knowledgeOverallMm(UNKNOWN_CHARACTER_PROMPT, { x: 40, y: 40, z: 40 })).toEqual({
      x: 40,
      y: 40,
      z: 40,
    });
    expect(cadKnowledgeFromPrompt(UNKNOWN_CHARACTER_PROMPT)).toBeUndefined();
    expect(formatKnowledgeNote(cadKnowledgeFromPrompt(UNKNOWN_CHARACTER_PROMPT))).toBe("");
    expect(() =>
      normalizeCadPlan(
        {
          object: "helmet",
          one_piece: true,
          units: "mm",
          features: [],
          holes: [],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          sit_on_z0: true,
        },
        { prompt: UNKNOWN_CHARACTER_PROMPT },
      ),
    ).not.toThrow();
  });

  it("enriches plan notes for a tech keyword", () => {
    const match = matchKnowledge(PETG_TECH_PROMPT);
    expect(match.characters).toEqual([]);
    expect(match.tech.map((entry) => entry.id)).toContain("petg");
    const knowledge = cadKnowledgeFromPrompt(PETG_TECH_PROMPT);
    expect(knowledge?.tech.some((hit) => hit.id === "petg")).toBe(true);
    expect(knowledge?.notes.join(" ")).toMatch(/PETG/i);
    expect(knowledge?.notes.join(" ")).toMatch(/0\.2 mm layer/i);
    expect(knowledge?.notes.join(" ")).toMatch(/Dry the spool/i);
    expect(formatKnowledgeNote(knowledge)).toMatch(/PETG/i);
  });

  it("replaces an implausibly tiny LLM overall with pack dims", () => {
    expect(knowledgeOverallMm(STORMTROOPER_HELMET_PROMPT, { x: 20, y: 20, z: 20 })).toEqual({
      x: 165,
      y: 195,
      z: 200,
    });
  });

  it("keeps a user-stated large size instead of forcing pack display dims", () => {
    expect(knowledgeOverallMm("150mm stormtrooper helmet", { x: 150, y: 160, z: 155 })).toEqual({
      x: 150,
      y: 160,
      z: 155,
    });
  });
});

describe("SMART_PIPELINE plan wiring", () => {
  it("documents the pack in planner + codegen prompts", () => {
    expect(planSystemPrompt()).toMatch(/omit the knowledge object unless/i);
    expect(planSystemPrompt()).toMatch(/not a live web crawl/i);
    expect(systemPrompt()).toMatch(/Knowledge pack/i);
    expect(formatKnowledgeConstraints()).toMatch(/stormtrooper/i);
  });

  it("injects pack dims into the plan prompt for a known character", () => {
    const prompt = buildPlanPrompt({ prompt: STORMTROOPER_HELMET_PROMPT, sizeNote: "" });
    expect(prompt).toContain("stormtrooper-helmet");
    expect(prompt).toMatch(/165/);
    expect(prompt).toMatch(/not a live web crawl/i);
  });

  it("omits pack excerpts when the character is unknown", () => {
    const prompt = buildPlanPrompt({ prompt: UNKNOWN_CHARACTER_PROMPT, sizeNote: "" });
    expect(prompt).not.toContain("stormtrooper-helmet");
    expect(prompt).not.toContain("vader-helmet");
    expect(prompt).not.toMatch(/Curated knowledge pack/);
  });

  it("normalizeCadPlan seeds pack dims and features for a known character", () => {
    const raw = parseCadPlan(
      JSON.stringify({
        object: "part",
        one_piece: true,
        units: "mm",
        features: [],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        sit_on_z0: true,
      }),
    );
    const plan = normalizeCadPlan(raw!, { prompt: STORMTROOPER_HELMET_PROMPT });
    expect(plan.object).toBe("stormtrooper helmet");
    expect(plan.overall_mm).toEqual({ x: 165, y: 195, z: 200 });
    expect(plan.features.some((feature) => feature.name === "visor" && feature.dims_mm?.w === 110)).toBe(true);
    expect(plan.knowledge?.characters[0]?.id).toBe("stormtrooper-helmet");
    expect(plan.knowledge?.live_web_crawl).toBe(false);
    expect(plan.knowledge?.notes.join(" ")).toMatch(/165×195×200/i);
    expect(plan.needs_user_choice).toBe(true);
    expect(plan.options?.some((group) => group.id === "scale_mode")).toBe(true);
  });

  it("normalizeCadPlan leaves unknown characters without knowledge", () => {
    const raw = parseCadPlan(
      JSON.stringify({
        object: "helmet",
        one_piece: true,
        units: "mm",
        overall_mm: { x: 80, y: 80, z: 90 },
        features: [{ name: "shell" }],
        holes: [],
        min_wall_mm: 1.6,
        clearance_mm: 0.3,
        sit_on_z0: true,
      }),
    );
    const plan = normalizeCadPlan(raw!, { prompt: UNKNOWN_CHARACTER_PROMPT });
    expect(plan.knowledge).toBeUndefined();
    expect(plan.overall_mm).toEqual({ x: 80, y: 80, z: 90 });
    expect(plan.features).toHaveLength(1);
  });

  it("embeds knowledge in the codegen prompt when the plan has a pack hit", () => {
    const plan = normalizeCadPlan(
      parseCadPlan(
        JSON.stringify({
          object: "helmet",
          one_piece: true,
          units: "mm",
          features: [],
          holes: [],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          sit_on_z0: true,
        }),
      )!,
      { prompt: STORMTROOPER_HELMET_PROMPT },
    );
    const prompt = buildUserPrompt({
      prompt: STORMTROOPER_HELMET_PROMPT,
      sizeNote: "",
      plan,
    });
    expect(prompt).toMatch(/Knowledge pack v1/);
    expect(prompt).toContain("165");
    expect(prompt).toMatch(/not a live web crawl/i);
  });

  it("enriches a PETG plan with tech notes and does not invent a character", () => {
    const plan = normalizeCadPlan(
      parseCadPlan(
        JSON.stringify({
          object: "cube",
          one_piece: true,
          units: "mm",
          overall_mm: { x: 20, y: 20, z: 20 },
          features: [{ name: "body", dims_mm: { s: 20 } }],
          holes: [{ d: 5 }],
          min_wall_mm: 1.6,
          clearance_mm: 0.3,
          sit_on_z0: true,
        }),
      )!,
      { prompt: PETG_TECH_PROMPT },
    );
    expect(plan.knowledge?.characters).toEqual([]);
    expect(plan.knowledge?.tech.some((hit) => hit.id === "petg")).toBe(true);
    expect(plan.overall_mm).toEqual({ x: 20, y: 20, z: 20 });
    expect(plan.knowledge?.notes.join(" ")).toMatch(/PETG/i);
  });
});
