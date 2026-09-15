import {
  getLlmConfig,
  getLlmTimeoutMs,
  isLocalOpenAiBaseUrl,
  LOCAL_AI_START_MESSAGE,
  type LlmConfig,
} from "./llm-config";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompleteChatOptions = {
  timeoutMs?: number;
  model?: string;
  temperature?: number;
};

export type CadPlan = {
  object: string;
  one_piece: boolean;
  units: "mm";
  overall_mm?: { x: number; y: number; z: number };
  features: Array<{
    name: string;
    kind?: string;
    dims_mm?: Record<string, number>;
    notes?: string;
  }>;
  holes: Array<{ d: number; purpose?: string }>;
  min_wall_mm: number;
  clearance_mm: number;
  sit_on_z0: boolean;
  safety_notes?: string;
};

export { LOCAL_AI_START_MESSAGE } from "./llm-config";

const SYSTEM_PROMPT = `You are a CAD assistant that writes OpenSCAD for FDM 3D printing.

Reply with ONLY OpenSCAD code (no markdown unless fenced as \`\`\`openscad). No commentary.

Units and output
- Units are millimeters. OpenSCAD is unitless; treat 1 unit = 1 mm. Never invent inches or "OpenSCAD units".
- Produce a single manifold solid suitable for slicing. Prefer one piece first (union overlapping solids). Split only if the user clearly needs an assembly.
- Sit the part on z=0 (build plate) when practical. Keep the positive-Z up orientation printable without supports when a simple redesign can avoid them.
- Keep the part under 250 mm in any dimension unless the user asks otherwise.

Printable engineering
- Minimum wall thickness 1.6 mm (1.2 mm only if the user insists and the feature is short).
- Through-holes diameter >= 2.5 mm unless the user asks smaller; add 0.3–0.4 mm clearance on holes meant to fit a real fastener or shaft.
- Snap / press / sliding fits: leave 0.2–0.4 mm clearance per side. Do not design interference that cannot print.
- Avoid zero-thickness faces, knife edges, and non-manifold boolean leftovers. Difference() cutters should fully pierce the host solid (overshoot by 0.2–1 mm).
- Prefer fillets/chamfers only when they stay printable (no tiny unsupported overhangs).
- If the request is mechanically ambiguous, pick everyday real-world dimensions and still emit a printable part.

OpenSCAD best practices
- Use $fn = 64 (or $fa/$fs) for curves. Do not exceed $fn = 96.
- Prefer cube(), cylinder(), sphere(), hull(), difference(), union(), intersection(), linear_extrude(), rotate_extrude().
- Name parameters at the top (size, wall, hole_d, …) so follow-up edits are easy.
- Never use import(), include, use <>, surface(), or any file/network access.
- Do not add echo() debug spam. Do not generate animation or $t.
- Valid syntax only: every statement ends with ';'. Balance braces and parentheses. Define modules before calling them.

Safety
- Do not design weapons, explosives, lock-defeat tools, or other harmful devices.
- If asked for unsafe or nonsense geometry, do not lecture. Quietly emit a safe, useful printable alternative that matches the spirit of the request (e.g. a paperweight, bracket, or toy-safe shape) with ordinary walls and no sharp weaponized features.
`;

const PLAN_SYSTEM_PROMPT = `You are a CAD planner for FDM 3D printing. Reply with ONLY compact JSON (no markdown, no prose).

Schema:
{"object":string,"one_piece":true,"units":"mm","overall_mm":{"x":n,"y":n,"z":n},"features":[{"name":string,"kind":string,"dims_mm":{"…":n},"notes":string}],"holes":[{"d":n,"purpose":string}],"min_wall_mm":n,"clearance_mm":n,"sit_on_z0":true,"safety_notes":string}

Rules:
- Millimeters only. Real-world dimensions. One piece first.
- min_wall_mm >= 1.6 unless the user insists thinner. clearance_mm ~ 0.3 for fits.
- If the request is unsafe or nonsense, plan a safe printable alternative and note it in safety_notes. Do not refuse in words — plan the safe part.
- Keep the JSON short. No OpenSCAD in this pass.
`;

const REPAIR_HEADER = `The previous OpenSCAD failed to compile or pass mesh checks. Repair it.

Reply with ONLY corrected OpenSCAD (no markdown unless fenced as \`\`\`openscad).`;

export const REPAIR_INSTRUCTIONS = `Fix instructions:
1. Read the error. Fix that exact syntax, undefined name, or mesh issue first.
2. Common OpenSCAD pitfalls: missing ';', unbalanced { } ( ), using '=' where you need a value, calling a module before it is defined, polyhedron face winding, difference() cutters that do not fully pierce.
3. Keep 1 unit = 1 mm. Result must be a single manifold solid on z=0 when practical.
4. Walls >= 1.6 mm. Holes printable. No import/include/use/surface.
5. Prefer the smallest change that compiles and stays printable. Preserve the user's design intent and any plan dimensions.
6. If the old design cannot be repaired cleanly, rewrite a simpler one-piece solid that still matches the request.`;

