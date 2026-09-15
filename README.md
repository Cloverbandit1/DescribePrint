# DescribePrint

Describe anything in plain language and get a **printable 3D model** (STL + 3MF), with a real preview.

V0 is the **create** path for parametric / mechanical parts: a Bambu Studio–inspired workspace (prepare / plate / print), an OpenSCAD generation pipeline, mesh checks, and downloads. **Local AI (Ollama)** generates the CAD by default so the loop stays self-contained and works offline. A fixture/mock path remains for tests and demos.

## Product principles

DescribePrint is **fully end-to-end in the web app**. Users must **never** need Blender, Meshmixer, or any other DCC after generation.

- The complete path is: describe → preview in the UI → download **STL** and **3MF** (and, later, slice/print from the same UI).
- Those files are for printing, not for cleanup in Blender or another DCC.
- Future Style2Fab-like edit, organic mesh, and other mesh work stay **in-app**. They are not a Blender plugin or an external DCC dependency.
- **Long-term, a separate slicer app is not required** for the core path. Users pick a printer and print settings in DescribePrint.
- **Very simple to use and print.** The everyday path is **describe → clear options → Print**. Smart defaults (mm, Bambu Lab P2S). Advanced controls stay hidden.
- **Bambu-inspired layout, original chrome.** The desktop workspace follows Bambu Studio / Bambu Lab slicer structure: a large **3D plate preview** in the center, **Print / options** on the right, and Prepare → Preview tabs. Dark and light themes use a compact studio palette (green actions, muted panels). The app does **not** use Bambu trademarks, logos, or proprietary assets — only a familiar workspace feel.
- **Chat stays first-class.** The left Prepare column is a live describe/chat thread, not a dead slicer object list. Users keep talking to add, remove, or change the part; follow-ups send the previous description and OpenSCAD so the plate can update. Mobile still keeps a composer on Preview so conversation is not trapped behind the plate.
- **Power + program, local-first.** Build what we need. Local AI handles generation. No cloud key is required.

V0 already follows the mesh path: the viewer plus STL/3MF download is the complete user path today. Full Bambu / Orca integration is **not** a V0 blocker.

## Local AI (Ollama)

DescribePrint defaults to a **local** OpenAI-compatible API:

| Setting | Default |
| --- | --- |
| `OPENAI_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `OPENAI_API_KEY` | `ollama` (Ollama accepts any non-empty key) |
| `MODEL` | `qwen2.5-coder:7b` (DescribePrint’s dedicated model; override with `MODEL`) |

When this path is active, the header shows a **Local AI** badge.

### Sharing Ollama with Agent Smith

Ollama on this machine may already be used by **Agent Smith**. DescribePrint **shares that server safely** and must not interfere:

- Use the **default** Ollama endpoint only (`127.0.0.1:11434`). Do not change Ollama’s port, host, or global server config for this app.
- Isolation is a **dedicated model name**. Default `MODEL` is `qwen2.5-coder:7b` — never `smith-minicpm5`, `openbmb/minicpm5-*`, or any other Agent Smith model.
- **Leave Smith models untouched.** Do not delete, replace, or retarget existing models.
- Pull DescribePrint’s model *alongside* whatever is already installed:

```bash
ollama pull qwen2.5-coder:7b
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

Default printer target: **Bambu Lab P2S**.

| | V0 (stub) | Later (in-app) |
| --- | --- | --- |
| Printer | P2S assumed: 256 × 256 × 256 mm bed, **0.4 mm** nozzle (0.2 / 0.6 / 0.8 supported), 1.75 mm filament | User can change printer and print settings in the web UI |
| Output | STL + 3MF download | Same, plus in-app slice / send — no separate slicer required |

Sensible P2S defaults live in [`lib/printers.ts`](lib/printers.ts). V0 does not ship Bambu Studio or Orca; it only names P2S as the default profile so parts are sized and flagged against that volume.

## Why OpenSCAD (not build123d)

V0 compiles **OpenSCAD**, not build123d / OpenCascade.

- OpenSCAD is a small CLI that exports STL reliably on Linux/macOS/Windows.
- build123d + OpenCascade is a much heavier native stack (harder to install, slower to sandbox).
- OpenSCAD has no network and a tiny filesystem surface; we still block `import` / `include` / `use` / `surface`.

Units are **millimeters**. OpenSCAD is unitless; DescribePrint treats `1` unit as `1 mm` and converts optional inch size hints (`× 25.4`).

## Quick start

