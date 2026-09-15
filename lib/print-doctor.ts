import {
  defaultPrinter,
  filamentPreset,
  normalizeFilamentId,
  type FilamentId,
  type PrinterId,
} from "./printers";

export type PrintDoctorRequest = {
  complaint: string;
  printerId?: PrinterId;
  material?: FilamentId | string;
};

export type PrintDoctorFix = {
  kind: "setting" | "physical";
  summary: string;
  key?: string;
  value?: string | number;
  autoApplicable: boolean;
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
  fixes: PrintDoctorFix[];
  physicalSteps: string[];
  autofix?: PrintDoctorAutofix;
};

export function withAutofix(result: PrintDoctorResult, autofix: PrintDoctorAutofix): PrintDoctorResult {
  return { ...result, autofix };
}

type DefectRule = {
  id: string;
  title: string;
  re: RegExp;
  confidence: "high" | "medium";
};

const DEFECT_RULES: DefectRule[] = [
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
  /\b(stringing|warp(?:ing)?|ams|clog|jam|spaghetti|empty\s+bed|nozzle\s*scrape|layer\s*shift|under[-\s]?extrud|over[-\s]?extrud|elephant|first\s+layer|not stick|nozzle|bed temp|feed\/?unfeed|wisps?|blobs?|zits?|clicking|grinding)\b/i;

export function looksLikePrintDoctorComplaint(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  return DEFECT_RULES.some((rule) => rule.re.test(cleaned)) || DOCTOR_HINT.test(cleaned);
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

function physical(summary: string): PrintDoctorFix {
  return { kind: "physical", summary, autoApplicable: false };
}

function buildFixes(defectId: string, material: FilamentId): { fixes: PrintDoctorFix[]; steps: string[] } {
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
      return {
        fixes: [
          physical("This is almost always a path or spool problem, not a CAD setting."),
          setting("Pause the job before touching AMS tubes or swapping slots.", "pause", "now", false),
        ],
        steps: [
          "Pause if a print is running.",
          "Check the PTFE path from that AMS slot to the toolhead for kinks or leftover filament.",
          "Make sure the spool can turn freely and is not tangled or over-tight on the cardboard core.",
          "Reseat the filament in the slot until the hub grips, then retry a feed.",
          "If the tip is chewed or flattened, cut a fresh 45° tip and try again.",
        ],
      };
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
        ],
      };
    case "spaghetti":
      return {
        fixes: [
          physical("The part has left the plate. Remaining plastic is scrap."),
          setting("Pause or abort immediately.", "pause", "now", false),
        ],
        steps: ["Pause/abort, clear the spaghetti, clean the plate, and fix first-layer adhesion before reprinting."],
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
    case "wet-filament":
      return "Popping or fuzzy walls usually mean moisture. Dry the spool before chasing more temperature changes.";
    default:
      return "I could not match a specific P2S defect. Describe the symptom (stringing, warp, AMS loop, first layer) and the filament.";
  }
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
  const material = inferMaterial(`${request.material ?? ""} ${complaint}`, printer.defaultFilament);
  const amsSlot = extractAmsSlot(complaint);
  const rule = matchDefect(complaint);
  const defectId = rule?.id ?? "unknown";
  const { fixes, steps } = buildFixes(defectId, material);

  return {
    defectId,
    title: rule?.title ?? "Print problem",
    diagnosis: diagnosisFor(defectId, material, amsSlot),
    confidence: rule?.confidence ?? "low",
    printerId,
    material,
    amsSlot,
    fixes,
    physicalSteps: steps,
  };
}
