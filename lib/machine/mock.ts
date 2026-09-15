import { defaultPrinter, getPrinter, type PrinterId } from "../printers";
import {
  emptyAmsSlots,
  midPrintCommandRisk,
  registerMachineAdapter,
  validateLanCredentials,
  type MachineAdapter,
} from "./adapter";
import { AMS_FEED_LOOP_SENTINEL, amsFeedLoopPhysicalSteps } from "./ams-autofix";
import type {
  AmsHint,
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
  private remainingHeightMm?: number;
  private layerHeightMm?: number;
  private speedPercent = 100;
  private slots: AmsSlotStatus[];
  private amsHint?: AmsHint;
  private amsSoftwareFixable = true;

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
    remainingHeightMm?: number;
    layerHeightMm?: number;
    /** Layer/total only — do not invent remainingHeightMm / currentZ. */
    omitHeights?: boolean;
  }): void {
    this.print = "printing";
    this.layer = opts?.layer ?? 12;
    this.totalLayers = opts?.totalLayers ?? 40;
    this.layerHeightMm = opts?.layerHeightMm;
    if (opts?.omitHeights) {
      this.currentHeightMm = undefined;
      this.objectHeightMm = undefined;
      this.remainingHeightMm = undefined;
    } else {
      this.currentHeightMm = opts?.currentHeightMm ?? 2.4;
      this.objectHeightMm = opts?.objectHeightMm ?? 8;
      this.remainingHeightMm =
        opts?.remainingHeightMm ??
        (this.objectHeightMm != null && this.currentHeightMm != null
          ? Math.max(0, this.objectHeightMm - this.currentHeightMm)
          : undefined);
    }
    this.progressPercent = Math.round(((this.layer ?? 0) / (this.totalLayers ?? 1)) * 100);
    this.nozzleTempC = 220;
    this.nozzleTargetC = 220;
    this.bedTempC = 55;
    this.bedTargetC = 55;
  }

  /**
   * Inject layer/total + remaining height so tests can prove pause-then-plan
   * without a slicer or camera JPEG.
   */
  injectRemainingHeight(opts: {
    layer?: number;
    totalLayers?: number;
    remainingHeightMm: number;
    currentHeightMm?: number;
    objectHeightMm?: number;
    layerHeightMm?: number;
  }): void {
    const currentHeightMm = opts.currentHeightMm ?? 2.4;
    this.simulatePrinting({
      layer: opts.layer ?? 12,
      totalLayers: opts.totalLayers ?? 40,
      currentHeightMm,
      objectHeightMm: opts.objectHeightMm ?? currentHeightMm + opts.remainingHeightMm,
      remainingHeightMm: opts.remainingHeightMm,
      layerHeightMm: opts.layerHeightMm,
    });
  }

  /**
   * Inject a fake AMS feed/unfeed loop so tests can prove pause-then-autofix
   * vs diagnose-only. No sockets.
   */
  injectAmsFeedLoop(slot = 2, opts?: { softwareFixable?: boolean }): void {
    this.amsSoftwareFixable = opts?.softwareFixable ?? true;
    this.amsHint = {
      kind: "feed-loop",
      slot,
      amsStatus: AMS_FEED_LOOP_SENTINEL,
      message: `AMS ${slot} feed/unfeed loop (mock).`,
    };
  }

  async connect(credentials?: MachineCredentials): Promise<LiveMachineStatus> {
    this.connection = "connecting";
    if (credentials) {
      const invalid = validateLanCredentials(credentials);
      if (invalid) {
        this.connection = "error";
        this.message = invalid;
        return this.snapshot();
      }
    }
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
    this.remainingHeightMm = undefined;
    this.layerHeightMm = undefined;
    this.speedPercent = 100;
    this.slots = emptyAmsSlots(getPrinter(this.printerId).ams.slotsPerUnit);
    this.amsHint = undefined;
    this.amsSoftwareFixable = true;
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
      case "ams-stop-feed": {
        if (!validAmsSlot(command.slot)) {
          return { ok: false, pausedFirst, message: "AMS slot must be 1–20." };
        }
        return { ok: true, pausedFirst, message: `Stopped AMS ${command.slot} feed.` };
      }
      case "ams-retry-load": {
        if (!validAmsSlot(command.slot)) {
          return { ok: false, pausedFirst, message: "AMS slot must be 1–20." };
        }
        if (!this.amsSoftwareFixable) {
          return {
            ok: false,
            pausedFirst,
            message: `Software could not reload AMS ${command.slot}.`,
            physicalSteps: amsFeedLoopPhysicalSteps(command.slot),
          };
        }
        this.amsHint = undefined;
        return { ok: true, pausedFirst, message: `Retried load on AMS ${command.slot}.` };
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
      remainingHeightMm: this.remainingHeightMm,
      ...(this.layerHeightMm != null ? { layerHeightMm: this.layerHeightMm } : {}),
      speedPercent: this.speedPercent,
      amsSlots: this.slots.map((slot) => ({ ...slot })),
      amsHint: this.amsHint ? { ...this.amsHint } : undefined,
    };
  }
}

function validAmsSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= 20;
}

registerMachineAdapter("mock", () => new MockMachineAdapter());
