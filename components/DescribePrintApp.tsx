"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { EXAMPLE_PROMPTS } from "@/lib/fixtures";
import { formatMm } from "@/lib/units";
import type { GenerateResult, PipelineStep, StatusEvent, Unit } from "@/lib/types";

const Viewer = dynamic(() => import("./Viewer").then((m) => m.Viewer), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-muted">Loading viewer…</div>,
});

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "status"; steps: StatusEvent[]; active: boolean }
  | { id: string; kind: "result"; result: GenerateResult }
  | { id: string; kind: "error"; text: string };

const STEP_LABEL: Record<PipelineStep, string> = {
  queued: "Queued",
  planning: "Planning",
  codegen: "Writing CAD",
  sanitize: "Sanitizing",
  compile: "Compiling STL",
  "mesh-check": "Mesh checks",
  export: "Exporting",
  retry: "Retrying",
  done: "Done",
};

let counter = 0;
const nid = () => `m-${Date.now()}-${counter++}`;

async function consumeSse(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
) {
  if (!response.body) {
    throw new Error("No response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const event = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const dataLine = chunk.match(/^data:\s*(.+)$/m)?.[1];
      if (event && dataLine) {
        onEvent(event, JSON.parse(dataLine));
      }
    }
  }
}

export function DescribePrintApp() {
  const [prompt, setPrompt] = useState("");
  const [sizeHint, setSizeHint] = useState("");
  const [units, setUnits] = useState<Unit>("mm");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [showCode, setShowCode] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const sizeNumber = useMemo(() => {
    const n = Number(sizeHint);
    return sizeHint.trim() && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeHint]);

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    });
  };

  async function generate(text: string) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;

    setBusy(true);
    setPrompt("");
    const statusId = nid();
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: cleaned },
      { id: statusId, kind: "status", steps: [], active: true },
    ]);
    scrollToEnd();

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleaned,
          sizeHint: sizeNumber,
          units,
          fixture: process.env.NODE_ENV === "test" ? true : undefined,
        }),
      });

      if (!response.ok && !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      let latest: GenerateResult | null = null;
      let lastError: string | null = null;

      await consumeSse(response, (event, data) => {
        if (event === "status") {
          const status = data as StatusEvent;
          setItems((prev) =>
            prev.map((item) =>
              item.id === statusId && item.kind === "status"
                ? { ...item, steps: [...item.steps, status] }
                : item,
            ),
          );
          scrollToEnd();
        }
        if (event === "result") {
          latest = data as GenerateResult;
        }
        if (event === "error") {
          lastError = (data as { message?: string }).message ?? "Generation failed";
        }
      });

      if (lastError) {
        throw new Error(lastError);
      }
      if (!latest) {
        throw new Error("No model was returned");
      }
      const generated: GenerateResult = latest;

      setResult(generated);
      setShowCode(false);
      setItems((prev) => [
        ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
        { id: nid(), kind: "result", result: generated },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed";
      setItems((prev) => [
        ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
        { id: nid(), kind: "error", text: message },
      ]);
    } finally {
      setBusy(false);
      scrollToEnd();
    }
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="grain" />
      <header className="z-10 flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <div className="text-sm font-medium tracking-wide">DescribePrint</div>
            <div className="text-xs text-muted">Describe anything → printable mesh</div>
          </div>
        </div>
        <div className="hidden text-xs text-muted sm:block">V0 · OpenSCAD · millimeters</div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <section className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {items.length === 0 ? (
              <EmptyState onPick={(value) => setPrompt(value)} />
            ) : (
              items.map((item) => <ChatBubble key={item.id} item={item} />)
            )}
          </div>

          <form
            className="border-t border-line bg-panel p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void generate(prompt);
            }}
          >
            <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-muted">
              Describe what to print…
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void generate(prompt);
                }
              }}
              rows={3}
              placeholder="20mm cube with 5mm hole"
              className="w-full resize-none rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm outline-none ring-accent/40 placeholder:text-muted/70 focus:ring-2"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={0}
                step="any"
                value={sizeHint}
                onChange={(e) => setSizeHint(e.target.value)}
                placeholder="Size hint"
                className="w-24 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
              />
              <select
                value={units}
                onChange={(e) => setUnits(e.target.value as Unit)}
                className="rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
              >
                <option value="mm">mm</option>
                <option value="in">inches</option>
              </select>
              <button
                type="submit"
                disabled={busy || !prompt.trim()}
                className="ml-auto rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Generating…" : "Generate"}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Optional size is converted to mm. Shift+Enter for a newline.
            </p>
          </form>
        </section>

        <section className="relative flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Viewer stlUrl={result ? `${result.stlUrl}?v=${result.jobId}` : null} />
          </div>
          <aside className="border-t border-line bg-panel/95 p-4 backdrop-blur">
            {result ? (
              <ResultBar result={result} showCode={showCode} onToggleCode={() => setShowCode((v) => !v)} />
            ) : (
              <p className="text-sm text-muted">
                Generate a part to see bounding box, volume, and downloads.
              </p>
            )}
          </aside>
        </section>
      </div>
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ml-8 rounded-2xl bg-panel-2 px-3 py-2 text-sm leading-relaxed">{item.text}</div>
    );
  }
  if (item.kind === "status") {
    const latest = item.steps[item.steps.length - 1];
    return (
      <div className="rounded-2xl border border-line bg-panel px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted">
          {item.active ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : null}
          {item.active ? "Working" : "Finished"}
        </div>
        <ol className="space-y-1.5">
          {item.steps.map((step, i) => (
            <li key={`${step.step}-${i}`} className="flex gap-2 text-sm">
              <span className="font-mono text-xs text-accent-2">{STEP_LABEL[step.step]}</span>
              <span className="text-muted">{step.message}</span>
            </li>
          ))}
          {item.active && latest ? null : null}
        </ol>
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        {item.text}
      </div>
    );
  }
  const { report } = item.result;
  return (
    <div className="rounded-2xl border border-ok/30 bg-ok/5 px-3 py-2 text-sm">
      <div className="font-medium">Printable mesh ready</div>
      <div className="mt-1 text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
        {item.result.usedFixture ? " · fixture path" : " · LLM path"}
        {item.result.retried ? " · retried" : ""}
      </div>
    </div>
  );
}

