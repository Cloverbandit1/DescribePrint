/**
 * In-session describe-edit version stack.
 *
 * Each generate / import / edit is a plate version: prompt + OpenSCAD
 * (or imported mesh job id) + job/preview metadata + chat thread.
 * In-memory only — refresh clears it. Persist later.
 */
import type { AppliedDesignChoice } from "./design-options";
import type {
  GenerateResult,
  PartSource,
  PlateEditMode,
  WearableCategoryId,
  WearableSizeId,
} from "./types";

export const VERSION_HISTORY_CAP = 20;

export const VERSION_HISTORY_NOTE =
  "In-session version history (stub). Refresh clears it. Persist later.";

export type PlateVersionKind = "generate" | "import" | "edit";

export type PlateVersion<TThread = unknown> = {
  id: string;
  createdAt: number;
  kind: PlateVersionKind;
  /** Short user-facing line (truncated prompt / import name). */
  label: string;
  /** The describe / import step that produced this plate. */
  prompt: string;
  /** Accumulated description used for CAD follow-ups. */
  designPrompt: string;
  /** OpenSCAD source when the plate is parametric (or an import wrap). */
  code: string | null;
  /** Server job that holds STL / 3MF / preview. */
  jobId: string;
  /** Same as jobId when the plate is an imported mesh; otherwise null. */
  importedMeshId: string | null;
  source: PartSource;
  result: GenerateResult;
  thread: TThread;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId | null;
  appliedChoices: AppliedDesignChoice[];
};

export type VersionHistoryState<TThread = unknown> = {
  versions: PlateVersion<TThread>[];
  /** Index of the plate currently on the bed. -1 when empty. */
  currentIndex: number;
};

export type PushVersionInput<TThread = unknown> = {
  id?: string;
  createdAt?: number;
  kind: PlateVersionKind;
  prompt: string;
  designPrompt: string;
  result: GenerateResult;
  thread: TThread;
  wearableSize?: WearableSizeId | null;
  wearableCategory?: WearableCategoryId | null;
  appliedChoices?: AppliedDesignChoice[] | null;
};

let nextVersionSeq = 0;

export function emptyVersionHistory<TThread = unknown>(): VersionHistoryState<TThread> {
  return { versions: [], currentIndex: -1 };
}

export function canUndo(state: VersionHistoryState<unknown>): boolean {
  return state.currentIndex > 0;
}

export function currentVersion<TThread>(
  state: VersionHistoryState<TThread>,
): PlateVersion<TThread> | null {
  if (state.currentIndex < 0) return null;
  return state.versions[state.currentIndex] ?? null;
}

export function versionKindLabel(kind: PlateVersionKind): string {
  if (kind === "import") return "Import";
  if (kind === "edit") return "Edit";
  return "Generate";
}

export function classifyPlateVersionKind(input: {
  hasPrevious?: boolean;
  startFresh?: boolean;
  source?: PartSource | null;
  editMode?: PlateEditMode | null;
}): PlateVersionKind {
  if (input.startFresh) return input.source === "imported-mesh" ? "import" : "generate";
  if (input.hasPrevious) return "edit";
  if (input.source === "imported-mesh") return "import";
  if (input.editMode === "import" || input.editMode === "image-import") return "import";
  return "generate";
}

export function formatVersionLabel(prompt: string, max = 48): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled plate";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function snapshotFromResult(result: GenerateResult): {
  code: string | null;
  jobId: string;
  importedMeshId: string | null;
  source: PartSource;
} {
  const code = result.code?.trim() ? result.code : null;
  const jobId = result.jobId;
  return {
    code,
    jobId,
    importedMeshId: result.source === "imported-mesh" ? jobId : null,
    source: result.source,
  };
}

export function pushVersion<TThread>(
  state: VersionHistoryState<TThread>,
  input: PushVersionInput<TThread>,
): VersionHistoryState<TThread> {
  const snapshot = snapshotFromResult(input.result);
  const version: PlateVersion<TThread> = {
    id: input.id ?? `v-${++nextVersionSeq}`,
    createdAt: input.createdAt ?? Date.now(),
    kind: input.kind,
    label: formatVersionLabel(input.prompt),
    prompt: input.prompt,
    designPrompt: input.designPrompt,
    code: snapshot.code,
    jobId: snapshot.jobId,
    importedMeshId: snapshot.importedMeshId,
    source: snapshot.source,
    result: input.result,
    thread: input.thread,
    wearableSize: input.wearableSize ?? input.result.wearableSize ?? null,
    wearableCategory: input.wearableCategory ?? input.result.wearableCategory ?? null,
    appliedChoices: input.appliedChoices ? [...input.appliedChoices] : [...(input.result.appliedChoices ?? [])],
  };

  const kept = state.currentIndex >= 0 ? state.versions.slice(0, state.currentIndex + 1) : [];
  let versions = [...kept, version];
  let currentIndex = versions.length - 1;

  if (versions.length > VERSION_HISTORY_CAP) {
    const drop = versions.length - VERSION_HISTORY_CAP;
    versions = versions.slice(drop);
    currentIndex = versions.length - 1;
  }

  return { versions, currentIndex };
}

export function undoVersion<TThread>(
  state: VersionHistoryState<TThread>,
): { state: VersionHistoryState<TThread>; restored: PlateVersion<TThread> | null } {
  if (!canUndo(state)) {
    return { state, restored: currentVersion(state) };
  }
  const next: VersionHistoryState<TThread> = {
    versions: state.versions,
    currentIndex: state.currentIndex - 1,
  };
  return { state: next, restored: currentVersion(next) };
}

export function restoreVersion<TThread>(
  state: VersionHistoryState<TThread>,
  index: number,
): { state: VersionHistoryState<TThread>; restored: PlateVersion<TThread> | null } {
  if (!Number.isInteger(index) || index < 0 || index >= state.versions.length) {
    return { state, restored: currentVersion(state) };
  }
  const next: VersionHistoryState<TThread> = { versions: state.versions, currentIndex: index };
  return { state: next, restored: currentVersion(next) };
}

export function resetVersionHistory<TThread>(): VersionHistoryState<TThread> {
  return emptyVersionHistory<TThread>();
}
