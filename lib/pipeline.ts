import { checkMesh, hasHardMeshFailure } from "./mesh-check";
import { compileOpenScad, withTempDir } from "./compile";
import { createJob, toGenerateResult } from "./jobs";
import { defaultFixture, matchConversationFixture, matchFixture, shouldUseFixture } from "./fixtures";
import { buildUserPrompt, completeChat, systemPrompt } from "./llm";
import { sanitizeOpenScad } from "./sanitize";
import { parseStl } from "./stl";
import { meshTo3mf } from "./threemf";
import { describeSizeHint } from "./units";
import type { GenerateRequest, GenerateResult, StatusEvent } from "./types";

export type StatusSink = (event: StatusEvent) => void;

function emit(sink: StatusSink | undefined, event: StatusEvent) {
  sink?.(event);
}

async function codeFromLlm(request: GenerateRequest, previous?: { code: string; error: string }): Promise<string> {
  const sizeNote = describeSizeHint(request.sizeHint, request.units ?? "mm");
  const content = await completeChat([
    { role: "system", content: systemPrompt() },
    {
      role: "user",
      content: buildUserPrompt({
        prompt: request.prompt,
        sizeNote,
        previousCode: previous?.code ?? request.previousCode ?? undefined,
        previousError: previous?.error,
        previousPrompt: request.previousPrompt ?? undefined,
      }),
    },
  ]);
  return content;
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

  emit(sink, { step: "planning", message: "Understanding your description…" });

  if (useFixture) {
    emit(sink, { step: "codegen", message: "Using the fixture / heuristic OpenSCAD path (no live API)…" });
    code = codeFromFixture(request).code;
  } else {
    emit(sink, { step: "codegen", message: "Asking the model for OpenSCAD…" });
    code = await codeFromLlm(request);
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

  let artifacts: Awaited<ReturnType<typeof attempt>>;
  try {
    artifacts = await attempt(code, 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (useFixture) {
      throw err;
    }
    retried = true;
    emit(sink, {
      step: "retry",
      message: "First attempt failed — retrying once with compiler feedback…",
      attempt: 2,
    });
    const retryCode = await codeFromLlm(request, { code, error: message });
    artifacts = await attempt(retryCode, 2);
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
