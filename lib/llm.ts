export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const SYSTEM_PROMPT = `You are a CAD assistant that writes OpenSCAD for FDM 3D printing.

Rules:
- Reply with ONLY OpenSCAD code (no markdown unless fenced as \`\`\`openscad).
- Units are millimeters. OpenSCAD is unitless; treat 1 unit = 1 mm.
- Produce a single manifold solid suitable for printing. Sit the part on z=0 when practical.
- Use $fn = 64 (or $fa/$fs) for curved surfaces. Do not exceed $fn = 96.
- Prefer cube(), cylinder(), sphere(), hull(), difference(), union(), intersection(), linear_extrude().
- Never use import(), include, use <>, surface(), or any file/network access.
- Keep wall thicknesses >= 1.2 mm and holes printable (diameter >= 2.5 mm unless the user asks smaller).
- Keep the part under 250 mm in any dimension unless the user asks otherwise.
- Do not add echo() debug spam. Do not generate animation or $t.
- If the request is ambiguous, pick reasonable everyday dimensions and still emit a printable part.
`;

export function buildUserPrompt(input: {
  prompt: string;
  sizeNote: string;
  previousError?: string;
  previousCode?: string;
}): string {
  const parts = [
    `Describe this object as OpenSCAD:`,
    input.prompt.trim(),
  ];
  if (input.sizeNote) {
    parts.push(input.sizeNote);
  }
  if (input.previousError) {
    parts.push(
      `The previous OpenSCAD failed. Fix it.`,
      `Error:\n${input.previousError.slice(0, 2500)}`,
    );
    if (input.previousCode) {
      parts.push(`Previous code:\n${input.previousCode.slice(0, 6000)}`);
    }
  }
  return parts.join("\n\n");
}

export function hasLiveLlm(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function completeChat(messages: ChatMessage[], timeoutMs = 60_000): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.MODEL?.trim() || "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 800)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error("LLM returned an empty completion");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}
