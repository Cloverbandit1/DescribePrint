/**
 * Structured AMS physical-step guides for Print doctor and autofix fallback.
 * Hands-on only — this module never sends LAN commands.
 */

import type { AmsHint } from "./types";

export type AmsHelpGuideId =
  | "ams-feed-loop"
  | "ams-load-failed"
  | "ams-spool-empty"
  | "ams-tangled-spool"
  | "ams-wet-pa"
  | "ams-ptfe-path";

export const AMS_HELP_GUIDE_IDS: readonly AmsHelpGuideId[] = [
  "ams-feed-loop",
  "ams-load-failed",
  "ams-spool-empty",
  "ams-tangled-spool",
  "ams-wet-pa",
  "ams-ptfe-path",
] as const;

export type AmsHelpGuide = {
  id: AmsHelpGuideId;
  symptom: string;
  slot?: number;
  steps: string[];
  whenToRetrySoftware?: string;
};

export type AmsHelpSelectInput = {
  defectId?: string;
  complaint?: string;
  hint?: Pick<AmsHint, "kind" | "slot">;
  slot?: number;
  remainingPercent?: number;
  material?: string;
};

type GuideTemplate = {
  symptom: string;
  steps: string[];
  whenToRetrySoftware?: string;
};

const SLOT_TOKEN = "{slot}";

const GUIDE_TEMPLATES: Record<AmsHelpGuideId, GuideTemplate> = {
  "ams-feed-loop": {
    symptom: "{slot} is cycling feed/unfeed — path, tip, or spool, not a CAD setting.",
    steps: [
      "Pause the job if it is still running. Do not keep tapping Retry on the P2S while {slot} loops.",
      "Open {slot} and pull the filament back so you can see the tip.",
      "Check the PTFE tube from {slot} to the toolhead for kinks, leftover filament, or a chewed stub.",
      "Make sure the spool on {slot} can turn freely and is not tangled or crushed on the cardboard core.",
      "If the tip is flattened or chewed, cut a fresh 45° tip, reseat it until the hub grips, then retry one feed.",
    ],
    whenToRetrySoftware: "After the path and tip are clear, retry a load on {slot} once from the printer. Do not keep looping.",
  },
  "ams-load-failed": {
    symptom: "{slot} failed to load filament.",
    steps: [
      "Pause if a print is waiting on {slot}.",
      "Confirm filament is seated in {slot} and the hub can grab it.",
      "Cut a fresh 45° tip (about 45 mm of clean filament) and discard the mashed end.",
      "Check the PTFE inlet at {slot} for a stub left from a previous unload.",
      "Retry the load once. If it fails again, treat it as a PTFE or tangle problem — do not keep auto-retrying.",
    ],
    whenToRetrySoftware: "Retry a load on {slot} only after the tip is fresh and the inlet is clear.",
  },
  "ams-spool-empty": {
    symptom: "{slot} is empty or the filament has run out.",
    steps: [
      "Confirm {slot} is actually empty (0% remaining or a bare spool core). Do not force another feed.",
      "Unload the empty spool from {slot} so the hub stops chewing air.",
      "Load a new spool of the same type into {slot}, or reassign the slot plan to a loaded tray.",
      "Seat a fresh 45° tip until the hub grips, then resume or reprint.",
    ],
    whenToRetrySoftware: "Retry a feed on {slot} only after a new spool is seated.",
  },
  "ams-tangled-spool": {
    symptom: "The spool on {slot} is tangled or will not turn.",
    steps: [
      "Pause. Lift the spool off {slot} so the hub is not fighting a knot.",
      "Unwind about a meter and look for over-wound loops under the wind or a crushed cardboard core.",
      "Rewind loosely so the spool turns freely on the AMS rollers.",
      "Reseat the spool in {slot}, feed a clean tip until the hub grips, then retry one load.",
    ],
    whenToRetrySoftware: "Retry a feed on {slot} only after the spool turns freely by hand.",
  },
  "ams-wet-pa": {
    symptom: "PA / nylon on {slot} looks wet — popping, brittle feed, or fuzzy walls.",
    steps: [
      "Pause long PA/nylon jobs. Wet nylon will keep snapping or grinding in {slot}.",
      "Move that spool to an AMS 2 Pro dryer or a dedicated dryer (typically 70–80 °C for several hours).",
      "Do not store PA open on {slot}. Bag it with desiccant when it is not printing.",
      "Keep the P2S door closed after drying. Reprint a small test cube before the long job.",
    ],
    whenToRetrySoftware: "Retry {slot} only after the spool has dried. Temperature tweaks will not fix wet PA.",
  },
  "ams-ptfe-path": {
    symptom: "The PTFE path from {slot} to the toolhead looks jammed or kinked.",
    steps: [
      "Pause. Do not keep commanding a feed into a jammed tube from {slot}.",
      "Disconnect the PTFE at the {slot} outlet and at the toolhead. Look for a stuck stub or a sharp bend.",
      "Push a short length of scrap filament through the tube. If it will not pass, replace that segment.",
      "Reseat both ends fully, then retry {slot} only.",
    ],
    whenToRetrySoftware: "Retry a load on {slot} only after scrap filament passes through the tube by hand.",
  },
};

