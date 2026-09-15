import { parseMidPrintCommand, type MachineApiResponse } from "@/lib/machine/api";
import { BAMBU_LAN_ADAPTER_ID } from "@/lib/machine/config";
import { defaultAdapterId } from "@/lib/machine/adapter";
import { getSharedMachine } from "@/lib/machine/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payload(
  live: boolean,
  adapterId: string,
  status: MachineApiResponse["status"],
  lastCommand?: MachineApiResponse["lastCommand"],
): MachineApiResponse {
  return { live, adapterId, status, lastCommand };
}

export async function GET() {
  const adapterId = defaultAdapterId();
  const live = adapterId === BAMBU_LAN_ADAPTER_ID;
  const machine = getSharedMachine();
  const status = live ? await machine.connect() : await machine.status();
  return Response.json(payload(live, machine.id, status), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const adapterId = defaultAdapterId();
  const live = adapterId === BAMBU_LAN_ADAPTER_ID;
  if (!live) {
    return Response.json(
      { error: "Live LAN MQTT is off. Set BAMBU_LAN_MQTT=1 and LAN credentials." },
      { status: 404 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const command = parseMidPrintCommand(
    body && typeof body === "object" && "command" in body ? (body as { command: unknown }).command : body,
  );
  if (!command) {
    return Response.json({ error: "Unsupported machine command." }, { status: 400 });
  }

  const machine = getSharedMachine();
  if ((await machine.status()).connection !== "connected") {
    await machine.connect();
  }
  const lastCommand = await machine.send(command);
  const status = await machine.status();
  return Response.json(payload(true, machine.id, status, lastCommand), {
    headers: { "Cache-Control": "no-store" },
  });
}
