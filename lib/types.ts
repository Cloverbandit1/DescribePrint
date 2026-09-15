export type Unit = "mm" | "in";

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
};

export type Triangle = {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
};

export type Mesh = {
  triangles: Triangle[];
};

/**
 * V0 extension points (not implemented — reserved for later versions).
 *
 * - describe-to-modify: follow-up "make the hole 8mm" using previous SCAD as context
 *   (V0 already sends previousPrompt/previousCode on chat follow-ups)
 * - Style2Fab-style edit: in-app stylization while preserving functional regions
 *   (not a Blender plugin or other DCC — preview + STL/3MF in the web UI is the full path)
 * - organic mesh: swap the OpenSCAD backend for a neural / implicit surface generator
 *
 * Product roadmap after V0 (README; do not implement here):
 * 1. wearable/cosplay sizing  2. raised etchings/emboss  3. articulated assemblies
 * 4. print doctor (defect description → diagnose for selected printer/material,
 *    default P2S → propose/auto-apply settings → still-bad vs perfect feedback)
 * 5. image import (single photo → full 3D solid including inferred backside
 *    and unseen geometry, not front-only; repair damage by default,
 *    keep cracks/missing chunks only if the user asks)
 * All stay in-app; users never need Blender or another DCC afterward.
 * V0 stays describe → CAD → STL/3MF.
 * UX: everyday path is describe → clear options → Print; hide advanced CAD.
 *
 * Default printer: Bambu Lab P2S (see lib/printers.ts). In-app printer/settings
 * UI and full Bambu/Orca slice are later; V0 still exports STL/3MF.
 */
export type FutureEditMode =
  | "create"
  | "describe-to-modify"
  | "style2fab"
  | "organic-mesh";
