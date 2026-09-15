/**
 * Print Control → CAD Core remaining-upper consumer.
 *
 * Calls the same `runCadReshapeUpper` entry the generate pipeline early-returns
 * to when `cadHandoff` is set (`POST /api/generate`). After a GenerateResult,
 * `cadFeedForReslice` attaches jobId/STL/3MF onto the reslice stub
 * (`sendGcode: false`). Does not rewrite CAD, etch, or send resume/gcode.
 */
import { cadFeedForReslice, runCadReshapeUpper } from "../cad-reshape";
import type { CadReshapeHandoff, CadReshapeUpperOutcome, ReslicePlanStub } from "./reshape-plan";
import type { GenerateResult } from "../types";

export type CadReshapeUpperConsumeInput = {
  handoff: CadReshapeHandoff;
  prompt?: string | null;
  previousCode?: string | null;
  previousPrompt?: string | null;
  previousJobId?: string | null;
  fixture?: boolean;
  reslice?: ReslicePlanStub;
};

export type CadReshapeUpperConsumer = (input: CadReshapeUpperConsumeInput) => Promise<GenerateResult>;

let consumerOverride: CadReshapeUpperConsumer | undefined;

/** Tests inject a mock so reshape orchestration does not compile OpenSCAD. */
export function setCadReshapeUpperConsumerForTests(consumer?: CadReshapeUpperConsumer): void {
  consumerOverride = consumer;
}

export function resetCadReshapeUpperConsumer(): void {
  consumerOverride = undefined;
}

async function defaultConsumeCadReshapeUpper(input: CadReshapeUpperConsumeInput): Promise<GenerateResult> {
  return runCadReshapeUpper({
    handoff: input.handoff,
    prompt: input.prompt,
    previousCode: input.previousCode,
    previousPrompt: input.previousPrompt,
    previousJobId: input.previousJobId,
    fixture: input.fixture ?? (process.env.NODE_ENV === "test" ? true : undefined),
    reslice: input.reslice,
  });
}

/** Invoke CAD Core's existing reshape-upper consumer. Never resumes. */
export async function invokeCadReshapeUpperConsumer(
  input: CadReshapeUpperConsumeInput,
): Promise<CadReshapeUpperOutcome> {
  try {
    const consume = consumerOverride ?? defaultConsumeCadReshapeUpper;
    const result = await consume(input);
    const resliceFeed = cadFeedForReslice(input.handoff, result, input.reslice);
    return { invoked: true, ok: true, result, resliceFeed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { invoked: true, ok: false, error };
  }
}
