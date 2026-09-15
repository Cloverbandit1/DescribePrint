import type { AppliedDesignChoice, DesignOptionGroup } from "./design-options";
import type { MachineDesignation } from "./alternate-machines";
import type { ColorRegion } from "./color-regions";
import type { AmsSlotPlan } from "./machine/types";
import type { CadReshapeHandoff, StumpCutPlaneBoundsMm } from "./machine/reshape-plan";
import type { FilamentId, PrintPresetSummary } from "./printers";

export type { AppliedDesignChoice, DesignOption, DesignOptionGroup, DesignOptionGroupId } from "./design-options";
export type { AmsSlotPlan, ColorRegion, FilamentId, MachineDesignation, PrintPresetSummary };
export type { CadReshapeHandoff, StumpCutPlaneBoundsMm };

export type ImageRasterFormat = "png" | "jpeg" | "webp";

export type ImageBacksideMethod = "luminance-depth-backside";

export type ImageFragmentKind = "none" | "crack" | "missing-chunk" | "disconnected-pieces";

export type ImageFragmentIdentify = {
  looksLikeFragment: boolean;
  kind: ImageFragmentKind;
  restoredMissingVolume: boolean;
  fragmentCells: number;
  intendedWholeCells: number;
  largestMissingFrac: number;
  solidity: number;
  note: string;
};

/** Partial subject seen in a photo or described in chat. */
export type ImageSubjectClass = "none" | "head" | "helmet" | "bust" | "fragment";

export type ImageSubjectSource = "heuristic" | "chat" | "filename" | "mixed";

export type ImageSubjectIdentify = {
  class: ImageSubjectClass;
  confidence: number;
  source: ImageSubjectSource;
  note: string;
};

export type ImageCompletionRegionId = "head" | "helmet" | "bust" | "neck" | "torso";

export type ImageCompletionRegion = {
  id: ImageCompletionRegionId;
  label: string;
  origin: "matched" | "invented";
  note: string;
};

export type ImageCompletionProportions = {
  headHeightMm: number;
  neckHeightMm: number;
  torsoHeightMm: number;
  shoulderWidthMm: number;
  waistWidthMm: number;
  chestToHeadCirc: number;
};

export type ImageCompletion = {
  applied: boolean;
  kind: "match-and-complete" | "none";
  subjectClass: ImageSubjectClass;
  matched: ImageCompletionRegionId[];
  invented: ImageCompletionRegionId[];
  regions: ImageCompletionRegion[];
  proportions: ImageCompletionProportions | null;
  note: string;
  identityAccurate: false;
  photogrammetry: false;
};

export type ImageImportMeta = {
  kind: "image-solid";
  format: ImageRasterFormat;
  repairApplied: boolean;
  keepWear: boolean;
  inferredBackside: true;
  method: ImageBacksideMethod;
  photogrammetry: false;
  neuralReconstruction: false;
  pixelsInferred: boolean;
  fragment: ImageFragmentIdentify;
  subject: ImageSubjectIdentify;
  completion: ImageCompletion;
};

export type Unit = "mm" | "in";

export type PartSource = "openscad" | "imported-mesh";

export type WearableSizeId = "S" | "M" | "L" | "XL";

export type WearableCategoryId = "helmet_mask" | "torso_armor" | "gauntlet" | "bracer";

export type PlateEditMode = "create" | "import" | "image-import" | "transform" | "describe-wrapper" | "reshape-upper";

export type GenerateRequest = {
  prompt: string;
  sizeHint?: number | null;
  units?: Unit;
  /** Force the built-in fixture/heuristic path (no live LLM). */
  fixture?: boolean;
  /** Last successful description, used so follow-ups can edit the same part. */
  previousPrompt?: string | null;
  /** Last successful OpenSCAD, used so follow-ups can add/remove/change the design. */
  previousCode?: string | null;
  /** Last plate job — required to edit an imported mesh. */
  previousJobId?: string | null;
  /** How the current plate part was produced. */
  previousSource?: PartSource | null;
  /** Wearable / cosplay size preset to apply (S–XL chart). */
  wearableSize?: WearableSizeId | null;
  /** Wearable category chart (helmet, torso, gauntlet, bracer). */
  wearableCategory?: WearableCategoryId | null;
  /** Print Control emergency-reshape handoff. When set, CAD generates the unprinted upper only. */
  cadHandoff?: CadReshapeHandoff | null;
  /** Selected P2S material — stamps auto-best presets onto export metadata. */
  filament?: FilamentId | string | null;
  /** Mid-design chips the user already picked (threaded into the next generate). */
  choices?: AppliedDesignChoice[] | null;
};

export type PipelineStep =
  | "queued"
  | "planning"
  | "codegen"
  | "sanitize"
  | "compile"
  | "mesh-check"
  | "export"
  | "retry"
  | "import"
  | "image"
  | "transform"
  | "done";

export type StatusEvent = {
  step: PipelineStep;
  message: string;
  attempt?: number;
};

