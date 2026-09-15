"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyDesignChoiceToPrompt,
  resolveDesignOptions,
  upsertAppliedChoice,
  type AppliedDesignChoice,
  type DesignOption,
  type DesignOptionGroup,
} from "@/lib/design-options";
import { EXAMPLE_PROMPTS } from "@/lib/fixtures";
import {
  namedColorRegions,
  PAINT_CHIP_COLORS,
  previewTintHex,
  suggestedPaintFollowUp,
} from "@/lib/region-paint";
import type { HealthReport, HealthTone } from "@/lib/health-types";
import {
  applyChatAmsSlotAssignment,
  buildAmsSlotPlan,
  declaredDesignFilaments,
  reassignAmsSlot,
} from "@/lib/machine/ams";
import { selectAmsHelpGuide, type AmsHelpGuide } from "@/lib/machine/ams-help";
import {
  cameraDoctorMidPrintChips,
  takeCameraDoctorAnnouncement,
  type CameraDoctorHeld,
  type CameraDoctorMidPrintChip,
} from "@/lib/machine/camera-doctor-bridge";
import {
  FAILURE_PHOTO_NOTE,
  annotateFailurePhotoDiagnosis,
  diagnosisFromFailurePhoto,
  failurePhotoAskResult,
  formatFailurePhotoUserLine,
  looksLikeFailurePhotoCaption,
  replayFailurePhoto,
  type FailurePhotoInput,
} from "@/lib/machine/failure-photo";
import type { AmsSlotPlan, AmsSlotStatus } from "@/lib/machine/types";
import { MACHINE_RESHAPE_STORAGE_KEY, parseReshapeRemainingPref } from "@/lib/machine/reshape-pref";
import { FARM_QUEUE_NOTE, nextFarmStubName } from "@/lib/machine/farm";
import {
  ESTIMATE_COST_SESSION_KEY,
  defaultCostPerKgFor,
  estimatePrintFromReport,
  formatPrintEstimateLine,
  parseCostPerKgMap,
  serializeCostPerKgMap,
} from "@/lib/machine/print-estimate";
import {
  PLATE_PACK_NOTE,
  copiesOfPart,
  packOverlays,
  packPartFromBoundingBox,
  packPlate,
  type PackPlan,
} from "@/lib/machine/plate-pack";
import { useFarmRegistry } from "@/lib/machine/use-farm-registry";
import { useMachineMonitor } from "@/lib/machine/use-machine-monitor";
import {
  PRINT_DOCTOR_MEMORY_KEY,
  applyStoredDoctorMemory,
  parsePrintDoctorMemory,
  rememberPerfect,
  rememberStillBad,
  writePrintDoctorMemory,
} from "@/lib/machine/print-doctor-memory";
import {
  confirmPerfect,
  diagnosePrintComplaint,
  looksLikeDoctorFeedback,
  looksLikeMaterialPresetRequest,
  looksLikePrintDoctorComplaint,
  type DoctorFeedbackKind,
  type PrintDoctorResult,
} from "@/lib/print-doctor";
import {
  coolingHintFor,
  defaultPrinter,
  filamentPickerLabel,
  filamentPreset,
  isFilamentId,
  listFilamentPresets,
  MATERIAL_SESSION_KEY,
  normalizeFilamentId,
  parseMaterialSession,
  serializeMaterialSession,
  speedTierFor,
  type FilamentId,
  type PrinterProfile,
} from "@/lib/printers";
import { formatMm, toMillimeters } from "@/lib/units";
import {
  applyUserProfileToRequest,
  formatUserProfileSummary,
  hasCustomUserProfile,
  sessionDefaultsFromProfile,
  upsertUserProfileAmsSlot,
  useUserProfile,
  USER_PROFILE_AMS_SLOT_COUNT,
  USER_PROFILE_NOTE,
  type UserProfile,
} from "@/lib/user-profile";
import {
  DEFAULT_WEARABLE_CATEGORY,
  MEASUREMENT_LABELS,
  WEARABLE_CATEGORY_IDS,
  WEARABLE_SIZE_IDS,
  WEARABLE_SIZE_LABELS,
  describeWearableSize,
  getWearableCategory,
  isWearableSizeId,
  wearableChartNote,
  wearableSizeRatio,
} from "@/lib/wearable-sizes";
import type { GenerateResult, ImageImportMeta, PipelineStep, StatusEvent, Unit, WearableCategoryId, WearableSizeId } from "@/lib/types";
import {
  VERSION_HISTORY_NOTE,
  canUndo,
  classifyPlateVersionKind,
  emptyVersionHistory,
  pushVersion,
  restoreVersion,
  undoVersion,
  versionKindLabel,
  type PlateVersion,
  type VersionHistoryState,
} from "@/lib/version-history";
import type { CameraView, PackOutline, ViewerTheme } from "./Viewer";

const EMPTY_AMS_SLOTS: AmsSlotStatus[] = [];

const Viewer = dynamic(() => import("./Viewer").then((m) => m.Viewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-canvas text-sm text-muted">Loading plate…</div>
  ),
});

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "status"; steps: StatusEvent[]; active: boolean }
  | { id: string; kind: "result"; result: GenerateResult }
  | { id: string; kind: "doctor"; result: PrintDoctorResult; feedback?: DoctorFeedbackKind }
  | { id: string; kind: "error"; text: string };

type WorkspaceTab = "prepare" | "preview";

function photoPlateHeadline(meta?: ImageImportMeta | null): string {
  if (meta?.completion?.applied) {
    const cls = meta.completion.subjectClass;
    const matched = cls === "helmet" ? "helmet" : cls === "bust" ? "bust" : "head";
    return `Photo solid on the plate — ${matched} matched, body completed`;
  }
  const fragment = meta?.fragment;
  if (fragment?.looksLikeFragment) {
    return fragment.restoredMissingVolume
      ? "Photo solid on the plate — fragment identified, missing volume restored"
      : "Photo solid on the plate — fragment identified, wear kept";
  }
  return "Photo solid on the plate — backside inferred (luminance depth)";
}

function cadUpperStatusLine(upper?: { invoked?: boolean; ok?: boolean; error?: string }): string {
  if (!upper?.invoked) return "";
  if (upper.ok) return " CAD upper ready.";
  const error = (upper.error ?? "unknown error").replace(/\.+$/, "");
  return ` CAD refused: ${error}.`;
}

function resliceFeedStatusLine(reslice?: {
  sendGcode?: boolean;
  cad?: { jobId?: string; stlUrl?: string; threemfUrl?: string };
}): string {
  if (!reslice) return "";
  if (reslice.cad?.jobId) {
    return ` Reslice feed: ${reslice.cad.jobId} (STL/3MF, send gcode off).`;
  }
  return reslice.sendGcode === false ? " Reslice stub (send gcode off)." : "";
}

/** Everyday status only — pipeline jargon stays out of the main view. */
const FRIENDLY_STEP: Record<PipelineStep, string> = {
  queued: "Starting…",
  planning: "Reading your description…",
  codegen: "Designing the part…",
  sanitize: "Checking the design…",
  compile: "Building the model…",
  "mesh-check": "Making sure it can print…",
  export: "Preparing files…",
  retry: "Trying again…",
  import: "Reading the file…",
  image: "Reading the photo…",
  transform: "Scaling the part…",
  done: "Ready",
};

const CAD_FOLLOW_UPS = ["Make the hole 8 mm", "Make it larger", "Start a new part"] as const;
const IMPORTED_FOLLOW_UPS = ["Make it size L", "Add an 8 mm hole", "Sit it on the plate", "Start a new part"] as const;

function cadFollowUps(result: GenerateResult): string[] {
  const paint = suggestedPaintFollowUp(result.colorRegions ?? []);
  if (!paint) return [...CAD_FOLLOW_UPS];
  return ["Make the hole 8 mm", "Make it larger", paint, "Start a new part"];
}
const PHOTO_FOLLOW_UPS = ["Complete the body", "Make it size L", "Add an 8 mm hole", "Start a new part"] as const;

const THEME_KEY = "describeprint-theme";

let counter = 0;
const nid = () => `m-${Date.now()}-${counter++}`;

async function consumeSse(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
) {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const event = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const dataLine = chunk.match(/^data:\s*(.+)$/m)?.[1];
      if (event && dataLine) {
        onEvent(event, JSON.parse(dataLine));
      }
    }
  }
}

