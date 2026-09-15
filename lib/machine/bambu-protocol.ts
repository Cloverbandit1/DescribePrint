import { emptyAmsSlots } from "./adapter";
import type {
  AmsSlotStatus,
  LiveMachineStatus,
  MidPrintCommand,
  PrintState,
} from "./types";
import type { PrinterId } from "../printers";
import { normalizeFilamentId } from "../printers";

/**
 * Observed Bambu LAN MQTT (P2S / H2 / P / X, community + OpenBambuAPI):
 * TLS 8883, username `bblp`, password = LAN access code.
 * Subscribe `device/{serial}/report`, publish `device/{serial}/request`.
 * P2S also needs LAN Only + Developer Mode for control writes.
 */
export const BAMBU_REPORT_SUFFIX = "report";
export const BAMBU_REQUEST_SUFFIX = "request";

export type BambuSpeedLevel = 1 | 2 | 3 | 4;

export const BAMBU_SPEED_LEVELS: ReadonlyArray<{
  level: BambuSpeedLevel;
  percent: number;
  name: string;
}> = [
  { level: 1, percent: 50, name: "silent" },
  { level: 2, percent: 100, name: "standard" },
  { level: 3, percent: 124, name: "sport" },
  { level: 4, percent: 166, name: "ludicrous" },
];

export function bambuTopics(serial: string): { report: string; request: string } {
  const id = serial.trim();
  return {
    report: `device/${id}/${BAMBU_REPORT_SUFFIX}`,
    request: `device/${id}/${BAMBU_REQUEST_SUFFIX}`,
  };
}

export function nextSequenceId(n: number): string {
  return String(Math.max(1, Math.floor(n)));
}

export function buildPushAllRequest(sequenceId: string): Record<string, unknown> {
  return {
    pushing: {
      sequence_id: sequenceId,
      command: "pushall",
      version: 1,
      push_target: 1,
    },
  };
}

export function percentToBambuSpeedLevel(percent: number): BambuSpeedLevel {
  let best: BambuSpeedLevel = 2;
  let dist = Infinity;
  for (const row of BAMBU_SPEED_LEVELS) {
    const d = Math.abs(row.percent - percent);
    if (d < dist) {
      dist = d;
      best = row.level;
    }
  }
  return best;
}

export function bambuSpeedLevelToPercent(level: number | undefined): number | undefined {
  const row = BAMBU_SPEED_LEVELS.find((entry) => entry.level === level);
  return row?.percent;
}

export function buildBambuCommandPayload(command: MidPrintCommand, sequenceId: string): Record<string, unknown> {
  switch (command.type) {
    case "pause":
      return { print: { sequence_id: sequenceId, command: "pause", param: "" } };
    case "resume":
      return { print: { sequence_id: sequenceId, command: "resume", param: "" } };
    case "set-speed":
      return {
        print: {
          sequence_id: sequenceId,
          command: "print_speed",
          param: String(percentToBambuSpeedLevel(command.percent)),
        },
      };
    case "set-nozzle-temp":
      return {
        print: {
          sequence_id: sequenceId,
          command: "gcode_line",
          param: `M104 S${Math.round(command.celsius)}\n`,
        },
      };
    case "set-bed-temp":
      return {
        print: {
          sequence_id: sequenceId,
          command: "gcode_line",
          param: `M140 S${Math.round(command.celsius)}\n`,
        },
      };
  }
}

