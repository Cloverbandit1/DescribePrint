/**
 * Failure-photo replay stub (Print Control).
 *
 * Maps a filename, alt text, or one-line hint onto an existing Print doctor
 * symptom. No pixel analysis, no vision ML. A later classifier can replace
 * the keyword table — do not invent a cause from bytes here.
 *
 * CAD repair is a suggestion only. This module never imports fit-wizard,
 * part-library, reshape/CAD generate, etch, or lattice.
 */

import { defaultPrinter } from "../printers";
import { diagnosePrintComplaint, type PrintDoctorResult } from "../print-doctor";

export type FailurePhotoKind = "spaghetti" | "scrape" | "empty-bed" | "ams-feed-loop" | "stringing" | "unknown";

export type FailurePhotoCadSuggestion = "try reshape remaining" | "print doctor settings";

export type FailurePhotoInput = {
  filename?: string;
  /** Caption, alt text, or the optional one-line hint. */
  hint?: string;
  mime?: string;
};

export type FailurePhotoReplay = {
  kind: FailurePhotoKind;
  doctorSymptom: string;
  confidence: "stub";
  cadSuggestion?: FailurePhotoCadSuggestion;
  ask?: string;
};

export const FAILURE_PHOTO_ASK =
  "Add a one-line hint (spaghetti, scrape, empty bed, AMS loop). This stub does not invent a cause from the photo.";

export const FAILURE_PHOTO_NOTE =
  "Filename or a one-line hint — not vision. Maps to Print doctor. Stub.";

const SYMPTOM: Record<Exclude<FailurePhotoKind, "unknown">, string> = {
  spaghetti: "spaghetti, print detached",
  scrape: "nozzle scrape",
  "empty-bed": "empty bed",
  "ams-feed-loop": "AMS feed/unfeed loop",
  stringing: "stringing",
};

const CAD_SUGGESTION: Record<Exclude<FailurePhotoKind, "unknown">, FailurePhotoCadSuggestion> = {
  spaghetti: "try reshape remaining",
  scrape: "print doctor settings",
  "empty-bed": "try reshape remaining",
  "ams-feed-loop": "print doctor settings",
  stringing: "print doctor settings",
};

type MapRule = { re: RegExp; kind: Exclude<FailurePhotoKind, "unknown"> };

/** First match wins. Underscores / dashes are treated as spaces. */
const MAP_RULES: MapRule[] = [
  { re: /\bspaghetti\b/i, kind: "spaghetti" },
  { re: /\bstringing\b/i, kind: "stringing" },
  { re: /\bblob\b/i, kind: "spaghetti" },
  { re: /\bstring\b/i, kind: "spaghetti" },
  { re: /\bscrape\b/i, kind: "scrape" },
  { re: /\bcrash\b/i, kind: "scrape" },
  { re: /\bempty\b/i, kind: "empty-bed" },
  { re: /\bnothing\b/i, kind: "empty-bed" },
  { re: /\bams\b/i, kind: "ams-feed-loop" },
  { re: /\bloop\b/i, kind: "ams-feed-loop" },
];

function fileStem(filename?: string): string {
  if (!filename?.trim()) return "";
  const base = filename.trim().replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

/** Normalize filename / hint so `spaghetti_blob.jpg` tokenizes as words. */
export function failurePhotoHaystack(input: FailurePhotoInput): string {
  const stem = fileStem(input.filename);
  const hint = input.hint?.trim() ?? "";
  return [stem, hint]
    .filter(Boolean)
    .join(" ")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchKind(haystack: string): Exclude<FailurePhotoKind, "unknown"> | undefined {
  if (!haystack) return undefined;
  return MAP_RULES.find((rule) => rule.re.test(haystack))?.kind;
}

/**
 * Classify a failed-print photo from filename / caption / hint only.
 * `mime` is accepted for a later real classify hook and is not used here.
 */
export function replayFailurePhoto(input: FailurePhotoInput = {}): FailurePhotoReplay {
  void input.mime;
  const kind = matchKind(failurePhotoHaystack(input));
  if (!kind) {
    return {
      kind: "unknown",
      doctorSymptom: "",
      confidence: "stub",
      ask: FAILURE_PHOTO_ASK,
    };
  }
  return {
    kind,
    doctorSymptom: SYMPTOM[kind],
    confidence: "stub",
    cadSuggestion: CAD_SUGGESTION[kind],
  };
}

const CAD_PROMPT_RE =
  /\d+\s*(?:mm|in)\b|\b(cube|hole|stand|diameter|fillet|hinge|knob|drawer|phone|vase|helmet|armor)\b/i;

/**
 * Short chat caption that the stub can map (e.g. "crash", "nothing on bed").
 * Does not steal CAD describe prompts or material-preset phrases.
 */
export function looksLikeFailurePhotoCaption(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > 48) return false;
  if (CAD_PROMPT_RE.test(cleaned)) return false;
  return replayFailurePhoto({ hint: cleaned }).kind !== "unknown";
}

export function failurePhotoAskResult(): PrintDoctorResult {
  const printer = defaultPrinter();
  return {
    defectId: "unknown",
    title: "Failed photo (stub)",
    diagnosis: FAILURE_PHOTO_ASK,
    confidence: "low",
    printerId: printer.id,
    material: printer.defaultFilament,
    fixes: [],
    physicalSteps: [],
  };
}

export function annotateFailurePhotoDiagnosis(
  result: PrintDoctorResult,
  replay: FailurePhotoReplay,
): PrintDoctorResult {
  if (replay.kind === "unknown") return result;
  const stub = /failed photo \(stub\)/i.test(result.diagnosis)
    ? result.diagnosis
    : `Failed photo (stub). ${result.diagnosis}`;
  const suggestion = replay.cadSuggestion
    ? stub.includes(replay.cadSuggestion)
      ? stub
      : `${stub} Suggestion: ${replay.cadSuggestion} — not running CAD.`
    : stub;
  return { ...result, diagnosis: suggestion };
}

/** Run the existing Print doctor path from a stub classify. Unknown → undefined (ask, no fake cause). */
export function diagnosisFromFailurePhoto(
  input: FailurePhotoInput,
  extras?: { printerId?: PrintDoctorResult["printerId"]; material?: string },
): PrintDoctorResult | undefined {
  const replay = replayFailurePhoto(input);
  if (replay.kind === "unknown") return undefined;
  const result = diagnosePrintComplaint({
    complaint: replay.doctorSymptom,
    printerId: extras?.printerId,
    material: extras?.material,
  });
  return annotateFailurePhotoDiagnosis(result, replay);
}

export function formatFailurePhotoUserLine(input: FailurePhotoInput): string {
  const name = input.filename?.trim().replace(/\\/g, "/").split("/").pop();
  const hint = input.hint?.trim();
  if (name && hint) return `Failed photo (stub): ${name} — ${hint}`;
  if (name) return `Failed photo (stub): ${name}`;
  if (hint) return `Failed photo (stub): ${hint}`;
  return "Failed photo (stub)";
}

/** Compile-time / test helper — this stub must not pull CAD fit-wizard, part-library, or generate. */
export function failurePhotoOwnsPrintControlOnly(): true {
  return true;
}
