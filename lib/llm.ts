import {
  getLlmConfig,
  isLocalOpenAiBaseUrl,
  LOCAL_AI_START_MESSAGE,
  type LlmConfig,
} from "./llm-config";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export { LOCAL_AI_START_MESSAGE } from "./llm-config";

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
  previousPrompt?: string;
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
  } else if (input.previousCode) {
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

export async function completeChat(messages: ChatMessage[], timeoutMs = 60_000): Promise<string> {
  const config = getLlmConfig();
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
        model: config.model,
        temperature: 0.2,
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
