import {
  explodedStlBuffer,
  partsFromThreeMf,
  partsZipBuffer,
  partStlBuffer,
} from "@/lib/assembly";
import { getJob, updateJobAmsSlotPlan } from "@/lib/jobs";
import { amsSlotPlanSidecarJson, parseAmsSlotPlan } from "@/lib/machine/ams";
import { buildProjectPack, ProjectPackError } from "@/lib/machine/project-pack";
import { printPresetSidecarJson } from "@/lib/printers";
import { stampAmsSlotPlan } from "@/lib/threemf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES = {
  "model.stl": { type: "application/sla", field: "stl" as const, download: "describeprint.stl" },
  "model.3mf": {
    type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    field: "threemf" as const,
    download: "describeprint.3mf",
  },
  "model.scad": { type: "text/plain; charset=utf-8", field: "scad" as const, download: "describeprint.scad" },
  "model.print.json": { type: "application/json; charset=utf-8", field: "printPreset" as const, download: "describeprint.print.json" },
};

async function serveProjectPack(id: string): Promise<Response> {
  const job = getJob(id);
  if (!job) {
    return Response.json({ error: "Job expired or not found" }, { status: 404 });
  }
  try {
    const threemf = job.amsSlotPlan?.slots.length
      ? await stampAmsSlotPlan(job.threemf, job.amsSlotPlan)
      : job.threemf;
    const body = await buildProjectPack({
      threemf,
      stl: job.stl,
      printPreset: job.printPreset,
      report: job.report,
      notes: job.notes,
      colorRegions: job.colorRegions,
      fileName: job.fileName,
      amsSlotPlan: job.amsSlotPlan,
    });
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="describeprint-project-pack.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ProjectPackError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await context.params;
  if (file === "model.pack.zip") {
    return serveProjectPack(id);
  }

  const job = getJob(id);
  if (!job) {
    return Response.json({ error: "Job expired or not found" }, { status: 404 });
  }

  if (file === "exploded.stl" || file === "parts.zip" || /^part-.+\.stl$/i.test(file)) {
    const parts = await partsFromThreeMf(job.threemf, { code: job.scad });
    if (file === "exploded.stl") {
      const body = parts.length
        ? explodedStlBuffer(parts, job.assembly)
        : job.stl;
      return new Response(new Uint8Array(body), {
        headers: {
          "Content-Type": "application/sla",
          "Content-Disposition": 'attachment; filename="describeprint-exploded.stl"',
          "Cache-Control": "no-store",
        },
      });
    }
    if (file === "parts.zip") {
      if (parts.length < 2) {
        return Response.json({ error: "This plate is a single part — download the STL instead." }, { status: 400 });
      }
      const body = await partsZipBuffer(parts);
      return new Response(new Uint8Array(body), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="describeprint-parts.zip"',
          "Cache-Control": "no-store",
        },
      });
    }
    const slug = file.replace(/^part-/i, "").replace(/\.stl$/i, "");
    const part = parts.find((item) => item.id === slug);
    if (!part) {
      return Response.json({ error: "Unknown part" }, { status: 404 });
    }
    return new Response(new Uint8Array(partStlBuffer(part)), {
      headers: {
        "Content-Type": "application/sla",
        "Content-Disposition": `attachment; filename="${slug}.stl"`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (file === "ams-plan.json") {
    return new Response(amsSlotPlanSidecarJson(job.amsSlotPlan), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="describeprint.ams-plan.json"',
        "Cache-Control": "no-store",
      },
    });
  }

  const spec = FILES[file as keyof typeof FILES];
  if (!spec) {
    return Response.json({ error: "Unknown file" }, { status: 404 });
  }

  const body =
    spec.field === "scad"
      ? job.scad
      : spec.field === "printPreset"
        ? printPresetSidecarJson(job.printPreset)
        : spec.field === "threemf" && job.amsSlotPlan?.slots.length
          ? new Uint8Array(await stampAmsSlotPlan(job.threemf, job.amsSlotPlan))
          : new Uint8Array(job[spec.field]);
  return new Response(body, {
    headers: {
      "Content-Type": spec.type,
      "Content-Disposition": `attachment; filename="${spec.download}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await context.params;
  if (file !== "ams-plan.json") {
    return Response.json({ error: "Unknown file" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const plan = parseAmsSlotPlan(body);
  if (!plan || !plan.slots.length) {
    return Response.json({ error: "Invalid AMS slot plan" }, { status: 400 });
  }
  const job = updateJobAmsSlotPlan(id, plan);
  if (!job) {
    return Response.json({ error: "Job expired or not found" }, { status: 404 });
  }
  return Response.json(job.amsSlotPlan);
}
