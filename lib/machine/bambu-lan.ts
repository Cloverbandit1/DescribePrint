import { defaultPrinter, getPrinter, type PrinterId } from "../printers";
import {
  emptyAmsSlots,
  midPrintCommandRisk,
  registerMachineAdapter,
  validateLanCredentials,
  type MachineAdapter,
} from "./adapter";
import {
  BAMBU_LAN_ADAPTER_ID,
  BAMBU_MQTT_USERNAME,
  bambuMqttPort,
  bambuMqttTimeoutMs,
  readBambuLanCredentials,
} from "./config";
import {
  bambuTopics,
  buildBambuCommandPayload,
  buildPushAllRequest,
  nextSequenceId,
  parseBambuPrintReport,
  physicalStepsForCommand,
} from "./bambu-protocol";
import { redactSecrets, safeErrorMessage } from "./redact";
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

export type BambuMqttClient = {
  on(event: "connect" | "error" | "close" | "offline" | "message", cb: (...args: unknown[]) => void): void;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }, cb?: (err?: Error | null) => void): void;
  publish(
    topic: string,
    payload: string,
    opts: { qos: 0 | 1 | 2 },
    cb?: (err?: Error | null) => void,
  ): void;
  end(force?: boolean, opts?: unknown, cb?: () => void): void;
};

export type BambuMqttConnect = (url: string, options: Record<string, unknown>) => BambuMqttClient;

export type BambuLanAdapterOptions = {
  printerId?: PrinterId;
  machineId?: string;
  credentials?: MachineCredentials;
  connect?: BambuMqttConnect;
  port?: number;
  timeoutMs?: number;
};

type PrintRecord = Record<string, unknown>;

function defaultMqttConnect(): BambuMqttConnect {
  // Lazy so unit tests that inject a client do not load mqtt at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mqtt = require("mqtt") as { connect: BambuMqttConnect };
  return mqtt.connect;
}

/**
 * Live Bambu P2S + AMS adapter over LAN MQTT. No Bambu Cloud, no FTPS, no camera.
 * Connect fails safe: never throws, never logs the access code.
 */
export class BambuLanMachineAdapter implements MachineAdapter {
  readonly id = BAMBU_LAN_ADAPTER_ID;
  readonly printerId: PrinterId;
  readonly machineId?: string;
  private readonly options: BambuLanAdapterOptions;
  private connection: ConnectionState = "disconnected";
  private print: PrintState = "idle";
  private message?: string;
  private credentials?: MachineCredentials;
  private client: BambuMqttClient | null = null;
  private connecting: Promise<LiveMachineStatus> | null = null;
  private sequence = 1;
  private lastPrint?: PrintRecord;
  private nozzleTempC?: number;
  private nozzleTargetC?: number;
  private bedTempC?: number;
  private bedTargetC?: number;
  private layer?: number;
  private totalLayers?: number;
  private progressPercent?: number;
  private speedPercent?: number;
  private slots: AmsSlotStatus[] = emptyAmsSlots();
  private amsHint?: AmsHint;

  constructor(options: BambuLanAdapterOptions = {}) {
    this.options = options;
    this.printerId = options.printerId ?? defaultPrinter().id;
    this.machineId = options.machineId;
    this.slots = emptyAmsSlots(getPrinter(this.printerId).ams.slotsPerUnit);
  }

