/**
 * Launch preflight: map a HealthReport to PASS/WARN/FAIL checks and exit codes.
 *
 * Soft issues (Ollama down, MODEL missing, OpenSCAD missing) never hard-fail Start.
 * Exit 0 = all PASS, 2 = soft issues (Start continues), 1 = reserved for runner crash.
 *
 * Never list-delete or retarget Agent Smith models. Tips may say `ollama pull <MODEL>` only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getHealthReport, type HealthDeps } from "./health";
import type { HealthReport, LocalAiHealth, OpenscadHealth } from "./health-types";

export const PREFLIGHT_EXIT = {
  /** All checks passed. */
  ok: 0,
  /** Runner crash / could not produce a report. Start scripts treat this as non-blocking. */
  hard: 1,
  /** WARN or soft FAIL — Start continues. */
  soft: 2,
} as const;

export type PreflightStatus = "PASS" | "WARN" | "FAIL";

export type PreflightCheckId = "localAi" | "openscad";

export type PreflightCheck = {
  id: PreflightCheckId;
  name: string;
  status: PreflightStatus;
  detail: string;
  tips: string[];
};

export type PreflightResult = {
  checks: PreflightCheck[];
  overall: PreflightStatus;
  exitCode: 0 | 1 | 2;
  /** Start.ps1 / cmd always continue for report-based results. */
  continueStart: boolean;
};

const UNSAFE_OLLAMA_TIP = /ollama\s+(rm|delete|rmi)\b|list-delete|11435/i;

export function preflightTextIsUnsafe(text: string): boolean {
  return UNSAFE_OLLAMA_TIP.test(text);
}

function worstStatus(statuses: PreflightStatus[]): PreflightStatus {
  if (statuses.includes("FAIL")) return "FAIL";
  if (statuses.includes("WARN")) return "WARN";
  return "PASS";
}

export function evaluateLocalAiCheck(localAi: LocalAiHealth): PreflightCheck {
  if (localAi.mode === "fixture" || localAi.mode === "cloud") {
    return {
      id: "localAi",
      name: localAi.label,
      status: "PASS",
      detail: localAi.detail,
      tips: localAi.tips,
    };
  }
  if (!localAi.reachable) {
    return {
      id: "localAi",
      name: localAi.label,
      status: "FAIL",
      detail: localAi.detail,
      tips: localAi.tips,
    };
  }
  if (!localAi.modelPresent) {
    return {
      id: "localAi",
      name: localAi.label,
      status: "WARN",
      detail: localAi.detail,
      tips: localAi.tips,
    };
  }
  return {
    id: "localAi",
    name: localAi.label,
    status: "PASS",
    detail: localAi.detail,
    tips: localAi.tips,
  };
}

export function evaluateOpenscadCheck(openscad: OpenscadHealth): PreflightCheck {
  return {
    id: "openscad",
    name: openscad.label,
    status: openscad.found ? "PASS" : "WARN",
    detail: openscad.detail,
    tips: openscad.tips,
  };
}

export function evaluateHealthPreflight(report: HealthReport): PreflightResult {
  const checks = [evaluateLocalAiCheck(report.localAi), evaluateOpenscadCheck(report.openscad)];
  const overall = worstStatus(checks.map((check) => check.status));
  return {
    checks,
    overall,
    exitCode: overall === "PASS" ? PREFLIGHT_EXIT.ok : PREFLIGHT_EXIT.soft,
    continueStart: true,
  };
}

function statusTag(status: PreflightStatus): string {
  return `[${status}]`;
}

export function formatHealthPreflight(result: PreflightResult): string {
  const lines: string[] = ["DescribePrint preflight", "----------------------"];
  for (const check of result.checks) {
    lines.push(`  ${statusTag(check.status)} ${check.name.padEnd(10)} ${check.detail}`);
    if (check.status !== "PASS") {
      for (const tip of check.tips) {
        if (preflightTextIsUnsafe(tip)) continue;
        lines.push(`         • ${tip}`);
      }
    }
  }
  lines.push("");
  if (result.overall === "PASS") {
    lines.push("Overall: PASS — Local AI and OpenSCAD look ready.");
  } else if (result.overall === "WARN") {
    lines.push(
      "Overall: WARN — starting the app anyway. Generate/compile may fail until the items above are fixed.",
    );
  } else {
    lines.push(
      "Overall: FAIL — starting the app anyway. Start Ollama and/or pull MODEL before generating.",
    );
  }
  lines.push("Do not change the Ollama port (11434). Leave Agent Smith models untouched.");
  return lines.join("\n");
}

/** Parse a Next-style .env file. Does not override keys already set on process.env. */
export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): number {
  if (!existsSync(filePath)) return 0;
  const text = readFileSync(filePath, "utf8");
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      applied += 1;
    }
  }
  return applied;
}

/** Load `.env` then `.env.local` (local wins for unset keys; existing process.env wins). */
export function loadDescribePrintEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  loadEnvFile(path.join(root, ".env"), env);
  loadEnvFile(path.join(root, ".env.local"), env);
}

export async function runHealthPreflight(
  deps: HealthDeps & { getReport?: () => Promise<HealthReport> } = {},
): Promise<PreflightResult> {
  const report = deps.getReport
    ? await deps.getReport()
    : await getHealthReport({
        probeLocalModels: deps.probeLocalModels,
        resolveOpenscad: deps.resolveOpenscad,
        // Cheap start: filesystem resolve only — skip the OpenSCAD -v spawn.
        probeOpenscadVersion: deps.probeOpenscadVersion ?? (async () => null),
      });
  return evaluateHealthPreflight(report);
}
