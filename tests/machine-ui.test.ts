import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/machine/route";
import {
  INCOMPLETE_LAN_HINT,
  credentialsComplete,
  defaultAdapterId,
  defaultMachineLanPrefs,
  machineLanHint,
  parseMachineConfigure,
  parseMachineLanPrefs,
  readLiveCredentials,
  resetSharedMachine,
  resolveActiveAdapterId,
  resolveMachineAdapterId,
  serializeMachineLanPrefs,
  setMachineUiSession,
} from "@/lib/machine";

const SECRET = "ui-secret-access-code-xyz";
const CREDS = { host: "192.168.1.20", serial: "01S00A123456789", accessCode: SECRET };

const TRACKED = [
  "BAMBU_LAN_MQTT",
  "BAMBU_HOST",
  "BAMBU_SERIAL",
  "BAMBU_ACCESS_CODE",
  "BAMBU_MQTT_PORT",
  "BAMBU_MQTT_TIMEOUT_MS",
  "MACHINE_ADAPTER",
] as const;

function clearEnv() {
  for (const key of TRACKED) delete process.env[key];
}

function assertNoSecret(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(SECRET);
  expect(value).not.toHaveProperty("accessCode");
}

afterEach(() => {
  resetSharedMachine();
  clearEnv();
});

describe("Machine panel LAN prefs", () => {
  it("defaults off and round-trips without dropping fields", () => {
    expect(defaultMachineLanPrefs()).toEqual({
      enabled: false,
      host: "",
      serial: "",
      accessCode: "",
    });
    const raw = serializeMachineLanPrefs({ enabled: true, ...CREDS });
    expect(parseMachineLanPrefs(raw)).toEqual({ enabled: true, ...CREDS });
    expect(parseMachineLanPrefs("not-json")).toEqual(defaultMachineLanPrefs());
    expect(parseMachineLanPrefs(null)).toEqual(defaultMachineLanPrefs());
  });

  it("treats only a complete set as connectable", () => {
    expect(credentialsComplete(CREDS)).toBe(true);
    expect(credentialsComplete({ ...CREDS, accessCode: "" })).toBe(false);
    expect(credentialsComplete({ ...CREDS, host: "  " })).toBe(false);
  });
});

describe("UI session vs env flag", () => {
  it("does not select LAN from the UI when the session is off", () => {
    expect(resolveActiveAdapterId()).toBe("mock");
    expect(defaultAdapterId()).toBe("mock");
    expect(resolveMachineAdapterId()).toBe("mock");
    expect(readLiveCredentials()).toBeNull();
  });

  it("selects bambu-lan from a complete UI session without BAMBU_LAN_MQTT", () => {
    setMachineUiSession({ enabled: true, credentials: CREDS });
    expect(process.env.BAMBU_LAN_MQTT).toBeUndefined();
    expect(resolveMachineAdapterId()).toBe("mock");
    expect(resolveActiveAdapterId()).toBe("bambu-lan");
    expect(defaultAdapterId()).toBe("bambu-lan");
    expect(readLiveCredentials()).toEqual(CREDS);
    expect(machineLanHint()).toBeUndefined();
  });

  it("keeps mock and a short hint when the toggle is on but creds are incomplete", () => {
    setMachineUiSession({
      enabled: true,
      credentials: { host: CREDS.host, serial: "", accessCode: "" },
    });
    expect(resolveActiveAdapterId()).toBe("mock");
    expect(readLiveCredentials()).toBeNull();
    expect(machineLanHint()).toBe(INCOMPLETE_LAN_HINT);
  });

  it("lets MACHINE_ADAPTER=mock win over a complete UI session", () => {
    process.env.MACHINE_ADAPTER = "mock";
    setMachineUiSession({ enabled: true, credentials: CREDS });
    expect(resolveActiveAdapterId()).toBe("mock");
  });

  it("lets env flag+creds override a disabled UI session", () => {
    process.env.BAMBU_LAN_MQTT = "1";
    process.env.BAMBU_HOST = CREDS.host;
    process.env.BAMBU_SERIAL = CREDS.serial;
    process.env.BAMBU_ACCESS_CODE = SECRET;
    setMachineUiSession({ enabled: false });
    expect(resolveActiveAdapterId()).toBe("bambu-lan");
    expect(readLiveCredentials()).toEqual(CREDS);
  });
});

