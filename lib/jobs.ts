import { randomUUID } from "node:crypto";
import type { GenerateResult, PartSource, PlateEditMode, PrintabilityReport, WearableSizeId } from "./types";

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
  nativeSizeMm: [number, number, number];
  editMode: PlateEditMode;
  notes: string[];
};

export type CreateJobInput = Omit<StoredJob, "id" | "createdAt"> & {
  source?: PartSource;
  fileName?: string | null;
  wearableSize?: WearableSizeId | null;
  nativeSizeMm?: [number, number, number];
  editMode?: PlateEditMode;
  notes?: string[];
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
    nativeSizeMm: input.nativeSizeMm ?? input.report.boundingBoxMm.size,
    editMode: input.editMode ?? "create",
    notes: input.notes ?? [],
    id: randomUUID(),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): StoredJob | undefined {
  sweep();
  return jobs.get(id);
}

export function toGenerateResult(job: StoredJob): GenerateResult {
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
    editMode: job.editMode,
    notes: job.notes,
  };
}