export function physicalStepsForCommand(command: MidPrintCommand): string[] {
  switch (command.type) {
    case "pause":
      return ["On the P2S screen, tap Pause."];
    case "resume":
      return ["On the P2S screen, tap Resume."];
    case "set-speed":
      return ["On the P2S screen, change the speed preset (Silent / Standard / Sport / Ludicrous)."];
    case "set-nozzle-temp":
      return [`On the P2S screen, set nozzle target to ${Math.round(command.celsius)} °C.`];
    case "set-bed-temp":
      return [`On the P2S screen, set bed target to ${Math.round(command.celsius)} °C.`];
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function mapGcodeState(state: string | undefined): PrintState {
  switch ((state ?? "").toUpperCase()) {
    case "RUNNING":
    case "PREPARE":
    case "SLICING":
      return "printing";
    case "PAUSE":
    case "PAUSED":
      return "paused";
    case "FINISH":
    case "FINISHED":
      return "finished";
    default:
      return "idle";
  }
}

export function trayColorToHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.trim().replace(/^#/, "");
  if (hex.length < 6 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

export function parseAmsSlots(print: JsonRecord, fallbackCount = 4): AmsSlotStatus[] {
  const amsRoot = asRecord(print.ams);
  const units = Array.isArray(amsRoot?.ams) ? amsRoot.ams : null;
  if (!units) return emptyAmsSlots(fallbackCount);

  const slots: AmsSlotStatus[] = [];
  for (const unitRaw of units) {
    const unit = asRecord(unitRaw);
    if (!unit) continue;
    const unitId = (asNumber(unit.id) ?? 0) + 1;
    const trays = Array.isArray(unit.tray) ? unit.tray : [];
    for (const trayRaw of trays) {
      const tray = asRecord(trayRaw);
      if (!tray) continue;
      const slot = (asNumber(tray.id) ?? 0) + 1;
      const filamentType = asString(tray.tray_type);
      const present = Boolean(filamentType);
      const remain = asNumber(tray.remain);
      slots.push({
        unit: unitId,
        slot,
        present,
        filamentType: present ? (normalizeFilamentId(filamentType) ?? filamentType) : undefined,
        colorHex: present ? trayColorToHex(asString(tray.tray_color)) : undefined,
        remainingPercent: present && remain != null ? Math.max(0, Math.min(100, remain)) : undefined,
        name: present ? asString(tray.tray_sub_brands) ?? asString(tray.tray_id_name) : undefined,
      });
    }
  }

  return slots.length ? slots : emptyAmsSlots(fallbackCount);
}

export function mergePrintReports(previous: JsonRecord | undefined, incoming: JsonRecord): JsonRecord {
  if (!previous) return { ...incoming };
  const merged: JsonRecord = { ...previous, ...incoming };
  if (incoming.ams) merged.ams = incoming.ams;
  return merged;
}

export function parseBambuPrintReport(
  payload: unknown,
  previousPrint?: JsonRecord,
): { print: JsonRecord; statusPatch: Partial<LiveMachineStatus> } | null {
  const root = asRecord(payload);
  const incoming = root ? asRecord(root.print) : null;
  if (!incoming) return null;
  const print = mergePrintReports(previousPrint, incoming);

  const layer = asNumber(print.layer_num);
  const totalLayers = asNumber(print.total_layer_num);
  const progress = asNumber(print.mc_percent);
  const spdMag = asNumber(print.spd_mag);
  const spdLvl = asNumber(print.spd_lvl);
  const gcodeState = asString(print.gcode_state);

  return {
    print,
    statusPatch: {
      print: mapGcodeState(gcodeState),
      nozzleTempC: asNumber(print.nozzle_temper),
      nozzleTargetC: asNumber(print.nozzle_target_temper),
      bedTempC: asNumber(print.bed_temper),
      bedTargetC: asNumber(print.bed_target_temper),
      layer,
      totalLayers,
      progressPercent: progress,
      speedPercent: spdMag ?? bambuSpeedLevelToPercent(spdLvl),
      amsSlots: parseAmsSlots(print),
    },
  };
}

export function applyStatusPatch(
  base: LiveMachineStatus,
  patch: Partial<LiveMachineStatus>,
  extras?: { adapterId?: string; printerId?: PrinterId; connection?: LiveMachineStatus["connection"]; message?: string },
): LiveMachineStatus {
  return {
    ...base,
    ...patch,
    ...extras,
    amsSlots: patch.amsSlots ?? base.amsSlots,
  };
}
