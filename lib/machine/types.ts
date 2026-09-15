import type { FilamentId, PrinterId } from "../printers";

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
  speedPercent?: number;
  amsSlots: AmsSlotStatus[];
};

export type MidPrintCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set-speed"; percent: number }
  | { type: "set-nozzle-temp"; celsius: number }
  | { type: "set-bed-temp"; celsius: number };

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
  askCad: boolean;
  message: string;
};