function ResultBar({
  result,
  showCode,
  onToggleCode,
}: {
  result: GenerateResult;
  showCode: boolean;
  onToggleCode: () => void;
}) {
  const { report } = result;
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={result.stlUrl}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-black"
        >
          Download STL
        </a>
        <a
          href={result.threemfUrl}
          className="rounded-lg border border-line px-3 py-1.5 text-sm"
        >
          Download 3MF
        </a>
        <a href={result.scadUrl} className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted">
          OpenSCAD
        </a>
        <button type="button" onClick={onToggleCode} className="ml-auto text-xs text-muted underline-offset-2 hover:underline">
          {showCode ? "Hide code" : "Show generated code"}
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <Stat label="Bounding box" value={`${formatMm(report.boundingBoxMm.size[0])} × ${formatMm(report.boundingBoxMm.size[1])} × ${formatMm(report.boundingBoxMm.size[2])} mm`} />
        <Stat label="Volume" value={`${formatMm(report.volumeMm3, 1)} mm³`} />
        <Stat label="Triangles" value={report.triangleCount.toLocaleString()} />
        <Stat label="Manifold" value={report.watertight ? "Yes" : "Check flags"} />
      </dl>
      {errors.length + warnings.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {errors.map((issue) => (
            <li key={issue.code} className="text-danger">
              {issue.message}
            </li>
          ))}
          {warnings.map((issue) => (
            <li key={`${issue.code}-w`} className="text-warn">
              {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ok">No obvious printability issues.</p>
      )}
      {showCode ? (
        <pre className="scrollbar-thin max-h-48 overflow-auto rounded-xl bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted">
          {result.code}
        </pre>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted">
        Describe a parametric or mechanical part. V0 compiles <span className="text-ink">OpenSCAD</span> to a
        watertight-ish mesh, checks it, and lets you download STL and 3MF.
      </p>
      <div className="space-y-2">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="block w-full rounded-xl border border-line bg-panel-2 px-3 py-2 text-left text-sm hover:border-accent/50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="22" height="22" rx="4" stroke="#f0a33a" strokeWidth="1.6" />
      <circle cx="14" cy="14" r="4.5" stroke="#6ec8d4" strokeWidth="1.6" />
      <path d="M8 20.5 L20 7.5" stroke="#f3efe6" strokeWidth="1.2" opacity="0.55" />
    </svg>
  );
}
