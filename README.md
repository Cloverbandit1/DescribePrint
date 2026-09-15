# DescribePrint

Describe anything in plain language and get a **printable 3D model** (STL + 3MF), with a real preview.

V0 is the **create** path for parametric / mechanical parts: a chat-style web app, an OpenSCAD generation pipeline, mesh checks, and downloads. You can run the whole loop without a live LLM via the fixture/mock path.

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

1. Chat UI: prompt, optional size/units, generate, streaming status.
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

Style2Fab, neural organic mesh, FEA / MechStyle, multi-agent CAD, slicer integration.

## Roadmap after V0

Priority order from the product owner (not in V0):

1. **Wearable / cosplay sizing** — S/M/L/XL plus measurement charts; auto-scale the model; show the assumed size.
2. **Raised etchings / emboss** — from a description (and later images) that print as visible relief.
3. **Articulated / functional assemblies** — real joints with print clearances, multi-part export, and material-aware thickness/strength so moving parts (e.g. robot arms) don’t break.

## Extension points (later)

- **Describe-to-modify** — send the previous OpenSCAD plus “make the hole 8 mm”.
- **Style2Fab-style edit** — stylize a mesh while keeping functional regions.
- **Organic mesh** — swap the OpenSCAD backend for a neural / implicit generator.

See `FutureEditMode` in [`lib/types.ts`](lib/types.ts). The pipeline is already split so those backends can sit beside `runGeneratePipeline`.

## License

MIT