export function DescribePrintApp({ localAi = false }: { localAi?: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [sizeHint, setSizeHint] = useState("");
  const [units, setUnits] = useState<Unit>("mm");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [doctorResult, setDoctorResult] = useState<PrintDoctorResult | null>(null);
  const [designPrompt, setDesignPrompt] = useState<string | null>(null);
  const [wearableSize, setWearableSize] = useState<WearableSizeId | null>(null);
  const [wearableCategory, setWearableCategory] = useState<WearableCategoryId>(DEFAULT_WEARABLE_CATEGORY);
  const [appliedChoices, setAppliedChoices] = useState<AppliedDesignChoice[]>([]);
  const [history, setHistory] = useState<VersionHistoryState<ChatItem[]>>(() => emptyVersionHistory());
  const [showHistory, setShowHistory] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keepWear, setKeepWear] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceTab>("prepare");
  const [cameraView, setCameraView] = useState<CameraView>("iso");
  const [showStrengthHeatmap, setShowStrengthHeatmap] = useState(true);
  const [explodeView, setExplodeView] = useState(false);
  const [theme, setTheme] = useState<ViewerTheme>("dark");
  const [wideLayout, setWideLayout] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const printer = defaultPrinter();
  const [material, setMaterial] = useState<FilamentId>(printer.defaultFilament);
  const [userProfile, commitUserProfile] = useUserProfile();
  const [packPlan, setPackPlan] = useState<PackPlan | null>(null);
  const [packOutlines, setPackOutlines] = useState<PackOutline[]>([]);

  const sizeNumber = useMemo(() => {
    const n = Number(sizeHint);
    return sizeHint.trim() && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeHint]);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
    setMaterial(parseMaterialSession(window.localStorage.getItem(MATERIAL_SESSION_KEY)));
  }, []);

  useEffect(() => {
    const defaults = sessionDefaultsFromProfile(userProfile);
    setWearableSize(defaults.wearableSize);
    setWearableCategory(defaults.wearableCategory);
    setMaterial(defaults.filament);
    setSizeHint(defaults.sizeHint);
    setUnits(defaults.units);
  }, [
    userProfile.wearableSize,
    userProfile.wearableCategory,
    userProfile.filament,
    userProfile.partSizeHint,
    userProfile.units,
  ]);

  useEffect(() => {
    window.localStorage.setItem(MATERIAL_SESSION_KEY, serializeMaterialSession(material));
  }, [material]);

  useEffect(() => {
    setPackPlan(null);
    setPackOutlines([]);
  }, [result?.jobId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWideLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    });
  };

  function readDoctorMemory() {
    return parsePrintDoctorMemory(
      typeof window !== "undefined" ? window.localStorage.getItem(PRINT_DOCTOR_MEMORY_KEY) : null,
    );
  }

  function persistDoctorMemory(store: ReturnType<typeof parsePrintDoctorMemory>) {
    if (typeof window === "undefined") return;
    writePrintDoctorMemory(store, window.localStorage);
  }

  function applyDoctorFeedback(kind: DoctorFeedbackKind, spoken: string) {
    if (!doctorResult) return;
    const store = readDoctorMemory();
    if (kind === "perfect") {
      persistDoctorMemory(rememberPerfect(store, doctorResult));
      const confirmation = confirmPerfect(doctorResult);
      setPrompt("");
      setDoctorResult(confirmation);
      setItems((prev) => [
        ...prev,
        { id: nid(), kind: "user", text: spoken },
        { id: nid(), kind: "doctor", result: confirmation, feedback: "perfect" },
      ]);
      scrollToEnd();
      return;
    }
    const { store: nextStore, next } = rememberStillBad(store, doctorResult);
    persistDoctorMemory(nextStore);
    setPrompt("");
    setDoctorResult(next);
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: spoken },
      { id: nid(), kind: "doctor", result: next },
    ]);
    scrollToEnd();
  }

  async function submitFailurePhoto(input: FailurePhotoInput) {
    if (busy) return;
    const replay = replayFailurePhoto(input);
    const userText = formatFailurePhotoUserLine(input);
    setPrompt("");
    if (replay.kind === "unknown") {
      const ask = failurePhotoAskResult();
      setDoctorResult(ask);
      setItems((prev) => [
        ...prev,
        { id: nid(), kind: "user", text: userText },
        { id: nid(), kind: "doctor", result: ask },
      ]);
      scrollToEnd();
      return;
    }
    let diagnosis =
      diagnosisFromFailurePhoto(input, { printerId: printer.id, material }) ??
      diagnosePrintComplaint({ complaint: replay.doctorSymptom, printerId: printer.id, material });
    setBusy(true);
    try {
      const response = await fetch("/api/machine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          complaint: replay.doctorSymptom,
          material,
          reshapeRemaining: false,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { diagnosis?: typeof diagnosis };
        if (data.diagnosis) diagnosis = annotateFailurePhotoDiagnosis(data.diagnosis, replay);
      }
    } catch {
      // Keep the local stub diagnosis if the machine API is down.
    } finally {
      setBusy(false);
    }
    diagnosis = applyStoredDoctorMemory(readDoctorMemory(), diagnosis);
    setDoctorResult(diagnosis);
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: userText },
      { id: nid(), kind: "doctor", result: diagnosis },
    ]);
    scrollToEnd();
  }

  const appendCameraDoctor = useCallback((diagnosis: PrintDoctorResult) => {
    const tagged = applyStoredDoctorMemory(
      parsePrintDoctorMemory(
        typeof window !== "undefined" ? window.localStorage.getItem(PRINT_DOCTOR_MEMORY_KEY) : null,
      ),
      diagnosis,
    );
    setDoctorResult(tagged);
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (
        last?.kind === "doctor" &&
        last.result.defectId === tagged.defectId &&
        last.result.cameraGuide &&
        !last.feedback
      ) {
        return prev;
      }
      return [...prev, { id: nid(), kind: "doctor", result: tagged }];
    });
    scrollToEnd();
  }, []);

  function applyProfileSession(profile: UserProfile) {
    const defaults = sessionDefaultsFromProfile(profile);
    setWearableSize(defaults.wearableSize);
    setWearableCategory(defaults.wearableCategory);
    setMaterial(defaults.filament);
    setSizeHint(defaults.sizeHint);
    setUnits(defaults.units);
  }

  function resetConversation() {
    setItems([]);
    setResult(null);
    setDoctorResult(null);
    setDesignPrompt(null);
    applyProfileSession(userProfile);
    setAppliedChoices([]);
    setHistory(emptyVersionHistory());
    setShowHistory(false);
    setPrompt("");
    setShowDetails(false);
    setWorkspace("prepare");
    setPackPlan(null);
    setPackOutlines([]);
  }

  function applyRestoredVersion(version: PlateVersion<ChatItem[]>) {
    setResult(version.result);
    setDesignPrompt(version.designPrompt);
    setWearableSize(version.wearableSize);
    setWearableCategory(version.wearableCategory ?? DEFAULT_WEARABLE_CATEGORY);
    setAppliedChoices(version.appliedChoices);
    setItems(version.thread);
    setShowDetails(false);
    setWorkspace("prepare");
    setPrompt("");
  }

  function undoPlate() {
    if (busy || !canUndo(history)) return;
    const { state, restored } = undoVersion(history);
    if (!restored) return;
    setHistory(state);
    applyRestoredVersion(restored);
    scrollToEnd();
  }

  function restorePlate(index: number) {
    if (busy) return;
    const { state, restored } = restoreVersion(history, index);
    if (!restored || state.currentIndex === history.currentIndex) return;
    setHistory(state);
    applyRestoredVersion(restored);
    scrollToEnd();
  }

  async function printPart(
    text: string,
    options?: {
      wearableSize?: WearableSizeId | null;
      wearableCategory?: WearableCategoryId | null;
      choices?: AppliedDesignChoice[] | null;
      filament?: FilamentId | null;
    },
  ) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;
    const profiled = applyUserProfileToRequest(
      {
        wearableSize: options?.wearableSize !== undefined ? options.wearableSize : wearableSize ?? undefined,
        wearableCategory: options?.wearableCategory ?? wearableCategory,
        filament: options?.filament ?? material,
        sizeHint: sizeNumber ?? undefined,
        units,
      },
      userProfile,
    );
    const sizeForRequest = profiled.wearableSize;
    const categoryForRequest = profiled.wearableCategory;

    const feedback = looksLikeDoctorFeedback(cleaned);
    if (feedback && doctorResult) {
      applyDoctorFeedback(feedback, cleaned);
      return;
    }

    const captionReplay = looksLikeFailurePhotoCaption(cleaned) ? replayFailurePhoto({ hint: cleaned }) : undefined;
    const doctorComplaint = looksLikePrintDoctorComplaint(cleaned)
      ? cleaned
      : captionReplay && captionReplay.kind !== "unknown"
        ? captionReplay.doctorSymptom
        : undefined;

    if (doctorComplaint) {
      const reshapePref = parseReshapeRemainingPref(
        typeof window !== "undefined" ? window.localStorage.getItem(MACHINE_RESHAPE_STORAGE_KEY) : null,
      );
      const fromCaption = doctorComplaint !== cleaned;
      let diagnosis = fromCaption
        ? (diagnosisFromFailurePhoto({ hint: cleaned }, { printerId: printer.id, material }) ??
          diagnosePrintComplaint({ complaint: doctorComplaint, printerId: printer.id, material }))
        : diagnosePrintComplaint({ complaint: doctorComplaint, printerId: printer.id, material });
      setBusy(true);
      try {
        const response = await fetch("/api/machine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            complaint: doctorComplaint,
            material,
            reshapeRemaining: reshapePref,
            jobId: result?.jobId,
            previousCode: result?.code,
            previousPrompt: designPrompt,
          }),
        });
        if (response.ok) {
          const data = (await response.json()) as { diagnosis?: typeof diagnosis };
          if (data.diagnosis) {
            diagnosis =
              fromCaption && captionReplay
                ? annotateFailurePhotoDiagnosis(data.diagnosis, captionReplay)
                : data.diagnosis;
          }
        }
      } catch {
        // Keep the local diagnosis if the machine API is down.
      } finally {
        setBusy(false);
      }
      if (diagnosis.defectId !== "mid-print-control") {
        diagnosis = applyStoredDoctorMemory(readDoctorMemory(), diagnosis);
      }
      setPrompt("");
      const named = normalizeFilamentId(cleaned);
      if (named || diagnosis.appliedPreset) {
        const next = normalizeFilamentId(String(diagnosis.material)) ?? named;
        if (next) setMaterial(next);
      } else if (looksLikeMaterialPresetRequest(cleaned)) {
        const next = normalizeFilamentId(String(diagnosis.material));
        if (next) setMaterial(next);
      }
      setDoctorResult(diagnosis);
      const cadUpper = diagnosis.reshape?.cadUpper?.ok ? diagnosis.reshape.cadUpper.result : undefined;
      setItems((prev) => {
        const nextItems: ChatItem[] = [
          ...prev,
          { id: nid(), kind: "user", text: cleaned },
          { id: nid(), kind: "doctor", result: diagnosis },
        ];
        if (cadUpper) {
          nextItems.push({ id: nid(), kind: "result", result: cadUpper });
          setResult(cadUpper);
          setDesignPrompt(cleaned);
          setShowDetails(false);
          setWorkspace("prepare");
          setHistory((prevHistory) =>
            pushVersion(prevHistory, {
              kind: classifyPlateVersionKind({
                hasPrevious: Boolean(result?.jobId),
                source: cadUpper.source,
                editMode: cadUpper.editMode,
              }),
              prompt: cleaned,
              designPrompt: cleaned,
              result: cadUpper,
              thread: nextItems,
              wearableSize: cadUpper.wearableSize ?? wearableSize,
              wearableCategory: cadUpper.wearableCategory ?? wearableCategory,
              appliedChoices,
            }),
          );
        }
        return nextItems;
      });
      scrollToEnd();
      return;
    }

    const startFresh = /\b(new part|start over|something else|different part|forget that|scratch)\b/i.test(cleaned);
    const choicesForRequest = startFresh ? [] : (options?.choices ?? appliedChoices);
    if (startFresh) {
      setAppliedChoices([]);
      setHistory(emptyVersionHistory());
    }
    const previousPrompt = startFresh ? null : designPrompt;
    const previousCode = startFresh ? null : result?.code;
    const previousJobId = startFresh ? null : result?.jobId;
    const previousSource = startFresh ? null : result?.source;

    setBusy(true);
    setPrompt("");
    const statusId = nid();
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: cleaned },
      { id: statusId, kind: "status", steps: [], active: true },
    ]);
    scrollToEnd();
    setWorkspace("prepare");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleaned,
          sizeHint: profiled.sizeHint,
          units: profiled.units,
          previousPrompt,
          previousCode,
          previousJobId,
          previousSource,
          wearableSize: sizeForRequest,
          wearableCategory: categoryForRequest,
          filament: profiled.filament,
          choices: choicesForRequest,
          fixture: process.env.NODE_ENV === "test" ? true : undefined,
          cadHandoff:
            !startFresh && doctorResult?.reshape?.attempted ? doctorResult.reshape.cadHandoff : undefined,
        }),
      });

      if (!response.ok && !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      let latest: GenerateResult | null = null;
      let lastError: string | null = null;

      await consumeSse(response, (event, data) => {
        if (event === "status") {
          const status = data as StatusEvent;
          setItems((prev) =>
            prev.map((item) =>
              item.id === statusId && item.kind === "status"
                ? { ...item, steps: [...item.steps, status] }
                : item,
            ),
          );
          scrollToEnd();
        }
        if (event === "result") {
          latest = data as GenerateResult;
        }
        if (event === "error") {
          lastError = (data as { message?: string }).message ?? "Could not make this part";
        }
      });

      if (lastError) {
        throw new Error(lastError);
      }
      if (!latest) {
        throw new Error("No model was returned");
      }
      const generated: GenerateResult = latest;

      const nextDesignPrompt = startFresh || !previousPrompt ? cleaned : `${previousPrompt}. ${cleaned}`;
      const nextWearableSize = generated.wearableSize ?? wearableSize;
      const nextWearableCategory = generated.wearableCategory ?? wearableCategory;
      const nextChoices = generated.appliedChoices ?? choicesForRequest;
      setResult(generated);
      setWearableSize(nextWearableSize);
      setWearableCategory(nextWearableCategory);
      setAppliedChoices(nextChoices);
      setDesignPrompt(nextDesignPrompt);
      setShowDetails(false);
      setItems((prev) => {
        const nextItems = [
          ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
          { id: nid(), kind: "result" as const, result: generated },
        ];
        setHistory((prevHistory) =>
          pushVersion(startFresh ? emptyVersionHistory<ChatItem[]>() : prevHistory, {
            kind: classifyPlateVersionKind({
              hasPrevious: Boolean(previousJobId),
              startFresh,
              source: generated.source,
              editMode: generated.editMode,
            }),
            prompt: cleaned,
            designPrompt: nextDesignPrompt,
            result: generated,
            thread: nextItems,
            wearableSize: nextWearableSize,
            wearableCategory: nextWearableCategory,
            appliedChoices: nextChoices,
          }),
        );
        return nextItems;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not make this part";
      setItems((prev) => [
        ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
        { id: nid(), kind: "error", text: message },
      ]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  async function importMeshFile(file: File) {
    if (busy) return;
    setBusy(true);
    const statusId = nid();
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: `Import ${/\.(png|jpe?g|webp)$/i.test(file.name) ? "photo " : ""}${file.name}` },
      { id: statusId, kind: "status", steps: [], active: true },
    ]);
    scrollToEnd();
    setWorkspace("prepare");

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("filament", material);
      form.append("repair", keepWear ? "0" : "1");
      form.append("keepWear", keepWear ? "1" : "0");
      if (prompt.trim()) form.append("prompt", prompt.trim());
      if (sizeNumber) form.append("targetMaxMm", String(toMillimeters(sizeNumber, units)));
      if (result?.jobId) form.append("previousJobId", result.jobId);
      if (designPrompt) form.append("previousPrompt", designPrompt);
      const response = await fetch("/api/import", { method: "POST", body: form });
      if (!response.ok && !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      let latest: GenerateResult | null = null;
      let lastError: string | null = null;
      await consumeSse(response, (event, data) => {
        if (event === "status") {
          const status = data as StatusEvent;
          setItems((prev) =>
            prev.map((item) =>
              item.id === statusId && item.kind === "status"
                ? { ...item, steps: [...item.steps, status] }
                : item,
            ),
          );
          scrollToEnd();
        }
        if (event === "result") latest = data as GenerateResult;
        if (event === "error") lastError = (data as { message?: string }).message ?? "Could not import this file";
      });
      if (lastError) throw new Error(lastError);
      if (!latest) throw new Error("No model was returned");
      const generated: GenerateResult = latest;
      const importPrompt = `Imported ${file.name}`;
      setResult(generated);
      setWearableSize(generated.wearableSize ?? null);
      setWearableCategory(generated.wearableCategory ?? DEFAULT_WEARABLE_CATEGORY);
      setDesignPrompt(importPrompt);
      setShowDetails(false);
      setItems((prev) => {
        const nextItems = [
          ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
          { id: nid(), kind: "result" as const, result: generated },
        ];
        setHistory((prevHistory) =>
          pushVersion(prevHistory, {
            kind: classifyPlateVersionKind({
              hasPrevious: Boolean(result?.jobId),
              source: generated.source,
              editMode: generated.editMode,
            }),
            prompt: importPrompt,
            designPrompt: importPrompt,
            result: generated,
            thread: nextItems,
            wearableSize: generated.wearableSize ?? null,
            wearableCategory: generated.wearableCategory ?? DEFAULT_WEARABLE_CATEGORY,
            appliedChoices,
          }),
        );
        return nextItems;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not import this file";
      setItems((prev) => [
        ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
        { id: nid(), kind: "error", text: message },
      ]);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
      if (photoInput.current) photoInput.current.value = "";
      scrollToEnd();
    }
  }

  function pickDesignOption(group: DesignOptionGroup, option: DesignOption) {
    if (busy) return;
    const choice: AppliedDesignChoice = { id: group.id, value: option.value };
    const next = upsertAppliedChoice(appliedChoices, choice);
    setAppliedChoices(next);
    if (group.id === "material" && isFilamentId(option.value)) setMaterial(option.value);
    if (group.id === "wearable_size" && isWearableSizeId(option.value)) setWearableSize(option.value);
    const source = prompt.trim() || designPrompt || "";
    const text = applyDesignChoiceToPrompt(source, choice);
    void printPart(text, {
      choices: next,
      wearableSize: group.id === "wearable_size" && isWearableSizeId(option.value) ? option.value : wearableSize,
      filament: group.id === "material" && isFilamentId(option.value) ? option.value : material,
    });
  }

  const pendingOptionGroups = useMemo(() => {
    const live = resolveDesignOptions({
      prompt: prompt.trim() || designPrompt,
      previousPrompt: prompt.trim() ? designPrompt : null,
      choices: appliedChoices,
      wearableSize,
      filament: material,
      colorRegions: result?.colorRegions,
    });
    if (live.options.length) return live.options;
    return result?.needs_user_choice ? (result.options ?? []) : [];
  }, [prompt, designPrompt, appliedChoices, wearableSize, material, result]);

  const canPrint = Boolean(prompt.trim()) && !busy;
  const plateW = printer.buildVolumeMm[0];
  const plateD = printer.buildVolumeMm[1];
  const plateH = printer.buildVolumeMm[2];
  const actionLabel = busy ? "Updating…" : result ? "Update" : "Print";

  const composer = (
    <ChatComposer
      prompt={prompt}
      onPromptChange={setPrompt}
      onSubmit={() => void printPart(prompt)}
      busy={busy}
      canSubmit={canPrint}
      actionLabel={actionLabel}
      placeholder={
        result?.source === "imported-mesh"
          ? "Describe an edit — size S–XL, scale, sit on the plate, or add a hole…"
          : result
            ? "Keep talking — change it, add or remove a feature, or start a new part…"
            : "A phone stand, a 20 mm cube with a hole, or import an STL/3MF/photo…"
      }
      showAdvanced={showAdvanced}
      onToggleAdvanced={() => setShowAdvanced((v) => !v)}
      sizeHint={sizeHint}
      onSizeHintChange={setSizeHint}
      units={units}
      onUnitsChange={setUnits}
      keepWear={keepWear}
      onKeepWearChange={setKeepWear}
      userProfile={userProfile}
      onUserProfileChange={commitUserProfile}
      followUps={
        result && !busy
          ? result.editMode === "image-import"
            ? PHOTO_FOLLOW_UPS
            : result.source === "imported-mesh"
              ? IMPORTED_FOLLOW_UPS
              : cadFollowUps(result)
          : null
      }
      onFollowUp={(value) => {
        if (value.toLowerCase().includes("new part")) {
          setPrompt("");
          setDesignPrompt(null);
          applyProfileSession(userProfile);
          setAppliedChoices([]);
          setHistory(emptyVersionHistory());
          setShowHistory(false);
          setResult(null);
          return;
        }
        setPrompt(value);
      }}
      onImport={() => fileInput.current?.click()}
      onImportPhoto={() => photoInput.current?.click()}
      optionGroups={pendingOptionGroups}
      onPickOption={pickDesignOption}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <input
        ref={fileInput}
        type="file"
        accept=".stl,.3mf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,model/stl,application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importMeshFile(file);
        }}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label="Import photo"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importMeshFile(file);
        }}
      />
      <header className="z-20 flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StudioMark />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-none">DescribePrint</div>
            <div className="mt-0.5 hidden truncate text-[10px] text-muted sm:block">Describe → options → Print</div>
          </div>
        </div>
        <nav className="ml-2 flex items-center self-stretch" aria-label="Workspace">
          <WorkspaceTabButton
            label="Prepare"
            active={workspace === "prepare"}
            onClick={() => setWorkspace("prepare")}
          />
          <WorkspaceTabButton
            label="Preview"
            active={workspace === "preview"}
            onClick={() => setWorkspace("preview")}
          />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ToolsStatus localAiHint={localAi} />
          {busy ? (
            <span className="hidden items-center gap-1.5 text-[11px] text-muted sm:flex">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
              Listening…
            </span>
          ) : null}
          <div className="hidden items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="font-medium">{printer.name}</span>
          </div>
          <button
            type="button"
            className="studio-btn studio-btn-ghost inline-flex h-7 w-7"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(200px,1fr)_auto] lg:grid-cols-[minmax(340px,400px)_minmax(0,1fr)_260px] lg:grid-rows-1">
        <section
          className={`min-h-0 flex-col border-line bg-panel lg:border-r ${
            workspace === "preview" && !wideLayout
              ? "hidden"
              : `flex ${workspace === "prepare" ? "order-2 max-h-[58vh] border-t lg:order-none lg:max-h-none lg:border-t-0" : ""}`
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div>
              <div className="studio-label">Chat</div>
              <div className="text-[11px] text-muted">Describe, then keep talking</div>
            </div>
            <div className="flex items-center gap-2">
              {history.versions.length > 0 ? (
                <button
                  type="button"
                  onClick={undoPlate}
                  disabled={busy || !canUndo(history)}
                  className="text-[11px] text-muted underline-offset-2 hover:underline disabled:opacity-40"
                >
                  Undo
                </button>
              ) : null}
              {history.versions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowHistory((open) => !open)}
                  className="text-[11px] text-muted underline-offset-2 hover:underline"
                  aria-expanded={showHistory}
                >
                  History
                </button>
              ) : null}
              {items.length > 0 ? (
                <button
                  type="button"
                  onClick={resetConversation}
                  className="text-[11px] text-muted underline-offset-2 hover:underline"
                >
                  Clear chat
                </button>
              ) : null}
            </div>
          </div>

          {showHistory && history.versions.length > 0 ? (
            <VersionHistoryList
              history={history}
              busy={busy}
              onRestore={restorePlate}
            />
          ) : null}

          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {items.length === 0 ? (
              <EmptyState
                onPick={(value) => {
                  setPrompt(value);
                  setWorkspace("prepare");
                }}
              />
            ) : (
              items.map((item, index) => {
                const cameraChips =
                  item.kind === "doctor" && index === items.length - 1
                    ? cameraDoctorMidPrintChips(item.result)
                    : [];
                return (
                <ChatBubble
                  key={item.id}
                  item={item}
                  onPickOption={pickDesignOption}
                  disabled={busy}
                  onDoctorFeedback={
                    item.kind === "doctor" &&
                    index === items.length - 1 &&
                    !item.feedback
                      ? applyDoctorFeedback
                      : undefined
                  }
                  cameraChips={cameraChips}
                  onCameraChip={cameraChips.length ? (phrase) => void printPart(phrase) : undefined}
                />
                );
              })
            )}
          </div>

          <div className="border-t border-line bg-panel">{composer}</div>
        </section>

        <section className="relative order-1 flex min-h-0 flex-col bg-canvas lg:order-none">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-2.5">
            <div className="pointer-events-auto flex items-center gap-1.5">
              <div className="flex overflow-hidden rounded-md border border-line bg-panel/90 shadow-sm backdrop-blur">
                {(
                  [
                    ["iso", "Iso"],
                    ["top", "Top"],
                    ["front", "Front"],
                    ["left", "Left"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setCameraView(id)}
                    className={`h-7 px-2.5 text-[11px] font-medium ${
                      cameraView === id ? "bg-accent text-accent-ink" : "text-muted hover:bg-panel-2 hover:text-ink"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={!result}
                title="Heuristic strength preview — not FEA"
                onClick={() => setShowStrengthHeatmap((on) => !on)}
                className={`h-7 rounded-md border px-2.5 text-[11px] font-medium shadow-sm backdrop-blur ${
                  result && showStrengthHeatmap && !explodeView
                    ? "border-accent/50 bg-accent text-accent-ink"
                    : "border-line bg-panel/90 text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                }`}
              >
                Strength
              </button>
              {result?.assembly?.isAssembly ? (
                <div className="flex overflow-hidden rounded-md border border-line bg-panel/90 shadow-sm backdrop-blur">
                  <button
                    type="button"
                    onClick={() => setExplodeView(false)}
                    className={`h-7 px-2.5 text-[11px] font-medium ${
                      !explodeView ? "bg-accent text-accent-ink" : "text-muted hover:bg-panel-2 hover:text-ink"
                    }`}
                  >
                    Assembled
                  </button>
                  <button
                    type="button"
                    title="Heuristic offset along one axis — not kinematics"
                    onClick={() => setExplodeView(true)}
                    className={`h-7 px-2.5 text-[11px] font-medium ${
                      explodeView ? "bg-accent text-accent-ink" : "text-muted hover:bg-panel-2 hover:text-ink"
                    }`}
                  >
                    Exploded
                  </button>
                </div>
              ) : null}
            </div>
            <div className="rounded-md border border-line bg-panel/90 px-2 py-1 text-[10px] text-muted backdrop-blur">
              Plate 1 · {plateW} × {plateD} mm
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Viewer
              stlUrl={
                result
                  ? `${
                      explodeView && result.assembly?.isAssembly && result.explodedStlUrl
                        ? result.explodedStlUrl
                        : result.stlUrl
                    }?v=${result.jobId}`
                  : null
              }
              view={cameraView}
              plateMm={plateW}
              heightMm={plateH}
              theme={theme}
              showGizmo={wideLayout}
              packOutlines={packOutlines}
              heatmap={Boolean(result) && showStrengthHeatmap && !explodeView}
              triangleScores={explodeView ? undefined : result?.report.strengthPreview?.triangleScores}
              previewTint={result ? previewTintHex(result.colorRegions ?? []) : null}
              colorRegions={result ? namedColorRegions(result.colorRegions) : []}
            />
          </div>
        </section>

        <aside
          className={`min-h-0 flex-col border-line bg-panel ${
            workspace === "prepare" ? "hidden lg:flex lg:border-l" : "flex border-t lg:border-l lg:border-t-0"
          } ${workspace === "preview" ? "order-2 lg:order-none" : ""}`}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="studio-label">Print</div>
            <div className="text-[10px] text-muted">{printer.name}</div>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            <MachinePanel
              printer={printer}
              doctor={doctorResult}
              material={material}
              onMaterialChange={setMaterial}
              result={result}
              packPlan={packPlan}
              onCameraDoctor={appendCameraDoctor}
              onFailurePhoto={(input) => void submitFailurePhoto(input)}
              onPacked={(plan, outlines) => {
                setPackPlan(plan);
                setPackOutlines(outlines);
              }}
            />

            <PrintEstimateBlock result={result} material={material} printer={printer} />

            <button
              type="button"
              disabled={!canPrint}
              onClick={() => void printPart(prompt)}
              className="studio-btn studio-btn-primary inline-flex h-10 w-full text-sm"
            >
              {actionLabel}
            </button>
            <p className="text-[11px] leading-relaxed text-muted">
              The chat is the editor. Keep describing changes, or import an STL/3MF or a photo onto the plate.
            </p>

            <WearableSizePicker
              selected={wearableSize}
              applied={result?.wearableSize ?? null}
              category={wearableCategory}
              appliedCategory={result?.wearableCategory ?? null}
              disabled={busy}
              canApply={Boolean(result) && !busy}
              onSelectCategory={(category) => {
                setWearableCategory(category);
                const size = result?.wearableSize ?? wearableSize;
                if (result && size) {
                  void printPart(`Apply wearable size ${size}`, { wearableSize: size, wearableCategory: category });
                }
              }}
              onSelect={(size) => {
                setWearableSize(size);
                if (result) void printPart(`Apply wearable size ${size}`, { wearableSize: size, wearableCategory });
              }}
            />

            {result ? (
              <ResultPanel
                result={result}
                showDetails={showDetails}
                onToggleDetails={() => setShowDetails((v) => !v)}
                onPaintRegion={(phrase) => void printPart(phrase)}
                paintDisabled={busy}
              />
            ) : (
              <div className="space-y-2 rounded-md border border-dashed border-line px-2.5 py-2 text-[11px] text-muted">
                <p>
                  Nothing on the plate yet. Describe a part, import STL/3MF or a photo, or pick a wearable size, then
                  Print. Files are sized for the P2S; oversized photo solids suggest another machine.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled
                    title="Print something first — project pack needs a 3MF on the plate"
                    className="studio-btn studio-btn-ghost inline-flex h-8 px-3 opacity-40"
                  >
                    Download pack
                  </button>
                  <span>Print something first</span>
                </div>
              </div>
            )}
          </div>

          {workspace === "preview" && !wideLayout ? (
            <div className="border-t border-line bg-panel">{composer}</div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function VersionHistoryList({
  history,
  busy,
  onRestore,
}: {
  history: VersionHistoryState<ChatItem[]>;
  busy: boolean;
  onRestore: (index: number) => void;
}) {
  return (
    <div className="border-b border-line bg-panel-2 px-3 py-2">
      <div className="studio-label">Versions</div>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted">{VERSION_HISTORY_NOTE}</p>
      <ol className="scrollbar-thin mt-2 max-h-36 space-y-1 overflow-y-auto">
        {history.versions.map((version, index) => {
          const current = index === history.currentIndex;
          return (
            <li key={version.id}>
              <button
                type="button"
                disabled={busy || current}
                onClick={() => onRestore(index)}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] ${
                  current
                    ? "bg-accent/15 text-ink"
                    : "text-muted hover:bg-panel hover:text-ink disabled:opacity-40"
                }`}
              >
                <span className="w-4 shrink-0 tabular-nums text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{version.label}</span>
                  <span className="text-[10px] text-muted">
                    {versionKindLabel(version.kind)}
                    {current ? " · on plate" : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ChatComposer({
  prompt,
  onPromptChange,
  onSubmit,
  busy,
  canSubmit,
  actionLabel,
  placeholder,
  showAdvanced,
  onToggleAdvanced,
  sizeHint,
  onSizeHintChange,
  units,
  onUnitsChange,
  keepWear,
  onKeepWearChange,
  userProfile,
  onUserProfileChange,
  followUps,
  onFollowUp,
  onImport,
  onImportPhoto,
  optionGroups,
  onPickOption,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  canSubmit: boolean;
  actionLabel: string;
  placeholder: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  sizeHint: string;
  onSizeHintChange: (value: string) => void;
  units: Unit;
  onUnitsChange: (value: Unit) => void;
  keepWear: boolean;
  onKeepWearChange: (value: boolean) => void;
  userProfile: UserProfile;
  onUserProfileChange: (profile: UserProfile) => void;
  followUps: readonly string[] | null;
  onFollowUp: (value: string) => void;
  onImport: () => void;
  onImportPhoto: () => void;
  optionGroups: DesignOptionGroup[];
  onPickOption: (group: DesignOptionGroup, option: DesignOption) => void;
}) {
  return (
    <form
      className="p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {optionGroups.length ? (
        <div className="mb-2">
          <DesignOptionChips groups={optionGroups} onPick={onPickOption} disabled={busy} />
        </div>
      ) : null}
      {followUps ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {followUps.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => onFollowUp(chip)}
              className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-ink"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
      <label className="studio-label mb-1.5 block" htmlFor="describe-input">
        Message
      </label>
      <textarea
        id="describe-input"
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder={placeholder}
        className="studio-field resize-none px-2.5 py-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={!canSubmit} className="studio-btn studio-btn-primary inline-flex h-8 px-3.5">
          {busy ? "Working…" : actionLabel}
        </button>
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="text-[11px] text-muted underline-offset-2 hover:underline"
        >
          {showAdvanced ? "Hide options" : "More options"}
        </button>
        {hasCustomUserProfile(userProfile) ? (
          <span className="hidden text-[10px] text-muted sm:inline">
            Profile: {formatUserProfileSummary(userProfile)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onImport}
          disabled={busy}
          title="STL, 3MF, or a photo (PNG / JPG / WebP)"
          className="ml-auto text-[11px] text-muted underline-offset-2 hover:underline disabled:opacity-40"
        >
          Import file
        </button>
        <button
          type="button"
          onClick={onImportPhoto}
          disabled={busy}
          title="Take or choose a photo (PNG / JPG / WebP)"
          className="text-[11px] text-muted underline-offset-2 hover:underline disabled:opacity-40"
        >
          Import photo
        </button>
      </div>
      {showAdvanced ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 p-2.5">
          <label className="text-[11px] text-muted" htmlFor="size-hint">
            Size
          </label>
          <input
            id="size-hint"
            type="number"
            min={0}
            step="any"
            value={sizeHint}
            onChange={(e) => onSizeHintChange(e.target.value)}
            placeholder="optional"
            className="studio-field w-20 px-2 py-1.5 text-sm"
          />
          <select
            value={units}
            onChange={(e) => onUnitsChange(e.target.value as Unit)}
            className="studio-field w-auto px-2 py-1.5 text-sm"
            aria-label="Units"
          >
            <option value="mm">mm</option>
            <option value="in">inches</option>
          </select>
          <label className="ml-1 flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={!keepWear}
              onChange={(event) => onKeepWearChange(!event.target.checked)}
            />
            Repair photo cracks
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={keepWear} onChange={(event) => onKeepWearChange(event.target.checked)} />
            Keep damage / wear
          </label>
          <UserProfilePanel profile={userProfile} onChange={onUserProfileChange} />
        </div>
      ) : null}
    </form>
  );
}

function WorkspaceTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative h-full px-3 text-[13px] font-medium ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
      {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" /> : null}
    </button>
  );
}

function ChatBubble({
  item,
  onPickOption,
  disabled,
  onDoctorFeedback,
  cameraChips,
  onCameraChip,
}: {
  item: ChatItem;
  onPickOption?: (group: DesignOptionGroup, option: DesignOption) => void;
  disabled?: boolean;
  onDoctorFeedback?: (kind: DoctorFeedbackKind, spoken: string) => void;
  cameraChips?: CameraDoctorMidPrintChip[];
  onCameraChip?: (phrase: string) => void;
}) {
  if (item.kind === "user") {
    return (
      <div className="ml-8 rounded-md bg-panel-2 px-2.5 py-2 text-sm leading-relaxed">{item.text}</div>
    );
  }
  if (item.kind === "status") {
    const latest = item.steps[item.steps.length - 1];
    const label = latest ? FRIENDLY_STEP[latest.step] : "Starting…";
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        {item.active ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        <span>{item.active ? label : "Ready"}</span>
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-sm text-danger">{item.text}</div>
    );
  }
  if (item.kind === "doctor") {
    const { result } = item;
    return (
      <div className="mr-4 rounded-md border border-accent/35 bg-accent/5 px-2.5 py-2 text-sm">
        <div className="font-medium">Print doctor — {result.title}</div>
        <div className="mt-1 text-muted">{result.diagnosis}</div>
        {result.fixes.filter((fix) => fix.kind === "setting").length ? (
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] text-muted">
            {result.fixes
              .filter((fix) => fix.kind === "setting")
              .slice(0, 3)
              .map((fix) => (
                <li key={`${fix.kind}-${fix.summary}`}>{fix.summary}</li>
              ))}
          </ul>
        ) : null}
        {result.physicalSteps.length ? (
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[13px] text-muted">
            {result.physicalSteps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
        ) : (
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[13px] text-muted">
            {result.fixes.slice(0, 3).map((fix) => (
              <li key={`${fix.kind}-${fix.summary}`}>{fix.summary}</li>
            ))}
          </ul>
        )}
        {result.amsGuide?.whenToRetrySoftware ? (
          <div className="mt-2 text-[13px] text-muted">{result.amsGuide.whenToRetrySoftware}</div>
        ) : null}
        {result.cameraGuide?.whenToRetrySoftware ? (
          <div className="mt-2 text-[13px] text-muted">{result.cameraGuide.whenToRetrySoftware}</div>
        ) : null}
        {result.autofix?.attempted ? (
          <div className="mt-2 text-[13px] text-muted">{result.autofix.message}</div>
        ) : null}
        {result.midPrint ? (
          <div className="mt-2 text-[13px] text-muted">
            {result.midPrint.message}
            {result.midPrint.physicalSteps?.length ? (
              <ul className="mt-1 list-disc pl-4">
                {result.midPrint.physicalSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {result.reshape ? (
          <div className="mt-2 text-[13px] text-muted">
            {result.reshape.message}
            {result.reshape.attempted ? (
              <div>
                {result.reshape.remainingHeightMm != null
                  ? `Remaining ${result.reshape.remainingHeightMm.toFixed(2)} mm`
                  : "Remaining height unknown"}
                {result.reshape.currentZ != null ? ` above Z ${result.reshape.currentZ.toFixed(2)}` : ""}. Resume is
                manual.
                {cadUpperStatusLine(result.reshape.cadUpper)}
                {resliceFeedStatusLine(result.reshape.reslice)}
              </div>
            ) : null}
          </div>
        ) : null}
        {result.learned ? (
          <div className="mt-1 text-[11px] text-muted">Remembered for this printer + filament.</div>
        ) : null}
        {(onDoctorFeedback && result.defectId !== "mid-print-control" && !result.reshape?.attempted) ||
        (onCameraChip && cameraChips?.length) ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {onDoctorFeedback && result.defectId !== "mid-print-control" && !result.reshape?.attempted ? (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onDoctorFeedback("perfect", "perfect")}
                  className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
                  aria-label="Perfect — remember this fix"
                >
                  Perfect
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onDoctorFeedback("still-bad", "still bad")}
                  className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
                  aria-label="Still bad — try the next cause"
                >
                  Still bad
                </button>
              </>
            ) : null}
            {onCameraChip
              ? cameraChips?.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onCameraChip(chip.phrase)}
                    className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
                    aria-label={chip.ariaLabel}
                  >
                    {chip.label}
                  </button>
                ))
              : null}
          </div>
        ) : null}
      </div>
    );
  }
  const { report } = item.result;
  const photo = item.result.editMode === "image-import";
  const imported = item.result.source === "imported-mesh";
  const reshapeUpper = item.result.editMode === "reshape-upper";
  return (
    <div className="mr-4 rounded-md border border-ok/35 bg-ok/5 px-2.5 py-2 text-sm">
      <div className="font-medium">
        {photo
          ? photoPlateHeadline(item.result.imageImport)
          : imported
            ? "Imported mesh on the plate — describe an edit"
            : reshapeUpper
              ? "Remaining upper on the plate — resume is manual"
              : "On the plate — keep talking to change it"}
      </div>
      <div className="mt-1 text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
        {item.result.fileName ? ` · ${item.result.fileName}` : ""}
      </div>
      {item.result.machineDesignation?.exceedsCurrentPrinter ? (
        <div className="mt-1.5 text-[13px] text-warn">{item.result.machineDesignation.message}</div>
      ) : null}
      {item.result.report.strengthPreview?.issues.length ? (
        <div className="mt-1.5 text-[12px] text-muted">
          Heuristic strength: {item.result.report.strengthPreview.issues[0]?.message}. Not FEA.
        </div>
      ) : null}
      {item.result.needs_user_choice && item.result.options?.length && onPickOption ? (
        <div className="mt-2">
          <DesignOptionChips groups={item.result.options} onPick={onPickOption} disabled={disabled} />
        </div>
      ) : null}
    </div>
  );
}

function DesignOptionChips({
  groups,
  onPick,
  disabled,
}: {
  groups: DesignOptionGroup[];
  onPick: (group: DesignOptionGroup, option: DesignOption) => void;
  disabled?: boolean;
}) {
  if (!groups.length) return null;
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.id}>
          <div className="studio-label mb-1 text-muted">{group.prompt}</div>
          <div className="flex flex-wrap gap-1.5">
            {group.options.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={disabled}
                title={option.description}
                onClick={() => onPick(group, option)}
                className="min-h-8 rounded-full border border-accent/45 bg-accent/10 px-3 py-1 text-[12px] font-medium text-ink hover:border-accent hover:bg-accent/20 disabled:opacity-40"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PrintEstimateBlock({
  result,
  material,
  printer,
}: {
  result: GenerateResult | null;
  material: FilamentId;
  printer: PrinterProfile;
}) {
  const [costByMaterial, setCostByMaterial] = useState<Partial<Record<FilamentId, number>>>({});
  const [costReady, setCostReady] = useState(false);
  const [showCost, setShowCost] = useState(false);

  useEffect(() => {
    setCostByMaterial(parseCostPerKgMap(window.localStorage.getItem(ESTIMATE_COST_SESSION_KEY)));
    setCostReady(true);
  }, []);

  useEffect(() => {
    if (!costReady) return;
    window.localStorage.setItem(ESTIMATE_COST_SESSION_KEY, serializeCostPerKgMap(costByMaterial));
  }, [costByMaterial, costReady]);

  const costPerKg = costByMaterial[material] ?? defaultCostPerKgFor(material);
  const estimate = useMemo(
    () => estimatePrintFromReport(result?.report, material, { costPerKg, printer }),
    [result?.report, material, costPerKg, printer],
  );

  return (
    <div className="rounded-md border border-line bg-panel-2 p-2.5 text-[11px] leading-relaxed text-muted">
      <div className="studio-label">Estimate (stub)</div>
      {estimate ? (
        <div className="mt-1 text-ink" title={estimate.assumptions.note}>
          {formatPrintEstimateLine(estimate)}
        </div>
      ) : (
        <div className="mt-1">Print something first</div>
      )}
      <button
        type="button"
        className="mt-1 text-[11px] text-muted underline-offset-2 hover:underline"
        onClick={() => setShowCost((v) => !v)}
      >
        {showCost ? "Hide $/kg" : "$/kg"}
      </button>
      {showCost ? (
        <label className="mt-1.5 grid grid-cols-[4.5rem_1fr] items-center gap-x-1.5 text-ink" htmlFor="print-estimate-cost">
          <span>$/kg</span>
          <input
            id="print-estimate-cost"
            type="number"
            min={1}
            max={9999}
            step={1}
            inputMode="decimal"
            className="studio-field h-6 px-1.5 text-[11px]"
            value={costPerKg}
            onChange={(event) => {
              const n = Number(event.target.value);
              setCostByMaterial((prev) => ({
                ...prev,
                [material]: Number.isFinite(n) && n > 0 ? n : defaultCostPerKgFor(material),
              }));
            }}
          />
        </label>
      ) : null}
    </div>
  );
}

function FailedPhotoControls({
  disabled,
  onReplay,
}: {
  disabled?: boolean;
  onReplay?: (input: FailurePhotoInput) => void;
}) {
  const [hint, setHint] = useState("");
  const [filename, setFilename] = useState("");
  const [mime, setMime] = useState("");

  function replay() {
    if (!onReplay) return;
    onReplay({
      filename: filename || undefined,
      hint: hint.trim() || undefined,
      mime: mime || undefined,
    });
  }

  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="font-medium text-ink">Failed photo (stub)</div>
      <p className="mt-0.5">{FAILURE_PHOTO_NOTE}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <label className="sr-only" htmlFor="failed-photo-file">
          Failed print photo
        </label>
        <input
          id="failed-photo-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          disabled={disabled}
          aria-label="Failed print photo"
          className="max-w-[11rem] text-[11px] text-ink file:mr-1.5 file:rounded file:border file:border-line file:bg-panel file:px-1.5 file:py-0.5"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setFilename(file?.name ?? "");
            setMime(file?.type ?? "");
          }}
        />
        <label className="sr-only" htmlFor="failed-photo-hint">
          One-line hint
        </label>
        <input
          id="failed-photo-hint"
          type="text"
          value={hint}
          disabled={disabled}
          placeholder="one-line hint"
          aria-label="One-line hint"
          className="studio-field h-6 min-w-[7rem] flex-1 px-1.5 text-[11px]"
          onChange={(event) => setHint(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              replay();
            }
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={replay}
          className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
        >
          Replay
        </button>
      </div>
    </div>
  );
}

function packPlacementLabel(id: string, index: number): string {
  const copy = id.match(/#(\d+)$/);
  if (copy) return `copy ${copy[1]}`;
  return `part ${index + 1}`;
}

function PlatePackControls({
  result,
  plan,
  onPacked,
}: {
  result: GenerateResult | null;
  plan: PackPlan | null;
  onPacked: (plan: PackPlan | null, outlines: PackOutline[]) => void;
}) {
  const [copies, setCopies] = useState(1);
  const box = result?.report.boundingBoxMm;
  const canPack = Boolean(box && box.size[0] > 0 && box.size[1] > 0);

  function runPack() {
    if (!result || !box) {
      const [plateW, plateD] = defaultPrinter().buildVolumeMm;
      onPacked(
        { placements: [], plateMm: [plateW, plateD], fitted: false, message: "Nothing on the plate to pack." },
        [],
      );
      return;
    }
    const parts = copiesOfPart(packPartFromBoundingBox(result.jobId, box), copies);
    const next = packPlate(parts);
    onPacked(next, packOverlays(next, parts));
  }

  return (
    <div className="mt-1.5 border-t border-line pt-1.5">
      <div>{PLATE_PACK_NOTE}</div>
      {box ? (
        <div className="mt-0.5">
          {formatMm(box.size[0])} × {formatMm(box.size[1])} × {formatMm(box.size[2])} mm
          {copies > 1 ? ` · ${copies} copies` : ""}
        </div>
      ) : (
        <div className="mt-0.5">No mesh AABB yet — describe or import a part.</div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1" htmlFor="plate-pack-copies">
          Copies
          <input
            id="plate-pack-copies"
            type="number"
            min={1}
            max={12}
            inputMode="numeric"
            className="h-6 w-12 rounded border border-line bg-panel px-1 text-[11px]"
            value={copies}
            onChange={(event) => {
              const n = Number(event.target.value);
              setCopies(Number.isFinite(n) ? Math.min(12, Math.max(1, Math.floor(n))) : 1);
            }}
          />
        </label>
        <button
          type="button"
          disabled={!canPack}
          onClick={runPack}
          className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
        >
          Pack plate (stub)
        </button>
        {plan ? (
          <button
            type="button"
            onClick={() => onPacked(null, [])}
            className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
          >
            Clear
          </button>
        ) : null}
      </div>
      {plan ? (
        <div className={`mt-1.5 ${plan.fitted ? "text-ink" : "text-warn"}`}>
          <div>{plan.message}</div>
          {plan.placements.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-muted">
              {plan.placements.map((placement, index) => (
                <li key={placement.id}>
                  {packPlacementLabel(placement.id, index)} · x {formatMm(placement.x)} · y {formatMm(placement.y)} ·{" "}
                  {placement.rotationDeg}°
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function persistAmsSlotPlan(jobId: string | undefined, plan: AmsSlotPlan) {
  if (!jobId) return;
  void fetch(`/api/jobs/${jobId}/ams-plan.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  }).catch(() => {
    // Download still has the generate-time plan if persist fails.
  });
}

function AmsPlanBlock({
  plan,
  onReassign,
  help,
}: {
  plan: AmsSlotPlan;
  onReassign: (fromIndex: number, toIndex: number) => void;
  help?: AmsHelpGuide;
}) {
  return (
    <div className="mt-2 border-t border-line pt-1.5">
      <div className="studio-label">AMS plan</div>
      {plan.slots.length === 0 ? (
        <div className="mt-0.5">No trays assigned</div>
      ) : (
        <ul className="mt-1 space-y-0.5" aria-label="AMS slot plan">
          {plan.slots.map((slot) => (
            <li key={`${slot.index}-${slot.designId ?? slot.material}`} className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor={`ams-plan-tray-${slot.index}`}>
                Tray for {slot.designId ?? slot.material}
              </label>
              <select
                id={`ams-plan-tray-${slot.index}`}
                aria-label={`AMS tray for ${slot.designId ?? slot.material}`}
                className="studio-field h-6 w-[4.5rem] px-1 text-[11px]"
                value={slot.index}
                onChange={(event) => onReassign(slot.index, Number(event.target.value))}
              >
                {[0, 1, 2, 3].map((index) => (
                  <option key={index} value={index}>
                    AMS {index + 1}
                  </option>
                ))}
              </select>
              <span className="text-ink">{slot.material.toUpperCase()}</span>
              {slot.color ? (
                <span className="inline-flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full border border-line"
                    style={{ background: slot.color }}
                  />
                  {slot.color}
                </span>
              ) : null}
              {slot.designId ? <span className="text-muted">{slot.designId}</span> : null}
              <span className="text-muted">{slot.source}</span>
            </li>
          ))}
        </ul>
      )}
      {help ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-ink">
            AMS help{help.slot != null ? ` · AMS ${help.slot}` : ""}
          </summary>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            {help.steps.map((step, index) => (
              <li key={`${index}-${step}`}>{step}</li>
            ))}
          </ol>
          {help.whenToRetrySoftware ? <div className="mt-1">{help.whenToRetrySoftware}</div> : null}
        </details>
      ) : null}
    </div>
  );
}

function MachinePanel({
  printer,
  doctor,
  material,
  onMaterialChange,
  result,
  packPlan,
  onPacked,
  onCameraDoctor,
  onFailurePhoto,
}: {
  printer: PrinterProfile;
  doctor: PrintDoctorResult | null;
  material: FilamentId;
  onMaterialChange: (id: FilamentId) => void;
  result: GenerateResult | null;
  packPlan: PackPlan | null;
  onPacked: (plan: PackPlan | null, outlines: PackOutline[]) => void;
  onCameraDoctor?: (result: PrintDoctorResult) => void;
  onFailurePhoto?: (input: FailurePhotoInput) => void;
}) {
  const [plateW, plateD, plateH] = printer.buildVolumeMm;
  const preset = filamentPreset(material, printer);
  const speedTier = speedTierFor(preset);
  const coolingHint = coolingHintFor(preset);
  const fallbackSlots = Array.from({ length: printer.ams.slotsPerUnit }, (_, i) => i + 1);
  const {
    prefs,
    setLanEnabled,
    setHost,
    setSerial,
    setAccessCode,
    machine,
    busy,
    sendCommand,
    cameraStubPref,
    setCameraStubPref,
    reshapeRemainingPref,
    setReshapeRemainingPref,
  } = useMachineMonitor();
  const farm = useFarmRegistry();
  const [nozzleInput, setNozzleInput] = useState("");
  const [bedInput, setBedInput] = useState("");
  const [manualPlan, setManualPlan] = useState<AmsSlotPlan | null>(null);
  const appliedDoctorKey = useRef("");
  const cameraAnnounceRef = useRef<CameraDoctorHeld>(null);

  const envLocked = machine?.source === "env";
  const lanOn = envLocked || prefs.enabled;
  const live = machine?.live === true;
  const status = machine?.status;
  const connected = live && status?.connection === "connected";
  const connectionLabel = !lanOn
    ? "Disconnected"
    : machine?.hint
      ? machine.hint
      : status?.connection === "connected"
        ? status.print === "idle"
          ? "Connected · idle"
          : `Connected · ${status.print}`
        : status?.connection === "connecting"
          ? "Connecting…"
          : status?.message
            ? `Disconnected · ${status.message}`
            : "Disconnected";
  const amsSlots = live && status ? status.amsSlots : EMPTY_AMS_SLOTS;
  const autoPlan = useMemo(
    () =>
      buildAmsSlotPlan({
        material,
        design: declaredDesignFilaments(result?.colorRegions ?? []),
        liveSlots: connected ? amsSlots : undefined,
        connected,
      }),
    [material, result?.colorRegions, result?.jobId, connected, amsSlots],
  );
  const [plan, setPlan] = useState<AmsSlotPlan>(autoPlan);

  useEffect(() => {
    appliedDoctorKey.current = "";
    setManualPlan(null);
    setPlan(autoPlan);
  }, [result?.jobId]);

  useEffect(() => {
    const assignment = doctor?.appliedSlotPlan ? doctor.slotPlanAssignment : undefined;
    const doctorKey = assignment ? `${assignment.index}:${assignment.role ?? ""}` : "";
    if (assignment && doctorKey !== appliedDoctorKey.current) {
      const next = applyChatAmsSlotAssignment(autoPlan, assignment, material);
      appliedDoctorKey.current = doctorKey;
      setManualPlan(next);
      setPlan(next);
      return;
    }
    if (!manualPlan) setPlan(autoPlan);
  }, [autoPlan, doctor, material, manualPlan]);

  useEffect(() => {
    persistAmsSlotPlan(result?.jobId, plan);
  }, [result?.jobId, plan]);

  const cameraOn = machine?.cameraStub === true || cameraStubPref;
  const cameraEnvLocked = machine?.cameraStub === true;
  const cameraDetect = machine?.cameraDetect;
  const cameraSeverity = cameraDetect?.severity ?? (cameraDetect?.kind === "suspected-failure" ? "suspected" : "ok");

  useEffect(() => {
    if (!onCameraDoctor) return;
    const next = takeCameraDoctorAnnouncement(
      cameraAnnounceRef.current,
      cameraOn ? cameraDetect : undefined,
      machine?.diagnosis,
    );
    cameraAnnounceRef.current = next.held;
    if (next.announce) onCameraDoctor(next.announce);
  }, [cameraOn, cameraDetect, machine?.diagnosis, onCameraDoctor]);
  const reshapeOn = machine?.reshapeRemaining === true || reshapeRemainingPref;
  const reshapeEnvLocked = machine?.reshapeRemaining === true;
  const reshapePlan = doctor?.reshape ?? machine?.lastReshape;
  const doctorHint = doctor ?? machine?.diagnosis ?? null;

  return (
    <div className="rounded-md border border-line bg-panel-2 p-2.5 text-[11px] leading-relaxed text-muted">
      <div className="studio-label">Machine</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-ink">{farm.selected.name}</div>
        <div>{farm.countLabel}</div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <label className="sr-only" htmlFor="farm-machine-select">
          Selected machine
        </label>
        <select
          id="farm-machine-select"
          value={farm.selected.id}
          onChange={(event) => farm.select(event.target.value)}
          className="studio-field h-6 min-w-[8.5rem] flex-1 px-1.5 text-[11px]"
        >
          {farm.machines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => farm.addStub()} className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]">
          Add {nextFarmStubName(farm.machines)}
        </button>
        {farm.count > 1 ? (
          <button
            type="button"
            onClick={() => farm.remove(farm.selected.id)}
            className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-1">
        Default printer · {plateW} × {plateD} × {plateH} mm · {printer.nozzleMm} mm nozzle
      </div>
      <PlatePackControls result={result} plan={packPlan} onPacked={onPacked} />
      <div className="mt-1.5 border-t border-line pt-1.5">
        <div>{FARM_QUEUE_NOTE}</div>
        {farm.machines.map((row) => {
          const lines = farm.jobsFor(row.id);
          return (
            <div key={row.id} className="mt-0.5">
              {lines.length === 0 ? (
                <span>{row.name} · idle</span>
              ) : (
                lines.map((job) => (
                  <div key={job.id}>
                    {row.name} · {job.id} · {job.status}
                  </div>
                ))
              )}
            </div>
          );
        })}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => farm.enqueueStub()}
            className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
          >
            Enqueue (stub)
          </button>
          {farm.count > 1 ? (
            <button
              type="button"
              onClick={() => farm.enqueueStub("first-free")}
              className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
            >
              First free
            </button>
          ) : null}
          <button type="button" onClick={() => farm.tick()} className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]">
            Tick
          </button>
          <button
            type="button"
            onClick={() => farm.clearDone()}
            className="studio-btn studio-btn-ghost h-6 px-2 text-[11px]"
          >
            Clear done
          </button>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-ink">
        <input
          type="checkbox"
          checked={lanOn}
          disabled={envLocked}
          onChange={(event) => setLanEnabled(event.target.checked)}
        />
        LAN MQTT
        {envLocked ? <span className="font-normal text-muted">· .env</span> : null}
      </label>
      {lanOn && !envLocked ? (
        <div className="mt-1.5 grid grid-cols-[4.5rem_1fr] items-center gap-x-1.5 gap-y-1">
          <label htmlFor="machine-lan-host">IP</label>
          <input
            id="machine-lan-host"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.20"
            value={prefs.host}
            onChange={(event) => setHost(event.target.value)}
            className="studio-field h-6 px-1.5 text-[11px]"
          />
          <label htmlFor="machine-lan-serial">Serial</label>
          <input
            id="machine-lan-serial"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="01S00A…"
            value={prefs.serial}
            onChange={(event) => setSerial(event.target.value)}
            className="studio-field h-6 px-1.5 text-[11px]"
          />
          <label htmlFor="machine-lan-access">Access code</label>
          <input
            id="machine-lan-access"
            type="password"
            autoComplete="off"
            placeholder="8-digit LAN code"
            value={prefs.accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            className="studio-field h-6 px-1.5 text-[11px]"
          />
        </div>
      ) : null}
      {envLocked && (machine?.host || machine?.serial) ? (
        <div className="mt-1">
          {machine.host}
          {machine.serial ? ` · ${machine.serial}` : ""}
        </div>
      ) : null}
      <div
        className="mt-2 flex items-center gap-1.5"
        role="status"
        aria-label={lanOn ? connectionLabel : "Printer disconnected"}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            connected ? "bg-ok" : status?.connection === "error" ? "bg-danger" : "bg-muted"
          }`}
          aria-hidden="true"
        />
        {connectionLabel}
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-ink">
        <input
          type="checkbox"
          checked={cameraOn}
          disabled={cameraEnvLocked}
          onChange={(event) => setCameraStubPref(event.target.checked)}
        />
        Camera stub
        {cameraEnvLocked ? <span className="font-normal text-muted">· .env</span> : null}
      </label>
      {cameraOn ? (
        <div
          className={`mt-1 ${cameraSeverity === "suspected" ? "text-warn" : ""}`}
          role="status"
          aria-label={
            cameraSeverity === "suspected"
              ? `Camera ${cameraDetect?.line ?? "suspected"} · ${cameraSeverity}`
              : "Camera ok"
          }
        >
          <div>
            camera: {cameraDetect?.line ?? "ok"}
            {cameraSeverity === "suspected" ? ` · ${cameraSeverity}` : ""}
          </div>
          {cameraSeverity === "suspected" && cameraDetect?.cue ? <div>{cameraDetect.cue}</div> : null}
        </div>
      ) : null}
      <FailedPhotoControls disabled={busy} onReplay={onFailurePhoto} />
      <label className="mt-2 flex items-center gap-1.5 text-ink">
        <input
          type="checkbox"
          checked={reshapeOn}
          disabled={reshapeEnvLocked}
          onChange={(event) => setReshapeRemainingPref(event.target.checked)}
        />
        Reshape remaining
        {reshapeEnvLocked ? <span className="font-normal text-muted">· .env</span> : null}
      </label>
      {reshapePlan?.attempted ? (
        <div className="mt-1">
          {reshapePlan.paused || reshapePlan.pauseConfirmed ? "Paused · " : ""}
          {reshapePlan.remainingHeightMm != null
            ? `remaining ${reshapePlan.remainingHeightMm.toFixed(2)} mm`
            : "remaining height unknown"}
          {reshapePlan.currentZ != null ? ` above Z ${reshapePlan.currentZ.toFixed(2)}` : ""}. Resume is manual.
          {cadUpperStatusLine(reshapePlan.cadUpper)}
          {resliceFeedStatusLine(reshapePlan.reslice)}
        </div>
      ) : reshapeOn ? (
        <div className="mt-1">reshape: stub · resume is manual</div>
      ) : null}
      {connected ? (
        <div className="mt-2 space-y-0.5">
          <div>
            Nozzle {Math.round(status?.nozzleTempC ?? 0)}/{Math.round(status?.nozzleTargetC ?? 0)} °C · Bed{" "}
            {Math.round(status?.bedTempC ?? 0)}/{Math.round(status?.bedTargetC ?? 0)} °C
          </div>
          <div>
            {status?.layer != null && status.totalLayers != null
              ? `Layer ${status.layer}/${status.totalLayers}`
              : "Layer —"}
            {status?.progressPercent != null ? ` · ${Math.round(status.progressPercent)}%` : ""}
            {status?.speedPercent != null ? ` · ${Math.round(status.speedPercent)}% speed` : ""}
          </div>
        </div>
      ) : null}
      <div className="mt-2">AMS {printer.ams.slotsPerUnit} slots</div>
      <div className="mt-1 flex gap-1" aria-label={connected ? "AMS slots" : "AMS slots unloaded"}>
        {(connected && amsSlots.length
          ? amsSlots
          : fallbackSlots.map((slot) => ({ slot, present: false as const, filamentType: undefined as string | undefined, colorHex: undefined as string | undefined, remainingPercent: undefined as number | undefined }))
        ).map((slot) => {
          const title = slot.present
            ? `AMS ${slot.slot} ${slot.filamentType ?? ""}${slot.remainingPercent != null ? ` ${slot.remainingPercent}%` : ""}`
            : `AMS ${slot.slot} empty`;
          return (
            <div
              key={slot.slot}
              className={`flex h-7 w-7 items-center justify-center rounded border text-[10px] ${
                slot.present ? "" : "border-dashed border-line"
              }`}
              style={
                slot.present && slot.colorHex
                  ? { background: slot.colorHex, color: "#111", borderColor: slot.colorHex }
                  : undefined
              }
              title={title.trim()}
            >
              {slot.slot}
            </div>
          );
        })}
      </div>
      <AmsPlanBlock
        plan={plan}
        help={
          doctorHint?.amsGuide ??
          selectAmsHelpGuide({
            hint: status?.amsHint,
            slot: status?.amsHint?.slot ?? doctorHint?.amsSlot,
          })
        }
        onReassign={(fromIndex, toIndex) => {
          const next = reassignAmsSlot(plan, fromIndex, toIndex);
          setManualPlan(next);
          setPlan(next);
        }}
      />
      <label className="mt-2 grid grid-cols-[4.5rem_1fr] items-center gap-x-1.5 text-ink" htmlFor="machine-material">
        <span>Material</span>
        <select
          id="machine-material"
          value={material}
          onChange={(event) => onMaterialChange(event.target.value as FilamentId)}
          className="studio-field h-6 px-1.5 text-[11px]"
        >
          {listFilamentPresets(printer).map((item) => (
            <option key={item.id} value={item.id}>
              {filamentPickerLabel(item)}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-1.5">
        Auto-best {preset.name}: {preset.nozzleC} °C / {preset.bedC} °C bed · {speedTier} · {coolingHint}
      </div>
      {preset.notes ? <div className="mt-0.5">{preset.notes}</div> : null}
      {connected ? (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendCommand({ type: "pause" })}
              className="studio-btn studio-btn-ghost h-7 px-2 text-[11px]"
            >
              Pause
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendCommand({ type: "resume" })}
              className="studio-btn studio-btn-ghost h-7 px-2 text-[11px]"
            >
              Resume
            </button>
            {[50, 100, 124].map((percent) => (
              <button
                key={percent}
                type="button"
                disabled={busy}
                onClick={() => void sendCommand({ type: "set-speed", percent })}
                className="studio-btn studio-btn-ghost h-7 px-2 text-[11px]"
              >
                {percent}%
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label className="flex items-center gap-1">
              Nozzle
              <input
                type="number"
                inputMode="numeric"
                className="h-7 w-14 rounded border border-line bg-panel px-1 text-[11px]"
                value={nozzleInput}
                placeholder={String(status?.nozzleTargetC ?? preset.nozzleC)}
                onChange={(event) => setNozzleInput(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !nozzleInput}
              onClick={() => void sendCommand({ type: "set-nozzle-temp", celsius: Number(nozzleInput) })}
              className="studio-btn studio-btn-ghost h-7 px-2 text-[11px]"
            >
              Set
            </button>
            <label className="flex items-center gap-1">
              Bed
              <input
                type="number"
                inputMode="numeric"
                className="h-7 w-14 rounded border border-line bg-panel px-1 text-[11px]"
                value={bedInput}
                placeholder={String(status?.bedTargetC ?? preset.bedC)}
                onChange={(event) => setBedInput(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !bedInput}
              onClick={() => void sendCommand({ type: "set-bed-temp", celsius: Number(bedInput) })}
              className="studio-btn studio-btn-ghost h-7 px-2 text-[11px]"
            >
              Set
            </button>
          </div>
          {machine?.lastCommand ? (
            <div>
              {machine.lastCommand.message}
              {machine.lastCommand.physicalSteps?.length ? (
                <ul className="mt-1 list-disc pl-4">
                  {machine.lastCommand.physicalSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {doctorHint ? (
        <div className="mt-2 border-t border-line pt-2">
          <div className="font-medium text-ink">{doctorHint.title}</div>
          <div className="mt-0.5">{doctorHint.diagnosis}</div>
          {doctorHint.autofix?.attempted ? <div className="mt-0.5">{doctorHint.autofix.message}</div> : null}
          {doctorHint.midPrint ? <div className="mt-0.5">{doctorHint.midPrint.message}</div> : null}
          {doctorHint.reshape ? <div className="mt-0.5">{doctorHint.reshape.message}</div> : null}
        </div>
      ) : (
        <p className="mt-2">Describe a print problem in chat — CAD export still works disconnected.</p>
      )}
    </div>
  );
}

function ResultPanel({
  result,
  showDetails,
  onToggleDetails,
  onPaintRegion,
  paintDisabled = false,
}: {
  result: GenerateResult;
  showDetails: boolean;
  onToggleDetails: () => void;
  onPaintRegion?: (phrase: string) => void;
  paintDisabled?: boolean;
}) {
  const { report } = result;
  const issues = report.issues;
  const photo = result.editMode === "image-import";
  const imported = result.source === "imported-mesh";
  const reshapeUpper = result.editMode === "reshape-upper";
  const designation = result.machineDesignation;
  const colorRegions = result.colorRegions ?? [];
  const showColors = colorRegions.length > 1 || (colorRegions.length === 1 && colorRegions[0]?.colorName !== "default");

  return (
    <div className="space-y-3 border-t border-line pt-3">
      {designation?.exceedsCurrentPrinter ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 p-2.5 text-[11px] leading-relaxed text-ink">
          <div className="studio-label mb-1">Exceeds current printer</div>
          <p>{designation.message}</p>
          {designation.designatedMachine ? (
            <p className="mt-1 text-muted">
              Designated: {designation.designatedMachine.name} ·{" "}
              {designation.designatedMachine.buildVolumeMm.join(" × ")} mm (stub profile)
            </p>
          ) : null}
        </div>
      ) : null}
      {result.notes.length > 0 ? (
        <div className="rounded-md border border-line bg-panel-2 p-2.5 text-[11px] leading-relaxed text-muted">
          <div className="studio-label mb-1">
            {photo
              ? "Photo solid"
              : imported
                ? "Imported mesh"
                : reshapeUpper
                  ? "Remaining upper"
                  : showColors
                    ? "Colors / size"
                    : "Size"}
          </div>
          {result.notes.map((note) => (
            <p key={note} className="mt-1">
              {note}
            </p>
          ))}
        </div>
      ) : null}
      <div className="studio-label">Exports</div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={result.stlUrl} className="studio-btn studio-btn-ghost inline-flex h-8 px-3">
          Download STL
        </a>
        <a href={result.threemfUrl} className="studio-btn studio-btn-ghost inline-flex h-8 px-3">
          Download 3MF
        </a>
        <a href={result.printPresetUrl} className="studio-btn studio-btn-ghost inline-flex h-8 px-3">
          Print settings
        </a>
        <a
          href={result.projectPackUrl}
          className="studio-btn studio-btn-ghost inline-flex h-8 px-3"
          title="Project pack (stub) · 3MF + steps + shopping links"
        >
          Download pack
        </a>
        {result.assembly?.isAssembly && result.partsZipUrl ? (
          <a
            href={result.partsZipUrl}
            className="studio-btn studio-btn-ghost inline-flex h-8 px-3"
            title="Individual part STLs in assembled coordinates. Explode is a viewer heuristic, not kinematics."
          >
            Download parts
          </a>
        ) : null}
        <button type="button" onClick={onToggleDetails} className="ml-auto text-[11px] text-muted underline-offset-2 hover:underline">
          {showDetails ? "Hide details" : "Details"}
        </button>
      </div>
      <p className="text-sm text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
        {issues.length === 0 ? " · looks good" : ""}
      </p>
      {result.assembly?.isAssembly ? (
        <div className="space-y-1.5">
          <div className="studio-label">Assembly parts</div>
          <div className="flex flex-wrap gap-1.5">
            {result.assembly.parts.map((part) => (
              <a
                key={part.id}
                href={`/api/jobs/${result.jobId}/part-${part.id}.stl`}
                className="inline-flex items-center rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink hover:bg-panel"
                title="Download this solid as STL (assembled coordinates)"
              >
                {part.name} STL
              </a>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-muted">{result.assembly.disclaimer}</p>
        </div>
      ) : null}
      {showColors ? (
        <div className="space-y-1.5">
          <div className="studio-label">Color regions</div>
          <div className="flex flex-wrap gap-1.5">
            {colorRegions.map((region) => (
              <span
                key={`${region.id}-${region.amsSlot}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink"
                title={`Suggested extruder ${region.amsSlot} — CAD export metadata, not a live AMS tray`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full border border-line"
                  style={{ background: region.colorHex }}
                />
                {region.name} · {region.colorName} · {region.colorHex} · extruder {region.amsSlot}
              </span>
            ))}
          </div>
          {onPaintRegion ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted">Paint</span>
              {namedColorRegions(colorRegions).flatMap((region) =>
                PAINT_CHIP_COLORS.filter((color) => color !== region.colorName).map((color) => (
                  <button
                    key={`${region.id}-${color}`}
                    type="button"
                    disabled={paintDisabled}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-panel px-1.5 py-0.5 text-[10px] text-ink hover:bg-panel-2 disabled:opacity-40"
                    onClick={() => onPaintRegion(`paint the ${region.name} ${color}`)}
                  >
                    <span className="inline-block h-2 w-2 rounded-full border border-line" style={{ background: color === "white" ? "#FFFFFF" : color === "black" ? "#1A1A1A" : color === "blue" ? "#2F6FED" : "#FF0000" }} />
                    {region.name} {color}
                  </button>
                )),
              )}
            </div>
          ) : null}
          <p className="text-[10px] leading-snug text-muted">
            Suggested extruder / AMS index is CAD export metadata. Print Control maps physical trays.
          </p>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.severity}`} className={issue.severity === "error" ? "text-danger" : "text-warn"}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {report.strengthPreview ? (
        <div className="rounded-md border border-line bg-panel-2 p-2.5">
          <div className="studio-label mb-1">Strength preview</div>
          <p className="text-[11px] leading-relaxed text-muted">{report.strengthPreview.disclaimer}</p>
          {report.strengthPreview.issues.length ? (
            <ul className="mt-1.5 space-y-1 text-xs text-warn">
              {report.strengthPreview.issues.map((issue, index) => (
                <li key={`${issue.kind}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-xs text-muted">No high-risk heuristic regions on this mesh.</p>
          )}
        </div>
      ) : null}
      {showDetails ? (
        <div className="space-y-2 rounded-md border border-line bg-panel-2 p-2.5">
          <p className="text-[11px] text-muted">
            Volume {formatMm(report.volumeMm3, 1)} mm³ · {report.triangleCount.toLocaleString()} triangles ·{" "}
            {report.watertight ? "watertight" : "check mesh"}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={result.scadUrl} className="text-[11px] text-muted underline-offset-2 hover:underline">
              {imported ? "Mesh notes / wrapper" : "OpenSCAD source"}
            </a>
          </div>
          <pre className="scrollbar-thin max-h-40 overflow-auto font-mono text-[11px] leading-relaxed text-muted">
            {result.code}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-muted">
        Describe a part in plain language, or <span className="text-ink">import an STL/3MF or a photo</span>. If a
        known fork is unclear, the chat offers a few chips — pick one, then <span className="text-ink">Print</span>.
        Open <span className="text-ink">More options</span> for a one-off size or saved profile defaults (this device
        only).         The plate is a Bambu Lab P2S (256 × 256 × 256 mm) by default. A print defect (stringing, AMS loop) or a
        failed-print photo / caption (stub) goes to Print doctor instead of CAD.
      </p>
      <div className="studio-label">Try saying</div>
      <div className="space-y-1.5">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="block w-full rounded-md border border-line bg-panel-2 px-2.5 py-2 text-left text-sm hover:border-accent/50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserProfilePanel({
  profile,
  onChange,
}: {
  profile: UserProfile;
  onChange: (profile: UserProfile) => void;
}) {
  const printer = defaultPrinter();
  const slotRows = Array.from({ length: USER_PROFILE_AMS_SLOT_COUNT }, (_, index) => {
    return profile.amsSlots.find((slot) => slot.index === index) ?? { index, label: "" };
  });

  return (
    <div className="mt-2 w-full space-y-2 border-t border-line pt-2">
      <div className="studio-label">Profile defaults</div>
      <p className="text-[10px] leading-relaxed text-muted">{USER_PROFILE_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-muted">
          Printer
          <input
            value={printer.name}
            readOnly
            className="studio-field mt-0.5 w-40 px-2 py-1.5 text-sm"
            aria-label="Default printer"
          />
        </label>
        <label className="text-[11px] text-muted">
          Category
          <select
            value={profile.wearableCategory}
            onChange={(event) =>
              onChange({ ...profile, wearableCategory: event.target.value as WearableCategoryId })
            }
            className="studio-field mt-0.5 w-36 px-2 py-1.5 text-sm"
            aria-label="Default wearable category"
          >
            {WEARABLE_CATEGORY_IDS.map((id) => (
              <option key={id} value={id}>
                {getWearableCategory(id).shortLabel}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          Size
          <select
            value={profile.wearableSize ?? ""}
            onChange={(event) =>
              onChange({
                ...profile,
                wearableSize: isWearableSizeId(event.target.value) ? event.target.value : null,
              })
            }
            className="studio-field mt-0.5 w-28 px-2 py-1.5 text-sm"
            aria-label="Default wearable size"
          >
            <option value="">Native / unset</option>
            {WEARABLE_SIZE_IDS.map((id) => (
              <option key={id} value={id}>
                {id} · {WEARABLE_SIZE_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          Filament
          <select
            value={profile.filament}
            onChange={(event) =>
              onChange({
                ...profile,
                filament: isFilamentId(event.target.value) ? event.target.value : profile.filament,
              })
            }
            className="studio-field mt-0.5 w-28 px-2 py-1.5 text-sm"
            aria-label="Default filament"
          >
            {listFilamentPresets(printer).map((item) => (
              <option key={item.id} value={item.id}>
                {filamentPickerLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          Part size
          <input
            type="number"
            min={0}
            step="any"
            value={profile.partSizeHint ?? ""}
            onChange={(event) => {
              const n = Number(event.target.value);
              onChange({
                ...profile,
                partSizeHint: event.target.value.trim() && Number.isFinite(n) && n > 0 ? n : null,
              });
            }}
            placeholder="optional"
            className="studio-field mt-0.5 w-20 px-2 py-1.5 text-sm"
            aria-label="Default part size"
          />
        </label>
        <label className="text-[11px] text-muted">
          Units
          <select
            value={profile.units}
            onChange={(event) => onChange({ ...profile, units: event.target.value as Unit })}
            className="studio-field mt-0.5 w-auto px-2 py-1.5 text-sm"
            aria-label="Default units"
          >
            <option value="mm">mm</option>
            <option value="in">inches</option>
          </select>
        </label>
      </div>
      <div>
        <div className="text-[11px] text-muted">AMS slot labels (prefs only)</div>
        <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
          {slotRows.map((slot) => (
            <div key={slot.index} className="flex items-center gap-1.5">
              <span className="w-10 shrink-0 text-[10px] text-muted">AMS {slot.index + 1}</span>
              <input
                value={slot.label}
                onChange={(event) =>
                  onChange(upsertUserProfileAmsSlot(profile, { ...slot, label: event.target.value }))
                }
                placeholder="label"
                className="studio-field min-w-0 flex-1 px-2 py-1 text-[11px]"
                aria-label={`AMS ${slot.index + 1} label`}
              />
              <select
                value={slot.material ?? ""}
                onChange={(event) =>
                  onChange(
                    upsertUserProfileAmsSlot(profile, {
                      ...slot,
                      material: isFilamentId(event.target.value) ? event.target.value : undefined,
                    }),
                  )
                }
                className="studio-field w-20 px-1.5 py-1 text-[11px]"
                aria-label={`AMS ${slot.index + 1} material`}
              >
                <option value="">—</option>
                {listFilamentPresets(printer).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WearableSizePicker({
  selected,
  applied,
  category,
  appliedCategory,
  disabled,
  canApply,
  onSelect,
  onSelectCategory,
}: {
  selected: WearableSizeId | null;
  applied: WearableSizeId | null;
  category: WearableCategoryId;
  appliedCategory: WearableCategoryId | null;
  disabled: boolean;
  canApply: boolean;
  onSelect: (size: WearableSizeId) => void;
  onSelectCategory: (category: WearableCategoryId) => void;
}) {
  const assumed = applied ?? selected;
  const chart = getWearableCategory(category);
  return (
    <div className="rounded-md border border-line bg-panel-2 p-2.5">
      <div className="studio-label">Wearable size</div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{wearableChartNote()}</p>
      <p className="mt-1 text-[11px] text-ink">{describeWearableSize(assumed, category)}</p>
      <label className="mt-2 block">
        <span className="sr-only">Wearable category</span>
        <select
          value={category}
          disabled={disabled}
          onChange={(event) => onSelectCategory(event.target.value as WearableCategoryId)}
          className="h-7 w-full rounded-md border border-line bg-panel px-2 text-[11px] text-ink"
        >
          {WEARABLE_CATEGORY_IDS.map((id) => {
            const option = getWearableCategory(id);
            return (
              <option key={id} value={id}>
                {option.label}
                {appliedCategory === id ? " · on plate" : ""}
              </option>
            );
          })}
        </select>
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {WEARABLE_SIZE_IDS.map((id) => {
          const active = (applied ?? selected) === id;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled || (!canApply && Boolean(applied))}
              onClick={() => onSelect(id)}
              className={`h-7 min-w-8 rounded-md border px-2 text-[11px] font-semibold ${
                active ? "border-accent bg-accent text-accent-ink" : "border-line bg-panel text-muted hover:text-ink"
              }`}
            >
              {id}
            </button>
          );
        })}
      </div>
      <table className="mt-2 w-full text-left text-[10px] text-muted">
        <thead>
          <tr>
            <th className="font-medium">Size</th>
            <th className="font-medium">× M</th>
            {chart.keys.map((key) => (
              <th key={key} className="font-medium">
                {MEASUREMENT_LABELS[key]}
                {key === chart.primaryKey ? "*" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEARABLE_SIZE_IDS.map((id) => (
            <tr key={id} className={assumed === id ? "text-ink" : undefined}>
              <td>{id}</td>
              <td>{wearableSizeRatio(id, category).toFixed(3)}</td>
              {chart.keys.map((key) => (
                <td key={key}>{chart.sizes[id][key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-muted">
        {WEARABLE_SIZE_LABELS[assumed ?? "M"]} · values in mm · * primary (uniform scale). Select a size to scale the
        plate mesh.
      </p>
    </div>
  );
}

function toneDot(tone: HealthTone): string {
  if (tone === "ok") return "bg-ok";
  if (tone === "warn") return "bg-warn";
  if (tone === "danger") return "bg-danger";
  return "bg-muted";
}

function toneChip(tone: HealthTone): string {
  if (tone === "ok") return "border-ok/35 bg-ok/10 text-ok";
  if (tone === "warn") return "border-warn/40 bg-warn/10 text-warn";
  if (tone === "danger") return "border-danger/40 bg-danger/10 text-danger";
  return "border-line bg-panel-2 text-muted";
}

function ToolsStatus({ localAiHint = false }: { localAiHint?: boolean }) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!response.ok) throw new Error("health failed");
        const report = (await response.json()) as HealthReport;
        if (!cancelled) {
          setHealth(report);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const localTone: HealthTone = health?.localAi.tone ?? "neutral";
  const scadTone: HealthTone = health?.openscad.tone ?? "neutral";
  const localLabel = health?.localAi.label ?? (localAiHint ? "Local AI" : "Tools");
  const summary = health
    ? health.ready
      ? "Local AI and OpenSCAD look ready"
      : "Local AI / tools need a fix — click for tips"
    : failed
      ? "Could not check local AI / tools"
      : "Checking local AI and OpenSCAD…";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${toneChip(
          !health ? "neutral" : health.ready ? "ok" : localTone === "danger" ? "danger" : "warn",
        )}`}
        aria-expanded={open}
        aria-label={summary}
        title={summary}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${toneDot(localTone)}`} aria-hidden="true" />
        <span className="hidden sm:inline">{localLabel}</span>
        <span className="sm:hidden">Tools</span>
        <span className={`hidden h-1.5 w-1.5 rounded-full sm:inline-block ${toneDot(scadTone)}`} aria-hidden="true" />
        <span className="hidden text-[10px] opacity-80 sm:inline">OpenSCAD</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-1.5rem))] space-y-2.5 rounded-md border border-line bg-panel p-3 text-[12px] shadow-lg"
          role="status"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="studio-label">Local AI / tools</div>
            <button type="button" className="text-[11px] text-muted hover:underline" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {health ? (
            <>
              <HealthBlock
                tone={health.localAi.tone}
                title={health.localAi.label}
                detail={health.localAi.detail}
                tips={health.localAi.tips}
              />
              <HealthBlock
                tone={health.openscad.tone}
                title={health.openscad.label}
                detail={health.openscad.detail}
                tips={health.openscad.tips}
              />
              <p className="text-[11px] text-muted">
                Printer default: {health.printer.name} ({health.printer.buildVolumeMm.join(" × ")} mm). Agent Smith
                models and the Ollama port stay untouched.
              </p>
            </>
          ) : (
            <p className="text-muted">{failed ? "Health check failed. Is the app still running?" : "Checking…"}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HealthBlock({
  tone,
  title,
  detail,
  tips,
}: {
  tone: HealthTone;
  title: string;
  detail: string;
  tips: string[];
}) {
  return (
    <div className={`rounded-md border px-2.5 py-2 ${toneChip(tone)}`}>
      <div className="flex items-center gap-1.5 font-medium text-ink">
        <span className={`h-1.5 w-1.5 rounded-full ${toneDot(tone)}`} aria-hidden="true" />
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink/90">{detail}</p>
      {tips.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed">
          {tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StudioMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.2" width="17.6" height="17.6" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M4.5 16.2 H17.5 V14.4 H4.5 Z" fill="var(--accent)" />
      <path d="M8 14.2 L11 6.8 L14 14.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 1.4v1.3M7 11.3v1.3M1.4 7h1.3M11.3 7h1.3M2.9 2.9l.9.9M10.2 10.2l.9.9M11.1 2.9l-.9.9M3.8 10.2l-.9.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M8.4 2.1A4.8 4.8 0 1 0 11.9 8 3.7 3.7 0 0 1 8.4 2.1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
