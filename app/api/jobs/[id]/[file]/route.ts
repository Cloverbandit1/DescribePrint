import { getJob } from "@/lib/jobs";
import { printPresetSidecarJson } from "@/lib/printers";

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

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await context.params;
  const spec = FILES[file as keyof typeof FILES];
  if (!spec) {
    return Response.json({ error: "Unknown file" }, { status: 404 });
  }

  const job = getJob(id);
  if (!job) {
    return Response.json({ error: "Job expired or not found" }, { status: 404 });
  }

  const body =
    spec.field === "scad"
      ? job.scad
      : spec.field === "printPreset"
        ? printPresetSidecarJson(job.printPreset)
        : new Uint8Array(job[spec.field]);
  return new Response(body, {
    headers: {
      "Content-Type": spec.type,
      "Content-Disposition": `attachment; filename="${spec.download}"`,
      "Cache-Control": "no-store",
    },
  });
}
