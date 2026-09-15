import {
  buildAmsHelpGuide,
  isAmsHelpGuideId,
  selectAmsHelpGuideId,
  type AmsHelpGuide,
} from "./machine/ams-help";
import type { AmsHint } from "./machine/types";
import type { EmergencyRemainingReshapePlan } from "./machine/reshape-plan";
import {
  defaultPrinter,
  filamentPreset,
  isFilamentId,
  normalizeFilamentId,
  printPresetSummary,
  type FilamentId,
  type PrinterId,
} from "./printers";

export type PrintDoctorRequest = {
  complaint: string;
  printerId?: PrinterId;
  material?: FilamentId | string;
  /** Live 1-based AMS slot when status/plan already knows it. */
  amsSlot?: number;
  remainingPercent?: number;
  amsHint?: Pick<AmsHint, "kind" | "slot">;
};

export type PrintDoctorFix = {
  /** Stable id for feedback memory (`defectId:key` or `defectId:physical-n`). */
  id?: string;
  kind: "setting" | "physical";
  summary: string;
  key?: string;
  value?: string | number;
  autoApplicable: boolean;
};

export type DoctorFeedbackKind = "perfect" | "still-bad";

export type PrintDoctorMemoryHint = {
  preferredFixId?: string;
  rejectedFixIds?: string[];
};

export type PrintDoctorAutofix = {
  attempted: boolean;
  ok: boolean;
  pausedFirst: boolean;
  message: string;
  physicalSteps?: string[];
};

export type PrintDoctorResult = {
  defectId: string;
  title: string;
  diagnosis: string;
  confidence: "high" | "medium" | "low";
  printerId: PrinterId;
  material: FilamentId | string;
  amsSlot?: number;
  /** Structured AMS physical guide when the complaint or live hint is an AMS fault. */
  amsGuide?: AmsHelpGuide;
  fixes: PrintDoctorFix[];
  physicalSteps: string[];
  autofix?: PrintDoctorAutofix;
  reshape?: EmergencyRemainingReshapePlan;
  /** True when chat asked to switch to a material's auto-best table. */
  appliedPreset?: boolean;
  /** True when chat asked to put a role (accent/body) on an AMS tray. */
  appliedSlotPlan?: boolean;
  slotPlanAssignment?: { index: number; role?: string };
  /** True when a remembered Perfect for this printer + filament was applied. */
  learned?: boolean;
};

export function withAutofix(result: PrintDoctorResult, autofix: PrintDoctorAutofix): PrintDoctorResult {
  return { ...result, autofix };
}

export function withReshape(result: PrintDoctorResult, reshape: EmergencyRemainingReshapePlan): PrintDoctorResult {
  return { ...result, reshape };
}

const EMERGENCY_RESHAPE_RE =
  /\breshape\s+the\s+rest\b|\bemergency\s+reshape(?:\s+remaining(?:\s+layers)?)?\b|\breshape\s+remaining(?:\s+layers)?\b/i;

const CAMERA_CONFIRM_RE = /\b(yes|confirm(?:ed)?|go ahead)\b/i;
const CAMERA_TALK_RE = /\b(camera|suspected(?:\s+failure)?|failure)\b/i;

export function looksLikeEmergencyReshape(text: string): boolean {
  return EMERGENCY_RESHAPE_RE.test(text.trim());
}

/** Chat-first confirm of a camera suspected-failure, or an explicit reshape phrase. */
export function isEmergencyReshapeRequest(text: string, detect?: { kind?: string }): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (looksLikeEmergencyReshape(cleaned)) return true;
  const confirm = CAMERA_CONFIRM_RE.test(cleaned);
  if (!confirm) return false;
  if (CAMERA_TALK_RE.test(cleaned)) return true;
  return detect?.kind === "suspected-failure";
}

type DefectRule = {
  id: string;
  title: string;
  re: RegExp;
  confidence: "high" | "medium";
};

