export type Unit = "mm" | "in";

export type PartSource = "openscad" | "imported-mesh";

export type WearableSizeId = "S" | "M" | "L" | "XL";

export type WearableCategoryId = "helmet_mask" | "torso_armor" | "gauntlet" | "bracer";

export type PlateEditMode = "create" | "import" | "transform" | "describe-wrapper";

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

export type PrintabilityReport = {
  triangleCount: number;
  volumeMm3: number;
  boundingBoxMm: BoundingBoxMm;
  manifold: boolean;
  watertight: boolean;
  issues: MeshIssue[];
  units: "mm";
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
 * - Wearable S/M/L/XL measurement charts that scale the current mesh
 * - Describe-to-edit on imported meshes: real triangle scale/rotate/sit-on-bed;
 *   generative adds (holes, tabs) wrap import("imported.stl") in OpenSCAD.
 *   Holes difference the import (through by default). Full triangle sculpt /
 *   Style2Fab is not implemented.
 *
 * Still later:
 * - describe-to-modify already sends previousPrompt/previousCode on CAD follow-ups
 * - Style2Fab-style edit, organic mesh, image→3D, Print doctor, machine control
 *
 * Default printer: Bambu Lab P2S (see lib/printers.ts).
 */
export type FutureEditMode =
  | "create"
  | "describe-to-modify"
  | "style2fab"
  | "organic-mesh";
