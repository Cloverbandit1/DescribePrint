import type { MachineAdapter } from "./adapter";
import {
  BAMBU_SPEED_LEVELS,
  bambuSpeedLevelToPercent,
  percentToBambuSpeedLevel,
  physicalStepsForCommand,
  type BambuSpeedLevel,
} from "./bambu-protocol";
import type { CommandResult, MidPrintCommand } from "./types";
import { defaultPrinter, filamentPreset, isFilamentId, normalizeFilamentId, type FilamentId } from "../printers";

/**
 * Chat-first mid-print control. Whole-utterance match only so CAD prompts
 * ("pause the hinge clearance") stay on the generate path.
 *
 * Speed % maps onto Bambu `print_speed` levels 1–4:
 *   1 silent 50% · 2 standard 100% · 3 sport 124% · 4 ludicrous 166%
 */
export const MID_PRINT_CONTROL_ID = "mid-print-control";

export const CONNECT_LAN_FIRST =
  "Connect LAN first. Turn on LAN MQTT in the Machine panel and wait until the printer is connected.";

/** Same whole-utterance phrases as camera doctor chips. */
export const CAMERA_SLOW_DOWN_PHRASE = "slow down";
export const CAMERA_COOL_NOZZLE_PHRASE = "cool nozzle";

/** Cool-nozzle chip / chat: drop this many °C, then clamp to a material-safe floor. */
export const COOL_NOZZLE_DELTA_C = 10;
const PRESET_COOL_FLOOR_DELTA_C = 30;

export type MidPrintParseOptions = {
  material?: FilamentId | string;
  currentNozzleC?: number;
};

export type MidPrintIntent = {
  command: MidPrintCommand;
  /** Bambu print_speed tier when the phrase set speed. */
  speedLevel?: BambuSpeedLevel;
  label: string;
};

/** Material/preset floor so cool-nozzle never drops blindly below a printable min. */
export function coolNozzleSafeMinC(material: FilamentId = defaultPrinter().defaultFilament): number {
  const printer = defaultPrinter();
  const preset = filamentPreset(material, printer);
  return Math.max(printer.minNozzleC, preset.nozzleC - PRESET_COOL_FLOOR_DELTA_C);
}

export function coolNozzleTargetC(
  material?: FilamentId | string,
  currentNozzleC?: number,
): number {
  const printer = defaultPrinter();
  const filament = (typeof material === "string" && isFilamentId(material)
    ? material
    : normalizeFilamentId(material)) ?? printer.defaultFilament;
  const preset = filamentPreset(filament, printer);
  const base =
    currentNozzleC != null && Number.isFinite(currentNozzleC) && currentNozzleC > 0
      ? currentNozzleC
      : preset.nozzleC;
  return Math.max(Math.round(base - COOL_NOZZLE_DELTA_C), coolNozzleSafeMinC(filament));
}

const LEAD = /^(?:please\s+)?/i;

export function looksLikeMidPrintCommand(text: string): boolean {
  return parseMidPrintCommandPhrase(text) != null;
}

export function parseMidPrintCommandPhrase(
  text: string,
  opts?: MidPrintParseOptions,
): MidPrintIntent | null {
  const cleaned = normalizeUtterance(text);
  if (!cleaned) return null;

  if (isPausePhrase(cleaned)) {
    return { command: { type: "pause" }, label: "pause" };
  }
  if (isResumePhrase(cleaned)) {
    return { command: { type: "resume" }, label: "resume" };
  }

  const speed = parseSpeedPhrase(cleaned);
  if (speed) return speed;

  const temp = parseTempPhrase(cleaned, opts);
  if (temp) return temp;

  return null;
}

/** Nearest Bambu 1–4 tier for a percent (or a bare level 1–4). */
export function mapSpeedPercentToBambuTier(percent: number): {
  level: BambuSpeedLevel;
  percent: number;
  name: string;
} {
  const level = percentToBambuSpeedLevel(percent);
  const row = BAMBU_SPEED_LEVELS.find((entry) => entry.level === level) ?? BAMBU_SPEED_LEVELS[1];
  return { level: row.level, percent: row.percent, name: row.name };
}

export function mapSpeedLevelToPercent(level: BambuSpeedLevel): number {
  return bambuSpeedLevelToPercent(level) ?? 100;
}

export function describeMidPrintIntent(intent: MidPrintIntent): string {
  switch (intent.command.type) {
    case "pause":
      return "Safe pause. This is an explicit chat pause — reshape / doctor paths never auto-resume.";
    case "resume":
      return "Resume the live job. Only this explicit phrase sends resume — reshape stays manual.";
    case "set-speed": {
      const level = intent.speedLevel ?? percentToBambuSpeedLevel(intent.command.percent);
      const row = BAMBU_SPEED_LEVELS.find((entry) => entry.level === level);
      const name = row ? capitalize(row.name) : "Standard";
      return `Set print speed to ${intent.command.percent}% (Bambu ${name}, level ${level}).`;
    }
    case "set-nozzle-temp":
      return `Set nozzle to ${intent.command.celsius} °C. Large jumps pause first while a job is printing.`;
    case "set-bed-temp":
      return `Set bed to ${intent.command.celsius} °C. Large jumps pause first while a job is printing.`;
    default:
      return "Mid-print control.";
  }
}

