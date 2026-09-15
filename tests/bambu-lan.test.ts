import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/machine/route";
import {
  BambuLanMachineAdapter,
  bambuTopics,
  buildBambuCommandPayload,
  createMachineAdapter,
  defaultAdapterId,
  isBambuLanMqttEnabled,
  parseBambuPrintReport,
  percentToBambuSpeedLevel,
  physicalStepsForCommand,
  readBambuLanCredentials,
  redactSecrets,
  resetSharedMachine,
  resolveMachineAdapterId,
  RESERVED_BAMBU_LAN_ADAPTER_ID,
} from "@/lib/machine";
import type { BambuMqttClient, BambuMqttConnect } from "@/lib/machine/bambu-lan";

const TRACKED = [
  "BAMBU_LAN_MQTT",
  "BAMBU_HOST",
  "BAMBU_SERIAL",
  "BAMBU_ACCESS_CODE",
  "BAMBU_MQTT_PORT",
  "BAMBU_MQTT_TIMEOUT_MS",
  "MACHINE_ADAPTER",
] as const;

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev = new Map<string, string | undefined>();
  for (const key of TRACKED) {
    prev.set(key, process.env[key]);
    if (!(key in vars)) continue;
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SECRET = "super-secret-access-code-xyz";
const CREDS = { host: "192.168.1.20", serial: "01S00A123456789", accessCode: SECRET };

function samplePrintReport() {
  return {
    print: {
      gcode_state: "RUNNING",
      nozzle_temper: 221.4,
      nozzle_target_temper: 220,
      bed_temper: 55.2,
      bed_target_temper: 55,
      layer_num: 12,
      total_layer_num: 40,
      mc_percent: 30,
      spd_mag: 100,
      spd_lvl: 2,
      ams: {
        ams: [
          {
            id: "0",
            tray: [
              {
                id: "0",
                tray_type: "PLA",
                tray_color: "1A1A1AFF",
                remain: 80,
                tray_sub_brands: "PLA Black",
              },
              { id: "1", tray_type: "PETG", tray_color: "2F6FEDFF", remain: 45 },
              { id: "2", tray_type: "ABS", tray_color: "C4C4C8FF", remain: 60 },
              { id: "3" },
            ],
          },
        ],
      },
    },
  };
}

function makeFakeMqtt() {
  const publishes: Array<{ topic: string; payload: string }> = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const client: BambuMqttClient & { emit: (event: string, ...args: unknown[]) => void } = {
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    subscribe(_topic, _opts, cb) {
      cb?.(null);
    },
    publish(topic, payload, _opts, cb) {
      publishes.push({ topic, payload });
      cb?.(null);
    },
    end(_force, _opts, cb) {
      cb?.();
    },
    emit(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
  };
  const connect: BambuMqttConnect = () => {
    queueMicrotask(() => client.emit("connect"));
    return client;
  };
  return { client, connect, publishes };
}

describe("BAMBU_LAN_MQTT feature flag", () => {
  it("stays off by default and keeps the mock adapter", () => {
    withEnv(
      {
        BAMBU_LAN_MQTT: undefined,
        BAMBU_HOST: undefined,
        BAMBU_SERIAL: undefined,
        BAMBU_ACCESS_CODE: undefined,
        MACHINE_ADAPTER: undefined,
      },
      () => {
        expect(isBambuLanMqttEnabled()).toBe(false);
        expect(readBambuLanCredentials()).toBeNull();
        expect(resolveMachineAdapterId()).toBe("mock");
        expect(defaultAdapterId()).toBe("mock");
        expect(createMachineAdapter().id).toBe("mock");
      },
    );
  });

  it("selects bambu-lan only when the flag and LAN credentials are set", () => {
    withEnv(
      {
        BAMBU_LAN_MQTT: "1",
        BAMBU_HOST: CREDS.host,
        BAMBU_SERIAL: CREDS.serial,
        BAMBU_ACCESS_CODE: SECRET,
        MACHINE_ADAPTER: undefined,
      },
      () => {
        expect(isBambuLanMqttEnabled()).toBe(true);
        expect(readBambuLanCredentials()).toEqual(CREDS);
        expect(resolveMachineAdapterId()).toBe(RESERVED_BAMBU_LAN_ADAPTER_ID);
        expect(createMachineAdapter().id).toBe("bambu-lan");
      },
    );
  });

  it("keeps mock when the flag is on but credentials are incomplete", () => {
    withEnv(
      {
        BAMBU_LAN_MQTT: "true",
        BAMBU_HOST: CREDS.host,
        BAMBU_SERIAL: CREDS.serial,
        BAMBU_ACCESS_CODE: undefined,
      },
      () => {
        expect(resolveMachineAdapterId()).toBe("mock");
        expect(createMachineAdapter().id).toBe("mock");
      },
    );
  });

  it("does not honor MACHINE_ADAPTER=bambu-lan without the flag", () => {
    withEnv(
      {
        BAMBU_LAN_MQTT: undefined,
        MACHINE_ADAPTER: "bambu-lan",
        BAMBU_HOST: CREDS.host,
        BAMBU_SERIAL: CREDS.serial,
        BAMBU_ACCESS_CODE: SECRET,
      },
      () => {
        expect(resolveMachineAdapterId()).toBe("mock");
      },
    );
  });
});

describe("Bambu LAN MQTT protocol helpers", () => {
  it("uses device/{serial}/report and /request", () => {
    expect(bambuTopics(CREDS.serial)).toEqual({
      report: `device/${CREDS.serial}/report`,
      request: `device/${CREDS.serial}/request`,
    });
  });

  it("parses live temps, layers, and AMS slots from a print report", () => {
    const parsed = parseBambuPrintReport(samplePrintReport());
    expect(parsed).not.toBeNull();
    expect(parsed?.statusPatch.print).toBe("printing");
    expect(parsed?.statusPatch.nozzleTempC).toBeCloseTo(221.4);
    expect(parsed?.statusPatch.bedTargetC).toBe(55);
    expect(parsed?.statusPatch.layer).toBe(12);
    expect(parsed?.statusPatch.totalLayers).toBe(40);
    expect(parsed?.statusPatch.progressPercent).toBe(30);
    const slots = parsed?.statusPatch.amsSlots ?? [];
    expect(slots).toHaveLength(4);
    expect(slots[0]).toMatchObject({
      unit: 1,
      slot: 1,
      present: true,
      filamentType: "pla",
      colorHex: "#1A1A1A",
      remainingPercent: 80,
    });
    expect(slots[3]).toMatchObject({ slot: 4, present: false });
  });

  it("builds pause/resume/speed/temp payloads", () => {
    expect(buildBambuCommandPayload({ type: "pause" }, "1")).toEqual({
      print: { sequence_id: "1", command: "pause", param: "" },
    });
    expect(buildBambuCommandPayload({ type: "resume" }, "2")).toEqual({
      print: { sequence_id: "2", command: "resume", param: "" },
    });
    expect(buildBambuCommandPayload({ type: "set-speed", percent: 50 }, "3")).toEqual({
      print: { sequence_id: "3", command: "print_speed", param: "1" },
    });
    expect(buildBambuCommandPayload({ type: "set-nozzle-temp", celsius: 230 }, "4").print).toMatchObject({
      command: "gcode_line",
      param: "M104 S230\n",
    });
    expect(percentToBambuSpeedLevel(100)).toBe(2);
    expect(physicalStepsForCommand({ type: "pause" })[0]).toMatch(/Pause/);
  });
});

describe("BambuLanMachineAdapter", () => {
  it("pauses before risky temperature changes on a live session", async () => {
    const fake = makeFakeMqtt();
    const machine = new BambuLanMachineAdapter({
      credentials: CREDS,
      connect: fake.connect,
      timeoutMs: 500,
    });
    const status = await machine.connect();
    expect(status.connection).toBe("connected");
    expect(JSON.stringify(status)).not.toContain(SECRET);

    fake.client.emit("message", bambuTopics(CREDS.serial).report, Buffer.from(JSON.stringify(samplePrintReport())));
    expect((await machine.status()).print).toBe("printing");

    const result = await machine.send({ type: "set-nozzle-temp", celsius: 230 });
    expect(result.ok).toBe(true);
    expect(result.pausedFirst).toBe(true);
    expect(result.message).toMatch(/Paused/);
    expect((await machine.status()).print).toBe("paused");
    expect((await machine.status()).nozzleTargetC).toBe(230);

    const commands = fake.publishes
      .map((row) => JSON.parse(row.payload) as { print?: { command?: string }; pushing?: { command?: string } })
      .filter((row) => row.print);
    expect(commands[0]?.print?.command).toBe("pause");
    expect(commands[1]?.print?.command).toBe("gcode_line");

    const before = fake.publishes.length;
    expect((await machine.connect()).connection).toBe("connected");
    expect(fake.publishes.length).toBe(before);
  });

  it("fails safe against an unhealthy endpoint without leaking secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const machine = new BambuLanMachineAdapter({
      credentials: { host: "127.0.0.1", serial: CREDS.serial, accessCode: SECRET },
      port: 1,
      timeoutMs: 800,
    });

    const status = await machine.connect();
    expect(status.connection).not.toBe("connected");
    expect(["error", "disconnected"]).toContain(status.connection);
    expect(status.adapterId).toBe("bambu-lan");
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(status.message ?? "").not.toContain(SECRET);

    const rejected = await machine.send({ type: "pause" });
    expect(rejected.ok).toBe(false);
    expect(rejected.physicalSteps?.[0]).toMatch(/Pause/);
    expect(JSON.stringify(rejected)).not.toContain(SECRET);

    const dumped = `${warn.mock.calls.join("\n")}\n${error.mock.calls.join("\n")}\n${log.mock.calls.join("\n")}`;
    expect(dumped).not.toContain(SECRET);

    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it("redacts the access code from error text", () => {
    expect(redactSecrets(`auth failed for ${SECRET}`, [SECRET])).toBe("auth failed for [redacted]");
  });
});

describe("machine API flag off", () => {
  afterEach(() => {
    resetSharedMachine();
    for (const key of TRACKED) delete process.env[key];
  });

  it("GET stays on the mock snapshot when the flag is off", async () => {
    delete process.env.BAMBU_LAN_MQTT;
    resetSharedMachine();
    const response = await GET();
    const body = (await response.json()) as { live: boolean; adapterId: string; status: { connection: string } };
    expect(body.live).toBe(false);
    expect(body.adapterId).toBe("mock");
    expect(body.status.connection).toBe("disconnected");
  });

  it("POST is rejected when the flag is off", async () => {
    delete process.env.BAMBU_LAN_MQTT;
    resetSharedMachine();
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ command: { type: "pause" } }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("GET with flag on and an unhealthy host fails safe without leaking secrets", async () => {
    process.env.BAMBU_LAN_MQTT = "1";
    process.env.BAMBU_HOST = "127.0.0.1";
    process.env.BAMBU_SERIAL = CREDS.serial;
    process.env.BAMBU_ACCESS_CODE = SECRET;
    process.env.BAMBU_MQTT_PORT = "1";
    process.env.BAMBU_MQTT_TIMEOUT_MS = "800";
    resetSharedMachine();
    const response = await GET();
    const body = (await response.json()) as {
      live: boolean;
      adapterId: string;
      status: { connection: string; message?: string };
    };
    expect(body.live).toBe(true);
    expect(body.adapterId).toBe("bambu-lan");
    expect(body.status.connection).not.toBe("connected");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.status.message ?? "").not.toContain(SECRET);
  });
});
