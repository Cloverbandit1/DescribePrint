import { looksLikeImageUpload, parseImageImportOptions } from "@/lib/image-import";
import { runImageImportPipeline, runImportPipeline } from "@/lib/pipeline";
import type { StatusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function readUpload(req: Request): Promise<{
  buffer: Buffer;
  fileName: string;
  options: ReturnType<typeof parseImageImportOptions>;
  filament?: string | null;
}> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("Choose an STL, 3MF, or a PNG/JPG/WebP photo.");
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const filamentRaw = form.get("filament");
    return {
      buffer,
      fileName: file.name || "imported.stl",
      options: parseImageImportOptions({
        repair: form.get("repair"),
        keepWear: form.get("keepWear") ?? form.get("keep_wear"),
        targetMaxMm: form.get("targetMaxMm") ?? form.get("target_max_mm"),
        prompt: form.get("prompt") ?? form.get("note"),
      }),
      filament: typeof filamentRaw === "string" ? filamentRaw : null,
    };
  }

  const body = (await req.json().catch(() => null)) as {
    fileName?: string;
    bytesBase64?: string;
    repair?: unknown;
    keepWear?: unknown;
    keep_wear?: unknown;
    targetMaxMm?: unknown;
    target_max_mm?: unknown;
    prompt?: unknown;
    note?: unknown;
    filament?: unknown;
  } | null;
  if (!body?.bytesBase64) {
    throw new Error("Choose an STL, 3MF, or a PNG/JPG/WebP photo.");
  }
  return {
    buffer: Buffer.from(body.bytesBase64, "base64"),
    fileName: body.fileName || "imported.stl",
    options: parseImageImportOptions(body),
    filament: typeof body.filament === "string" ? body.filament : null,
  };
}

export async function POST(req: Request) {
  let upload: Awaited<ReturnType<typeof readUpload>>;
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
        const image = looksLikeImageUpload(upload.buffer, upload.fileName);
        send("status", {
          step: image ? "image" : "queued",
          message: image ? "Starting photo import…" : "Starting import…",
        } satisfies StatusEvent);
        const result = image
          ? await runImageImportPipeline(upload, sink)
          : await runImportPipeline(upload, sink);
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
