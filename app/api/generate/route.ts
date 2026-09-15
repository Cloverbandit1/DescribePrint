import { runGeneratePipeline } from "@/lib/pipeline";
import type { GenerateRequest, StatusEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseLine(event, data)));
      };
      const sink = (status: StatusEvent) => send("status", status);

      try {
        send("status", { step: "queued", message: "Starting generation…" } satisfies StatusEvent);
        const result = await runGeneratePipeline(body, sink);
        send("result", result);
      } catch (err) {
        const raw = err instanceof Error ? err.message : "Generation failed";
        const message = raw.split(/\r?\n/, 1)[0]?.trim() || "Generation failed";
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
