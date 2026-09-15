import { defaultPrinter, getPrinter, type PrinterId } from "../printers";
import {
  emptyAmsSlots,
  midPrintCommandRisk,
  registerMachineAdapter,
  type MachineAdapter,
} from "./adapter";
import type {
  AmsSlotStatus,
  CommandResult,
  ConnectionState,
  LiveMachineStatus,
  MachineCredentials,
  MidPrintCommand,
  PrintState,
} from "./types";

const DEMO_SLOTS: AmsSlotStatus[] = [
  {
    unit: 1,
    slot: 1,
    present: true,
    filamentType: "pla",
    colorHex: "#1A1A1A",
    remainingPercent: 80,
    name: "PLA Black",
  },
  {
    unit: 1,
    slot: 2,
    present: true,
    filamentType: "petg",
    colorHex: "#2F6FED",
    remainingPercent: 45,
    name: "PETG Blue",
  },
  {
    unit: 1,
    slot: 3,
    present: true,
    filamentType: "abs",
    colorHex: "#C4C4C8",
    remainingPercent: 60,
    name: "ABS Grey",
  },
  { unit: 1, slot: 4, present: false },
];

/**
 * In-memory P2S + AMS stand-in. No sockets, no MQTT, no FTPS.
 * Used by tests and the disconnected Machine stub.
 */
export class MockMachineAdapter implements MachineAdapter {
  readonly id = "mock";
  readonly printerId: PrinterId;
  private connection: ConnectionState = "disconnected";
  private print: PrintState = "idle";
  private message?: string;
  private nextConnectError: string | null = null;
  private nozzleTempC = 25;
  private nozzleTargetC = 0;
  private bedTempC = 25;
  private bedTargetC = 0;
  private layer?: number;
  private totalLayers?: number;
  private progressPercent?: number;
  private currentHeightMm?: number;
  private objectHeightMm?: number;
  private speedPercent = 100;
  private slots: AmsSlotStatus[];

  constructor(printerId: PrinterId = defaultPrinter().id) {
    this.printerId = printerId;
    this.slots = emptyAmsSlots(getPrinter(printerId).ams.slotsPerUnit);
  }

  failNextConnect(message: string): void {
    this.nextConnectError = message;
  }

  simulatePrinting(opts?: {
    layer?: number;
    totalLayers?: number;
    currentHeightMm?: number;
    objectHeightMm?: number;
  }): void {
    this.print = "printing";
    this.layer = opts?.layer ?? 12;
    this.totalLayers = opts?.totalLayers ?? 40;
    this.currentHeightMm = opts?.currentHeightMm ?? 2.4;
    this.objectHeightMm = opts?.objectHeightMm ?? 8;
    this.progressPercent = Math.round(((this.layer ?? 0) / (this.totalLayers ?? 1)) * 100);
    this.nozzleTempC = 220;
    this.nozzleTargetC = 220;
    this.bedTempC = 55;
    this.bedTargetC = 55;
  }

  async connect(_credentials?: MachineCredentials): Promise<LiveMachineStatus> {
    this.connection = "connecting";
    if (this.nextConnectError) {
      const message = this.nextConnectError;
      this.nextConnectError = null;
      this.connection = "error";
      this.message = message;
      return this.snapshot();
    }
    this.connection = "connected";
    this.message = "Mock P2S connected (no LAN I/O).";
    this.slots = DEMO_SLOTS.map((slot) => ({ ...slot }));
    return this.snapshot();
  }

  async disconnect(): Promise<void> {
    this.connection = "disconnected";
    this.print = "idle";
    this.message = undefined;
    this.layer = undefined;
    this.totalLayers = undefined;
    this.progressPercent = undefined;
    this.currentHeightMm = undefined;
    this.objectHeightMm = undefined;
    this.speedPercent = 100;
    this.slots = emptyAmsSlots(getPrinter(this.printerId).ams.slotsPerUnit);
  }

  async status(): Promise<LiveMachineStatus> {
    return this.snapshot();
  }

  async send(command: MidPrintCommand): Promise<CommandResult> {
    if (this.connection !== "connected") {
      return { ok: false, pausedFirst: false, message: "Printer is not connected." };
    }

    const printer = getPrinter(this.printerId);
    const risky = midPrintCommandRisk(command) === "risky";
    let pausedFirst = false;
    if (risky && this.print === "printing") {
      this.print = "paused";
      pausedFirst = true;
    }

    switch (command.type) {
      case "pause":
        if (this.print !== "printing") {
          return { ok: false, pausedFirst, message: "Nothing is printing." };
        }
        this.print = "paused";
        return { ok: true, pausedFirst, message: "Paused." };
      case "resume":
        if (this.print !== "paused") {
          return { ok: false, pausedFirst, message: "Printer is not paused." };
        }
        this.print = "printing";
        return { ok: true, pausedFirst, message: "Resumed." };
      case "set-speed": {
        if (!Number.isFinite(command.percent) || command.percent < 10 || command.percent > 200) {
          return { ok: false, pausedFirst, message: "Speed must be between 10% and 200%." };
        }
        this.speedPercent = command.percent;
        return { ok: true, pausedFirst, message: `Speed set to ${command.percent}%.` };
      }
      case "set-nozzle-temp": {
        if (command.celsius < printer.minNozzleC || command.celsius > printer.maxNozzleC) {
          return {
            ok: false,
            pausedFirst,
            message: `Nozzle target must be ${printer.minNozzleC}–${printer.maxNozzleC} °C.`,
          };
        }
        this.nozzleTargetC = command.celsius;
        return {
          ok: true,
          pausedFirst,
          message: pausedFirst
            ? `Paused, then set nozzle to ${command.celsius} °C.`
            : `Nozzle target set to ${command.celsius} °C.`,
        };
      }
      case "set-bed-temp": {
        if (command.celsius < printer.minBedC || command.celsius > printer.maxBedC) {
          return {
            ok: false,
            pausedFirst,
            message: `Bed target must be ${printer.minBedC}–${printer.maxBedC} °C.`,
          };
        }
        this.bedTargetC = command.celsius;
        return {
          ok: true,
          pausedFirst,
          message: pausedFirst
            ? `Paused, then set bed to ${command.celsius} °C.`
            : `Bed target set to ${command.celsius} °C.`,
        };
      }
    }
  }

  private snapshot(): LiveMachineStatus {
    return {
      adapterId: this.id,
      printerId: this.printerId,
      connection: this.connection,
      print: this.print,
      message: this.message,
      nozzleTempC: this.nozzleTempC,
      nozzleTargetC: this.nozzleTargetC,
      bedTempC: this.bedTempC,
      bedTargetC: this.bedTargetC,
      layer: this.layer,
      totalLayers: this.totalLayers,
      progressPercent: this.progressPercent,
      currentHeightMm: this.currentHeightMm,
      objectHeightMm: this.objectHeightMm,
      speedPercent: this.speedPercent,
      amsSlots: this.slots.map((slot) => ({ ...slot })),
    };
  }
}

registerMachineAdapter("mock", () => new MockMachineAdapter());