describe("machine API UI configure", () => {
  it("parses a configure body without treating it as a mid-print command", () => {
    expect(
      parseMachineConfigure({
        lan: true,
        credentials: CREDS,
      }),
    ).toEqual({ lan: true, credentials: CREDS });
    expect(parseMachineConfigure({ command: { type: "pause" } })).toBeNull();
  });

  it("GET stays mock when no UI session and the env flag is off", async () => {
    const response = await GET();
    const body = (await response.json()) as {
      live: boolean;
      adapterId: string;
      lanEnabled: boolean;
      source: string;
      status: { connection: string };
    };
    expect(body.live).toBe(false);
    expect(body.adapterId).toBe("mock");
    expect(body.lanEnabled).toBe(false);
    expect(body.source).toBe("off");
    expect(body.status.connection).toBe("disconnected");
    expect(body).not.toHaveProperty("accessCode");
  });

  it("POST configure with incomplete creds stays mock and never echoes the access code", async () => {
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({
          lan: true,
          credentials: { host: CREDS.host, serial: "", accessCode: SECRET },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      live: boolean;
      adapterId: string;
      lanEnabled: boolean;
      source: string;
      hint?: string;
      host?: string;
    };
    expect(body.live).toBe(false);
    expect(body.adapterId).toBe("mock");
    expect(body.lanEnabled).toBe(true);
    expect(body.source).toBe("ui");
    expect(body.hint).toBe(INCOMPLETE_LAN_HINT);
    expect(body.host).toBe(CREDS.host);
    assertNoSecret(body);
  });

  it("POST configure with complete creds selects LAN and fails safe without leaking secrets", async () => {
    process.env.BAMBU_MQTT_PORT = "1";
    process.env.BAMBU_MQTT_TIMEOUT_MS = "800";
    const local = { ...CREDS, host: "127.0.0.1" };
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ lan: true, credentials: local }),
      }),
    );
    const body = (await response.json()) as {
      live: boolean;
      adapterId: string;
      source: string;
      status: { connection: string; message?: string };
    };
    expect(body.live).toBe(true);
    expect(body.adapterId).toBe("bambu-lan");
    expect(body.source).toBe("ui");
    expect(body.status.connection).not.toBe("connected");
    expect(body.status.message ?? "").not.toContain(SECRET);
    assertNoSecret(body);

    const followUp = await GET();
    const again = (await followUp.json()) as { live: boolean; adapterId: string };
    expect(again.live).toBe(true);
    expect(again.adapterId).toBe("bambu-lan");
    assertNoSecret(again);
  });

  it("POST command after a UI session is live is not a 404", async () => {
    process.env.BAMBU_MQTT_PORT = "1";
    process.env.BAMBU_MQTT_TIMEOUT_MS = "800";
    await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ lan: true, credentials: { ...CREDS, host: "127.0.0.1" } }),
      }),
    );
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ command: { type: "pause" } }),
      }),
    );
    expect(response.status).not.toBe(404);
    const body = (await response.json()) as { lastCommand?: { ok: boolean; message: string } };
    expect(body.lastCommand?.ok).toBe(false);
    assertNoSecret(body);
  });

  it("POST configure lan:false returns to mock", async () => {
    setMachineUiSession({ enabled: true, credentials: CREDS });
    const response = await POST(
      new Request("http://localhost/api/machine", {
        method: "POST",
        body: JSON.stringify({ lan: false, credentials: CREDS }),
      }),
    );
    const body = (await response.json()) as { live: boolean; adapterId: string; source: string };
    expect(body.live).toBe(false);
    expect(body.adapterId).toBe("mock");
    expect(body.source).toBe("off");
    assertNoSecret(body);
  });
});