const DEFECT_RULES: DefectRule[] = [
  {
    id: "emergency-reshape",
    title: "Emergency remaining-layer reshape",
    re: EMERGENCY_RESHAPE_RE,
    confidence: "high",
  },
  {
    id: "ams-slot-assign",
    title: "AMS slot plan",
    re: /\b(?:use|assign|put)\s+ams\s*(?:#|slot\s*)?\d+\s+for\s+\w+/i,
    confidence: "high",
  },
  {
    id: "ams-feed-loop",
    title: "AMS feed / unfeed loop",
    re: /\bams\b[\s\S]{0,48}\b(loop(?:ing)?|feed|unfeed|reload|unload|chew)/i,
    confidence: "high",
  },
  {
    id: "ams-feed-loop",
    title: "AMS feed / unfeed loop",
    re: /\b(feed|unfeed|reload|unload)\b[\s\S]{0,40}\b(loop(?:ing)?|ams)\b/i,
    confidence: "high",
  },
  {
    id: "ams-load-failed",
    title: "AMS load failed",
    re: /\b(can'?t\s+load|cannot\s+load|failed\s+to\s+load|load\s+failed|won'?t\s+load|not\s+loading)\b/i,
    confidence: "high",
  },
  {
    id: "ams-spool-empty",
    title: "AMS spool empty / runout",
    re: /\b(spool\s+empty|empty\s+spool|run-?out|ran\s+out|filament\s+ran\s+out|no\s+filament)\b/i,
    confidence: "high",
  },
  {
    id: "ams-tangled-spool",
    title: "AMS tangled spool",
    re: /\b(tangl(?:e|ed|ing)|over-?wound)\b[\s\S]{0,24}\b(spool|ams|filament)\b|\b(spool|ams)\b[\s\S]{0,28}\b(tangl(?:e|ed|ing)|over-?wound|won'?t\s+turn)\b/i,
    confidence: "high",
  },
  {
    id: "ams-ptfe-path",
    title: "AMS PTFE path",
    re: /\b(ptfe|bowden|buffer\s+tube)\b/i,
    confidence: "high",
  },
  {
    id: "ams-wet-pa",
    title: "Wet PA / nylon",
    re: /\b(?:wet\s+)?(?:pa(?:6|12|ht)?|nylon)\b[\s\S]{0,32}\b(wet|humid(?:ity)?|dryer|dry(?:ing)?)\b|\b(humid(?:ity)?|dryer)\b[\s\S]{0,24}\b(?:pa|nylon|ams)\b/i,
    confidence: "high",
  },
  {
    id: "clog",
    title: "Nozzle clog or grind",
    re: /\b(clog|jam(?:med)?|nothing coming out|grinding|clicking extruder)\b/i,
    confidence: "high",
  },
  {
    id: "layer-shift",
    title: "Layer shift",
    re: /\blayer\s*shift|\bshifted\s+layers?\b|\bprint\s+jumped\b/i,
    confidence: "high",
  },
  {
    id: "spaghetti",
    title: "Spaghetti / print detached",
    re: /\bspaghetti\b|\bnest of (plastic|filament)\b|\bprint\s+(fell|detached|came off)\b/i,
    confidence: "high",
  },
  {
    id: "nozzle-scrape",
    title: "Nozzle scrape",
    re: /\bnozzle\s*scrape|\bscrape(?:d)?\s+(?:the\s+)?(?:bed|plate|nozzle)\b/i,
    confidence: "high",
  },
  {
    id: "empty-bed",
    title: "Empty bed / part off",
    re: /\bempty\s+bed\b|\bpart\s+(?:came\s+off|off the (?:bed|plate))\b/i,
    confidence: "high",
  },
  {
    id: "first-layer",
    title: "First-layer adhesion",
    re: /\bfirst\s+layer\b|\bnot stick(?:ing)?\b|\bwon'?t\s+stick\b|\bbad\s+adhesion\b/i,
    confidence: "high",
  },
  {
    id: "elephant-foot",
    title: "Elephant foot",
    re: /\belephant\s*foot\b|\bbulge at the base\b/i,
    confidence: "high",
  },
  {
    id: "warping",
    title: "Warping / corner lift",
    re: /\bwarp(?:ing)?\b|\bcorners?\s+lift|\blifting\s+corners?\b/i,
    confidence: "high",
  },
  {
    id: "stringing",
    title: "Stringing",
    re: /\bstringing\b|\bstrings between\b|\bwisps?\b|\bangel hair\b/i,
    confidence: "high",
  },
  {
    id: "under-extrusion",
    title: "Under-extrusion",
    re: /\bunder[-\s]?extrud|\bthin walls?\b|\bgaps? in (walls?|infill|layers?)\b|\bmissing\s+extrusion\b/i,
    confidence: "high",
  },
  {
    id: "over-extrusion",
    title: "Over-extrusion",
    re: /\bover[-\s]?extrud|\bblobs?\b|\bzits?\b|\btoo much plastic\b/i,
    confidence: "medium",
  },
  {
    id: "wet-filament",
    title: "Wet filament",
    re: /\bwet\s+filament\b|\bpopping\b|\bhiss(?:ing)?\b|\bneeds? dry(?:ing)?\b/i,
    confidence: "high",
  },
];

const DOCTOR_HINT =
  /\b(stringing|warp(?:ing)?|ams|clog|jam|spaghetti|empty\s+bed|nozzle\s*scrape|layer\s*shift|under[-\s]?extrud|over[-\s]?extrud|elephant|first\s+layer|not stick|nozzle|bed temp|feed\/?unfeed|wisps?|blobs?|zits?|clicking|grinding|run-?out|spool\s+empty|can'?t\s+load|ptfe)\b/i;

const MATERIAL_WORD = "petg|nylon|pla|abs|tpu|pa(?:6|12|ht)?|pa-?cf";
const MATERIAL_PRESET_RE = new RegExp(
  String.raw`\b(?:use|apply|switch(?:\s+to)?|set)\b[\s\S]{0,28}\b(?:${MATERIAL_WORD})\b[\s\S]{0,16}\b(?:settings?|presets?|defaults?)\b` +
    String.raw`|\bbest(?:\s+settings?)?\s+for\b[\s\S]{0,16}\b(?:${MATERIAL_WORD})\b` +
    String.raw`|\b(?:${MATERIAL_WORD})\b[\s\S]{0,12}\b(?:settings?|presets?)\b`,
  "i",
);

export function looksLikeMaterialPresetRequest(text: string): boolean {
  return MATERIAL_PRESET_RE.test(text.trim());
}

const AMS_SLOT_PLAN_RE = /\b(?:use|assign|put)\s+ams\s*(?:#|slot\s*)?(\d+)\s+for\s+(\w+)/i;

export function looksLikeAmsSlotPlanRequest(text: string): boolean {
  return AMS_SLOT_PLAN_RE.test(text.trim());
}

export function extractAmsSlotPlanAssignment(
  text: string,
): { index: number; role: string } | undefined {
  const match = text.match(AMS_SLOT_PLAN_RE);
  if (!match) return undefined;
  const slot = Number(match[1]);
  const role = (match[2] ?? "").trim().toLowerCase();
  if (!Number.isInteger(slot) || slot < 1 || slot > 20 || !role) return undefined;
  return { index: slot - 1, role };
}

export function looksLikePrintDoctorComplaint(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  return (
    DEFECT_RULES.some((rule) => rule.re.test(cleaned)) ||
    DOCTOR_HINT.test(cleaned) ||
    isEmergencyReshapeRequest(cleaned) ||
    looksLikeMaterialPresetRequest(cleaned) ||
    looksLikeAmsSlotPlanRequest(cleaned)
  );
}

const PERFECT_RE = /^(?:(?:that(?:'s| was)?\s+)?perfect|(?:that\s+)?worked(?:\s+perfectly)?)[.!]?$/i;
const STILL_BAD_RE = /^(?:still[\s-]?bad|didn'?t work|still broken)[.!]?$/i;
const THUMBS_UP_RE = /^(?:thumbs?\s*up|\u{1F44D})$/u;
const THUMBS_DOWN_RE = /^(?:thumbs?\s*down|\u{1F44E})$/u;

/** Short chat replies after a doctor diagnosis. Does not steal CAD prompts like "a perfect cube". */
export function looksLikeDoctorFeedback(text: string): DoctorFeedbackKind | undefined {
  const cleaned = text.trim();
  if (!cleaned) return undefined;
  if (PERFECT_RE.test(cleaned) || THUMBS_UP_RE.test(cleaned)) return "perfect";
  if (STILL_BAD_RE.test(cleaned) || THUMBS_DOWN_RE.test(cleaned)) return "still-bad";
  return undefined;
}

const NEXT_CAUSE: Record<string, string> = {
  stringing: "wet-filament",
  "wet-filament": "under-extrusion",
  "under-extrusion": "clog",
  "over-extrusion": "wet-filament",
  warping: "first-layer",
  "first-layer": "warping",
  "ams-feed-loop": "ams-ptfe-path",
  "ams-ptfe-path": "ams-tangled-spool",
  "ams-tangled-spool": "ams-load-failed",
  "ams-load-failed": "ams-spool-empty",
  "ams-spool-empty": "ams-wet-pa",
  "ams-wet-pa": "under-extrusion",
  clog: "ams-feed-loop",
  spaghetti: "first-layer",
  "empty-bed": "first-layer",
  "layer-shift": "spaghetti",
  "nozzle-scrape": "first-layer",
  "elephant-foot": "first-layer",
};

export function defectTitle(defectId: string): string {
  if (defectId === "material-preset") return "Auto-best settings";
  return DEFECT_RULES.find((rule) => rule.id === defectId)?.title ?? "Print problem";
}

export function nextDefectCause(defectId: string, rejectedDefectIds: string[] = []): string | undefined {
  const next = NEXT_CAUSE[defectId];
  if (!next || rejectedDefectIds.includes(next)) return undefined;
  return next;
}

export function tagFixes(defectId: string, fixes: PrintDoctorFix[]): PrintDoctorFix[] {
  return fixes.map((fix, index) => ({
    ...fix,
    id: fix.id ?? (fix.key ? `${defectId}:${fix.key}` : `${defectId}:physical-${index}`),
  }));
}

export function primaryFixId(result: PrintDoctorResult): string | undefined {
  return result.fixes[0]?.id;
}

export function applyLearnedFixes(
  result: PrintDoctorResult,
  hint?: PrintDoctorMemoryHint | null,
): PrintDoctorResult {
  const tagged = { ...result, fixes: tagFixes(result.defectId, result.fixes) };
  if (!hint) return tagged;
  const rejected = new Set((hint.rejectedFixIds ?? []).filter(Boolean));
  const preferredId = hint.preferredFixId && !rejected.has(hint.preferredFixId) ? hint.preferredFixId : undefined;
  const preferred = preferredId ? tagged.fixes.find((fix) => fix.id === preferredId) : undefined;
  const rest = tagged.fixes.filter((fix) => fix.id !== preferredId && !rejected.has(fix.id ?? ""));
  const fixes = preferred ? [preferred, ...rest] : rest;
  if (!preferred && fixes.length === tagged.fixes.length) return tagged;
  if (fixes.length === 0) {
    return {
      ...tagged,
      learned: Boolean(preferred),
      fixes: [
        {
          id: `${tagged.defectId}:physical-escalate`,
          kind: "physical",
          summary: "Inspect the live job by hand. No more setting or LAN changes from this step.",
          autoApplicable: false,
        },
      ],
    };
  }
  if (!preferred) return { ...tagged, fixes, learned: false };
  const material = String(tagged.material).toUpperCase();
  return {
    ...tagged,
    fixes,
    learned: true,
    diagnosis: `Last time this worked for ${material} on this printer. ${tagged.diagnosis}`,
  };
}

export function confirmPerfect(result: PrintDoctorResult): PrintDoctorResult {
  const tagged = applyLearnedFixes(result);
  const material = String(tagged.material).toUpperCase();
  return {
    ...tagged,
    learned: true,
    diagnosis: `Glad that helped. I’ll remember this ${tagged.title} fix for ${material} on this printer.`,
  };
}

export function diagnoseByDefectId(
  defectId: string,
  request: Pick<PrintDoctorRequest, "printerId" | "material" | "amsSlot"> = {},
): PrintDoctorResult {
  const printer = defaultPrinter();
  const printerId = request.printerId ?? printer.id;
  const sessionMaterial = isFilamentId(String(request.material ?? ""))
    ? (request.material as FilamentId)
    : normalizeFilamentId(request.material);
  const material = sessionMaterial ?? printer.defaultFilament;
  const { fixes, steps, guide } = buildFixes(defectId, material, request.amsSlot);
  const materialSwitch = defectId === "material-preset";
  return {
    defectId,
    title: defectTitle(defectId),
    diagnosis: diagnosisFor(defectId, material, request.amsSlot),
    confidence: defectId === "unknown" ? "low" : defectId === "over-extrusion" ? "medium" : "high",
    printerId,
    material,
    amsSlot: request.amsSlot,
    ...(guide ? { amsGuide: guide } : {}),
    fixes: tagFixes(defectId, fixes),
    physicalSteps: steps,
    appliedPreset: materialSwitch,
    appliedSlotPlan: defectId === "ams-slot-assign",
  };
}

/** After Still bad: next unused fix, else next likely cause, else physical steps. Never sends LAN. */
export function nextAfterRejected(
  last: PrintDoctorResult,
  hint: { rejectedFixIds?: string[]; rejectedDefectIds?: string[] } = {},
): PrintDoctorResult {
  const tagged = applyLearnedFixes(last);
  const rejectedFixIds = new Set((hint.rejectedFixIds ?? []).filter(Boolean));
  const remaining = tagged.fixes.filter((fix) => !rejectedFixIds.has(fix.id ?? ""));
  if (remaining.length > 0) {
    const escalatePhysical = remaining.every((fix) => fix.kind === "physical");
    return {
      ...tagged,
      learned: false,
      fixes: remaining,
      diagnosis: escalatePhysical
        ? "That setting change didn’t help. Next are physical checks — I’m not sending LAN commands."
        : "That didn’t land. Trying the next likely tweak for the same symptom.",
    };
  }
  const rejectedDefectIds = [...new Set([...(hint.rejectedDefectIds ?? []), tagged.defectId])];
  const nextId = nextDefectCause(tagged.defectId, rejectedDefectIds);
  if (nextId) {
    const next = diagnoseByDefectId(nextId, {
      printerId: tagged.printerId,
      material: tagged.material,
      amsSlot: tagged.amsSlot,
    });
    return {
      ...next,
      learned: false,
      diagnosis: `Still seeing the issue. Next likely cause: ${next.title}. ${next.diagnosis}`,
    };
  }
  return {
    ...tagged,
    learned: false,
    confidence: "low",
    fixes: [
      {
        id: `${tagged.defectId}:physical-escalate`,
        kind: "physical",
        summary: "Inspect the live job by hand. No more setting or LAN changes from this step.",
        autoApplicable: false,
      },
    ],
    diagnosis: "I’m out of setting tweaks for this symptom. Physical checks next — I’m not sending LAN commands.",
  };
}

export function inferMaterial(text: string, fallback: FilamentId = "pla"): FilamentId {
  return normalizeFilamentId(text) ?? fallback;
}

export function extractAmsSlot(text: string): number | undefined {
  const match = text.match(/\bams\s*(?:#|slot\s*)?(\d+)\b/i);
  if (!match) return undefined;
  const slot = Number(match[1]);
  return Number.isInteger(slot) && slot >= 1 && slot <= 20 ? slot : undefined;
}

function matchDefect(text: string): DefectRule | undefined {
  return DEFECT_RULES.find((rule) => rule.re.test(text));
}

function setting(
  summary: string,
  key: string,
  value: string | number,
  autoApplicable = true,
): PrintDoctorFix {
  return { kind: "setting", summary, key, value, autoApplicable };
}

function physical(summary: string, id?: string): PrintDoctorFix {
  return { kind: "physical", summary, autoApplicable: false, ...(id ? { id } : {}) };
}

function amsGuideFixes(defectId: string, amsSlot?: number): { fixes: PrintDoctorFix[]; steps: string[]; guide: AmsHelpGuide } {
  const guide = buildAmsHelpGuide(isAmsHelpGuideId(defectId) ? defectId : "ams-feed-loop", amsSlot);
  return {
    guide,
    fixes: [physical(guide.symptom, guide.id)],
    steps: guide.steps,
  };
}

function buildFixes(
  defectId: string,
  material: FilamentId,
  amsSlot?: number,
): { fixes: PrintDoctorFix[]; steps: string[]; guide?: AmsHelpGuide } {
  const preset = filamentPreset(material);

  switch (defectId) {
    case "stringing": {
      const cooler = Math.max(preset.nozzleC - (material === "petg" ? 10 : 5), 190);
      const retraction = Number((preset.retractionMm + 0.2).toFixed(1));
      return {
        fixes: [
          setting(`Drop nozzle to ${cooler} °C for ${preset.name} on the P2S.`, "nozzleC", cooler),
          setting(`Increase retraction to ${retraction} mm.`, "retractionMm", retraction),
          physical("Dry the spool if it has been open — wisps are often moisture, especially PETG."),
        ],
        steps: [
          "Unload and dry the filament (PETG/ABS/TPU especially).",
          "Wipe the nozzle, then retry a short retraction tower.",
        ],
      };
    }
    case "ams-feed-loop":
    case "ams-load-failed":
    case "ams-spool-empty":
    case "ams-tangled-spool":
    case "ams-wet-pa":
    case "ams-ptfe-path":
      return amsGuideFixes(defectId, amsSlot);
    case "warping":
      return {
        fixes: [
          setting(`Raise bed to ${Math.min(preset.bedC + 5, 110)} °C.`, "bedC", Math.min(preset.bedC + 5, 110)),
          setting("Add a brim for the next slice.", "brim", "on"),
          physical("Keep the P2S door closed. There is no active chamber heater — drafts still lift ABS corners."),
        ],
        steps: ["Wash the plate with dish soap, dry it, and do not move the part until the bed cools."],
      };
    case "first-layer":
      return {
        fixes: [
          setting(`Set bed to the ${preset.name} default ${preset.bedC} °C.`, "bedC", preset.bedC),
          setting("Slow the first layer to 50% for the next slice.", "firstLayerSpeedPercent", 50),
        ],
        steps: [
          "Clean the plate.",
          "Confirm the live first-layer offset is not printing in air.",
          "If the skirt will not stick, pause and re-level / reset z-offset on the printer.",
        ],
      };
    case "elephant-foot":
      return {
        fixes: [
          setting(`Lower bed 5 °C from ${preset.bedC} °C.`, "bedC", Math.max(preset.bedC - 5, 0)),
          setting("Enable elephant-foot compensation on the next slice.", "elephantFootMm", 0.15),
        ],
        steps: ["Let the plate cool before removing the part so the base is not still soft."],
      };
    case "under-extrusion":
      return {
        fixes: [
          setting(`Nudge flow to ${preset.flowPercent + 2}%.`, "flowPercent", preset.flowPercent + 2),
          setting(`Confirm nozzle is ${preset.nozzleC} °C for ${preset.name}.`, "nozzleC", preset.nozzleC),
          physical("If AMS is clicking, treat it as a partial clog or wet filament — dry or cold-pull."),
        ],
        steps: ["Check the nozzle for a partial clog. Dry the spool. Confirm the AMS slot is the filament you think it is."],
      };
    case "over-extrusion":
      return {
        fixes: [
          setting(`Drop flow to ${preset.flowPercent - 3}%.`, "flowPercent", preset.flowPercent - 3),
          setting(`Drop nozzle 5 °C to ${preset.nozzleC - 5} °C.`, "nozzleC", preset.nozzleC - 5),
        ],
        steps: ["If blobs remain after a flow tweak, clean the nozzle and check for a worn PTFE tip."],
      };
    case "clog":
      return {
        fixes: [
          physical("Do not keep pushing temperature — heat-soak and a cold pull beat another +20 °C."),
          setting("Pause before any extruder work.", "pause", "now", false),
        ],
        steps: [
          "Pause.",
          "Heat the nozzle to the material default, push a little filament by hand, then cool and cold-pull.",
          "If AMS will not feed, cut a fresh tip and retry that slot only.",
        ],
      };
    case "layer-shift":
      return {
        fixes: [
          physical("A shift is a mechanical hit or lost steps. Software cannot un-shift printed layers."),
          setting("Pause now if the job is still running.", "pause", "now", false),
        ],
        steps: [
          "Pause or abort.",
          "Check for a crashed toolhead, loose belt, or a part that popped loose and was hit.",
          "Re-home and reprint; do not keep printing a shifted stack.",
          "Emergency reshape of remaining layers is a later option (flag off by default).",
        ],
      };
    case "spaghetti":
      return {
        fixes: [
          physical("The part has left the plate. Remaining plastic is scrap."),
          setting("Pause or abort immediately.", "pause", "now", false),
        ],
        steps: [
          "Pause/abort, clear the spaghetti, clean the plate, and fix first-layer adhesion before reprinting.",
          "Emergency reshape of remaining layers is a later option (flag off by default).",
        ],
      };
    case "nozzle-scrape":
      return {
        fixes: [
          physical("Check z-offset and whether the toolhead crashed into the plate."),
          setting("Pause before inspecting the nozzle or bed.", "pause", "now", false),
        ],
        steps: [
          "Pause.",
          "Check z-offset and a crashed toolhead before reprinting.",
          "Clear any gouged plastic from the plate.",
        ],
      };
    case "empty-bed":
      return {
        fixes: [
          physical("The plate looks empty — the part may have come off."),
          setting("Pause and inspect the plate before reprinting.", "pause", "now", false),
        ],
        steps: [
          "Pause.",
          "Inspect the plate and find the part.",
          "Clean the plate and fix first-layer adhesion before reprinting.",
        ],
      };
    case "emergency-reshape":
      return {
        fixes: [
          physical("Pause, then redesign only the unprinted upper. Resume is manual — CAD Core owns the new mesh."),
          setting("Pause now if a job is still running.", "pause", "now", false),
        ],
        steps: [
          "Pause the live job.",
          "Hand remaining height H and current Z to CAD Core — redesign unprinted upper above Z.",
          "Reslice the new remainder for the P2S. Do not send gcode from this stub.",
          "Resume is manual.",
        ],
      };
    case "wet-filament":
      return {
        fixes: [
          physical("Dry the spool before changing temperatures again."),
          setting(`After drying, return to the ${preset.name} default ${preset.nozzleC} °C.`, "nozzleC", preset.nozzleC),
        ],
        steps: [
          "Dry in an AMS 2 Pro / dryer if you have one, or a dedicated dryer.",
          "Reprint a small test cube before a long job.",
        ],
      };
    case "ams-slot-assign":
      return {
        fixes: [
          setting("Update the AMS slot plan. Advisory export metadata only — not a LAN command.", "amsSlot", "plan"),
          physical("Load that tray if the printer is disconnected. The 3MF keeps the mapping."),
        ],
        steps: [
          "The slot plan is written into 3MF metadata and the project-pack sidecar.",
          "This does not send filament-change commands over LAN.",
        ],
      };
    case "material-preset": {
      const summary = printPresetSummary(material);
      return {
        fixes: [
          setting(
            `Apply ${preset.name} auto-best: ${preset.nozzleC} °C nozzle / ${preset.bedC} °C bed.`,
            "material",
            preset.id,
          ),
          setting(
            `Speed tier ${summary.speedTier} (~${preset.printSpeedMms} mm/s), ${summary.coolingHint}.`,
            "speedTier",
            summary.speedTier,
          ),
          physical(preset.notes ?? "Advisory defaults for the next slice — not sent to the printer."),
        ],
        steps: [
          "These are panel + export defaults only. They are not pushed over LAN/MQTT.",
          "Dry PA/PETG/ABS before a long job. Keep the P2S door closed for PA and ABS.",
        ],
      };
    }
    default:
      return {
        fixes: [physical("Not enough detail to auto-apply a setting. Inspect the live job, then describe the defect.")],
        steps: [
          "Note material, AMS slot, and whether the nozzle/bed are at target.",
          "If the printer is making a risky move (jam, grind, spaghetti), pause first.",
        ],
      };
  }
}

function diagnosisFor(defectId: string, material: FilamentId, amsSlot?: number): string {
  const slotBit = amsSlot != null ? `AMS ${amsSlot}` : "the AMS slot";
  switch (defectId) {
    case "stringing":
      return material === "petg"
        ? "PETG on the P2S commonly strings when the nozzle is hot or the spool is damp. Cool a little, add a touch of retraction, and dry the filament."
        : `${material.toUpperCase()} strings when travel is wet or the nozzle is a few degrees high. Lower temp slightly and increase retraction.`;
    case "ams-feed-loop":
      return `${slotBit} is cycling feed/unfeed. That is a path, tip, or spool-tangle fault — software cannot clear a physical jam.`;
    case "ams-load-failed":
      return `${slotBit} did not load. Check the tip, hub grip, and PTFE inlet before retrying once.`;
    case "ams-spool-empty":
      return `${slotBit} looks empty or has run out. Load a new spool or pick another tray — do not force another feed.`;
    case "ams-tangled-spool":
      return `The spool on ${slotBit} is tangled or will not turn. Unwind it by hand before retrying a feed.`;
    case "ams-ptfe-path":
      return `The PTFE path from ${slotBit} to the toolhead looks jammed or kinked. Clear it by hand — software cannot push through a stub.`;
    case "ams-wet-pa":
      return `PA / nylon on ${slotBit} is likely wet. Dry the spool before chasing temperature or another AMS retry.`;
    case "warping":
      return `${material.toUpperCase()} corners are lifting. On the P2S (no active chamber heater) raise the bed a little, add a brim, and keep the door closed.`;
    case "first-layer":
      return "The first layer is not sticking. Clean the plate and confirm bed temp / z-offset before reprinting.";
    case "elephant-foot":
      return "The first layers are squashed. Cool the bed slightly or add elephant-foot compensation on the next slice.";
    case "under-extrusion":
      return "Too little plastic is landing. Check flow, nozzle temp, moisture, and a partial clog before reprinting.";
    case "over-extrusion":
      return "Too much plastic is landing. Drop flow a few percent and cool the nozzle slightly.";
    case "clog":
      return "The extruder is not pushing filament cleanly. Pause, then clear the nozzle or AMS path by hand.";
    case "layer-shift":
      return "Layers jumped. Pause — already-printed plastic cannot be shifted back. Check a crash or loose belt, then reprint.";
    case "spaghetti":
      return "The print left the plate. Pause or abort; do not keep extruding into air.";
    case "nozzle-scrape":
      return "Suspected nozzle scrape. Pause and check z-offset / a crashed toolhead before reprinting.";
    case "empty-bed":
      return "The bed looks empty — the part may have come off. Pause and inspect the plate.";
    case "emergency-reshape":
      return "You asked to reshape the unprinted remainder. When RESHAPE_REMAINING is on, Print Control pauses and emits a CAD-handoff + reslice plan. Resume is manual. CAD Core owns the new mesh. When the flag is off this stays a later option — no pause and no live plan.";
    case "wet-filament":
      return "Popping or fuzzy walls usually mean moisture. Dry the spool before chasing more temperature changes.";
    case "ams-slot-assign":
      return amsSlot != null
        ? `Use AMS ${amsSlot} for that filament in the slot plan. Advisory metadata only — not sent over LAN.`
        : "Updated the AMS slot plan. Advisory metadata only — not sent over LAN.";
    case "material-preset":
      return `Applied ${material.toUpperCase()} auto-best settings for the P2S (advisory — not sent over LAN).`;
    default:
      return "I could not match a specific P2S defect. Describe the symptom (stringing, warp, AMS loop, first layer) and the filament.";
  }
}

export function diagnosisFromAmsHint(
  hint?: Pick<AmsHint, "kind" | "slot" | "message">,
  extras?: { remainingPercent?: number; material?: FilamentId | string },
): PrintDoctorResult | undefined {
  if (!hint) return undefined;
  if (hint.kind !== "feed-loop" && hint.kind !== "hopper-error") return undefined;
  const slotBit = hint.slot != null ? `AMS ${hint.slot}` : "AMS";
  return diagnosePrintComplaint({
    complaint: hint.message?.trim() || `${slotBit} feed/unfeed loop`,
    amsSlot: hint.slot,
    remainingPercent: extras?.remainingPercent,
    amsHint: hint,
    material: extras?.material,
  });
}

export function diagnosisFromCameraDetect(
  detect: { kind: string; failure?: string } | undefined,
): PrintDoctorResult | undefined {
  if (!detect || detect.kind !== "suspected-failure" || !detect.failure) return undefined;
  const complaint =
    detect.failure === "spaghetti"
      ? "spaghetti, print detached"
      : detect.failure === "nozzle-scrape"
        ? "nozzle scrape"
        : detect.failure === "empty-bed"
          ? "empty bed"
          : "";
  if (!complaint) return undefined;
  return diagnosePrintComplaint({ complaint });
}

export function diagnosePrintComplaint(request: PrintDoctorRequest): PrintDoctorResult {
  const printer = defaultPrinter();
  const printerId = request.printerId ?? printer.id;
  const complaint = request.complaint.trim();
  const sessionMaterial = isFilamentId(String(request.material ?? ""))
    ? (request.material as FilamentId)
    : normalizeFilamentId(request.material);
  const fallback = sessionMaterial ?? printer.defaultFilament;
  const material = inferMaterial(`${request.material ?? ""} ${complaint}`, fallback);
  const complaintSlot = extractAmsSlot(complaint);
  const slotAssignment = extractAmsSlotPlanAssignment(complaint);
  const amsSlot =
    request.amsSlot ?? (slotAssignment ? slotAssignment.index + 1 : undefined) ?? complaintSlot ?? request.amsHint?.slot;
  const rule = matchDefect(complaint);
  const materialSwitch = !rule && looksLikeMaterialPresetRequest(complaint);
  let defectId = rule?.id ?? (materialSwitch ? "material-preset" : "unknown");
  const selectedGuideId = selectAmsHelpGuideId({
    defectId,
    complaint,
    hint: request.amsHint,
    slot: amsSlot,
    remainingPercent: request.remainingPercent,
    material,
  });
  if (selectedGuideId && (defectId === "unknown" || defectId === "wet-filament" || isAmsHelpGuideId(defectId))) {
    defectId = selectedGuideId;
  }
  const { fixes, steps, guide } = buildFixes(defectId, material, amsSlot);
  const amsGuide = guide ?? (isAmsHelpGuideId(defectId) ? buildAmsHelpGuide(defectId, amsSlot) : undefined);

  return {
    defectId,
    title: defectTitle(defectId),
    diagnosis: diagnosisFor(defectId, material, slotAssignment ? slotAssignment.index + 1 : amsSlot),
    confidence: rule?.confidence ?? (materialSwitch ? "high" : selectedGuideId ? "high" : "low"),
    printerId,
    material,
    amsSlot: slotAssignment ? slotAssignment.index + 1 : amsSlot,
    ...(amsGuide ? { amsGuide } : {}),
    fixes: tagFixes(defectId, fixes),
    physicalSteps: amsGuide?.steps ?? steps,
    appliedPreset: materialSwitch,
    appliedSlotPlan: defectId === "ams-slot-assign",
    ...(slotAssignment ? { slotPlanAssignment: slotAssignment } : {}),
  };
}
