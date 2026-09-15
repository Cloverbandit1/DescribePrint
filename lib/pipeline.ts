import { checkMesh, hasHardMeshFailure } from "./mesh-check";
import { compileOpenScad, withTempDir } from "./compile";
import { createJob, toGenerateResult } from "./jobs";
import { defaultFixture, matchConversationFixture, matchFixture, shouldUseFixture } from "./fixtures";
import { getLlmConfig, getPlanModel, isLocalOpenAiBaseUrl, isSmartPipelineEnabled } from "./llm-config";
import {
  buildPlanPrompt,
  buildUserPrompt,
  completeChat,
  parseCadPlan,
  planSystemPrompt,
  systemPrompt,
  toUserFacingLlmError,
  type CadPlan,
} from "./llm";
import { sanitizeOpenScad } from "./sanitize";
import { parseStl } from "./stl";
import { meshTo3mf } from "./threemf";
import { describeSizeHint } from "./units";
import type { GenerateRequest, GenerateResult, StatusEvent } from "./types";

export type StatusSink = (event: StatusEvent) => void;

/** First compile plus this many smart repair attempts. */
export const MAX_COMPILE_RETRIES = 2;
export const MAX_COMPILE_ATTEMPTS = 1 + MAX_COMPILE_RETRIES;

function emit(sink: StatusSink | undefined, event: StatusEvent) {
  sink?.(event);
}

function requestSizeNote(request: GenerateRequest): string {
  return describeSizeHint(request.sizeHint, request.units ?? "mm");
}

async function planFromLlm(request: GenerateRequest): Promise<CadPlan | null> {
  const sizeNote = requestSizeNote(request);
  try {
    const raw = await completeChat(
      [
        { role: "system", content: planSystemPrompt() },
        {
          role: "user",
          content: buildPlanPrompt({
            prompt: request.prompt,
            sizeNote,
            previousCode: request.previousCode ?? undefined,
            previousPrompt: request.previousPrompt ?? undefined,
          }),
        },
      ],
      { model: getPlanModel(), temperature: 0.1 },
    );
    return parseCadPlan(raw);
  } catch (err) {
    throw toUserFacingLlmError(err);
  }
}

async function codeFromLlm(
  request: GenerateRequest,
  previous?: { code: string; error: string },
  plan?: CadPlan | null,
): Promise<string> {
  const sizeNote = requestSizeNote(request);
  try {
    return await completeChat([
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content: buildUserPrompt({
          prompt: request.prompt,
          sizeNote,
          previousCode: previous?.code ?? request.previousCode ?? undefined,
          previousError: previous?.error,
          previousPrompt: request.previousPrompt ?? undefined,
          plan,
        }),
      },
    ]);
  } catch (err) {
    throw toUserFacingLlmError(err);
  }
}

function codeFromFixture(request: GenerateRequest): { code: string; usedFixture: true } {
  const match =
    matchConversationFixture(
      request.prompt,
      request.previousPrompt,
      request.previousCode,
      request.sizeHint,
      request.units ?? "mm",
    ) ??
    matchFixture(request.prompt, request.sizeHint, request.units ?? "mm") ??
    defaultFixture();
  return { code: match.code, usedFixture: true };
}

async function compileAndCheck(code: string): Promise<{
  stl: Buffer;
  threemf: Buffer;
  report: ReturnType<typeof checkMesh>;
}> {
  return withTempDir(async (dir) => {
    const compiled = await compileOpenScad(code, dir);
    const mesh = parseStl(compiled.stl);
    const report = checkMesh(mesh);
    if (hasHardMeshFailure(report)) {
      const summary = report.issues
        .filter((i) => i.severity === "error")
        .map((i) => i.message)
        .join("; ");
      throw new Error(`Mesh check failed: ${summary}`);
    }
    const threemf = await meshTo3mf(mesh, "DescribePrint");
    return { stl: compiled.stl, threemf, report };
  });
}

export async function runGeneratePipeline(
  request: GenerateRequest,
  sink?: StatusSink,
): Promise<GenerateResult> {
  const prompt = request.prompt?.trim();
  if (!prompt) {
    throw new Error("Describe what to print first.");
  }

  const useFixture = shouldUseFixture(request.fixture);
  const usedFixture = useFixture;
  let retried = false;
  let code = "";
  let plan: CadPlan | null = null;

  emit(sink, { step: "planning", message: "Understanding your description…" });

  if (useFixture) {
    emit(sink, { step: "codegen", message: "Using the fixture / heuristic OpenSCAD path (no live API)…" });
    code = codeFromFixture(request).code;
  } else {
    const local = isLocalOpenAiBaseUrl(getLlmConfig().baseUrl);
    if (isSmartPipelineEnabled()) {
      emit(sink, {
        step: "planning",
        message: "Planning printable features and dimensions…",
      });
      plan = await planFromLlm(request);
      emit(sink, {
        step: "codegen",
        message: local
          ? "Asking local AI for OpenSCAD from the plan…"
          : "Asking the model for OpenSCAD from the plan…",
      });
    } else {
      emit(sink, {
        step: "codegen",
        message: local ? "Asking local AI for OpenSCAD…" : "Asking the model for OpenSCAD…",
      });
    }
    code = await codeFromLlm(request, undefined, plan);
  }

  const attempt = async (source: string, attemptNo: number) => {
    emit(sink, { step: "sanitize", message: "Validating generated code…", attempt: attemptNo });
    const sanitized = sanitizeOpenScad(source);
    if (!sanitized.ok) {
      throw new Error(sanitized.errors.join("; "));
    }

    emit(sink, { step: "compile", message: "Compiling OpenSCAD → STL…", attempt: attemptNo });
    emit(sink, { step: "mesh-check", message: "Checking mesh printability…", attempt: attemptNo });
    emit(sink, { step: "export", message: "Writing STL and 3MF…", attempt: attemptNo });
    const artifacts = await compileAndCheck(sanitized.code);
    return { code: sanitized.code, ...artifacts };
  };

  let artifacts: Awaited<ReturnType<typeof attempt>> | undefined;
  let lastCode = code;
  for (let attemptNo = 1; attemptNo <= MAX_COMPILE_ATTEMPTS; attemptNo++) {
    try {
      artifacts = await attempt(lastCode, attemptNo);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (useFixture || attemptNo === MAX_COMPILE_ATTEMPTS) {
        throw err;
      }
      retried = true;
      emit(sink, {
        step: "retry",
        message: `Compile failed — retrying with compiler feedback (${attemptNo + 1}/${MAX_COMPILE_ATTEMPTS})…`,
        attempt: attemptNo + 1,
      });
      lastCode = await codeFromLlm(request, { code: lastCode, error: message }, plan);
    }
  }

  if (!artifacts) {
    throw new Error("Generation failed");
  }

  const job = createJob({
    stl: artifacts.stl,
    threemf: artifacts.threemf,
    scad: artifacts.code,
    report: artifacts.report,
    usedFixture,
    retried,
  });

  emit(sink, { step: "done", message: "Ready to preview and download." });
  return toGenerateResult(job);
}