export function midPrintSettingSummary(intent: MidPrintIntent): string {
  switch (intent.command.type) {
    case "pause":
      return "Pause now.";
    case "resume":
      return "Resume printing.";
    case "set-speed":
      return `Speed ${intent.command.percent}% (tier ${intent.speedLevel ?? percentToBambuSpeedLevel(intent.command.percent)}).`;
    case "set-nozzle-temp":
      return `Nozzle ${intent.command.celsius} °C.`;
    case "set-bed-temp":
      return `Bed ${intent.command.celsius} °C.`;
    default:
      return "Mid-print command.";
  }
}

/**
 * Send only when the selected adapter is already connected.
 * Disconnected → no send (mock does not record), clear LAN tip, no fake success.
 * Does not call connect — no surprise LAN.
 */
export async function sendMidPrintIfConnected(
  adapter: MachineAdapter,
  command: MidPrintCommand,
): Promise<CommandResult> {
  const status = await adapter.status();
  if (status.connection !== "connected") {
    return disconnectedMidPrintResult(command);
  }
  return adapter.send(command);
}

export function disconnectedMidPrintResult(command: MidPrintCommand): CommandResult {
  return {
    ok: false,
    pausedFirst: false,
    message: CONNECT_LAN_FIRST,
    physicalSteps: physicalStepsForCommand(command),
  };
}

function normalizeUtterance(text: string): string {
  return text.trim().replace(/[.!?]+$/g, "").trim();
}

function stripPlease(text: string): string {
  return text.replace(LEAD, "").trim();
}

function isPausePhrase(text: string): boolean {
  const body = stripPlease(text);
  return /^(?:pause(?:\s+now|\s+the\s+print|\s+this\s+print|\s+printing|\s+print)?)$/i.test(body);
}

function isResumePhrase(text: string): boolean {
  const body = stripPlease(text);
  return /^(?:resume(?:\s+(?:the\s+print|this\s+print|printing|print))?|continue\s+printing)$/i.test(body);
}

function parseSpeedPhrase(text: string): MidPrintIntent | null {
  const body = stripPlease(text);

  if (/^slow\s+down$/i.test(body)) {
    return speedIntent(1);
  }

  const named = body.match(
    /^(?:set\s+)?(?:print\s+)?speed\s+(silent|standard|sport|ludicrous)$/i,
  );
  if (named) {
    const name = named[1].toLowerCase();
    const row = BAMBU_SPEED_LEVELS.find((entry) => entry.name === name);
    return row ? speedIntent(row.level) : null;
  }

  const percent = body.match(
    /^(?:slow(?:\s+down)?\s+to|set\s+(?:print\s+)?speed(?:\s+to)?|(?:print\s+)?speed(?:\s+to)?)\s+(\d+)\s*%$/i,
  );
  if (percent) {
    const raw = Number(percent[1]);
    if (!Number.isFinite(raw)) return null;
    const mapped = mapSpeedPercentToBambuTier(raw);
    return speedIntent(mapped.level);
  }

  const tier = body.match(/^(?:set\s+)?(?:print\s+)?speed\s+(?:tier\s+)?([1-4])$/i);
  if (tier) {
    const level = Number(tier[1]) as BambuSpeedLevel;
    return speedIntent(level);
  }

  return null;
}

function parseTempPhrase(text: string, opts?: MidPrintParseOptions): MidPrintIntent | null {
  const body = stripPlease(text);
  if (/^cool(?:\s+the)?\s+nozzle(?:\s+-?10(?:\s*°?\s*c)?)?$/i.test(body)) {
    return {
      command: { type: "set-nozzle-temp", celsius: coolNozzleTargetC(opts?.material, opts?.currentNozzleC) },
      label: "nozzle-temp",
    };
  }
  const nozzle = body.match(
    /^(?:set\s+)?nozzle(?:\s+temp(?:erature)?)?(?:\s+to)?\s+(\d+)(?:\s*°?\s*c)?$/i,
  );
  if (nozzle) {
    const celsius = Number(nozzle[1]);
    if (!Number.isFinite(celsius)) return null;
    return {
      command: { type: "set-nozzle-temp", celsius },
      label: "nozzle-temp",
    };
  }
  const bed = body.match(/^(?:set\s+)?bed(?:\s+temp(?:erature)?)?(?:\s+to)?\s+(\d+)(?:\s*°?\s*c)?$/i);
  if (bed) {
    const celsius = Number(bed[1]);
    if (!Number.isFinite(celsius)) return null;
    return {
      command: { type: "set-bed-temp", celsius },
      label: "bed-temp",
    };
  }
  return null;
}

function speedIntent(level: BambuSpeedLevel): MidPrintIntent {
  return {
    command: { type: "set-speed", percent: mapSpeedLevelToPercent(level) },
    speedLevel: level,
    label: "speed",
  };
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
