import { runImportPipeline } from "@/lib/pipeline";
import type { StatusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readUpload(req: Request): Promise<{ buffer: Buffer; fileName: string }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Choose an STL or 3MF file to import.");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    return { buffer, fileName: file.name || "imported.stl" };
  }

  const body = (await req.json().catch(() => null)) as { fileName?: string; bytesBase64?: string } | null;
  if (!body?.bytesBase64) {
    throw new Error("Choose an STL or 3MF file to import.");
  }
  return {
    buffer: Buffer.from(body.bytesBase64, "base64"),
    fileName: body.fileName || "imported.stl",
  };
}

export async function POST(req: Request) {
  let upload: { buffer: Buffer; fileName: string };
  try {
    upload = await readUpload(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Import failed";
    return Response.json({ error: message }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseLine(event, data)));
      };
      const sink = (status: StatusEvent) => send("status", status);

      try {
        send("status", { step: "queued", message: "Starting import…" } satisfies StatusEvent);
        const result = await runImportPipeline(upload, sink);
        send("result", result);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Import failed";
        const message = raw.split(/\r?\n/, 1)[0]?.trim() || "Import failed";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