export function classifyCompileIssue(error: string): string[] {
  const hints: string[] = [];
  const text = error ?? "";
  if (/syntax|parser|unexpected|missing ;|WARNING: Ignoring unknown|ERROR:/i.test(text)) {
    hints.push("Fix the syntax or unknown token at the reported line; check semicolons and braces.");
  }
  if (/undefined|not defined|unknown variable|unknown module/i.test(text)) {
    hints.push("Define every variable and module before use.");
  }
  if (/\bimport\b|\binclude\b|\buse\b|surface\(/i.test(text)) {
    hints.push("Remove filesystem calls; rebuild with cube/cylinder/sphere primitives.");
  }
  if (/manifold|mesh check|non-manifold|zero.volume|empty mesh|no-triangles/i.test(text)) {
    hints.push(
      "Ensure a single closed solid: union overlapping parts, extend subtractors through faces, avoid zero-thickness shells.",
    );
  }
  if (/timeout|timed out/i.test(text)) {
    hints.push("Simplify geometry; keep $fn at 48–64; avoid huge minkowski() or deep recursion.");
  }
  return hints;
}

export function buildRepairPrompt(input: {
  error: string;
  previousCode?: string;
  plan?: CadPlan | null;
}): string {
  const parts = [REPAIR_HEADER, REPAIR_INSTRUCTIONS];
  const hints = classifyCompileIssue(input.error);
  if (hints.length) {
    parts.push(`Error-specific hints:\n- ${hints.join("\n- ")}`);
  }
  parts.push(`Error:\n${input.error.slice(0, 2500)}`);
  if (input.plan) {
    parts.push(`Design plan (keep these dimensions):\n${JSON.stringify(input.plan)}`);
  }
  if (input.previousCode) {
    parts.push(`Previous code:\n${input.previousCode.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export function buildUserPrompt(input: {
  prompt: string;
  sizeNote: string;
  previousError?: string;
  previousCode?: string;
  previousPrompt?: string;
  plan?: CadPlan | null;
}): string {
  if (input.previousError) {
    const repair = buildRepairPrompt({
      error: input.previousError,
      previousCode: input.previousCode,
      plan: input.plan,
    });
    const parts = [repair, `User request:\n${input.prompt.trim()}`];
    if (input.sizeNote) parts.push(input.sizeNote);
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    return parts.join("\n\n");
  }

  const parts = [`Describe this object as OpenSCAD:`, input.prompt.trim()];
  if (input.sizeNote) {
    parts.push(input.sizeNote);
  }
  if (input.plan) {
    parts.push(`Design plan (follow these features and millimeters):\n${JSON.stringify(input.plan)}`);
  }
  if (input.previousCode) {
    parts.push(
      `This is a follow-up in an ongoing design conversation. Edit the existing printable part to match the user's latest request. Add, remove, or change features as asked. Start from scratch only if they clearly want a new object.`,
    );
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    parts.push(`Current OpenSCAD:\n${input.previousCode.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export function buildPlanPrompt(input: {
  prompt: string;
  sizeNote: string;
  previousPrompt?: string;
  previousCode?: string;
}): string {
  const parts = [`Plan this printable part as compact JSON.`, `User request:\n${input.prompt.trim()}`];
  if (input.sizeNote) parts.push(input.sizeNote);
  if (input.previousCode) {
    parts.push(
      `This is a follow-up edit. Update the plan; do not start over unless they want a new object.`,
    );
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    parts.push(`Current OpenSCAD (for context, do not rewrite it here):\n${input.previousCode.slice(0, 3000)}`);
  }
  return parts.join("\n\n");
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

export function parseCadPlan(raw: string): CadPlan | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const object = asString(rec.object) ?? asString(rec.title) ?? asString(rec.name);
  const rawFeatures = Array.isArray(rec.features) ? rec.features : [];
  const features = rawFeatures.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const f = item as Record<string, unknown>;
    const name = asString(f.name);
    if (!name) return [];
    const dims: Record<string, number> = {};
    if (f.dims_mm && typeof f.dims_mm === "object" && !Array.isArray(f.dims_mm)) {
      for (const [key, value] of Object.entries(f.dims_mm as Record<string, unknown>)) {
        const n = asFiniteNumber(value);
        if (n !== undefined) dims[key] = n;
      }
    }
    return [
      {
        name,
        kind: asString(f.kind),
        dims_mm: Object.keys(dims).length ? dims : undefined,
        notes: asString(f.notes),
      },
    ];
  });
  if (!object && features.length === 0) return null;

  const rawHoles = Array.isArray(rec.holes) ? rec.holes : [];
  const holes = rawHoles.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const h = item as Record<string, unknown>;
    const d = asFiniteNumber(h.d) ?? asFiniteNumber(h.diameter);
    if (d === undefined || d <= 0) return [];
    return [{ d, purpose: asString(h.purpose) }];
  });

  let overall_mm: CadPlan["overall_mm"];
  if (rec.overall_mm && typeof rec.overall_mm === "object" && !Array.isArray(rec.overall_mm)) {
    const o = rec.overall_mm as Record<string, unknown>;
    const x = asFiniteNumber(o.x);
    const y = asFiniteNumber(o.y);
    const z = asFiniteNumber(o.z);
    if (x !== undefined && y !== undefined && z !== undefined) {
      overall_mm = { x, y, z };
    }
  }

  const minWall = asFiniteNumber(rec.min_wall_mm) ?? 1.6;
  const clearance = asFiniteNumber(rec.clearance_mm) ?? 0.3;

  return {
    object: object ?? "part",
    one_piece: rec.one_piece !== false,
    units: "mm",
    overall_mm,
    features,
    holes,
    min_wall_mm: minWall >= 1.2 ? minWall : 1.6,
    clearance_mm: clearance > 0 ? clearance : 0.3,
    sit_on_z0: rec.sit_on_z0 !== false,
    safety_notes: asString(rec.safety_notes),
  };
}

export function hasLiveLlm(): boolean {
  return Boolean(getLlmConfig().apiKey);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      "cause" in err && err.cause !== undefined
        ? ` ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : "";
    return `${err.name} ${err.message}${cause}`;
  }
  return String(err);
}

function isUnreachableError(err: unknown): boolean {
  const text = errorText(err);
  return /fetch failed|failed to fetch|econnrefused|enotfound|econnreset|ehostunreach|enetunreach|socket|networkerror|network error|aborted|aborterror|und_err|connect (e|timeout)|other side closed/i.test(
    text,
  );
}

export function toUserFacingLlmError(err: unknown, config: LlmConfig = getLlmConfig()): Error {
  if (err instanceof Error && err.message === LOCAL_AI_START_MESSAGE) {
    return err;
  }
  if (isLocalOpenAiBaseUrl(config.baseUrl) && isUnreachableError(err)) {
    return new Error(LOCAL_AI_START_MESSAGE);
  }
  if (err instanceof Error) {
    const line = firstLine(err.message);
    if (isLocalOpenAiBaseUrl(config.baseUrl) && /econnrefused|fetch failed|failed to fetch/i.test(line)) {
      return new Error(LOCAL_AI_START_MESSAGE);
    }
    return new Error(line || LOCAL_AI_START_MESSAGE);
  }
  return new Error(isLocalOpenAiBaseUrl(config.baseUrl) ? LOCAL_AI_START_MESSAGE : "LLM request failed");
}

function normalizeChatOptions(timeoutMsOrOptions?: number | CompleteChatOptions): CompleteChatOptions {
  if (typeof timeoutMsOrOptions === "number") {
    return { timeoutMs: timeoutMsOrOptions };
  }
  return timeoutMsOrOptions ?? {};
}

export async function completeChat(
  messages: ChatMessage[],
  timeoutMsOrOptions?: number | CompleteChatOptions,
): Promise<string> {
  const options = normalizeChatOptions(timeoutMsOrOptions);
  const config = getLlmConfig();
  const timeoutMs = options.timeoutMs ?? getLlmTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Ollama’s /v1 API: Bearer + JSON only. Do not send OpenAI-Organization /
    // OpenAI-Project headers — they are unused and some local servers reject extras.
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? config.model,
        temperature: options.temperature ?? 0.2,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      if (
        isLocalOpenAiBaseUrl(config.baseUrl) &&
        (response.status === 502 ||
          response.status === 503 ||
          response.status === 504 ||
          /connection refused|dial tcp|no such host|connect: /i.test(body))
      ) {
        throw new Error(LOCAL_AI_START_MESSAGE);
      }
      const snippet = firstLine(body).slice(0, 240);
      throw new Error(
        snippet
          ? `LLM request failed (${response.status}): ${snippet}`
          : `LLM request failed (${response.status})`,
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string } | string;
    };
    if (data.error) {
      const msg = typeof data.error === "string" ? data.error : data.error.message;
      throw new Error(firstLine(msg ?? "LLM returned an error"));
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error("LLM returned an empty completion");
    }
    return content;
  } catch (err) {
    throw toUserFacingLlmError(err, config);
  } finally {
    clearTimeout(timer);
  }
}

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function planSystemPrompt(): string {
  return PLAN_SYSTEM_PROMPT;
}
