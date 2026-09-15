# DescribePrint

Describe anything in plain language and get a **printable 3D model** (STL + 3MF), with a real preview.

V0 is the **create** path for parametric / mechanical parts: a Bambu Studio–inspired workspace (prepare / plate / print), an OpenSCAD generation pipeline, mesh checks, and downloads. **Local AI (Ollama)** generates the CAD by default so the loop stays self-contained and works offline. A fixture/mock path remains for tests and demos.

## Product principles

DescribePrint is **fully end-to-end in the web app**. Users must **never** need Blender, Meshmixer, or any other DCC after generation.

- The complete path is: describe → preview in the UI → download **STL** and **3MF** (and, later, slice/print from the same UI).
- Those files are for printing, not for cleanup in Blender or another DCC.
- Future Style2Fab-like edit, organic mesh, and other mesh work stay **in-app**. They are not a Blender plugin or an external DCC dependency.
- **Long-term, a separate slicer app is not required** for the core path. Users pick a printer and print settings in DescribePrint.
- **Very simple to use and print.** The everyday path is **describe → clear options → Print**. Smart defaults (mm, Bambu Lab P2S, optional saved profile). Advanced controls stay hidden.
- **Bambu-inspired layout, original chrome.** The desktop workspace follows Bambu Studio / Bambu Lab slicer structure: a large **3D plate preview** in the center, **Print / options** on the right, and Prepare → Preview tabs. Dark and light themes use a compact studio palette (green actions, muted panels). The app does **not** use Bambu trademarks, logos, or proprietary assets — only a familiar workspace feel.
- **Chat stays first-class.** The left Prepare column is a live describe/chat thread, not a dead slicer object list. Users keep talking to add, remove, or change the part; follow-ups send the previous description and OpenSCAD so the plate can update. Mobile still keeps a composer on Preview so conversation is not trapped behind the plate.
- **Power + program, local-first.** Build what we need. Local AI handles generation. No cloud key is required.

V0 already follows the mesh path: the viewer plus STL/3MF download is the complete user path today. Full Bambu / Orca integration is **not** a V0 blocker.

## Milestones

Owner timeline for DescribePrint as a personal tool. **M0 is done.** M1 is the current slice (this repo): a packaged / self-contained first useful release — power + program only, as far as practical.

