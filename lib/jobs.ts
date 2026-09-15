import type { MachineDesignation } from "./alternate-machines";
import { defaultColorRegion, regionsToDesignFilaments, type ColorRegion } from "./color-regions";
import { buildAmsSlotPlan, normalizeAmsSlotPlan } from "./machine/ams";
import type { AmsSlotPlan } from "./machine/types";
import { printPresetSummary, type PrintPresetSummary } from "./printers";
import { formatStrengthPreviewNote } from "./strength-preview";
import type {
  GenerateResult,
  ImageImportMeta,
  PartSource,
  PlateEditMode,
  PrintabilityReport,
  WearableCategoryId,
  WearableSizeId,
} from "./types";

export type StoredJob = {
  id: string;
  createdAt: number;
  stl: Buffer;
  threemf: Buffer;
  scad: string;
  report: PrintabilityReport;
  usedFixture: boolean;
  retried: boolean;
  source: PartSource;
  fileName: string | null;
  wearableSize: WearableSizeId | null;
  wearableCategory: WearableCategoryId | null;
  nativeSizeMm: [number, number, number];
  editMode: PlateEditMode;
  notes: string[];
  colorRegions: ColorRegion[];
  imageImport?: ImageImportMeta | null;
  machineDesignation?: MachineDesignation | null;
  printPreset: PrintPresetSummary;
  amsSlotPlan: AmsSlotPlan;
};

export type CreateJobInput = Omit<StoredJob, "id" | "createdAt" | "printPreset" | "amsSlotPlan"> & {
  source?: PartSource;
  fileName?: string | null;
  wearableSize?: WearableSizeId | null;
  wearableCategory?: WearableCategoryId | null;
  nativeSizeMm?: [number, number, number];
  editMode?: PlateEditMode;
  notes?: string[];
  colorRegions?: ColorRegion[];
  imageImport?: ImageImportMeta | null;
  machineDesignation?: MachineDesignation | null;
  printPreset?: PrintPresetSummary | null;
  amsSlotPlan?: AmsSlotPlan | null;
};

const TTL_MS = 60 * 60 * 1000;
const jobs = new Map<string, StoredJob>();

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function createJob(input: CreateJobInput): StoredJob {
  sweep();
  const job: StoredJob = {
    stl: input.stl,
    threemf: input.threemf,
    scad: input.scad,
    report: input.report,
    usedFixture: input.usedFixture,
    retried: input.retried,
    source: input.source ?? "openscad",
    fileName: input.fileName ?? null,
    wearableSize: input.wearableSize ?? null,
    wearableCategory: input.wearableCategory ?? null,
    nativeSizeMm: input.nativeSizeMm ?? input.report.boundingBoxMm.size,
    editMode: input.editMode ?? "create",
    notes: input.notes ?? [],
    colorRegions: input.colorRegions?.length ? input.colorRegions : [defaultColorRegion()],
    imageImport: input.imageImport ?? null,
    machineDesignation: input.machineDesignation ?? null,
    printPreset: input.printPreset ?? printPresetSummary("pla"),
    amsSlotPlan:
      input.amsSlotPlan ??
      buildAmsSlotPlan({
        material: (input.printPreset ?? printPresetSummary("pla")).material,
        design: regionsToDesignFilaments(input.colorRegions?.length ? input.colorRegions : [defaultColorRegion()]),
      }),
    id: globalThis.crypto.randomUUID(),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): StoredJob | undefined {
  sweep();
  return jobs.get(id);
}

export function updateJobAmsSlotPlan(id: string, plan: AmsSlotPlan): StoredJob | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  job.amsSlotPlan = normalizeAmsSlotPlan(plan);
  return job;
}

/** Most recently created in-memory generate result, if any. */
export function getLatestJob(): StoredJob | undefined {
  sweep();
  let latest: StoredJob | undefined;
  for (const job of jobs.values()) {
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  return latest;
}

export function resetJobs(): void {
  jobs.clear();
}

export function toGenerateResult(job: StoredJob): GenerateResult {
  const strengthNote = formatStrengthPreviewNote(job.report.strengthPreview);
  const notes = [...job.notes];
  if (strengthNote && !notes.includes(strengthNote)) notes.push(strengthNote);
  return {
    jobId: job.id,
    language: "openscad",
    code: job.scad,
    usedFixture: job.usedFixture,
    retried: job.retried,
    stlUrl: `/api/jobs/${job.id}/model.stl`,
    threemfUrl: `/api/jobs/${job.id}/model.3mf`,
    scadUrl: `/api/jobs/${job.id}/model.scad`,
    report: job.report,
    source: job.source,
    fileName: job.fileName,
    wearableSize: job.wearableSize,
    wearableCategory: job.wearableCategory,
    editMode: job.editMode,
    notes,
    colorRegions: job.colorRegions,
    imageImport: job.imageImport ?? null,
    machineDesignation: job.machineDesignation ?? null,
    printPreset: job.printPreset,
    printPresetUrl: `/api/jobs/${job.id}/model.print.json`,
    projectPackUrl: `/api/jobs/${job.id}/model.pack.zip`,
    amsSlotPlan: job.amsSlotPlan,
  };
}