  async connect(credentials?: MachineCredentials): Promise<LiveMachineStatus> {
    if (this.connection === "connected" && this.client) return this.snapshot();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce(credentials).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connectOnce(credentials?: MachineCredentials): Promise<LiveMachineStatus> {
    const creds = credentials ?? this.options.credentials ?? readBambuLanCredentials();
    if (!creds) {
      this.failClosed("LAN credentials are missing.");
      return this.snapshot();
    }
    const invalid = validateLanCredentials(creds);
    if (invalid) {
      this.failClosed(invalid);
      return this.snapshot();
    }

    this.credentials = creds;
    this.connection = "connecting";
    this.message = "Connecting to P2S over LAN MQTT…";

    try {
      await this.openMqtt(creds);
      this.connection = "connected";
      this.message = "P2S LAN MQTT connected.";
    } catch (error) {
      await this.closeMqtt();
      this.failClosed(this.safeMessage(error, creds));
    }
    return this.snapshot();
  }

  async disconnect(): Promise<void> {
    await this.closeMqtt();
    this.connection = "disconnected";
    this.print = "idle";
    this.message = undefined;
    this.lastPrint = undefined;
    this.layer = undefined;
    this.totalLayers = undefined;
    this.progressPercent = undefined;
    this.speedPercent = undefined;
    this.slots = emptyAmsSlots(getPrinter(this.printerId).ams.slotsPerUnit);
    this.amsHint = undefined;
  }

  async status(): Promise<LiveMachineStatus> {
    return this.snapshot();
  }

  async send(command: MidPrintCommand): Promise<CommandResult> {
    if (this.connection !== "connected" || !this.client || !this.credentials) {
      return {
        ok: false,
        pausedFirst: false,
        message: "Printer is not connected.",
        physicalSteps: physicalStepsForCommand(command),
      };
    }

    const printer = getPrinter(this.printerId);
    const risky = midPrintCommandRisk(command) === "risky";
    let pausedFirst = false;

    const invalid = this.validateCommand(command, printer);
    if (invalid) return { ok: false, pausedFirst, message: invalid };

    if (risky && this.print === "printing") {
      const paused = await this.publishCommand({ type: "pause" });
      if (!paused.ok) {
        return {
          ...paused,
          pausedFirst: false,
          message: redactSecrets(
            `Could not pause before a temperature change. ${paused.message}`,
            this.secretList(),
          ),
          physicalSteps: [
            "On the P2S screen, tap Pause before changing temperature.",
            ...(paused.physicalSteps ?? []),
          ],
        };
      }
      this.print = "paused";
      pausedFirst = true;
    }

    const published = await this.publishCommand(command);
    if (!published.ok) {
      return {
        ...published,
        pausedFirst,
        physicalSteps: published.physicalSteps ?? physicalStepsForCommand(command),
      };
    }

    this.applyLocalCommand(command);
    return {
      ok: true,
      pausedFirst,
      message: this.successMessage(command, pausedFirst),
    };
  }

  private validateCommand(command: MidPrintCommand, printer: ReturnType<typeof getPrinter>): string | null {
    if (command.type === "set-speed") {
      if (!Number.isFinite(command.percent) || command.percent < 10 || command.percent > 200) {
        return "Speed must be between 10% and 200%.";
      }
    }
    if (command.type === "set-nozzle-temp") {
      if (command.celsius < printer.minNozzleC || command.celsius > printer.maxNozzleC) {
        return `Nozzle target must be ${printer.minNozzleC}–${printer.maxNozzleC} °C.`;
      }
    }
    if (command.type === "set-bed-temp") {
      if (command.celsius < printer.minBedC || command.celsius > printer.maxBedC) {
        return `Bed target must be ${printer.minBedC}–${printer.maxBedC} °C.`;
      }
    }
    if (command.type === "ams-stop-feed" || command.type === "ams-retry-load") {
      if (!Number.isInteger(command.slot) || command.slot < 1 || command.slot > 20) {
        return "AMS slot must be 1–20.";
      }
    }
    return null;
  }

  private applyLocalCommand(command: MidPrintCommand): void {
    switch (command.type) {
      case "pause":
        if (this.print === "printing") this.print = "paused";
        break;
      case "resume":
        if (this.print === "paused") this.print = "printing";
        break;
      case "set-speed":
        this.speedPercent = command.percent;
        break;
      case "set-nozzle-temp":
        this.nozzleTargetC = command.celsius;
        break;
      case "set-bed-temp":
        this.bedTargetC = command.celsius;
        break;
      case "ams-stop-feed":
      case "ams-retry-load":
        break;
    }
  }

  private successMessage(command: MidPrintCommand, pausedFirst: boolean): string {
    switch (command.type) {
      case "pause":
        return "Paused.";
      case "resume":
        return "Resumed.";
      case "set-speed":
        return `Speed set to ${command.percent}%.`;
      case "set-nozzle-temp":
        return pausedFirst
          ? `Paused, then set nozzle to ${command.celsius} °C.`
          : `Nozzle target set to ${command.celsius} °C.`;
      case "set-bed-temp":
        return pausedFirst
          ? `Paused, then set bed to ${command.celsius} °C.`
          : `Bed target set to ${command.celsius} °C.`;
      case "ams-stop-feed":
        return `Stopped AMS ${command.slot} feed.`;
      case "ams-retry-load":
        return `Retried load on AMS ${command.slot}.`;
    }
  }

  private async openMqtt(creds: MachineCredentials): Promise<void> {
    await this.closeMqtt();
    const port = this.options.port ?? bambuMqttPort();
    const timeoutMs = this.options.timeoutMs ?? bambuMqttTimeoutMs();
    const url = `mqtts://${creds.host}:${port}`;
    const connect = this.options.connect ?? defaultMqttConnect();
    const topics = bambuTopics(creds.serial);

    const client = connect(url, {
      username: BAMBU_MQTT_USERNAME,
      password: creds.accessCode,
      protocol: "mqtts",
      protocolVersion: 4,
      port,
      rejectUnauthorized: false,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      keepalive: 60,
      clientId: `dp-${creds.serial.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "p2s"}`,
    });
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("LAN MQTT timed out."));
      }, timeoutMs);

      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(this.safeMessage(error, creds)));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("LAN MQTT connection closed."));
      };

      const cleanup = () => {
        clearTimeout(timer);
        client.on("connect", () => undefined);
      };

      client.on("connect", onConnect);
      client.on("error", onError);
      client.on("close", onClose);
      client.on("offline", onClose);
    });

    client.on("message", (topic, payload) => {
      this.onMessage(String(topic ?? ""), payload);
    });
    client.on("error", (error) => {
      this.failClosed(this.safeMessage(error, creds));
    });
    client.on("close", () => {
      if (this.connection === "connected") {
        this.connection = "disconnected";
        this.message = "LAN MQTT disconnected.";
      }
    });

    await this.subscribe(topics.report);
    await this.publishJson(topics.request, buildPushAllRequest(this.takeSequence()));
  }

  private onMessage(_topic: string, payload: unknown): void {
    try {
      const text = Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : typeof payload === "string"
          ? payload
          : payload instanceof Uint8Array
            ? Buffer.from(payload).toString("utf8")
            : "";
      if (!text) return;
      const parsed = JSON.parse(text) as unknown;
      const report = parseBambuPrintReport(parsed, this.lastPrint);
      if (!report) return;
      this.lastPrint = report.print;
      const patch = report.statusPatch;
      if (patch.print) this.print = patch.print;
      if (patch.nozzleTempC != null) this.nozzleTempC = patch.nozzleTempC;
      if (patch.nozzleTargetC != null) this.nozzleTargetC = patch.nozzleTargetC;
      if (patch.bedTempC != null) this.bedTempC = patch.bedTempC;
      if (patch.bedTargetC != null) this.bedTargetC = patch.bedTargetC;
      if (patch.layer != null) this.layer = patch.layer;
      if (patch.totalLayers != null) this.totalLayers = patch.totalLayers;
      if (patch.progressPercent != null) this.progressPercent = patch.progressPercent;
      if (patch.speedPercent != null) this.speedPercent = patch.speedPercent;
      if (patch.amsSlots) this.slots = patch.amsSlots;
      if (patch.amsHint) this.amsHint = patch.amsHint;
    } catch {
      // Ignore malformed printer payloads. Never echo them — they can contain serials.
    }
  }

  private subscribe(topic: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error("LAN MQTT client is missing."));
        return;
      }
      this.client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private publishJson(topic: string, payload: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error("LAN MQTT client is missing."));
        return;
      }
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async publishCommand(command: MidPrintCommand): Promise<CommandResult> {
    if (!this.client || !this.credentials) {
      return {
        ok: false,
        pausedFirst: false,
        message: "Printer is not connected.",
        physicalSteps: physicalStepsForCommand(command),
      };
    }
    const topics = bambuTopics(this.credentials.serial);
    try {
      await this.publishJson(topics.request, buildBambuCommandPayload(command, this.takeSequence()));
      return { ok: true, pausedFirst: false, message: "sent" };
    } catch (error) {
      return {
        ok: false,
        pausedFirst: false,
        message: this.safeMessage(error, this.credentials),
        physicalSteps: physicalStepsForCommand(command),
      };
    }
  }

  private takeSequence(): string {
    const id = nextSequenceId(this.sequence);
    this.sequence += 1;
    return id;
  }

  private async closeMqtt(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => {
      try {
        client.end(true, {}, () => resolve());
        setTimeout(resolve, 250);
      } catch {
        resolve();
      }
    });
  }

  private failClosed(message: string): void {
    this.connection = "error";
    this.message = redactSecrets(message, this.secretList());
  }

  private secretList(): string[] {
    return [this.credentials?.accessCode, this.options.credentials?.accessCode].filter(
      (value): value is string => Boolean(value),
    );
  }

  private safeMessage(error: unknown, creds?: MachineCredentials): string {
    const secrets = [creds?.accessCode, this.credentials?.accessCode, this.options.credentials?.accessCode];
    const safe = safeErrorMessage(error, secrets);
    if (!safe || /password|access code|accessCode/i.test(safe) && /[A-Za-z0-9]{6,}/.test(safe)) {
      return "LAN MQTT unreachable.";
    }
    return safe || "LAN MQTT unreachable.";
  }

  private snapshot(): LiveMachineStatus {
    return {
      adapterId: this.id,
      printerId: this.printerId,
      ...(this.machineId ? { machineId: this.machineId } : {}),
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
      speedPercent: this.speedPercent,
      amsSlots: this.slots.map((slot) => ({ ...slot })),
      amsHint: this.amsHint ? { ...this.amsHint } : undefined,
    };
  }
}

registerMachineAdapter(BAMBU_LAN_ADAPTER_ID, (options) => new BambuLanMachineAdapter({
  printerId: options?.printerId,
  machineId: options?.machineId,
}));