```bash
# 1) Compiler (pick one)
sudo apt-get install -y openscad          # Debian / Ubuntu
brew install openscad                     # macOS
# Windows: install from https://openscad.org/ and put it on PATH
# Optional: OPENSCAD_BIN=/path/to/openscad

# 2) Local AI — pull DescribePrint’s model only (leave other Ollama models alone)
#    Install Ollama from https://ollama.com if it is not already running.
#    Do not change Ollama’s port or replace Agent Smith models.
ollama pull qwen2.5-coder:7b

# 3) App
cp .env.example .env.local                # defaults already point at local Ollama
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Confirm the **Local AI** badge.

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
| `MODEL` | no | Default `qwen2.5-coder:7b` (DescribePrint’s dedicated model). Do not point this at Agent Smith models. |
| `USE_FIXTURE` | no | `true` forces the mock path even when local AI is configured |
| `FORCE_LLM` | no | `true` always calls the LLM unless `USE_FIXTURE` is also set |
| `OPENSCAD_BIN` | no | OpenSCAD executable (default `openscad`) |
| `OPENSCAD_TIMEOUT_MS` | no | Compile timeout (default `45000`) |

Secrets stay in the environment only. Do not commit `.env.local`.

## Example prompts

- `20mm cube with 5mm hole`
- `phone stand for iPhone 15, 60 degree tilt`
- `parametric drawer knob diameter 40mm`

These three match built-in fixtures (used when `USE_FIXTURE` is on, or in tests). With local AI running, the same UI asks the dedicated Ollama model for OpenSCAD, sanitizes it, compiles, and retries once if the compiler or mesh check fails.

## What V0 does

1. Studio-style UI with a first-class **chat**: describe in Prepare, keep talking to iterate, then **Print** / **Update** (size/units and CAD details stay under More options / Details). The center plate previews the latest part; STL and 3MF download from the Print panel.
2. Local AI (or fixture / optional cloud LLM) → OpenSCAD text.
3. Sanitize / validate (no network, no filesystem escapes); run OpenSCAD in a subprocess with a timeout.
4. Parse the STL; check non-empty, volume, triangle count, edge-manifold / watertight-ish.
5. Preview in Three.js (`react-three-fiber`).
6. Download **STL** and **3MF** (plus the `.scad` source).

Printability report: bounding box (mm), volume, triangle count, manifold flag, and obvious issues (empty mesh, zero volume, huge triangle count, oversized, undersized).

## Success paths

- **Local AI (default):** Ollama on `127.0.0.1:11434` with DescribePrint’s model (`qwen2.5-coder:7b`) → describe → OpenSCAD → STL → viewer → download. No cloud key.
- **Ollama not running:** the UI shows **Start local AI (Ollama)**.
- **Fixture / mock:** `USE_FIXTURE=true` (or `fixture: true`) compiles example/heuristic OpenSCAD without calling a model.
- **Optional cloud:** set `OPENAI_BASE_URL` + a real `OPENAI_API_KEY` to use a hosted model.

Run as a Node process (`next dev` / `next start`). V0 is not aimed at serverless-only hosts: it needs to spawn OpenSCAD.

## Tests

```bash
npm test
```

Covers local LLM config defaults, code sanitization, and the mesh-check / STL / 3MF path. If OpenSCAD is installed, an integration test compiles the default fixture.

## Out of V0

Style2Fab, neural organic mesh, FEA / MechStyle, multi-agent CAD, full Bambu Studio / Orca slicer embedding, and the owner-approved extras below (profile, AMS-aware design, live P2S control, and the rest). Those extras are **approved**, not V0 work, and they must **not** block the Bambu-layout + chat-first PR.

## Roadmap

Owner-approved. **Do not treat this list as V0 scope.** The current Bambu-inspired layout and chat-first describe → Print path ships first; items below come later, still **in-app** (no Blender / Meshmixer / separate DCC). Default printer remains **Bambu Lab P2S**.

### After V0 (existing)

1. **Wearable / cosplay sizing** — S/M/L/XL plus measurement charts; auto-scale the model; show the assumed size.
2. **Raised etchings / emboss** — from a description (and later images) that print as visible relief.
3. **Articulated / functional assemblies** — real joints with print clearances, multi-part export, and material-aware thickness/strength so moving parts (e.g. robot arms) don’t break.
4. **Print doctor** — user describes print defects (e.g. stringing with nylon PA); the system diagnoses likely causes for the **selected printer/material** (default **Bambu Lab P2S**) and proposes or auto-applies setting fixes; then a feedback loop (still bad vs perfect). In-app only — not a separate slicer or DCC.
5. **Image import as starting point** — user uploads a **single photo**; the system infers/generates the **backside and unseen geometry** into a **full 3D printable solid** (not a front-only relief). Output is a clean, watertight-ish mesh ready to print. By default, use light intelligence to **repair** broken or damaged parts (fill cracks, restore missing chunks). Do **not** preserve wear unless the user asks to keep it.
6. **Auto calibration assistant** — guided calibration for the **Bambu Lab P2S** and later machines (bed, flow, offset, and related checks) from the web UI.
7. **Part library + remix** — save successful prints and remix them (change a dimension, restyle, reuse a proven fixture) instead of starting from a blank description.
8. **Tolerance / fit wizard** — pick snap, press, loose, or hinge fit; the system applies print-aware clearances for the selected printer/material.
9. **Failure replay from a phone photo** — upload a photo of a failed print; the system reconstructs what went wrong and proposes a repaired model and/or settings (pairs with Print doctor).
10. **Digital twin of the printer** — live status, queue, AMS, and ETA in the DescribePrint UI (no separate slicer required).
11. **Generative lattice / lightweighting** — infill-as-geometry: lighter parts that still print and stay strong enough for the chosen use.
12. **Compliance / safety checks for wearables and props** — flag sharp edges, occlusion, skin-contact, and similar risks before export.
13. **Multi-machine farm mode** — send jobs across more than one printer, with queue and status in-app.

V0 stays **describe → CAD → STL/3MF**. Image import, Print doctor, items 6–13, and the extras below are after V0. Local AI (`qwen2.5-coder:7b` on the default Ollama server) remains the generate path; do not retarget Agent Smith models.

All of the above ship **inside the web UI** (preview + printable export). None of them assume Blender or another DCC after the fact.

**Printer profiles (later, not a V0 blocker):** in-app picker to change printer and print settings (layer height, nozzle, material). Default remains Bambu Lab P2S. Long-term the core path slices in-app so users do not need a separate slicer; V0 only exports STL/3MF against the P2S stub profile. Print doctor uses that same selected profile.

### Owner-approved extras (later)

All approved. None of these block the Bambu-layout + chat-first PR.

1. **User profile** — saved body/part sizes, filaments, and defaults (P2S + AMS slots).
2. **Version history / undo** — step back through describe-edits and restore an earlier plate.
3. **Time + filament + cost estimates** — show print time, filament use, and a simple cost before Print.
4. **Design to what’s loaded on AMS** — prefer colors/materials that are actually in the AMS.
5. **Learn from Print doctor** — remember fixes per machine and filament so later diagnoses get better.
6. **Project pack export** — 3MF plus build steps and shopping links in one pack.
7. **Smart plate packing** — arrange one or many parts on the P2S plate.
8. **Strength preview heatmap** — show likely weak regions on the preview.
9. **Assembly / explode mode** — inspect multi-part designs as assembled or exploded.
10. **Optional voice describe** — talk instead of (or as well as) typing, same chat-first path.

### Critical (later, not a V0 / layout-PR blocker)

11. **Direct control of the user’s Bambu Lab P2S and attached AMS** — diagnose and autofix from plain language in the same chat (example: AMS #2 feed/unfeed loop). Use Bambu **local/network APIs** where possible; **safe pause** before risky moves; give simple physical steps when software cannot fix hardware. Keep the interaction **chat-first**.

### Additional owner requirements (later, do not implement now)

Approved. Do **not** implement these in the current V0 / layout work. They come later, still **in-app**.

12. **Pluggable machine control** — Control, diagnose, and autofix for **any** future machines through a pluggable adapter — not only Bambu Lab P2S + AMS. Same chat-first diagnose / autofix path as the P2S/AMS item above.
13. **Full transfer on machine upgrades** — When the user upgrades or switches machines, transfer **all** of: projects, versions, profile, filament prefs, learned Print doctor fixes, AMS/machine history, and designated jobs.
14. **Design exceeds current printer** — If a design cannot print on the current machine: suggest how to accomplish it, list other machines that can handle it, and let the user save/export to a user-designated machine.
15. **Complex builds** — For large projects (e.g. a home drone): a simple step-by-step how-to, sourcing links on demand, and alternative build paths.
16. **Continuous knowledge updates** — Keep knowledge current for **new characters** and **real-world tech** (materials, machines, techniques).

## Extension points (later)

- **Richer describe-to-modify** — V0 already threads the last prompt + OpenSCAD into chat follow-ups; later work can deepen multi-part / selection-aware edits.
- **Style2Fab-style edit** — in-app stylization while keeping functional regions (not a Blender plugin).
- **Organic mesh** — swap the OpenSCAD backend for a neural / implicit generator, still exported from the app.

See `FutureEditMode` in [`lib/types.ts`](lib/types.ts). The pipeline is already split so those backends can sit beside `runGeneratePipeline`.

## License

MIT
