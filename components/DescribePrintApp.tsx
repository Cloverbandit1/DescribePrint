"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { EXAMPLE_PROMPTS } from "@/lib/fixtures";
import { defaultPrinter } from "@/lib/printers";
import { formatMm } from "@/lib/units";
import type { GenerateResult, PipelineStep, StatusEvent, Unit } from "@/lib/types";
import type { CameraView, ViewerTheme } from "./Viewer";

const Viewer = dynamic(() => import("./Viewer").then((m) => m.Viewer), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-canvas text-sm text-muted">Loading plate…</div>
  ),
});

type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "status"; steps: StatusEvent[]; active: boolean }
  | { id: string; kind: "result"; result: GenerateResult }
  | { id: string; kind: "error"; text: string };

type WorkspaceTab = "prepare" | "preview";

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

const FOLLOW_UPS = ["Make the hole 8 mm", "Make it larger", "Start a new part"] as const;

const THEME_KEY = "describeprint-theme";

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
  const [designPrompt, setDesignPrompt] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceTab>("prepare");
  const [cameraView, setCameraView] = useState<CameraView>("iso");
  const [theme, setTheme] = useState<ViewerTheme>("dark");
  const [wideLayout, setWideLayout] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const printer = defaultPrinter();

  const sizeNumber = useMemo(() => {
    const n = Number(sizeHint);
    return sizeHint.trim() && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeHint]);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWideLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const scrollToEnd = () => {
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    });
  };

  function resetConversation() {
    setItems([]);
    setResult(null);
    setDesignPrompt(null);
    setPrompt("");
    setShowDetails(false);
    setWorkspace("prepare");
  }

  async function printPart(text: string) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;

    const startFresh = /\b(new part|start over|something else|different part|forget that|scratch)\b/i.test(cleaned);
    const previousPrompt = startFresh ? null : designPrompt;
    const previousCode = startFresh ? null : result?.code;

    setBusy(true);
    setPrompt("");
    const statusId = nid();
    setItems((prev) => [
      ...prev,
      { id: nid(), kind: "user", text: cleaned },
      { id: statusId, kind: "status", steps: [], active: true },
    ]);
    scrollToEnd();
    setWorkspace("prepare");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleaned,
          sizeHint: sizeNumber,
          units,
          previousPrompt,
          previousCode,
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
      setDesignPrompt(startFresh || !previousPrompt ? cleaned : `${previousPrompt}. ${cleaned}`);
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

  const canPrint = Boolean(prompt.trim()) && !busy;
  const plateW = printer.buildVolumeMm[0];
  const plateD = printer.buildVolumeMm[1];
  const plateH = printer.buildVolumeMm[2];
  const actionLabel = busy ? "Updating…" : result ? "Update" : "Print";

  const composer = (
    <ChatComposer
      prompt={prompt}
      onPromptChange={setPrompt}
      onSubmit={() => void printPart(prompt)}
      busy={busy}
      canSubmit={canPrint}
      actionLabel={actionLabel}
      placeholder={
        result
          ? "Keep talking — change it, add or remove a feature, or start a new part…"
          : "A phone stand, or a 20 mm cube with a hole…"
      }
      showAdvanced={showAdvanced}
      onToggleAdvanced={() => setShowAdvanced((v) => !v)}
      sizeHint={sizeHint}
      onSizeHintChange={setSizeHint}
      units={units}
      onUnitsChange={setUnits}
      followUps={result && !busy ? FOLLOW_UPS : null}
      onFollowUp={(value) => {
        if (value.toLowerCase().includes("new part")) {
          setPrompt("");
          setDesignPrompt(null);
          setResult(null);
          return;
        }
        setPrompt(value);
      }}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">
      <header className="z-20 flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StudioMark />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-none">DescribePrint</div>
            <div className="mt-0.5 hidden truncate text-[10px] text-muted sm:block">Describe → talk → Print</div>
          </div>
        </div>

        <nav className="ml-2 flex items-center self-stretch" aria-label="Workspace">
          <WorkspaceTabButton
            label="Prepare"
            active={workspace === "prepare"}
            onClick={() => setWorkspace("prepare")}
          />
          <WorkspaceTabButton
            label="Preview"
            active={workspace === "preview"}
            onClick={() => setWorkspace("preview")}
          />
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {busy ? (
            <span className="hidden items-center gap-1.5 text-[11px] text-muted sm:flex">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" />
              Listening…
            </span>
          ) : null}
          <div className="hidden items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="font-medium">{printer.name}</span>
          </div>
          <button
            type="button"
            className="studio-btn studio-btn-ghost inline-flex h-7 w-7"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(200px,1fr)_auto] lg:grid-cols-[minmax(340px,400px)_minmax(0,1fr)_260px] lg:grid-rows-1">
        <section
          className={`min-h-0 flex-col border-line bg-panel lg:border-r ${
            workspace === "preview" && !wideLayout
              ? "hidden"
              : `flex ${workspace === "prepare" ? "order-2 max-h-[58vh] border-t lg:order-none lg:max-h-none lg:border-t-0" : ""}`
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div>
              <div className="studio-label">Chat</div>
              <div className="text-[11px] text-muted">Describe, then keep talking</div>
            </div>
            {items.length > 0 ? (
              <button
                type="button"
                onClick={resetConversation}
                className="text-[11px] text-muted underline-offset-2 hover:underline"
              >
                Clear chat
              </button>
            ) : null}
          </div>

          <div ref={scroller} className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {items.length === 0 ? (
              <EmptyState
                onPick={(value) => {
                  setPrompt(value);
                  setWorkspace("prepare");
                }}
              />
            ) : (
              items.map((item) => <ChatBubble key={item.id} item={item} />)
            )}
          </div>

          <div className="border-t border-line bg-panel">{composer}</div>
        </section>

        <section className="relative order-1 flex min-h-0 flex-col bg-canvas lg:order-none">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-2.5">
            <div className="pointer-events-auto flex overflow-hidden rounded-md border border-line bg-panel/90 shadow-sm backdrop-blur">
              {(
                [
                  ["iso", "Iso"],
                  ["top", "Top"],
                  ["front", "Front"],
                  ["left", "Left"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCameraView(id)}
                  className={`h-7 px-2.5 text-[11px] font-medium ${
                    cameraView === id ? "bg-accent text-accent-ink" : "text-muted hover:bg-panel-2 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="rounded-md border border-line bg-panel/90 px-2 py-1 text-[10px] text-muted backdrop-blur">
              Plate 1 · {plateW} × {plateD} mm
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Viewer
              stlUrl={result ? `${result.stlUrl}?v=${result.jobId}` : null}
              view={cameraView}
              plateMm={plateW}
              heightMm={plateH}
              theme={theme}
              showGizmo={wideLayout}
            />
          </div>
        </section>

        <aside
          className={`min-h-0 flex-col border-line bg-panel ${
            workspace === "prepare" ? "hidden lg:flex lg:border-l" : "flex border-t lg:border-l lg:border-t-0"
          } ${workspace === "preview" ? "order-2 lg:order-none" : ""}`}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <div className="studio-label">Print</div>
            <div className="text-[10px] text-muted">{printer.name}</div>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            <div className="rounded-md border border-line bg-panel-2 p-2.5 text-[11px] leading-relaxed text-muted">
              <div className="text-sm font-medium text-ink">{printer.name}</div>
              <div className="mt-1">
                {plateW} × {plateD} × {plateH} mm · {printer.nozzleMm} mm nozzle
              </div>
            </div>

            <button
              type="button"
              disabled={!canPrint}
              onClick={() => void printPart(prompt)}
              className="studio-btn studio-btn-primary inline-flex h-10 w-full text-sm"
            >
              {actionLabel}
            </button>
            <p className="text-[11px] leading-relaxed text-muted">
              The chat is the editor. Keep describing changes; Print puts the latest part on the plate.
            </p>

            {result ? (
              <ResultPanel result={result} showDetails={showDetails} onToggleDetails={() => setShowDetails((v) => !v)} />
            ) : (
              <p className="rounded-md border border-dashed border-line px-2.5 py-2 text-[11px] text-muted">
                Nothing on the plate yet — tell the chat what to make.
              </p>
            )}
          </div>

          {workspace === "preview" && !wideLayout ? (
            <div className="border-t border-line bg-panel">{composer}</div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function ChatComposer({
  prompt,
  onPromptChange,
  onSubmit,
  busy,
  canSubmit,
  actionLabel,
  placeholder,
  showAdvanced,
  onToggleAdvanced,
  sizeHint,
  onSizeHintChange,
  units,
  onUnitsChange,
  followUps,
  onFollowUp,
}: {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  canSubmit: boolean;
  actionLabel: string;
  placeholder: string;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  sizeHint: string;
  onSizeHintChange: (value: string) => void;
  units: Unit;
  onUnitsChange: (value: Unit) => void;
  followUps: readonly string[] | null;
  onFollowUp: (value: string) => void;
}) {
  return (
    <form
      className="p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {followUps ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {followUps.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => onFollowUp(chip)}
              className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-ink"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
      <label className="studio-label mb-1.5 block" htmlFor="describe-input">
        Message
      </label>
      <textarea
        id="describe-input"
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder={placeholder}
        className="studio-field resize-none px-2.5 py-2 text-sm"
      />
      <div className="mt-2 flex items-center gap-2">
        <button type="submit" disabled={!canSubmit} className="studio-btn studio-btn-primary inline-flex h-8 px-3.5">
          {busy ? "Working…" : actionLabel}
        </button>
        <button
          type="button"
          onClick={onToggleAdvanced}
          className="text-[11px] text-muted underline-offset-2 hover:underline"
        >
          {showAdvanced ? "Hide options" : "More options"}
        </button>
      </div>
      {showAdvanced ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 p-2.5">
          <label className="text-[11px] text-muted" htmlFor="size-hint">
            Size
          </label>
          <input
            id="size-hint"
            type="number"
            min={0}
            step="any"
            value={sizeHint}
            onChange={(e) => onSizeHintChange(e.target.value)}
            placeholder="optional"
            className="studio-field w-20 px-2 py-1.5 text-sm"
          />
          <select
            value={units}
            onChange={(e) => onUnitsChange(e.target.value as Unit)}
            className="studio-field w-auto px-2 py-1.5 text-sm"
            aria-label="Units"
          >
            <option value="mm">mm</option>
            <option value="in">inches</option>
          </select>
        </div>
      ) : null}
    </form>
  );
}

function WorkspaceTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative h-full px-3 text-[13px] font-medium ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {label}
      {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" /> : null}
    </button>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return (
      <div className="ml-8 rounded-md bg-panel-2 px-2.5 py-2 text-sm leading-relaxed">{item.text}</div>
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
      <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-sm text-danger">{item.text}</div>
    );
  }
  const { report } = item.result;
  return (
    <div className="mr-4 rounded-md border border-ok/35 bg-ok/5 px-2.5 py-2 text-sm">
      <div className="font-medium">On the plate — keep talking to change it</div>
      <div className="mt-1 text-muted">
        {formatMm(report.boundingBoxMm.size[0])} × {formatMm(report.boundingBoxMm.size[1])} ×{" "}
        {formatMm(report.boundingBoxMm.size[2])} mm
      </div>
    </div>
  );
}

function ResultPanel({
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
    <div className="space-y-3 border-t border-line pt-3">
      <div className="studio-label">Exports</div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={result.stlUrl} className="studio-btn studio-btn-ghost inline-flex h-8 px-3">
          Download STL
        </a>
        <a href={result.threemfUrl} className="studio-btn studio-btn-ghost inline-flex h-8 px-3">
          Download 3MF
        </a>
        <button type="button" onClick={onToggleDetails} className="ml-auto text-[11px] text-muted underline-offset-2 hover:underline">
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
        <div className="space-y-2 rounded-md border border-line bg-panel-2 p-2.5">
          <p className="text-[11px] text-muted">
            Volume {formatMm(report.volumeMm3, 1)} mm³ · {report.triangleCount.toLocaleString()} triangles ·{" "}
            {report.watertight ? "watertight" : "check mesh"}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={result.scadUrl} className="text-[11px] text-muted underline-offset-2 hover:underline">
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
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-muted">
        Talk to the workspace. Describe a part, then keep chatting to add, remove, or change it. The plate updates when
        you Print.
      </p>
      <div className="studio-label">Try saying</div>
      <div className="space-y-1.5">
        {EXAMPLE_PROMPTS.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="block w-full rounded-md border border-line bg-panel-2 px-2.5 py-2 text-left text-sm hover:border-accent/50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

function StudioMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.2" width="17.6" height="17.6" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M4.5 16.2 H17.5 V14.4 H4.5 Z" fill="var(--accent)" />
      <path d="M8 14.2 L11 6.8 L14 14.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 1.4v1.3M7 11.3v1.3M1.4 7h1.3M11.3 7h1.3M2.9 2.9l.9.9M10.2 10.2l.9.9M11.1 2.9l-.9.9M3.8 10.2l-.9.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M8.4 2.1A4.8 4.8 0 1 0 11.9 8 3.7 3.7 0 0 1 8.4 2.1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
