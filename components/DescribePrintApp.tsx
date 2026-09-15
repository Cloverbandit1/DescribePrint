"use client";

import dynamic from "next/dynamic";
import { useMemo, useRef, useState } from "react";
import { EXAMPLE_PROMPTS } from "@/lib/fixtures";
import { defaultPrinter } from "@/lib/printers";
import { formatMm } from "@/lib/units";
import type { GenerateResult, PipelineStep, StatusEvent, Unit } from "@/lib/types";

const Viewer = dynamic(() => import("./Viewer").then((m) => m.Viewer), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-muted">Loading preview…</div>,
});

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "status"; steps: StatusEvent[]; active: boolean }
  | { id: string; kind: "result"; result: GenerateResult }
  | { id: string; kind: "error"; text: string };

/** Everyday status only — pipeline jargon stays out of the main view. */
const FRIENDLY_STEP: Record<PipelineStep, string> = {
  queued: "Starting…",
  planning: "Reading your description…",
  codegen: "Designing the part…",
  sanitize: "Checking the design…",
  compile: "Building the model…",
  "mesh-check": "Making sure it can print…",
  export: "Preparing files…",
  retry: "Trying again…",
  done: "Ready",
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

export function DescribePrintApp({ localAi = false }: { localAi?: boolean }) {
  const [prompt, setPrompt] = useState("");
  const [sizeHint, setSizeHint] = useState("");
  const [units, setUnits] = useState<Unit>("mm");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const printer = defaultPrinter();

  const sizeNumber = useMemo(() => {
    const n = Number(sizeHint);
    return sizeHint.trim() && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeHint]);

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    });
  };

  async function printPart(text: string) {
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
          lastError = (data as { message?: string }).message ?? "Could not make this part";
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
      setShowDetails(false);
      setItems((prev) => [
        ...prev.map((item) => (item.id === statusId && item.kind === "status" ? { ...item, active: false } : item)),
        { id: nid(), kind: "result", result: generated },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not make this part";
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
            <div className="text-xs text-muted">Describe → options → Print</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {localAi ? (
            <div
              className="flex items-center gap-1.5 rounded-full border border-ok/35 bg-ok/10 px-2 py-0.5 text-xs text-ok"
              role="status"
              aria-label="Local AI is active"
              title="DescribePrint is using local Ollama. Agent Smith models are left untouched."
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
              Local AI
            </div>
          ) : null}
          <div className="hidden text-xs text-muted sm:block">{printer.name}</div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(300px,400px)_1fr]">
        <section className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {items.length === 0 ? (
              <EmptyState
                onPick={(value) => {
                  setPrompt(value);
                }}
              />
            ) : (
              items.map((item) => <ChatBubble key={item.id} item={item} />)
            )}
          </div>

          <form
            className="border-t border-line bg-panel p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void printPart(prompt);
            }}
          >
            <label className="mb-2 block text-sm text-muted">Describe what to print</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void printPart(prompt);
                }
              }}
              rows={3}
              placeholder="A phone stand, or a 20 mm cube with a hole…"
              className="w-full resize-none rounded-xl border border-line bg-panel-2 px-3 py-2 text-sm outline-none ring-accent/40 placeholder:text-muted/70 focus:ring-2"
            />
            <div className="mt-3 flex items-center gap-2">
              <button
                type="submit"
                disabled={busy || !prompt.trim()}
                className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Printing…" : "Print"}
              </button>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs text-muted underline-offset-2 hover:underline"
              >
                {showAdvanced ? "Hide options" : "More options"}
              </button>
            </div>
            {showAdvanced ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel-2 p-3">
                <label className="text-xs text-muted">Size</label>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={sizeHint}
                  onChange={(e) => setSizeHint(e.target.value)}
                  placeholder="optional"
                  className="w-24 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
                />
                <select
                  value={units}
                  onChange={(e) => setUnits(e.target.value as Unit)}
                  className="rounded-lg border border-line bg-panel px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-accent/40"
                >
                  <option value="mm">mm</option>
                  <option value="in">inches</option>
                </select>
              </div>
            ) : null}
          </form>
        </section>

        <section className="relative flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Viewer stlUrl={result ? `${result.stlUrl}?v=${result.jobId}` : null} />
          </div>
          <aside className="border-t border-line bg-panel/95 p-4 backdrop-blur">
            {result ? (
              <ResultBar
                result={result}
                showDetails={showDetails}
                onToggleDetails={() => setShowDetails((v) => !v)}
              />
            ) : (
              <p className="text-sm text-muted">Describe something, pick an option if you like, then Print.</p>
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
    const label = latest ? FRIENDLY_STEP[latest.step] : "Starting…";
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        {item.active ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        <span>{item.active ? label : "Ready"}</span>
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
      <div className="font-medium">Ready to print</div>
      <div className="mt-1 text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
      </div>
    </div>
  );
}

function ResultBar({
  result,
  showDetails,
  onToggleDetails,
}: {
  result: GenerateResult;
  showDetails: boolean;
  onToggleDetails: () => void;
}) {
  const { report } = result;
  const issues = report.issues;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={result.stlUrl}
          className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-black"
        >
          Download STL
        </a>
        <a
          href={result.threemfUrl}
          className="rounded-xl border border-line px-4 py-2 text-sm"
        >
          Download 3MF
        </a>
        <button type="button" onClick={onToggleDetails} className="ml-auto text-xs text-muted underline-offset-2 hover:underline">
          {showDetails ? "Hide details" : "Details"}
        </button>
      </div>
      <p className="text-sm text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
        {issues.length === 0 ? " · looks good" : ""}
      </p>
      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.severity}`} className={issue.severity === "error" ? "text-danger" : "text-warn"}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {showDetails ? (
        <div className="space-y-2 rounded-xl border border-line bg-panel-2 p-3">
          <p className="text-xs text-muted">
            Volume {formatMm(report.volumeMm3, 1)} mm³ · {report.triangleCount.toLocaleString()} triangles ·{" "}
            {report.watertight ? "watertight" : "check mesh"}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={result.scadUrl} className="text-xs text-muted underline-offset-2 hover:underline">
              OpenSCAD source
            </a>
          </div>
          <pre className="scrollbar-thin max-h-40 overflow-auto font-mono text-[11px] leading-relaxed text-muted">
            {result.code}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted">
        Type what you want, or pick one of these, then Print.
      </p>
      <div className="space-y-2">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="block w-full rounded-xl border border-line bg-panel-2 px-3 py-2.5 text-left text-sm hover:border-accent/50"
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
