/** Where the OpenSCAD binary was resolved from. Safe for client imports. */
export type OpenscadSource =
  | "OPENSCAD_PATH"
  | "OPENSCAD_BIN"
  | "portable"
  | "windows-install"
  | "macos-install"
  | "linux-install"
  | "path"
  | "missing";

export type HealthTone = "ok" | "warn" | "danger" | "neutral";

export type LocalAiMode = "local" | "cloud" | "fixture";

export type LocalAiHealth = {
  mode: LocalAiMode;
  configured: boolean;
  reachable: boolean;
  model: string;
  modelPresent: boolean;
  baseUrl: string;
  tone: HealthTone;
  label: string;
  detail: string;
  tips: string[];
};

export type OpenscadHealth = {
  found: boolean;
  path: string | null;
  source: OpenscadSource;
  version: string | null;
  tone: HealthTone;
  label: string;
  detail: string;
  tips: string[];
};

export type HealthReport = {
  ready: boolean;
  localAi: LocalAiHealth;
  openscad: OpenscadHealth;
  printer: {
    id: string;
    name: string;
    buildVolumeMm: [number, number, number];
  };
};
