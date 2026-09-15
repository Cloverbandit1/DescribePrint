import {
  commandFromBody,
  parseCameraStubFromBody,
  parseCameraStubFromRequest,
  parseFarmConfigure,
  parseMachineConfigure,
  parsePrintDoctorBody,
  parseReshapeRemainingFromBody,
  parseReshapeRemainingFromRequest,
  type MachineApiResponse,
} from "@/lib/machine/api";
import { isAmsAutofixEnabled, maybeAutofixAmsFeedLoop } from "@/lib/machine/ams-autofix";
import {
  currentStubCameraFrame,
  detectFailure,
  isCameraDetectEnabled,
  isCameraStubEnabled,
  maybeDetectFailure,
  toCameraDetectReport,
} from "@/lib/machine/camera";
import {
  BAMBU_LAN_ADAPTER_ID,
  machineLanHint,
  machineLanSource,
  readLiveCredentials,
} from "@/lib/machine/config";
import { defaultAdapterId } from "@/lib/machine/adapter";
import { applyFarmSelection, getFarmRegistry } from "@/lib/machine/farm";
import {
  isReshapeRemainingActive,
  isReshapeRemainingEnabled,
  maybeEmergencyReshapeRemaining,
  peekLastReshapePlan,
} from "@/lib/machine/reshape";
import { getSharedMachine } from "@/lib/machine/runtime";
import { getMachineUiSession, setMachineUiSession } from "@/lib/machine/session";
import {
  diagnosisFromAmsHint,
  diagnosisFromCameraDetect,
  diagnosePrintComplaint,
  withAutofix,
  withReshape,
} from "@/lib/print-doctor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function applyCameraStubPref(cameraStub?: boolean): void {
  if (cameraStub !== undefined) {
    setMachineUiSession({ cameraStub });
  }
}

function applyReshapeRemainingPref(reshapeRemaining?: boolean): void {
  if (reshapeRemaining !== undefined) {
    setMachineUiSession({ reshapeRemaining });
  }
}

function payload(
  status: MachineApiResponse["status"],
  lastCommand?: MachineApiResponse["lastCommand"],
  extras?: Pick<MachineApiResponse, "diagnosis" | "lastAutofix" | "lastReshape">,
): MachineApiResponse {
  const adapterId = defaultAdapterId();
  const live = adapterId === BAMBU_LAN_ADAPTER_ID;
  const source = machineLanSource();
  const creds = readLiveCredentials();
  const session = getMachineUiSession();
  const host = creds?.host || (session.enabled ? session.credentials.host : "") || undefined;
  const serial = creds?.serial || (session.enabled ? session.credentials.serial : "") || undefined;
  const cameraDetect = maybeDetectFailure(isCameraDetectEnabled(process.env, session.cameraStub));
  return {
    live,
    adapterId,
    lanEnabled: source !== "off",
    source,
    hint: machineLanHint(),
    host,
    serial,
    cameraStub: isCameraStubEnabled(),
    amsAutofix: isAmsAutofixEnabled(),
    reshapeRemaining: isReshapeRemainingEnabled(),
    farm: {
      selectedId: getFarmRegistry().selected().id,
      count: getFarmRegistry().count(),
    },
    status,
    lastCommand,
    cameraDetect,
    ...extras,
    lastReshape: extras?.lastReshape ?? peekLastReshapePlan(),
    diagnosis: extras?.diagnosis ?? diagnosisFromCameraDetect(cameraDetect) ?? diagnosisFromAmsHint(status.amsHint),
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

export async function GET(request?: Request) {
  applyCameraStubPref(parseCameraStubFromRequest(request));
  applyReshapeRemainingPref(parseReshapeRemainingFromRequest(request));
  return snapshot();
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const farm = parseFarmConfigure(body);
  if (farm) {
    applyFarmSelection(farm.machine);
  }

  const configure = parseMachineConfigure(body);
  if (configure) {
    setMachineUiSession({
      enabled: configure.lan,
      credentials: configure.credentials,
      cameraStub: configure.cameraStub,
      reshapeRemaining: configure.reshapeRemaining,
    });
  } else {
    applyCameraStubPref(parseCameraStubFromBody(body));
    applyReshapeRemainingPref(parseReshapeRemainingFromBody(body));
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

  const doctor = parsePrintDoctorBody(body);
  if (doctor) {
    applyReshapeRemainingPref(doctor.reshapeRemaining);
    const machine = getSharedMachine();
    const status = await machine.status();
    const liveSlot = doctor.slot ?? status.amsHint?.slot;
    const liveRemain =
      liveSlot != null
        ? status.amsSlots.find((slot) => slot.slot === liveSlot)?.remainingPercent
        : status.amsSlots.find((slot) => slot.remainingPercent === 0)?.remainingPercent;
    const diagnosis = doctor.complaint
      ? diagnosePrintComplaint({
          complaint: doctor.complaint,
          material: doctor.material,
          amsSlot: liveSlot,
          remainingPercent: liveRemain,
          amsHint: status.amsHint,
        })
      : diagnosisFromAmsHint(status.amsHint, { remainingPercent: liveRemain, material: doctor.material });
    const patched = diagnosis && liveSlot != null ? { ...diagnosis, amsSlot: diagnosis.amsSlot ?? liveSlot } : diagnosis;
    const session = getMachineUiSession();
    const cameraDetect = isCameraDetectEnabled(process.env, session.cameraStub)
      ? toCameraDetectReport(detectFailure(currentStubCameraFrame()))
      : undefined;
    const lastAutofix = await maybeAutofixAmsFeedLoop({
      adapter: machine,
      diagnosis: patched,
      complaint: doctor.complaint || undefined,
      status,
    });
    const reshapeEnabled = isReshapeRemainingActive(process.env, session.reshapeRemaining);
    const lastReshape = await maybeEmergencyReshapeRemaining({
      adapter: machine,
      complaint: doctor.complaint || undefined,
      defectId: patched?.defectId,
      cameraDetect,
      status: await machine.status(),
      enabled: reshapeEnabled,
      jobId: doctor.jobId,
      material: doctor.material,
    });
    const nextStatus = await machine.status();
    let nextDiagnosis = patched ? withAutofix(patched, lastAutofix) : undefined;
    if (nextDiagnosis && lastReshape.requested) {
      nextDiagnosis = withReshape(nextDiagnosis, lastReshape);
    }
    return Response.json(
      payload(nextStatus, lastAutofix.commands.at(-1) ?? lastReshape.commands.at(-1), {
        diagnosis: nextDiagnosis,
        lastAutofix,
        lastReshape: lastReshape.requested ? lastReshape : undefined,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (configure || farm) {
    return snapshot();
  }

  return Response.json({ error: "Unsupported machine command." }, { status: 400 });
}

function isLiveMachineOn(): boolean {
  return defaultAdapterId() === BAMBU_LAN_ADAPTER_ID;
}