| Milestone | Status | Target | What it means |
| --- | --- | --- | --- |
| **M0** | **Done** | — | Describe → local AI (`qwen2.5-coder:32b` on default Ollama) → OpenSCAD → STL/3MF in the studio UI. |
| **M1** | **In progress** | early Oct 2026 | First useful release: one-click-ish Windows start from AllosWorkstation, launch health check (Ollama + MODEL + OpenSCAD), portable OpenSCAD path, Windows zip/setup pack (`npm run pack:windows`), everyday describe → options → Print (P2S default). |
| **M2** | Planned | Nov–Dec 2026 | Daily driver: tighter loop, fewer setup steps, reliable personal use. |
| **M3** | Planned | Q1 2027 | Machine control + live monitor (P2S / AMS in-app). |
| **M4** | Planned | mid 2027 | Advanced vision / articulation. |
| **Full vision** | Later | 12–24+ months | In-app slice/print, Print doctor, image import, pluggable machines, and the rest of the [Roadmap](#roadmap). |

M1 does **not** change the Ollama port, retarget Agent Smith models, or drop the smart pipeline / 32b defaults.

## Local AI (Ollama)

DescribePrint defaults to a **local** OpenAI-compatible API:

| Setting | Default |
| --- | --- |
| `OPENAI_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `OPENAI_API_KEY` | `ollama` (Ollama accepts any non-empty key) |
| `MODEL` | `qwen2.5-coder:32b` (smartest default; higher RAM). Lighter overrides: `qwen2.5-coder:14b`, `qwen2.5-coder:7b` |
| `SMART_PIPELINE` | `1` (default on): plan JSON then OpenSCAD. Set `0` for a single codegen pass |
| `PLAN_MODEL` | optional; defaults to the same `MODEL` |

On launch the header **Local AI / tools** chip probes Ollama, the configured `MODEL`, and OpenSCAD. Click it for status and fix tips (start Ollama, `ollama pull`, install or set `OPENSCAD_PATH`). The chip stays green when the local path is ready.

### Sharing Ollama with Agent Smith

Ollama on this machine may already be used by **Agent Smith**. DescribePrint **shares that server safely** and must not interfere:

- Use the **default** Ollama endpoint only (`127.0.0.1:11434`). Do not change Ollama’s port, host, or global server config for this app.
- Isolation is a **dedicated model name**. Default `MODEL` is `qwen2.5-coder:32b` — never `smith-minicpm5`, `openbmb/minicpm5-*`, or any other Agent Smith model.
- **Leave Smith models untouched.** Do not delete, replace, or retarget existing models.
- The 32b default needs a capable machine (roughly **32GB RAM**). If generation is slow or Ollama is swapping, override `MODEL` to `qwen2.5-coder:14b` or `qwen2.5-coder:7b`.
- Pull DescribePrint’s model *alongside* whatever is already installed:

```bash
ollama pull qwen2.5-coder:32b
# lighter machines:
# ollama pull qwen2.5-coder:14b
# ollama pull qwen2.5-coder:7b
```

If Ollama is not running, generation fails with a simple **Start local AI (Ollama)** message (not a stack trace).

### Optional cloud override

To use OpenAI or another hosted compatible API instead of local Ollama:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
MODEL=gpt-4o-mini
```

### Fixture / mock path

The built-in fixture/heuristic path is still available (`USE_FIXTURE=true`, or `fixture: true` on the generate request). Example prompts still have matching OpenSCAD fixtures for tests and offline demos without a model.

## Printer profiles

Default printer target: **Bambu Lab P2S** + one AMS (4 slots).

| | Today | Later (in-app) |
| --- | --- | --- |
| Printer | P2S: 256 × 256 × 256 mm, **0.4 mm** nozzle (0.2 / 0.6 / 0.8), 1.75 mm filament, 300 °C / 110 °C limits, PLA/PETG/PA/ABS/TPU auto-best tables | User can change printer and print settings in the web UI |
| Output | STL + 3MF download (works disconnected) | Same, plus LAN connect / send — no separate slicer required |

Profile data lives in [`lib/printers.ts`](lib/printers.ts). V0 does not ship Bambu Studio or Orca.

## Machine control

In-app P2S + AMS control. Architecture: [`docs/machine-control.md`](docs/machine-control.md). Not send-to-printer, not a live farm, not Bambu Cloud. The Machine panel has a stub farm registry (default one P2S; add/select extra stubs) plus a local queue worker stub (enqueue / tick `queued → active → done`). Simulation only — not send-across-farm. **Pack plate (stub)** shelves the current mesh AABB (or N copies) on the 256×256 mm P2S bed — layout only, no send. The Print column also shows a compact **estimate (stub)** (time · grams · $) from mesh/AABB volume and the selected material.

- **LAN MQTT (off by default):** in the Machine panel, turn **LAN MQTT** on and enter printer IP, serial, and the 8-digit LAN access code. Saved in the browser only. On the P2S enable **LAN Only** and **Developer Mode**. The adapter uses TLS MQTT on port 8883 (`bblp` + access code). Headless/dev can still set `BAMBU_LAN_MQTT=1` plus `BAMBU_HOST` / `BAMBU_SERIAL` / `BAMBU_ACCESS_CODE` in `.env.local` (overrides the panel). Never commit those values. Never log the access code.
- **Machine panel** (Print column): pick a material (**PLA / PETG / PA / ABS / TPU**, default PLA) to apply compact auto-best defaults (nozzle/bed, speed tier, cooling hint). Compact **AMS plan** shows slot → material/color (live trays when connected, otherwise the selected preset). Reassign trays in the panel; the plan is written into 3MF metadata and the project-pack sidecar. LAN off stays disconnected / mock. Toggle + complete creds streams live connection, temps, layer/progress, and AMS slots (polls `/api/machine`). Connected printers keep the tiny pause / resume / speed / temp controls. CAD export still works with no printer. Material presets and the AMS plan are advisory + export metadata — they are **not** pushed over LAN/MQTT.
- **Print doctor:** type a defect or machine complaint in the existing chat (`stringing with PETG`, `AMS 2 keeps looping feed/unfeed`, `can't load`, `spool empty`, `tangled spool`, `wet nylon`, `PTFE jam`), ask for a material table (`use PETG settings`, `best for PA`), or reassign a tray (`use AMS 2 for accent`). A keyword stub returns a diagnosis plus proposed settings or **numbered AMS physical steps** (slot-aware) and can switch the selected material or update the AMS slot plan. After a reply, say **perfect** / **still bad** (or tap the tiny chips) to remember or reject that fix — AMS guides key off their guide id. A camera-defect announcement also offers mid-print chips (pause; spaghetti can slow / cool the nozzle) — send only when LAN is already connected. **Failed photo (stub):** upload a photo or paste a short caption (`spaghetti blob`); filename / hint maps to those same doctor guides. No vision ML. CAD repair is a suggestion only. Except the flagged remaining-layer reshape stub (which invokes CAD Core’s existing reshape-upper consumer), it does not call the CAD pipeline and does not send surprise LAN commands.
- **Mock adapter:** default and CI path — in-memory connection state, AMS mapping, pause-before-risky temp changes, remaining-layer reshape **stub** (flag off by default: pause → CAD-handoff → `runCadReshapeUpper` → `cadFeedForReslice` onto the reslice stub with `sendGcode: false`, never auto-resume). CAD Core (`lib/cad-reshape.ts`) owns the unprinted upper; Print Control only invokes that consumer, attaches job/STL/3MF, and shows the existing plate/preview result. An unhealthy LAN host fails safe (not connected, no crash, access code never logged).

## Why OpenSCAD (not build123d)

V0 compiles **OpenSCAD**, not build123d / OpenCascade.

- OpenSCAD is a small CLI that exports STL reliably on Linux/macOS/Windows.
- build123d + OpenCascade is a much heavier native stack (harder to install, slower to sandbox).
- OpenSCAD has no network and a tiny filesystem surface; we still block `import` / `include` / `use` / `surface`.

Units are **millimeters**. OpenSCAD is unitless; DescribePrint treats `1` unit as `1 mm` and converts optional inch size hints (`× 25.4`).

### OpenSCAD on Windows (portable / bundled plan)

M1 does **not** ship the OpenSCAD binary (size + separate license). Resolution order:

1. `OPENSCAD_PATH` — file, or a folder that contains `openscad.exe`
2. `OPENSCAD_BIN` — legacy explicit executable
3. Portable drop-in: `vendor/openscad/openscad.exe` (also `tools/openscad`, `bundled/openscad`, `.local/openscad`)
4. Common Windows installs: `Program Files\OpenSCAD`, Nightly, `LOCALAPPDATA\Programs\OpenSCAD`, scoop, Chocolatey
5. `PATH`

The Windows setup pack can download the official OpenSCAD zip into `vendor/openscad/` at pack or install time (`npm run openscad:portable`). Until then, install from [openscad.org](https://openscad.org/) or set `OPENSCAD_PATH`.

## Quick start

### Windows (AllosWorkstation)

Near one-click from the repo folder:

1. Install [Node.js LTS](https://nodejs.org) if needed.
2. Double-click `Start-DescribePrint.cmd` (or run `npm run start:windows`). Desktop shortcuts should `call Start-DescribePrint.cmd` — that entry stays stable.
3. The script copies `.env.local` if missing, runs `npm install` on first launch, runs a **preflight health check** (Ollama reachable + configured `MODEL` + OpenSCAD via `resolveOpenscad`), prints the **LAN URL + QR** (Tailscale `100.x` URL is preferred for the QR when Tailscale is up), then opens [http://localhost:3000](http://localhost:3000).

Missing Node/npm is a hard stop. Missing OpenSCAD or `MODEL` (or Ollama not running) is a **warning** — Start still launches the app so one-click is preserved; generate/compile will fail until those are fixed. Tips may say `ollama pull <MODEL>` only. Do not change the Ollama port. Leave Agent Smith models untouched.

### iPhone on the same Wi‑Fi (LAN, no App Store)

The phone is the same DescribePrint app (PWA / Add to Home Screen). It talks to Next.js on the PC. **Ollama stays on the host at `127.0.0.1:11434`** — the phone never calls Ollama directly, and Start does not expose Ollama to LAN.

1. On Smith or the laptop, run `Start-DescribePrint.cmd` (or `npm run start:windows` / `npm run dev`). The Next.js / `next start` server binds **`0.0.0.0:3000`** so it is reachable on the private LAN. This is **not** meant for the public internet — do not port-forward 3000, and do not change the Ollama port.
2. On the iPhone, join the **same Wi‑Fi**. Open `http://<host-lan-ip>:3000` (Start prints the URL and a terminal QR). `npm run lan:url` reprints it.
3. **Windows Firewall:** allow **Node.js** on **Private** networks the first time Windows asks, or add an inbound allow for TCP 3000 on the Private profile. Block Public. Do not open the app to the internet.
4. In iOS Safari: **Share → Add to Home Screen**. The web app manifest uses `display: standalone` plus an Apple touch icon. The service worker caches the app shell offline; **describe / generate / import / Print doctor still need the PC** on LAN (or Tailscale).
5. **HTTP on LAN is the default** (fastest local-first path, no cloud, no extra certs). Describe and preview work over `http://`. Photo import uses `<input type="file" accept="image/*" capture="environment">` (camera roll / Camera app) — that path does **not** need `getUserMedia`. If a future in-page live camera needs a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) on a LAN IP, use Tailscale HTTPS later or a local cert (mkcert); it is not required for this host pack.

No App Store listing and no cloud account are required.

### Optional: iPhone away from home (Tailscale)

LAN stays the everyday path. For remote-away access, use a **private mesh** — prefer **Tailscale** (WireGuard is also fine). Do **not** require a public cloud tunnel or a router port-forward for core use.

1. Install [Tailscale](https://tailscale.com) on Smith or the laptop **and** on the iPhone. Sign both into the **same account** (or tailnet).
2. Start DescribePrint on the PC as usual (`0.0.0.0:3000`). Start prints a `http://<tailscale-ip>:3000` URL when it can run `tailscale ip -4` or see a `100.64.0.0/10` address; the QR prefers that address. If Tailscale is not installed, Start fails soft and shows LAN only.
3. On the phone, open that `100.x` URL (or Add to Home Screen — same PWA). Same app, still no App Store.
4. **Firewall / exposure:** bind stays `0.0.0.0` so the process can accept Tailscale-interface traffic, but Tailscale exposure is **mesh-only** (your tailnet), not the public internet. No port-forward. Ollama remains `127.0.0.1:11434` on the host.

First-time machine prep (once):

```bat
npm run setup
ollama pull qwen2.5-coder:32b
```

Install OpenSCAD from https://openscad.org/ **or** set `OPENSCAD_PATH` **or** run `npm run openscad:portable` (official zip → `vendor\openscad\`). Keep Ollama on port **11434**. Do not delete Agent Smith models.

The header chip reports Local AI + OpenSCAD. Click it if something is red or yellow. First-run health: `npm run health:preflight`.

**Windows portable / installer pack:** zip + bootstrap (not Electron). Build with `npm run pack:windows`. Install/setup: `Setup-DescribePrint.cmd` or `scripts/windows/Install-AllosWorstation.ps1 -Layout Laptop|Smith`. Full steps, OpenSCAD fetch, qwen-only Ollama pulls, and Smith-model safety: [`packaging/windows/README.md`](packaging/windows/README.md).

### Build Setup.exe (optional)

Portable zip is the supported Windows path. After the portable folder exists, an optional Inno Setup wrapper can produce `dist/AllosWorstation-DescribePrint-Setup.exe` (does **not** bundle Node; MSI is a follow-up):

```bat
npm run pack:windows:installer
```

or:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Build-InnoInstaller.ps1
```

Requires [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`ISCC.exe`). The helper runs `npm run pack:windows` if `dist\AllosWorstation-portable\` is missing.

### Any OS (terminal)

```bash
# 1) Compiler (pick one)
sudo apt-get install -y openscad          # Debian / Ubuntu
brew install openscad                     # macOS
# Windows: Start-DescribePrint.cmd, or install from https://openscad.org/
# Optional: OPENSCAD_PATH=/path/to/openscad   (or OPENSCAD_BIN)

# 2) Local AI — pull DescribePrint’s model only (leave other Ollama models alone)
#    Install Ollama from https://ollama.com if it is not already running.
#    Do not change Ollama’s port or replace Agent Smith models.
#    32b is the smartest default (higher RAM). Use 14b or 7b if needed.
ollama pull qwen2.5-coder:32b

# 3) App
npm run setup                             # .env.local + npm install if needed
npm test
npm run dev                               # binds 0.0.0.0:3000 (LAN / optional Tailscale)
```

On this PC open [http://localhost:3000](http://localhost:3000). On an iPhone on the same Wi‑Fi, use the LAN URL Start prints (`npm run lan:url`). Confirm the **Local AI** chip (click for OpenSCAD + model tips). Ollama stays on `127.0.0.1:11434`.

Headless servers sometimes need a virtual display:

```bash
sudo apt-get install -y xvfb
xvfb-run -a npm run dev
```

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_BASE_URL` | no | Default `http://127.0.0.1:11434/v1` (local Ollama). Cloud example: `https://api.openai.com/v1`. |
| `OPENAI_API_KEY` | no | Default `ollama`. Any non-empty value works with Ollama. Set a real key only for cloud. |
| `MODEL` | no | Default `qwen2.5-coder:32b` (DescribePrint’s dedicated model; highest local quality, more RAM). Lighter: `qwen2.5-coder:14b` or `qwen2.5-coder:7b`. Do not point this at Agent Smith models. |
| `SMART_PIPELINE` | no | Default `1`: Pass A plans features/dims as short JSON; Pass B writes OpenSCAD from that plan (same `MODEL`, or `PLAN_MODEL`). Set `0`/`false` for a single stronger prompt. |
| `PLAN_MODEL` | no | Optional planning-model override. Defaults to the same `MODEL`. |
| `LLM_TIMEOUT_MS` | no | Local completion timeout (default `180000`) |
| `USE_FIXTURE` | no | `true` forces the mock path even when local AI is configured |
| `FORCE_LLM` | no | `true` always calls the LLM unless `USE_FIXTURE` is also set |
| `OPENSCAD_PATH` | no | Preferred OpenSCAD executable **or** folder (portable ZIP, custom install). |
| `OPENSCAD_BIN` | no | Legacy executable override. Bare `openscad` still searches well-known locations. |
| `OPENSCAD_TIMEOUT_MS` | no | Compile timeout (default `45000`) |
| `MACHINE_ADAPTER` | no | Default `mock`. Forced `mock` always wins (CI lock). `bambu-lan` is selected by the Machine panel or by the flag + env creds. |
| `BAMBU_LAN_MQTT` | no | Default off. Optional headless override: set `1`/`true` with the three creds below. Everyday path is the Machine panel toggle. |
| `BAMBU_HOST` / `BAMBU_SERIAL` / `BAMBU_ACCESS_CODE` | no | Optional env override for printer LAN IP, serial, and LAN access code. Prefer the Machine panel. Never commit real values. |
| `BAMBU_MQTT_PORT` | no | Default `8883`. |
| `BAMBU_MQTT_TIMEOUT_MS` | no | Connect timeout (default `8000`). |

Secrets stay in the browser (Machine panel) or `.env.local`. Do not commit `.env.local`. The access code is never logged or returned by `/api/machine`.

## Example prompts

- `20mm cube with 5mm hole`
- `phone stand for iPhone 15, 60 degree tilt`
- `parametric drawer knob diameter 40mm`
- `red 40mm plaque with black letters`
- `hinged box lid print-in-place`
- `print-in-place pin joint`
- `print-in-place ball joint`
- `snap-fit clip`
- `helmet with embossed crest on the back`
- `helmet with embossed crest on the back and etched initials on the front`
- `chest plate with embossed chevron on the front`
- `gauntlet with etched ring on the cuff`
- `20mm cube with etched initials on the front`
- `20mm cube with 5mm hole, round the edges`
- `20mm cube with 5mm hole, make it look steampunk`
- `20mm cube with 5mm hole, add decorative ribs`
- `stormtrooper helmet`
- `mandalorian helmet`
- `captain america shield`
- `20mm cube with 5mm hole in PETG`
- `20mm cube with a 0.6 mm nozzle`
- `20mm cube with press-fit 8mm pin hole`

The first three match built-in single-body fixtures (used when `USE_FIXTURE` is on, or in tests). The plaque prompt is a two-color fixture: OpenSCAD `region_*` modules compile separately so the downloaded 3MF has two objects (red body, black letters) with AMS slot metadata. The hinge, pin, ball, and snap prompts are print-in-place fixtures with documented P2S / 0.4 mm-nozzle clearances (separate solids, not a fused blob). The helmet / cube / chest / gauntlet relief prompts are the **raised etchings / emboss stub**: primitive crest, chevron, ring, or block initials applied to a named wearable face (or an uploaded logo silhouette). The cube pretty-up prompts are the **Style2Fab-adjacent restyle stub**: primitive fillets/chamfers, decorative ribs, or steampunk discs/rivets while the through-hole stays open. The stormtrooper / mando / shield / PETG / 0.6 mm-nozzle prompts hit the **curated knowledge pack** (character display dims or material notes). With local AI running, the same UI asks the dedicated Ollama model for OpenSCAD (optional two-pass plan → code when `SMART_PIPELINE=1`), sanitizes it, compiles, and retries up to twice with structured compiler or printability feedback if OpenSCAD fails or the mesh is disconnected, off the plate, non-manifold, or thinner than 2× the 0.4 mm nozzle. Print-in-place joints are allowed to be disconnected solids — that warning does not trigger a fuse-together retry.

## What V0 does

1. Studio-style UI with a first-class **chat**: describe in Prepare, keep talking to iterate, then **Print** / **Update** (size/units, CAD details, and a **user profile stub** stay under More options / Details). Import an existing **STL** or **3MF**, or a **single photo** (PNG/JPG/WebP → silhouette solid stub; a head/helmet/bust partial completes a matching body), onto the same plate. The center plate previews the latest part; STL and 3MF download from the Print panel. Wearable **S/M/L/XL** measurement charts (helmet, torso, gauntlet, bracer) auto-scale whatever is on the plate. **Undo / History** in Prepare steps back through generate / import / describe-edits and restores that plate plus the chat thread (in-session, last 20). **Library** saves a named plate (prompt + OpenSCAD or import job id) in `localStorage` and remixes from that saved part instead of a blank description — this device only, not cloud sync (cap 12). Saved profile defaults (wearable size, filament, P2S, optional AMS slot labels) persist in `localStorage` on this device only — not a cloud account.
2. Local AI (or fixture / optional cloud LLM) → optional plan JSON → OpenSCAD text.
3. Sanitize / validate (no network, no filesystem escapes); run OpenSCAD in a subprocess with a timeout.
4. Parse the STL; check non-empty, volume, triangle count, edge-manifold / watertight-ish.
5. Preview in Three.js (`react-three-fiber`). Named color regions show chips on the plate (and a cheap single-color tint when Strength is off). Not a live AMS preview. Multi-body plates (joints, named modules, or 3MF regions) get an **Assembled / Exploded** toggle — explode is a one-axis heuristic offset, not kinematics.
6. Download **STL** and **3MF** (plus the `.scad` source and **Print settings** JSON), or one **project pack** zip (3MF + STL + stub build steps + shopping search terms + AMS slot plan). Multi-part designs also offer **per-part STLs** / a parts zip and a **named multi-object 3MF**. The selected Machine-panel material (PLA / PETG / PA / ABS / TPU) is written as advisory auto-best metadata on the 3MF and as `describeprint.print.json`. An **AMS slot plan** (tray 0–3 → material/color, live-preferring when connected) is written as `DescribePrint:ams_tray_*` metadata and `ams_slot_plan.json`. If the description names colors or materials, the 3MF also carries **separate objects** with `basematerials` display colors and extruder / AMS 1–4 metadata so a slicer can assign filaments. Chat follow-ups (`paint the letters black`, `make the base red`) recolor those named objects without remeshing. No colors mentioned → one default object (unless joints / modules already split solids). This is CAD export, not live AMS control. OpenSCAD itself is one mesh; split bodies need `region_*` modules, top-level part modules, or `color()` groups (the two-color fixture and hinged-box fixture do this). If OpenSCAD cannot split, the 3MF stays one colored object and the chat says so. Importing a colored 3MF preserves those objects.

Printability report: bounding box (mm), volume, triangle count, manifold flag, and issues (empty mesh, zero volume, huge triangle count, oversized vs the P2S 256 mm bed, undersized / thin walls vs the 0.4 mm nozzle, off-bed, disconnected solids). Soft printability issues are fed back into CAD retries. Plans are normalized to one-piece, 1.6 mm walls, and through-holes unless the user clearly asks otherwise. Joints (`hinge` / `pin` / `ball` / `snap` plus `print-in-place` or `multi-part` clearance) are added only when the prompt asks for motion; otherwise the planner stays one fused solid. The **fit wizard** (`snap` / `press` / `sliding` / `wearable` / `hinge` plus S/M/L or explicit mm) applies documented P2S clearances to holes, pins, snaps, and mating bores when named — it does not invent a fit for an ordinary sized hole. Reliefs (`emboss` / `etch`, motif, region / wearable target, height/depth mm) are added only when the prompt asks for raised or recessed detail. An uploaded logo/crest can become a silhouette/heightfield relief on a chosen face. Pretty-up (`fillet` / `chamfer` / `ribs` / `panels` / `steampunk`) is added only when the prompt asks to restyle — it is not a structural edit and is refused if it would fuse a PIP joint or close a through-hole. A curated in-repo **knowledge pack** (characters / props + materials / nozzle / joint / volume tech) seeds plan millimeters when the prompt names a known entry; unknown names are omitted. Not a live web crawl.

### Raised etchings / emboss (honest CSG stub)

Region-aware relief from a description **or an uploaded logo/crest**. Not Style2Fab / neural stylization. Not a generative lattice.

| | Default | Notes |
| --- | --- | --- |
| Kind | emboss if crest/raised; etch if initials/engrave | Emboss unions; etch differences |
| Region | **largest vertical face**; ties → **front (+Y)** | `back` −Y, `left` −X, `right` +X, `top` +Z, `bottom` −Z |
| Wearable target | `back of helmet` / `chest plate` / `gauntlet cuff` | Ties to `helmet_mask` / `torso_armor` / `gauntlet` (+ pack feature when a character is named) |
| Emboss height | **0.8 mm** | Clamp 0.4–2.0 mm (visible, not a blade) |
| Etch depth | **0.6 mm** | Clamp 0.4–1.2 mm; leave ≥ **1.6 mm** remaining wall (#11) when host thickness is known (helmet/shell/armor assumes 2.4 mm) |
| Motif | initials / crest / disc / bar / chevron / shield / star / cross / ring / stripe / grid / diamond / **image** | No `text()` / fonts. Image = silhouette + optional luminance heightfield |
| Multi-relief | crest on the back **and** initials on the front | One-piece host; do not close holes or fuse PIP joints |

Fixtures: `helmet with embossed crest on the back`, `helmet with embossed crest on the back and etched initials on the front`, `chest plate with embossed chevron on the front`, `gauntlet with etched ring on the cuff`, `20mm cube with etched initials on the front`. Import wraps can union/difference the same motifs onto `imported.stl` when the prompt is relief-only (or relief + hole). Upload a logo PNG/JPG/WebP with “emboss this on the back” (optionally with a part already on the plate) for the image-driven path. Remaining limits: no organic sculpt, no font rendering, no neural Style2Fab.

### Pretty-up / restyle (honest CSG stub)

Style2Fab-adjacent restyle from describe or a chat follow-up (`make it look steampunk`, `round the edges`, `add decorative ribs`) while **keeping functional regions**. In-app only — not a Blender plugin, not neural style transfer.

| | Default | Notes |
| --- | --- | --- |
| Intent | pretty-up / restyle, separate from holes / size / joints | Plan field `pretty_up` plus chat follow-up |
| Fillet | **2 mm** corner rounds | Hull of cylinders — not `minkowski()` |
| Chamfer | **2 mm** vertical bevels | Hull of inset cubes |
| Ribs / panels | **1.6 mm** thick, **1.2 mm** proud | Offset from holes and mating faces |
| Steampunk | ribs + disc + rivets | Reuses relief-adjacent disc primitives |
| Functional preserve | holes, PIP joints, mating faces, **1.6 mm** walls (#11) | Decorative stock never fills a bore or joint gap |
| Refuse | fuse/fill PIP joints; close/plug through-holes | Working fixture/CSG is left intact; plan notes say why |

**Functional preserve** means: planned through-holes still pierce, print-in-place members stay separate solids with documented clearances, mating/knuckle/socket faces stay undecorated, and walls stay ≥ 1.6 mm. Pretty-up is stylistic CSG on decorative regions only.

Fixtures: `20mm cube with 5mm hole, round the edges`, `20mm cube with 5mm hole, make it look steampunk`, `20mm cube with 5mm hole, add decorative ribs`. Chat follow-up on a cube-with-hole applies the same wrap. Pretty-up on a PIP hinge/pin/ball/snap is planned but **skipped** on moving members; “fuse the joint” / “close the hole” is **refused**. Import wraps can union decorative ribs/nubs (or difference chamfer cuts) onto `imported.stl` without closing a hole.

**Remaining limits:** not neural Style2Fab / image style transfer / organic sculpt. Imported-mesh fillets are bbox corner nubs (the STL cannot be hull-filleted honestly). No texture maps, no learned materials.

### Knowledge pack (characters + tech, curated stub)

Versioned in-repo references for SMART_PIPELINE. When the prompt names a **known** character/prop or tech keyword, the plan pass seeds millimeters and notes. Unknown names are omitted — generate does not crash.

| | Default | Notes |
| --- | --- | --- |
| Characters | helmets (trooper / vader / iron-man / spartan / mando / bat cowl / clone / knight), armor (mando chest / stark + infinity gauntlets / vambrace), props (saber / cap shield / mjolnir / staff / batarang) | Display scale that fits P2S; 1:1 / wearable uses `reference_mm` (may exceed 256³) |
| Tech | PLA/PETG/PA/ABS/TPU + ASA/CF notes, 0.2/0.4/0.6/0.8 mm nozzles, 0.12/0.2 mm layers, min wall / hole / fit clearance, hinge/snap/ball, P2S volume, PIP / multi-part / split / supports / brim / orientation | Cross-links `printers.ts` / `joints.ts` — does not fork those tables |
| Unknown | omit `knowledge` | Plan from the description alone |
| Update | edit `lib/knowledge/pack.json` | `npm run knowledge:validate` |

Honest limits: **not a live web crawl**, not official licensed measurements, not a RAG product. How to add an entry: [docs/knowledge-pack.md](docs/knowledge-pack.md). Character hits that omit display vs 1:1 surface **interactive scale chips** in the Prepare chat instead of growing `pack.json`.

### Interactive mid-design options

When the planner hits a **known fork** — not every prompt — the Prepare/chat column shows a few selectable chips. Picking one continues describe/edit and threads the choice into the next generate.

| Fork | When it appears | Choices |
| --- | --- | --- |
| Scale | Named knowledge-pack character without display vs 1:1 | Fit P2S / 1:1 wearable |
| Wearable size | Wearable / 1:1 without S–XL | S / M / L / XL |
| Material | User asks which material / filament | PLA / PETG / PA / ABS / TPU |
| Clearance | Motion/joint without PIP vs separate pieces | Print-in-place / multi-part |
| Fit kind | “which fit / tolerance” without snap/press/sliding/wearable/hinge | Snap / press / sliding / wearable / hinge |
| Fit grade | Named fit kind without S/M/L or explicit mm (not a moving joint) | S / M / L |
| Emboss face | Emboss/etch without a named face | Front / back / left / right / top / bottom |
| Color regions | “multi-color” / “color it” without named colors | Red+black / white+black / one color |
| Region paint | “paint the letters” (missing color) or “paint it” with named bodies on the plate | Letters/base × red/black/white/blue |

`20mm cube with 5mm hole` does **not** show chips. Advanced size/units stay under **More options**. Model: `lib/design-options.ts` (`id`, `label`, `value`, optional `description`). Generate/plan set `needs_user_choice` + `options` only when a fork is still open.

### Region paint → 3MF objects

After a multi-color generate (or a colored 3MF import), describe **paint / recolor** without changing geometry:

- `paint the letters black`, `make the base red`, or pick a Paint chip / Print-panel color button.
- The 3MF keeps existing objects, updates `basematerials` display colors, and rewrites extruder / AMS-index metadata.
- Plate chips show region name + hex + suggested extruder. A single named color can tint the preview mesh when Strength is off. Multi-color meshes stay the combined STL — chips are the honest preview, not a fake AMS live view.
- If OpenSCAD never split `region_*` / `color()` bodies, paint still recolors the one object and notes the limit.

CAD emits region names + colors + suggested extruder indices. **AMS tray mapping stays Print Control.**

### Strength preview heatmap (honest heuristic stub)

After mesh-check, the plate can show a **cool→hot** overlay of likely weak regions so print/strength risk is visible before download. Toggle **Strength** on the preview. In-app only — **not FEA**.

| Signal | What it approximates | Notes |
| --- | --- | --- |
| Local thickness | Inward ray to the opposite face | Falls back to slice width on huge meshes |
| Sharp concave edges | Hole rims / notches | Stress-concentration heuristic |
| Overhang vs plate | Faces steeper than **45°** from vertical, not on z=0 | Build direction is +Z |
| Tiny cross-section | Occupancy runs on X/Y/Z slices | Necks and slivers |

A 20 mm cube with a hole heats the bore (concave rims). A ~1.2 mm wall next to a large hole notes `thin wall ~1.2 mm near hole`. The printability report and chat notes list the top hits and say **not FEA**. Later: material-aware / real FEA. Pack growth is deferred — this is engineering visualization, not more `pack.json` content.

### Joint clearances (Bambu Lab P2S, 0.4 mm nozzle)

Radial values are **per side**: `bore_d = pin_d + 2 × radial`. Print-in-place is preferred when the user wants movement. Removable kits use the larger gaps. Hinge, pin, ball, and snap emit real OpenSCAD (one printable fixture each — not a full gimbal / living-hinge library).

| Joint | Intent | Radial mm/side | Diameter Δ mm | Axial mm | Min pin mm | Status |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| hinge | print-in-place | 0.40 | 0.80 | 0.50 | 4.0 | real OpenSCAD |
| hinge | multi-part | 0.50 | 1.00 | 0.60 | 4.0 | real OpenSCAD |
| pin | print-in-place | 0.40 | 0.80 | 0.50 | 4.0 | real OpenSCAD |
| pin | multi-part | 0.50 | 1.00 | 0.60 | 4.0 | real OpenSCAD |
| ball | print-in-place | 0.50 | 1.00 | 0.50 | 4.0 | real OpenSCAD |
| ball | multi-part | 0.60 | 1.20 | 0.60 | 4.0 | real OpenSCAD |
| snap | print-in-place | 0.30 | 0.60 | 0.50 | 4.0 | real OpenSCAD |
| snap | multi-part | 0.30 | 0.60 | 0.60 | 4.0 | real OpenSCAD |

Ordinary fastener/shaft fits stay **0.3 mm per side** (existing `printRules.clearanceMm`) unless the fit wizard names a tighter/looser grade. Ball keeps the wider 0.5 / 0.6 mm spherical gap from #23 (more contact area than a pin). Snap keeps 0.3 mm/side at Medium; the cantilever beam is **1.6 mm** (4× 0.4 mm nozzle) so it can flex without becoming a knife-edge — that thickness is not a table-column change. Verify with `print-in-place ball joint` (captive socket + ball) or `snap-fit clip` (window catch + hooked beam). Multi-part: `ball joint as two pieces` parks the ball beside an open cup.

### Tolerance / fit wizard (Bambu Lab P2S, 0.4 mm nozzle)

Pick **snap**, **press**, **sliding/loose**, **wearable**, or **hinge**. Grades **S / M / L** map to documented radial/axial clearances. Chat can override with an explicit **mm** (per-side). Finished hole = shaft + 2 × radial. Walls stay **≥ 1.6 mm**. PETG/PA/ABS add **0.05 mm/side**, TPU **0.10 mm/side**. Wearable here is body ease — not the S–XL clothing chart.

| Kind | Grade | Radial mm/side | Diameter Δ mm | Axial mm |
| --- | --- | ---: | ---: | ---: |
| snap | S | 0.20 | 0.40 | 0.40 |
| snap | M | 0.30 | 0.60 | 0.50 |
| snap | L | 0.40 | 0.80 | 0.60 |
| press | S | 0.10 | 0.20 | 0.15 |
| press | M | 0.20 | 0.40 | 0.25 |
| press | L | 0.30 | 0.60 | 0.35 |
| sliding | S | 0.30 | 0.60 | 0.40 |
| sliding | M | 0.40 | 0.80 | 0.50 |
| sliding | L | 0.50 | 1.00 | 0.60 |
| wearable | S | 0.50 | 1.00 | 0.60 |
| wearable | M | 1.00 | 2.00 | 1.20 |
| wearable | L | 2.00 | 4.00 | 2.40 |
| hinge | S | 0.40 | 0.80 | 0.50 |
| hinge | M | 0.45 | 0.90 | 0.55 |
| hinge | L | 0.50 | 1.00 | 0.60 |

Snap M and hinge S/L reuse `joints.ts`. Sliding M/L reuse hinge PIP / multi-part. Press L matches `printRules.clearanceMm`. Verify with `20mm cube with press-fit 8mm pin hole` (`hole_d = 8.4` at Medium PLA) or `press-fit 8mm pin, 0.25 mm clearance` (explicit override). Mid-design chips ask kind when the prompt is “which fit?”, and grade when a kind is named without S/M/L.

**Remaining stubs:** not ISO / GD&T tolerance classes, not a measured first-article loop, not material-shrinkage compensation beyond the small filament delta, not a part library (that comes after).

## M2 foundations (import + size + imported-mesh edit)

Shipped as an in-app stub trio on top of the OpenSCAD create path. No Blender / DCC.

| Path | What works | What is stubbed |
| --- | --- | --- |
| **STL/3MF import** | Upload onto the plate, preview, mesh-check, sit on z=0, re-export STL/3MF. Colored 3MF objects / materials are preserved on re-export | No repair sculpt; build-item transforms still ignored. Hole wraps flatten color objects into one solid |
| **Photo → solid** | Single PNG/JPG/WebP upload; silhouette + **luminance-depth / tapered-rounded backside** (full solid, sit-on-bed, not a front-only relief); **fragment identify** (crack / missing chunk / disconnected pieces vs the intended whole) with repair-by-default restoring missing volume unless Keep damage / wear is on; **match-and-complete** for head / helmet / bust partials (photo loaf + parametric neck/torso); if the bbox exceeds the P2S 256³, the plate still exports and **designates** a stub alternate machine (K1 Max / H2D / Prusa XL) | Not photogrammetry, NeRF, or identity-accurate. Backside is a loaf/luminance heuristic; invented body is parametric proportions from wearable charts. WebP pixels are inferred from the file header (PNG/JPG decode the real silhouette). Not Style2Fab / neural pretty-up. Not a machine farm or slicer picker |
| **Describe-to-edit (imported)** | Scale / rotate / sit-on-bed and S–XL edit the real triangles. “Add an 8 mm hole” (and similar) **differences** `import("imported.stl")` — through-holes by default, axis/offset inferred from the prompt, sit-on-bed + one-piece checks kept. Pretty-up / restyle wraps decorative CSG (ribs, corner nubs, chamfer cuts) without closing holes. Repair retries stay on the wrap (no from-scratch rewrite) | Full triangle sculpt / neural Style2Fab / organic remesh is **not** ready. Blind holes and multi-feature wraps are still CSG, not mesh sculpt |
| **Wearable size** | Category + S/M/L/XL picker and chat (“helmet size L”) scale the current mesh from documented mm charts and show the assumed size + key measurements | Not a custom-fit / saved-body grade; scale is **uniform** from the category primary measurement (preserves walls and holes) |
| **Version history / undo** | Prepare **Undo** + **History** list. Each generate / import / describe-edit is a version: prompt + OpenSCAD or imported mesh job id + preview URLs + chat thread. Restore puts that mesh back on the plate | In-session / in-memory only (cap 20). Refresh or Clear chat drops it. Jobs still expire after the server TTL. No disk persist, no cross-device sync |
| **Part library + remix** | Prepare **Library** + Print **Save to library**. Name the current plate (prompt + OpenSCAD or import job id + preview metadata). Browse / load restores the preview and a chat seed. Remix chips (`Make it 10% larger`, change one dim, pretty-up, fit, size L) run as follow-ups from the saved part, not a blank description | **localStorage only** (cap 12, this device). Not cloud sync. Preview job URLs still expire (~1h); remix uses saved OpenSCAD or the import job id while it lasts |

**Wearable charts (mm)** — pick a category (or say “helmet”, “cuirass”, “gauntlet”, “bracer” in chat) then S–XL:

| Category | Primary* | S | M | L | XL | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Helmet / mask | Head circ | 555 | 575 | 595 | 615 | EN 960:2006 headform designations; letter map matches common ECE/DOT helmet charts |
| Torso armor | Chest (waist) | 900 (760) | 1000 (860) | 1100 (960) | 1200 (1060) | ISO 8559-2 primary/secondary; 100 mm letter steps (ISO 8559-3 50 mm interval, every other step) |
| Gauntlet / glove | Hand circ (length) | 178 (171) | 203 (182) | 229 (192) | 254 (204) | EN ISO 21420:2020 Annex B sizes 7–10 |
| Bracer / cuff | Wrist (forearm) | 152 (240) | 165 (265) | 178 (290) | 191 (315) | ISO 8559-1 wrist method; 13 mm wrist / 25 mm forearm adult grade |

Scale is **uniform**: `primary(to) / primary(from)`. Native mesh is Medium. Not axis-aware (keeps holes circular and #11 printability).

### Match-and-complete (honest stub)

When a photo (or chat) looks like a **head / helmet / bust / fragment** partial, CAD Core completes a **plausible matching body** into one printable solid. Neural Style2Fab remains later; heuristic pretty-up is a separate describe/chat path.

| | Behavior |
| --- | --- |
| Detect | Silhouette heuristics (aspect, circularity, neck taper, shoulder flare, symmetry) plus file name and chat (`complete the body`, `match this head with a torso`) |
| Matched | Photographed head / helmet / bust region stays the silhouette + luminance-depth loaf |
| Invented | Parametric neck + torso from wearable chart proportions (Medium chest / head circ = 1000 / 575; waist / chest = 860 / 1000) |
| Plate | One standing figurine-length solid (not a front-only relief). Chat notes list matched vs invented region labels |
| Follow-up | “Complete the body” on a plate solid that was not auto-completed attaches the same invented body |
| Still applies | Repair-by-default unless keep-wear; oversize → designate alternate machine; STL / 3MF export; wearable S–XL charts |

**Remaining limits:** not identity-accurate, not photogrammetry / NeRF, not a full 7-head statue (bust-length torso), not neural pretty-up. A mug / bracket / generic object is not completed unless chat asks.

Local AI stays **`qwen2.5-coder`** only (`32b` / `14b` / `7b`). Agent Smith models are never retargeted.

## Success paths

- **Local AI (default):** Ollama on `127.0.0.1:11434` with DescribePrint’s model (`qwen2.5-coder:32b`) → describe → (optional plan JSON) → OpenSCAD → STL → viewer → download. No cloud key. Use `MODEL=qwen2.5-coder:14b` or `7b` on smaller machines.
- **Ollama not running / model missing / OpenSCAD missing:** the header chip turns yellow or red; click it for fix tips. Generation still shows **Start local AI (Ollama)** if the model call fails.
- **Fixture / mock:** `USE_FIXTURE=true` (or `fixture: true`) compiles example/heuristic OpenSCAD without calling a model.
- **Optional cloud:** set `OPENAI_BASE_URL` + a real `OPENAI_API_KEY` to use a hosted model.

Run as a Node process (`next dev` / `next start`). V0 is not aimed at serverless-only hosts: it needs to spawn OpenSCAD.

## Tests

```bash
npm test
```

Covers local LLM config defaults, OpenSCAD path resolution, launch health (Ollama + MODEL + OpenSCAD), Start preflight exit codes (0 = pass, 2 = warn/soft fail and continue), code sanitization, mesh-check / STL / 3MF (including multi-object color / AMS-slot encoding), region paint / recolor of named 3MF objects, assembly / explode detection (hinged-box named parts, cube is single-body, heuristic offsets, part STL zip), import, photo → solid (upload validation, luminance-depth backside, fragment identify, match-and-complete head/helmet/bust, repair-by-default, oversize → machine designation), wearable measurement charts + size application, imported-mesh describe-edit (hole difference / placement / wrap repair / emboss-etch wrap / pretty-up wrap / complete-the-body), joint clearance helpers + plan parsing + hinge/pin/ball/snap fixtures, tolerance / fit wizard (snap/press/sliding/wearable/hinge S/M/L + explicit mm, press-fit cube hole), raised etchings / emboss plan fields + fixtures (multi-relief, wearable regions, image silhouette/heightfield), pretty-up / restyle plan fields + functional-preserve / refuse + cube fixtures, generative lattice / lightweighting (honeycomb phone stand + cube patterns, shell ≥ 1.6 mm, hole/joint keepers; not FEA), the curated knowledge pack (known character dims, unknown-name fallback, tech keyword notes), mid-design option chips (character scale fork, cube does not ask, incomplete paint chips), heuristic strength-preview scoring (cube-with-hole / thin-wall fixture), in-session version history / undo (push, undo two describe-edits, restore mesh + thread, cap 20), the user-profile stub (localStorage parse/save, P2S + PLA defaults, AMS labels as prefs, apply size/filament into generate/options), the part-library + remix stub (localStorage save/load of prompt + OpenSCAD or import job id, cap 12, remix follow-ups from a saved part not a blank start, not cloud sync), the P2S profile, Print doctor (including `use AMS 2 for accent`), failure-photo replay stub (filename/hint → doctor guides; unknown asks for a hint; no fit-wizard), AMS slot plan (disconnected tray 0 = selected material; live inject 2 slots; 3MF tray metadata), print-estimate stub (cube grams / material cost / no mesh → null), project-pack stub (3MF + steps + shopping links + `ams_slot_plan.json`; empty plate fails cleanly), and machine adapters (mock + flagged LAN MQTT, no physical printer). If OpenSCAD is installed, an integration test compiles the default fixture, an imported-mesh hole wrap, the two-color plaque regions, the print-in-place hinge / pin / ball / snap fixtures, the helmet-emboss / cube-etch / chest-chevron / gauntlet-cuff / multi-relief fixtures, the pretty-up fillet / steampunk fixtures, and the honeycomb phone-stand / cube lattice fixtures (skipped if the binary is missing).

`npm run knowledge:validate` checks `lib/knowledge/pack.json` against the in-repo schema. See [docs/knowledge-pack.md](docs/knowledge-pack.md) to add a character or tech entry.

`GET /api/health` returns the same Local AI / OpenSCAD / P2S status the header chip shows. `npm run health:preflight` is the same check Start runs before `npm run dev`.

## Out of V0

Neural Style2Fab / image style transfer, neural organic mesh, FEA / MechStyle, multi-agent CAD, full Bambu Studio / Orca slicer embedding, and the owner-approved extras below (cloud profile, AMS-aware design, live P2S control, and the rest). Heuristic CSG pretty-up, the heuristic strength-preview heatmap, the generative lattice / lightweighting stub, the local user-profile stub, and the part-library + remix stub are shipped stubs (not neural style, not FEA / MechStyle, not a cloud account). Those extras are **approved**, not V0 work, and they must **not** block the Bambu-layout + chat-first PR.

## Roadmap

Owner-approved. **Do not treat this list as V0 scope.** The current Bambu-inspired layout and chat-first describe → Print path ships first; items below come later, still **in-app** (no Blender / Meshmixer / separate DCC). Default printer remains **Bambu Lab P2S**.

### After V0 (existing)

1. **Wearable / cosplay sizing** — **Charts shipped:** S/M/L/XL plus documented category charts (helmet/mask, torso armor, gauntlet, bracer); auto-scale the model; show the assumed size and key mm measurements. **Profile stub** can remember a default letter size. Later: saved body measurements and custom-fit grading.
2. **Raised etchings / emboss** — **Deepen shipped:** plan fields + print-aware depth + wearable region targets (helmet back / chest plate / gauntlet cuff) + richer primitive motifs + multi-relief + helmet/chest/gauntlet/cube fixtures + import-wrap CSG + **image silhouette/heightfield** logo relief. Later: organic sculpt / fonts. Not Style2Fab. Not generative lattice.
3. **Articulated / functional assemblies** — **Joint family + explode stub shipped:** plan fields + P2S clearances + hinge/pin/ball/snap print-in-place fixtures (captive ball; cantilever snap), plus Assembled/Exploded inspect and named part STL/3MF export. Later: richer joint library, constraint-solved kinematics, and material-aware thickness/strength so moving parts (e.g. robot arms) don’t break.
4. **Print doctor** — user describes print defects (e.g. stringing with nylon PA); the system diagnoses likely causes for the **selected printer/material** (default **Bambu Lab P2S**) and proposes or auto-applies setting fixes; then a feedback loop (still bad vs perfect). **Feedback loop shipped:** Perfect remembers the fix per printer + filament (`localStorage`); Still bad skips that suggestion and tries the next cause or physical steps. In-app only — not a separate slicer or DCC.
5. **Image import as starting point** — **Backside + fragment identify + match-and-complete shipped:** user uploads a **single photo** (PNG/JPG/WebP); silhouette + luminance-depth tapered/rounded backside becomes a **full 3D printable solid** (not a front-only relief). Head / helmet / bust partials complete a parametric matching body (neck/torso proportions). If the photo looks like a broken fragment / missing chunk, the pipeline identifies fragment vs intended whole and repair-by-default restores the missing volume unless the user asked to keep wear. Keep damage / wear override, STL/3MF export, and oversize vs P2S designates a stub alternate machine. Later: photogrammetry / NeRF-quality unseen geometry (still in-app, no Blender). Not identity-accurate.
6. **Auto calibration assistant** — guided calibration for the **Bambu Lab P2S** and later machines (bed, flow, offset, and related checks) from the web UI.
7. **Part library + remix** — **Stub shipped:** save the current plate under a name (prompt + OpenSCAD or imported-mesh job id + preview metadata) in `localStorage` (`lib/part-library.ts`). Browse / load restores the preview and a chat seed. Remix chips (`Make it 10% larger`, change one dim, pretty-up / fit / size) are follow-ups from the saved part, not a blank start. Cap 12. This device only — not cloud sync. Preview jobs still expire (~1h). Later: cloud library + richer reuse.
8. **Tolerance / fit wizard** — **Stub shipped:** pick snap, press, sliding/loose, wearable, or hinge; S/M/L grades (or explicit mm) apply print-aware radial/axial clearances for the selected printer/material (default **Bambu Lab P2S**, 0.4 mm nozzle). Wired into plan/codegen for holes, pins, snaps, and mating bores; chat + option chips. Reuses `joints.ts` numbers. Walls stay ≥ 1.6 mm. Later: ISO classes / measured first-article.
9. **Failure replay from a phone photo** — **Stub shipped:** upload a photo of a failed print (or a one-line caption); filename / hint maps to Print doctor (spaghetti / scrape / empty bed / AMS loop / stringing). Honest stub — no vision ML. CAD repair is a suggestion only (`try reshape remaining` / print doctor settings). Pairs with Print doctor. Later: real classify.
10. **Digital twin of the printer** — live status, queue, AMS, and ETA in the DescribePrint UI (no separate slicer required).
11. **Generative lattice / lightweighting** — **Stub shipped:** infill-as-geometry via OpenSCAD-feasible honeycomb / cubic / gyroid-ish / diagonal voids inside a printable outer shell (≥ 1.6 mm, 4× nozzle). Functional holes, PIP joints, and mating faces stay uncut. Heuristic pattern — not FEA / MechStyle. Later: topology optimization.
12. **Compliance / safety checks for wearables and props** — flag sharp edges, occlusion, skin-contact, and similar risks before export.
13. **Multi-machine farm mode** — send jobs across more than one printer, with queue and status in-app.

V0 stays **describe → CAD → STL/3MF**. Image import, Print doctor, items 6–13, and the extras below are after V0. Local AI (`qwen2.5-coder:32b` on the default Ollama server) remains the generate path; do not retarget Agent Smith models.

All of the above ship **inside the web UI** (preview + printable export). None of them assume Blender or another DCC after the fact.

**Printer profiles (later, not a V0 blocker):** in-app picker to change printer and print settings (layer height, nozzle, material). Default remains Bambu Lab P2S. Long-term the core path slices in-app so users do not need a separate slicer; V0 only exports STL/3MF against the P2S stub profile. Print doctor uses that same selected profile.

### Owner-approved extras (later)

All approved. None of these block the Bambu-layout + chat-first PR.

1. **User profile** — **Stub shipped:** More options **Profile defaults** remembers wearable S–XL / category, filament, optional part size, P2S, and optional AMS slot labels in `localStorage` (`lib/user-profile.ts`). Applied on load, new part, and generate/options when unset. This device only — not a cloud account. AMS labels are prefs, not live tray mapping. Later: cloud account + custom-fit measurements.
2. **Version history / undo** — **Stub shipped:** each generate / import / describe-edit is an in-session plate version (`lib/version-history.ts`: prompt + OpenSCAD or imported mesh job id + job/preview metadata + chat thread). Prepare **Undo** / **History** restores the earlier mesh on the plate, not just the text. Cap 20. Refresh clears it — persist later.
3. **Time + filament + cost estimates** — **Stub shipped:** Print column shows `~Xh Ym · Z g · $A.BB (stub)` from mesh/AABB volume × 20% infill × material density, using the selected P2S preset speed/layer height (`lib/machine/print-estimate.ts`). Optional $/kg. Empty plate → “Print something first”. Not a slicer; no LAN.
4. **Design to what’s loaded on AMS** — prefer colors/materials that are actually in the AMS.
5. **Learn from Print doctor** — **Stub shipped:** remember fixes per printer profile + filament in the browser (`describeprint.machine.printDoctorMemory`). Later: sync / full transfer across machines.
6. **Project pack export** — **Stub shipped:** one zip (`lib/machine/project-pack.ts`) with the current 3MF/STL, template build steps, and vendor-agnostic shopping search terms. Print column **Download pack**; empty plate → disabled. Not a slicer; no LAN.
7. **Smart plate packing** — **Stub shipped:** largest-first shelf pack of the current job AABB (or N copies) on the P2S 256×256 mm plate (`lib/machine/plate-pack.ts`). Won't-fit returns rotate-90 / split advice — no invented geometry, no LAN. Later: multi-body plates and a real packer.
8. **Strength preview heatmap** — **Stub shipped:** per-triangle heuristic weakness (thickness proxy, concave stress, overhang vs plate, tiny slices) as a cool→hot overlay with a legend + report/chat notes. Toggle on the preview. Not FEA. Later: material-aware / real FEA.
9. **Assembly / explode mode** — **Stub shipped:** detect multi-body plates from planned joints, named OpenSCAD modules, multi-object 3MF regions, or mesh islands (`lib/assembly.ts`). Viewer **Assembled / Exploded** offsets parts along the longest AABB axis. Chat lists part names. Download per-part STLs / a parts zip and a named multi-object 3MF. Explode offsets are heuristic — not constraint-solved kinematics. Later: a real joint solver.
10. **Optional voice describe** — talk instead of (or as well as) typing, same chat-first path.

### Critical (later, not a V0 / layout-PR blocker)

11. **Direct control of the user’s Bambu Lab P2S and attached AMS** — diagnose and autofix from plain language in the same chat (example: AMS #2 feed/unfeed loop). Use Bambu **local/network APIs** where possible; **safe pause** before risky moves; give simple physical steps when software cannot fix hardware. Keep the interaction **chat-first**.

### Additional owner requirements (later, do not implement now)

Approved. Do **not** implement these in the current V0 / layout work. They come later, still **in-app**.

12. **Pluggable machine control** — Control, diagnose, and autofix for **any** future machines through a pluggable adapter — not only Bambu Lab P2S + AMS. Same chat-first diagnose / autofix path as the P2S/AMS item above.
13. **Full transfer on machine upgrades** — When the user upgrades or switches machines, transfer **all** of: projects, versions, profile, filament prefs, learned Print doctor fixes, AMS/machine history, and designated jobs.
14. **Design exceeds current printer** — **Photo-solid stub shipped:** if the imported/generated bbox does not fit the current P2S 256³, the UI reports the miss and designates the smallest stub alternate that fits (K1 Max / H2D / Prusa XL) instead of failing silently. Later: full picker, saved designated machine, and farm send.
15. **Complex builds** — For large projects (e.g. a home drone): a simple step-by-step how-to, sourcing links on demand, and alternative build paths.
16. **Continuous knowledge updates** — **Stub shipped (v1.1):** versioned in-repo pack (`lib/knowledge/pack.json`) for a curated set of cosplay/prop characters (helmets, armor, props with display + 1:1 mm) and tech (materials, supported nozzles/layers, min wall/hole/fit, joint-clearance + P2S volume + common techniques). SMART_PIPELINE consults the pack when the prompt names a known entry; unknown names are omitted. Add entries in JSON and run `npm run knowledge:validate`. Not a live web crawl. Later: richer library, still curated (not a crawler).
17. **Live print monitor + mid-print adjust** — Watch the **Bambu Lab P2S** (and later any machine) live camera/status during a print. Detect failures (spaghetti, layer shift, AMS feed issues, under-extrusion). Intervene mid-print via machine APIs (pause, slow, temp/flow tweaks when supported, AMS fault clear, abort + queue a corrected reprint). Explain simply what was seen and what changed. Ties to **Print doctor**, **digital twin**, and **pluggable machine control**. Model geometry cannot be reshaped mid-layer; intervention is control, settings, or abort + fix.
18. **Emergency mid-print reshape (remaining layers only)** — If a live print is going wrong, **pause**; the user describes the emergency change; the system redesigns **only the unprinted upper geometry** so it mates with the already-printed stump; reslice remaining layers and resume when the printer API allows (or a guided handoff). **Cannot** reshape already-solid printed plastic. Ties to **live print monitor** and **machine control**.

## Extension points (later)

- **Richer describe-to-modify** — V0 already threads the last prompt + OpenSCAD into chat follow-ups; later work can deepen multi-part / selection-aware edits.
- **Style2Fab-style edit** — **Heuristic CSG stub shipped** (`pretty_up` plan + fillet/chamfer/ribs/steampunk fixtures; refuses fuse-joint / close-hole). Later: neural Style2Fab / image style transfer. Still in-app, not a Blender plugin.
- **Organic mesh** — swap the OpenSCAD backend for a neural / implicit generator, still exported from the app.

See `FutureEditMode` in [`lib/types.ts`](lib/types.ts). The pipeline is already split so those backends can sit beside `runGeneratePipeline`.

## License

MIT
