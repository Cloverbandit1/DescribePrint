import type { FilamentId, PrinterId } from "../printers";

export type AmsHintKind = "none" | "feed-loop" | "hopper-error";

export type AmsHint = {
  kind: AmsHintKind;
  slot?: number;
  amsStatus?: number;
  message?: string;
};

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type PrintState = "idle" | "printing" | "paused" | "finished";

export type MachineCredentials = {
  host: string;
  serial: string;
  accessCode: string;
};

export type AmsSlotStatus = {
  unit: number;
  slot: number;
  present: boolean;
  filamentType?: FilamentId | string;
  colorHex?: string;
  remainingPercent?: number;
  name?: string;
};

export type LiveMachineStatus = {
  adapterId: string;
  printerId: PrinterId;
  /** Farm registry id when status comes from the selected machine. */
  machineId?: string;
  connection: ConnectionState;
  print: PrintState;
  message?: string;
  nozzleTempC?: number;
  nozzleTargetC?: number;
  bedTempC?: number;
  bedTargetC?: number;
  layer?: number;
  totalLayers?: number;
  progressPercent?: number;
  currentHeightMm?: number;
  objectHeightMm?: number;
  /** Injected or derived unprinted height. Mock tests can set this directly. */
  remainingHeightMm?: number;
  /** Live layer height when the report or mock exposes it. Never invent from remaining layer count. */
  layerHeightMm?: number;
  speedPercent?: number;
  amsSlots: AmsSlotStatus[];
  /** Live AMS hopper / feed-loop hint when the report exposes it. */
  amsHint?: AmsHint;
};

export type MidPrintCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set-speed"; percent: number }
  | { type: "set-nozzle-temp"; celsius: number }
  | { type: "set-bed-temp"; celsius: number }
  | { type: "ams-stop-feed"; slot: number }
  | { type: "ams-retry-load"; slot: number };

export type CommandRisk = "safe" | "risky";

export type CommandResult = {
  ok: boolean;
  pausedFirst: boolean;
  message: string;
  /** Simple hands-on steps when LAN/software cannot complete the command. */
  physicalSteps?: string[];
};

export type DesignFilament = {
  id: string;
  type: string;
  colorHex?: string;
  name?: string;
};

export type AmsMappingMatch = "exact" | "type" | "unmapped";

export type AmsMapping = {
  designId: string;
  unit?: number;
  slot?: number;
  match: AmsMappingMatch;
  reason: string;
};

export type FilamentPlan = {
  design: DesignFilament[];
  mappings: AmsMapping[];
  unmapped: DesignFilament[];
};

export type ReshapeAction = "pause-now" | "insufficient-data" | "nothing-remaining";

export type RemainingLayerReshapePlan = {
  action: ReshapeAction;
  remainingHeightMm: number | null;
  remainingLayers: number | null;
  /** Already-printed stump height (current Z). */
  currentZ?: number | null;
  askCad: boolean;
  message: string;
};
