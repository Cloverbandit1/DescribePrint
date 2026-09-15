import { randomUUID } from "node:crypto";
import type { GenerateResult, PrintabilityReport } from "./types";

export type StoredJob = {
  id: string;
  createdAt: number;
  stl: Buffer;
  threemf: Buffer;
  scad: string;
  report: PrintabilityReport;
  usedFixture: boolean;
  retried: boolean;
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

export function createJob(input: Omit<StoredJob, "id" | "createdAt">): StoredJob {
  sweep();
  const job: StoredJob = {
    ...input,
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
  };
}