export type MeshIssue = {
  code:
    | "empty"
    | "zero-volume"
    | "huge-triangles"
    | "non-manifold"
    | "oversized"
    | "undersized"
    | "thin-wall"
    | "off-bed"
    | "disconnected"
    | "no-triangles";
  severity: "error" | "warning";
  message: string;
};

export type BoundingBoxMm = {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
};

export type StrengthPreviewKind = "thin-wall" | "stress-concentration" | "overhang" | "tiny-section";

export type StrengthPreviewIssue = {
  kind: StrengthPreviewKind;
  message: string;
  score: number;
  thicknessMm?: number;
  positionMm: [number, number, number];
};

/** Heuristic weakness overlay — not FEA. */
export type StrengthPreview = {
  method: "heuristic";
  fea: false;
  disclaimer: string;
  triangleCount: number;
  maxScore: number;
  meanScore: number;
  issues: StrengthPreviewIssue[];
  triangleScores: number[];
};

export type PrintabilityReport = {
  triangleCount: number;
  volumeMm3: number;
  boundingBoxMm: BoundingBoxMm;
  manifold: boolean;
  watertight: boolean;
  issues: MeshIssue[];
  units: "mm";
  /** Present after mesh-check. Omitted on hand-built test reports. */
  strengthPreview?: StrengthPreview;
};

export type GenerateResult = {
  jobId: string;
  language: "openscad";
  code: string;
  usedFixture: boolean;
  retried: boolean;
  stlUrl: string;
  threemfUrl: string;
  scadUrl: string;
  report: PrintabilityReport;
  source: PartSource;
  fileName?: string | null;
  wearableSize?: WearableSizeId | null;
  wearableCategory?: WearableCategoryId | null;
  editMode: PlateEditMode;
  notes: string[];
  /** Named color / material objects written into the 3MF (AMS slots are export metadata). */
  colorRegions: ColorRegion[];
  /** Present when the plate came from a photo → solid stub. */
  imageImport?: ImageImportMeta | null;
  /** Present when the solid does not fit the current printer (default P2S). */
  machineDesignation?: MachineDesignation | null;
  /** Advisory P2S auto-best snapshot written into 3MF + sidecar JSON. */
  printPreset: PrintPresetSummary;
  printPresetUrl: string;
  /** One-click stub zip: 3MF + STL + steps + shopping links. */
  projectPackUrl: string;
  /** AMS tray handoff written into 3MF metadata (omit unused trays). */
  amsSlotPlan?: AmsSlotPlan;
  /** True only when a known fork is still open — not set on ordinary prompts. */
  needs_user_choice?: boolean;
  /** Selectable chips for the open fork(s). Empty when generate can just proceed. */
  options?: DesignOptionGroup[];
  appliedChoices?: AppliedDesignChoice[];
};

export type Triangle = {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
};

export type Mesh = {
  triangles: Triangle[];
};

/**
 * Extension points.
 *
 * Shipped M2 foundations (in-app, no DCC):
 * - STL/3MF import onto the plate
 * - Photo → printable solid (silhouette + luminance-depth backside + fragment
 *   identify / restore-missing-volume; match-and-complete for head/helmet/bust
 *   partials; repair-by-default; oversize designates a stub alternate machine).
 *   Not photogrammetry / NeRF / identity-accurate.
 * - Wearable S/M/L/XL measurement charts that scale the current mesh
 * - Describe-to-edit on imported meshes: real triangle scale/rotate/sit-on-bed;
 *   generative adds (holes, tabs, emboss/etch, pretty-up) wrap import("imported.stl") in
 *   OpenSCAD. Holes difference the import (through by default). Relief is an
 *   honest CSG stub (primitive / block initials). Pretty-up is heuristic CSG
 *   (fillet/chamfer/ribs/panels) that keeps functional holes/joints/walls —
 *   not neural Style2Fab. Full triangle sculpt is not implemented.
 * - Multi-filament 3MF: describe colors/materials → separate 3MF objects with
 *   displaycolor + extruder/AMS slot metadata. OpenSCAD compiles one mesh;
 *   color bodies are split via named region_* modules / color() groups.
 *   Import preserves 3MF colors when present. Not live AMS / machine control.
 * - Heuristic strength preview heatmap (thickness / concave / overhang /
 *   tiny-section). Not FEA.
 *
 * Still later:
 * - describe-to-modify already sends previousPrompt/previousCode on CAD follow-ups
 * - version history / undo is an in-session stack (see lib/version-history.ts)
 * - user profile stub is localStorage-only (see lib/user-profile.ts)
 * - Neural Style2Fab / image style transfer (pretty-up shipped as heuristic CSG)
 * - organic mesh, photogrammetry / NeRF image→3D, Print doctor, machine control
 *
 * Default printer: Bambu Lab P2S (see lib/printers.ts).
 */
export type FutureEditMode =
  | "create"
  | "describe-to-modify"
  | "style2fab"
  | "organic-mesh";
