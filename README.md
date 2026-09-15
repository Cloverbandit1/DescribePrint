# DescribePrint

Describe anything in plain language and get a **printable 3D model** (STL + 3MF), with a real preview.

V0 is the **create** path for parametric / mechanical parts: a chat-style web app, an OpenSCAD generation pipeline, mesh checks, and downloads. You can run the whole loop without a live LLM via the fixture/mock path.

## Product principles

DescribePrint is **fully end-to-end in the web app**. Users must **never** need Blender, Meshmixer, or any other DCC after generation.

- The complete path is: describe → preview in the UI → download **STL** and **3MF** (and, later, slice/print from the same UI).
- Those files are for printing, not for cleanup in Blender or another DCC.
- Future Style2Fab-like edit, organic mesh, and other mesh work stay **in-app**. They are not a Blender plugin or an external DCC dependency.
- **Long-term, a separate slicer app is not required** for the core path. Users pick a printer and print settings in DescribePrint.
- **Very simple to use and print.** The everyday path is **describe → clear options → Print**. Smart defaults (mm, Bambu Lab P2S). Advanced controls stay hidden. Prefer a clean chat + preview layout over a dense CAD UI.

V0 already follows the mesh path: the viewer plus STL/3MF download is the complete user path today. Full Bambu / Orca integration is **not** a V0 blocker.

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

# 2) App
cp .env.example .env.local                # add OPENAI_API_KEY later if you want
npm install
npm test
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Headless servers sometimes need a virtual display:

```bash
sudo apt-get install -y xvfb
xvfb-run -a npm run dev
```

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | no | OpenAI-compatible API key. If unset, V0 uses fixtures / heuristics. |
| `OPENAI_BASE_URL` | no | Default `https://api.openai.com/v1` |
| `MODEL` | no | Default `gpt-4o-mini` |
| `USE_FIXTURE` | no | `true` forces the mock path even when a key is set |
| `FORCE_LLM` | no | `true` always calls the LLM (needs a key) |
| `OPENSCAD_BIN` | no | OpenSCAD executable (default `openscad`) |
| `OPENSCAD_TIMEOUT_MS` | no | Compile timeout (default `45000`) |

Secrets stay in the environment only. Do not commit `.env.local`.

## Example prompts

- `20mm cube with 5mm hole`
- `phone stand for iPhone 15, 60 degree tilt`
- `parametric drawer knob diameter 40mm`

These three match built-in fixtures, so they work **without an API key**. With a key, the same UI asks an OpenAI-compatible model for OpenSCAD, sanitizes it, compiles, and retries once if the compiler or mesh check fails.

## What V0 does

1. Simple chat + preview UI: describe → example options → **Print** (size/units and CAD details stay under More options / Details).
2. LLM (or fixture) → OpenSCAD text.
3. Sanitize / validate (no network, no filesystem escapes); run OpenSCAD in a subprocess with a timeout.
4. Parse the STL; check non-empty, volume, triangle count, edge-manifold / watertight-ish.
5. Preview in Three.js (`react-three-fiber`).
6. Download **STL** and **3MF** (plus the `.scad` source).

Printability report: bounding box (mm), volume, triangle count, manifold flag, and obvious issues (empty mesh, zero volume, huge triangle count, oversized, undersized).

## Success paths

- **No API key:** example prompts (or any matched heuristic) compile → STL → viewer → download.
- **With API key:** a simple part description yields a downloadable STL. One automatic retry includes compiler/mesh error text.

Run as a Node process (`next dev` / `next start`). V0 is not aimed at serverless-only hosts: it needs to spawn OpenSCAD.

## Tests

```bash
npm test
```

Covers code sanitization and the mesh-check / STL / 3MF path. If OpenSCAD is installed, an integration test compiles the default fixture.

## Out of V0

Style2Fab, neural organic mesh, FEA / MechStyle, multi-agent CAD, and full Bambu Studio / Orca slicer integration.

## Roadmap after V0

Priority order from the product owner (not in V0):

1. **Wearable / cosplay sizing** — S/M/L/XL plus measurement charts; auto-scale the model; show the assumed size.
2. **Raised etchings / emboss** — from a description (and later images) that print as visible relief.
3. **Articulated / functional assemblies** — real joints with print clearances, multi-part export, and material-aware thickness/strength so moving parts (e.g. robot arms) don’t break.
4. **Print doctor** — user describes print defects (e.g. stringing with nylon PA); the system diagnoses likely causes for the **selected printer/material** (default **Bambu Lab P2S**) and proposes or auto-applies setting fixes; then a feedback loop (still bad vs perfect). In-app only — not a separate slicer or DCC.
5. **Image import as starting point** — user uploads a photo; the system reconstructs a **clean printable model**. By default, use light intelligence to **repair** broken or damaged parts (fill cracks, restore missing chunks). Do **not** preserve wear unless the user asks to keep it.

V0 stays **describe → CAD → STL/3MF**. Image import and Print doctor are after V0.

All of the above ship **inside the web UI** (preview + printable export). None of them assume Blender or another DCC after the fact.

**Printer profiles (later, not a V0 blocker):** in-app picker to change printer and print settings (layer height, nozzle, material). Default remains Bambu Lab P2S. Long-term the core path slices in-app so users do not need a separate slicer; V0 only exports STL/3MF against the P2S stub profile. Print doctor uses that same selected profile.

## Extension points (later)

- **Describe-to-modify** — send the previous OpenSCAD plus “make the hole 8 mm”.
- **Style2Fab-style edit** — in-app stylization while keeping functional regions (not a Blender plugin).
- **Organic mesh** — swap the OpenSCAD backend for a neural / implicit generator, still exported from the app.

See `FutureEditMode` in [`lib/types.ts`](lib/types.ts). The pipeline is already split so those backends can sit beside `runGeneratePipeline`.

## License

MIT
