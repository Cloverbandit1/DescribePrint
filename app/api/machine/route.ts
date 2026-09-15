import { commandFromBody, parseMachineConfigure, type MachineApiResponse } from "@/lib/machine/api";
import {
  BAMBU_LAN_ADAPTER_ID,
  machineLanHint,
  machineLanSource,
  readLiveCredentials,
} from "@/lib/machine/config";
import { defaultAdapterId } from "@/lib/machine/adapter";
import { getSharedMachine } from "@/lib/machine/runtime";
import { getMachineUiSession, setMachineUiSession } from "@/lib/machine/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(
  status: MachineApiResponse["status"],
  lastCommand?: MachineApiResponse["lastCommand"],
): MachineApiResponse {
  const adapterId = defaultAdapterId();
  const live = adapterId === BAMBU_LAN_ADAPTER_ID;
  const source = machineLanSource();
  const creds = readLiveCredentials();
  const session = getMachineUiSession();
  const host = creds?.host || (session.enabled ? session.credentials.host : "") || undefined;
  const serial = creds?.serial || (session.enabled ? session.credentials.serial : "") || undefined;
  return {
    live,
    adapterId,
    lanEnabled: source !== "off",
    source,
    hint: machineLanHint(),
    host,
    serial,
    status,
    lastCommand,
  };
}

async function snapshot(lastCommand?: MachineApiResponse["lastCommand"]): Promise<Response> {
  const machine = getSharedMachine();
  const live = machine.id === BAMBU_LAN_ADAPTER_ID;
  const creds = readLiveCredentials();
  const status = live ? await machine.connect(creds ?? undefined) : await machine.status();
  return Response.json(payload(status, lastCommand), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  return snapshot();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const command = commandFromBody(body);
  if (command) {
    if (!isLiveMachineOn()) {
      return Response.json(
        { error: "Live LAN MQTT is off. Turn it on in the Machine panel or set BAMBU_LAN_MQTT=1." },
        { status: 404 },
      );
    }

    const machine = getSharedMachine();
    const creds = readLiveCredentials();
    if ((await machine.status()).connection !== "connected") {
      await machine.connect(creds ?? undefined);
    }
    const lastCommand = await machine.send(command);
    const status = await machine.status();
    return Response.json(payload(status, lastCommand), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const configure = parseMachineConfigure(body);
  if (configure) {
    setMachineUiSession({
      enabled: configure.lan,
      credentials: configure.credentials,
    });
    return snapshot();
  }

  return Response.json({ error: "Unsupported machine command." }, { status: 400 });
}

function isLiveMachineOn(): boolean {
  return defaultAdapterId() === BAMBU_LAN_ADAPTER_ID;
}
