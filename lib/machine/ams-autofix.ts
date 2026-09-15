import { extractAmsSlot, type PrintDoctorResult } from "../print-doctor";
import type { MachineAdapter } from "./adapter";
import { envFlagEnabled, type ProcessEnvLike } from "./config";
import type { AmsHint, CommandResult, LiveMachineStatus } from "./types";

export type { AmsHint, AmsHintKind } from "./types";

export type AmsAutofixResult = {
  attempted: boolean;
  ok: boolean;
  pausedFirst: boolean;
  slot?: number;
  message: string;
  commands: CommandResult[];
  physicalSteps?: string[];
};

/**
 * Mock / test sentinel stored in `ams_status`. Not a claimed official enum —
 * live hopper faults are detected via AMS-family `print_error` (HMS 0C…).
 */
export const AMS_FEED_LOOP_SENTINEL = 0x0c01;

/** AMS autofix is off unless AMS_AUTOFIX is explicitly enabled. */
export function isAmsAutofixEnabled(env: ProcessEnvLike = process.env): boolean {
  return envFlagEnabled(env.AMS_AUTOFIX, false);
}

export function amsFeedLoopPhysicalSteps(slot: number): string[] {
  return [
    `Pull filament from AMS ${slot}, check PTFE, retry.`,
    "Make sure the spool can turn freely and is not tangled.",
    "If the tip is chewed or flattened, cut a fresh 45° tip and reseat it.",
  ];
}

export function trayIndexToSlot(tray: number | undefined): number | undefined {
  if (tray == null || !Number.isFinite(tray) || tray < 0 || tray >= 254) return undefined;
  return (Math.floor(tray) % 4) + 1;
}

/** HMS AMS family uses high byte 0x0C on many P / X / H reports. */
export function isAmsPrintError(printError: number | undefined): boolean {
  if (printError == null || !Number.isFinite(printError) || printError === 0) return false;
  return ((printError >>> 16) & 0xff) === 0x0c;
}

export function amsHintFromReport(input: {
  amsStatus?: number;
  printError?: number;
  trayNow?: number;
  trayTar?: number;
}): AmsHint | undefined {
  const slot = trayIndexToSlot(input.trayTar ?? input.trayNow);
  if (isAmsPrintError(input.printError)) {
    return {
      kind: "hopper-error",
      slot,
      amsStatus: input.amsStatus,
      message: "AMS hopper/feed error (print_error).",
    };
  }
  if (input.amsStatus === AMS_FEED_LOOP_SENTINEL) {
    return {
      kind: "feed-loop",
      slot,
      amsStatus: input.amsStatus,
      message: "AMS feed/unfeed loop.",
    };
  }
  if (input.amsStatus != null) {
    return { kind: "none", amsStatus: input.amsStatus, slot };
  }
  return undefined;
}

export function isAmsFeedLoopHint(hint: AmsHint | undefined): boolean {
  return hint?.kind === "feed-loop" || hint?.kind === "hopper-error";
}

export function resolveAmsLoopSlot(input: {
  diagnosis?: PrintDoctorResult;
  complaint?: string;
  status?: LiveMachineStatus;
}): number {
  return (
    input.diagnosis?.amsSlot ??
    (input.complaint ? extractAmsSlot(input.complaint) : undefined) ??
    input.status?.amsHint?.slot ??
    1
  );
}

export function detectsAmsFeedLoop(input: {
  diagnosis?: PrintDoctorResult;
  status?: LiveMachineStatus;
}): boolean {
  if (input.diagnosis?.defectId === "ams-feed-loop") return true;
  return isAmsFeedLoopHint(input.status?.amsHint);
}

function idleResult(message: string, slot?: number): AmsAutofixResult {
  return { attempted: false, ok: false, pausedFirst: false, slot, message, commands: [] };
}

/**
 * Diagnose-only unless AMS_AUTOFIX is on. When on: safe pause first, then
 * stop feed + retry load on that slot. Software failure returns physical steps.
 */
export async function maybeAutofixAmsFeedLoop(opts: {
  adapter: MachineAdapter;
  diagnosis?: PrintDoctorResult;
  complaint?: string;
  status?: LiveMachineStatus;
  enabled?: boolean;
  env?: ProcessEnvLike;
}): Promise<AmsAutofixResult> {
  const enabled = opts.enabled ?? isAmsAutofixEnabled(opts.env);
  const status = opts.status ?? (await opts.adapter.status());
  const looping = detectsAmsFeedLoop({ diagnosis: opts.diagnosis, status });
  const slot = resolveAmsLoopSlot({ diagnosis: opts.diagnosis, complaint: opts.complaint, status });

  if (!looping) return idleResult("No AMS feed loop detected.", slot);
  if (!enabled) {
    return idleResult("AMS autofix is off — diagnosis only, no printer commands.", slot);
  }
  if (status.connection !== "connected") {
    return {
      attempted: true,
      ok: false,
      pausedFirst: false,
      slot,
      message: "Printer is not connected. Software autofix skipped.",
      commands: [],
      physicalSteps: amsFeedLoopPhysicalSteps(slot),
    };
  }

  const commands: CommandResult[] = [];
  let pausedFirst = false;

  if (status.print === "printing") {
    const paused = await opts.adapter.send({ type: "pause" });
    commands.push(paused);
    if (!paused.ok) {
      return {
        attempted: true,
        ok: false,
        pausedFirst: false,
        slot,
        message: `Could not pause before AMS autofix. ${paused.message}`,
        commands,
        physicalSteps: ["On the P2S screen, tap Pause.", ...amsFeedLoopPhysicalSteps(slot)],
      };
    }
    pausedFirst = true;
  }

  const stop = await opts.adapter.send({ type: "ams-stop-feed", slot });
  commands.push(stop);
  if (!stop.ok) {
    return {
      attempted: true,
      ok: false,
      pausedFirst,
      slot,
      message: `Paused, but could not stop AMS ${slot} feed. ${stop.message}`,
      commands,
      physicalSteps: stop.physicalSteps ?? amsFeedLoopPhysicalSteps(slot),
    };
  }

  const retry = await opts.adapter.send({ type: "ams-retry-load", slot });
  commands.push(retry);
  if (!retry.ok) {
    return {
      attempted: true,
      ok: false,
      pausedFirst,
      slot,
      message: `Software could not clear AMS ${slot}. Use the physical steps.`,
      commands,
      physicalSteps: retry.physicalSteps ?? amsFeedLoopPhysicalSteps(slot),
    };
  }

  return {
    attempted: true,
    ok: true,
    pausedFirst,
    slot,
    message: pausedFirst
      ? `Paused, then stopped feed and retried load on AMS ${slot}.`
      : `Stopped feed and retried load on AMS ${slot}.`,
    commands,
  };
}