const LOAD_FAILED_RE =
  /\b(can'?t\s+load|cannot\s+load|failed\s+to\s+load|load\s+failed|won'?t\s+load|not\s+loading)\b/i;
const SPOOL_EMPTY_RE = /\b(spool\s+empty|empty\s+spool|run-?out|ran\s+out|filament\s+ran\s+out|no\s+filament)\b/i;
const TANGLED_RE =
  /\b(tangl(?:e|ed|ing)|over-?wound)\b[\s\S]{0,24}\b(spool|ams|filament)\b|\b(spool|ams)\b[\s\S]{0,28}\b(tangl(?:e|ed|ing)|over-?wound|won'?t\s+turn)\b/i;
const PTFE_RE = /\b(ptfe|bowden|buffer\s+tube)\b/i;
const WET_PA_RE =
  /\b(?:wet\s+)?(?:pa(?:6|12|ht)?|nylon)\b[\s\S]{0,32}\b(wet|humid(?:ity)?|dryer|dry(?:ing)?)\b|\b(humid(?:ity)?|dryer)\b[\s\S]{0,24}\b(?:pa|nylon|ams)\b/i;
const FEED_LOOP_RE = /\b(loop(?:ing)?|feed\/?unfeed|unfeed|chew(?:ing|ed)?)\b/i;
const AMS_WORD_RE = /\bams\b/i;

export function isAmsHelpGuideId(value: string | undefined): value is AmsHelpGuideId {
  return Boolean(value && (AMS_HELP_GUIDE_IDS as readonly string[]).includes(value));
}

/** Prefer a live 1–4 (or 1–20) slot; otherwise leave wording generic. */
export function formatAmsSlotLabel(slot?: number): string {
  if (slot == null || !Number.isInteger(slot) || slot < 1 || slot > 20) return "that AMS slot";
  return `AMS ${slot}`;
}

export function resolveAmsHelpSlot(input: {
  diagnosisSlot?: number;
  complaintSlot?: number;
  hintSlot?: number;
  requestedSlot?: number;
}): number | undefined {
  const candidates = [input.requestedSlot, input.diagnosisSlot, input.complaintSlot, input.hintSlot];
  for (const slot of candidates) {
    if (slot != null && Number.isInteger(slot) && slot >= 1 && slot <= 20) return slot;
  }
  return undefined;
}

function interpolate(text: string, slotLabel: string): string {
  return text.split(SLOT_TOKEN).join(slotLabel);
}

export function buildAmsHelpGuide(id: AmsHelpGuideId, slot?: number): AmsHelpGuide {
  const template = GUIDE_TEMPLATES[id];
  const slotLabel = formatAmsSlotLabel(slot);
  return {
    id,
    symptom: interpolate(template.symptom, slotLabel),
    ...(slot != null ? { slot } : {}),
    steps: template.steps.map((step) => interpolate(step, slotLabel)),
    ...(template.whenToRetrySoftware
      ? { whenToRetrySoftware: interpolate(template.whenToRetrySoftware, slotLabel) }
      : {}),
  };
}

export function amsHelpPhysicalSteps(id: AmsHelpGuideId, slot?: number): string[] {
  return buildAmsHelpGuide(id, slot).steps;
}

export function selectAmsHelpGuideId(input: AmsHelpSelectInput = {}): AmsHelpGuideId | undefined {
  if (isAmsHelpGuideId(input.defectId)) return input.defectId;

  const complaint = input.complaint?.trim() ?? "";
  if (complaint) {
    if (FEED_LOOP_RE.test(complaint) && (AMS_WORD_RE.test(complaint) || /\b(feed|unfeed)\b/i.test(complaint))) {
      return "ams-feed-loop";
    }
    if (LOAD_FAILED_RE.test(complaint)) return "ams-load-failed";
    if (SPOOL_EMPTY_RE.test(complaint)) return "ams-spool-empty";
    if (TANGLED_RE.test(complaint)) return "ams-tangled-spool";
    if (PTFE_RE.test(complaint)) return "ams-ptfe-path";
    if (WET_PA_RE.test(complaint)) return "ams-wet-pa";
  }

  if (input.defectId === "wet-filament" && isPaLike(input.material, complaint)) {
    return "ams-wet-pa";
  }

  if (input.remainingPercent === 0) return "ams-spool-empty";

  if (input.hint?.kind === "feed-loop" || input.hint?.kind === "hopper-error") {
    return "ams-feed-loop";
  }

  return undefined;
}

export function selectAmsHelpGuide(input: AmsHelpSelectInput = {}): AmsHelpGuide | undefined {
  const id = selectAmsHelpGuideId(input);
  if (!id) return undefined;
  const slot = resolveAmsHelpSlot({
    diagnosisSlot: input.slot,
    hintSlot: input.hint?.slot,
  });
  return buildAmsHelpGuide(id, slot);
}

function isPaLike(material?: string, complaint = ""): boolean {
  const blob = `${material ?? ""} ${complaint}`.toLowerCase();
  return /\b(pa(?:6|12|ht)?|nylon)\b/.test(blob);
}
