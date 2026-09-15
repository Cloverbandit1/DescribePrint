# Machine control (P2S + AMS)

This is the first **printer/machine-control** slice for DescribePrint. It is **not** live send-to-printer, not a digital-twin farm, and not a slicer. CAD generation stays in Allos CAD Core. Windows installers and `/api/health` stay in Allos Desktop Pack (M1).

Default machine remains **Bambu Lab P2S** with one **AMS (4 slots)**.

## What this slice ships

1. A richer P2S **profile** (volume, nozzles, AMS 4 slots, temp limits, PLA/PETG/PA/ABS/TPU auto-best tables) in [`lib/printers.ts`](../lib/printers.ts). The Machine panel material picker applies those tables as visible smart defaults. Export writes the same snapshot into 3MF metadata plus `describeprint.print.json`. Presets are **advisory** — they never send pause/resume/temp over LAN.
2. A **pluggable machine adapter** interface, a **mock** adapter, and typed stubs for live status, AMS slots, mid-print commands, 3MF→AMS mapping, and a remaining-layer reshape **stub** (pause → CAD-handoff plan → reslice stub; never auto-resume).
3. A **Print doctor** keyword/rule stub: plain-language defect or machine complaint → structured diagnosis + proposed setting or physical steps. No LLM and no LAN I/O.
4. A **camera / failure-detect stub** (flag off by default), **AMS feed-loop autofix** (flag off by default), and **emergency remaining-layer reshape** (flag off by default).
5. A **smart plate-packing stub** — largest-first shelf layout of current-job AABBs (or N copies) on the P2S 256×256 mm bed. Layout only; no LAN and no farm enqueue.
6. A **print time / filament / cost estimate stub** — compact line above Print from mesh volume (or AABB) × infill × density, using the selected material preset. Advisory only.
7. A **project pack export stub** — one zip with the current 3MF (and STL), template build steps, and vendor-agnostic shopping search terms. Empty plate disables the button.
8. An **AMS slot plan** on 3MF export (and the project-pack sidecar): live trays when connected, otherwise the selected preset. The Machine panel shows slot → material/color and lets the user reassign trays.

The Print column shows a compact **Machine** panel. Everyday path: toggle **LAN MQTT**, enter IP / serial / LAN access code (saved in the browser). Off stays disconnected / mock. On with incomplete fields stays mock and shows a short hint — no crash. Env `BAMBU_LAN_MQTT=1` plus creds is a headless/dev override. Live P2S/AMS status and tiny pause/resume/speed/temp controls appear when connected. Chat can route a complaint to Print doctor **without** calling the CAD generate path. STL/3MF export still works with no printer.

## What this slice does not ship

- Bambu Cloud, a real camera stream, send-to-printer FTPS, or remaining-layer CAD mesh generation (Print Control emits a CAD-handoff plan only)
- Changes to Ollama host/port or Agent Smith models
- M1 Desktop Pack files (`Start-DescribePrint.cmd`, `scripts/windows/`, `packaging/windows/`, `/api/health`, OpenSCAD path discovery)

## Architecture

```
Chat / Print column
        │
        ├─ looks like a defect? ──► print-doctor (rules) ──► diagnosis + fixes
        │
        └─ describe a part? ─────► CAD Core (unchanged) ──► STL / 3MF
                                            │
                                   3MF filament plan (stub)
                                            │
                                   mapDesignFilamentsToAms()
                                            │
MachineAdapter (interface)
        ├─ mock          ◄── default; tests + disconnected UI
        └─ bambu-lan     ◄── Machine panel toggle + access code, or BAMBU_LAN_MQTT=1 + env creds
                 │
                 ▼
        LiveMachineStatus (temps, layer, AMS slots, optional amsHint)
        MidPrintCommand  (pause / resume / speed / temp / AMS stop-feed + retry-load)
                 │
                 ▼
        remaining-layer reshape stub (RESHAPE_REMAINING, default OFF)
                 │
                 ▼
        pause → CAD-handoff plan → reslice stub (never resume)
```

### Pluggable adapter

[`lib/machine/adapter.ts`](../lib/machine/adapter.ts) is the only machine I/O seam. Every printer family implements `MachineAdapter`:

- `connect` / `disconnect` / `status`
- `send(MidPrintCommand)` for mid-print adjust

Register new machines with `registerMachineAdapter`. The default id is `mock`. `bambu-lan` is registered and selected when:

1. The Machine panel turns **LAN MQTT** on and all three credential fields are filled (everyday path), or
2. `BAMBU_LAN_MQTT` is on and `BAMBU_HOST` / `BAMBU_SERIAL` / `BAMBU_ACCESS_CODE` are all set (headless/dev override).

`MACHINE_ADAPTER=mock` always wins, so CI cannot be forced onto LAN. `MACHINE_ADAPTER=bambu-lan` without the panel session or flag+creds still falls back to mock. Incomplete UI creds also stay on mock.

Credentials (`host`, `serial`, `accessCode`) are typed and validated as strings only. Everyday use stores them in browser `localStorage` (`describeprint.machine.lan`). Env vars remain a valid override. **Never commit them. Never log the access code.** The API never returns the access code.

### Farm registry + queue (stub)

[`lib/machine/farm.ts`](../lib/machine/farm.ts) is an in-app list of machines (`id`, `name`, `printerId`, `adapterId` mock | bambu-lan, optional host/serial/notes). It is **not** live multi-send.

- Seeded with the current default **Bambu Lab P2S**. Adding **P2S-2** (and further stubs) does not require LAN credentials.
- `FarmRegistry` supports list / get / add / remove / select. The client persists the snapshot in `localStorage` (`describeprint.machine.farm`). The server keeps only an in-memory selected machine so `/api/machine` stays mock-safe.
- The Machine panel shows the selected name, a compact selector, and a count (`1 machine` / `2 machines`). Selecting switches which machine the existing monitor / doctor talks to **through the current adapter factory** — still mock unless that machine’s LAN path has the existing flag+creds. Registry add/select/remove never write MQTT or blast commands across the farm.
- `FarmJob { id, machineId, status: queued | active | done }` plus a local **queue worker stub** ([`lib/machine/farm-queue.ts`](../lib/machine/farm-queue.ts)): `enqueue` (selected machine by default; optional first-free = machine with no `active` job), `tick`/`advance` (`queued → active → done`), `listByMachine`, `clearDone`. Simulation only — sync ticks, never adapter `send` / connect / MQTT / pause / resume. Queue rows persist in the same `describeprint.machine.farm` blob. Real send-across-farm is later.
- Machine panel Queue section: job id/status lines, **Enqueue (stub)**, **Tick**, **Clear done** (and **First free** when more than one machine). Clicking enqueue does not send LAN commands.

No `FARM_REGISTRY` flag: one default machine is today’s single-printer path.

### Smart plate packing (stub)

[`lib/machine/plate-pack.ts`](../lib/machine/plate-pack.ts) arranges one or more part footprints on the default **P2S** bed (`defaultPrinter().buildVolumeMm` = 256×256×256 mm).

- Inputs are `PackPart { id, widthMm, depthMm, heightMm? }` from the current generate/import mesh AABB (`report.boundingBoxMm`). Multi-part is **N copies** of that footprint — the in-memory job map is one current result, not a multi-body plate list. Fixtures are not fabricated into extra geometry.
- `packPlate()` is a largest-first **shelf** packer (0° / 90° only) with a 2 mm plate margin and 3 mm clearance. A single fitting part is centered. `x`/`y` are the min-corner from the front-left plate origin.
- `PackPlan { placements, plateMm, fitted, message }` — if a part cannot fit (even after 90°), `fitted` is false and the message suggests rotate-90 / split. The stub does **not** invent mesh, rewrite OpenSCAD, or send LAN / enqueue.
- Machine panel **Pack plate (stub)** plus a copies stepper. Placements list in the panel; optional blue outlines on the Viewer plate. The live STL preview is unchanged (no mesh transform).

### LAN MQTT (flagged)

P2S LAN control uses **MQTT over TLS** (not Bambu Cloud):

1. On the printer: **LAN Only**, then **Developer Mode** (required on P2S / H2 for MQTT writes). The 8-digit LAN access code is on that settings page.
2. Broker: `mqtts://{BAMBU_HOST}:8883` (override with `BAMBU_MQTT_PORT`). Username `bblp`, password = access code. Printers use a self-signed cert; the adapter does not verify it.
3. Topics (observed community / OpenBambuAPI contract): subscribe `device/{serial}/report`, publish `device/{serial}/request`. After connect the adapter sends `pushing.pushall` for a full status dump.
4. Status fields mapped when present: `gcode_state`, `nozzle_temper` / `nozzle_target_temper`, `bed_temper` / `bed_target_temper`, `layer_num` / `total_layer_num`, `mc_percent`, `spd_mag` / `spd_lvl`, AMS `tray_type` / `tray_color` / `remain`.
5. Commands: `print.pause`, `print.resume`, `print.print_speed` (levels 1–4), temps via `print.gcode_line` (`M104` / `M140`). Risky temps still **pause first**. If a publish fails, the adapter returns Print-doctor-style physical steps (use the P2S screen).

`GET /api/machine` auto-connects only when the live adapter is selected (panel session or env override). Default / CI: mock snapshot, no sockets. The panel POSTs `{ lan, credentials }` to configure the in-memory session, then polls GET so temps / layer / AMS update live. An unhealthy host fails safe (`error` / not connected, no throw, secrets redacted).

FTPS, camera, and send-to-printer are out of scope.

### Live monitor

[`lib/machine/types.ts`](../lib/machine/types.ts) defines `LiveMachineStatus`:

- connection: `disconnected` → `connecting` → `connected` | `error`
- print: `idle` | `printing` | `paused` | `finished`
- nozzle/bed current + target °C
- layer / total layers / progress
- AMS slots: type, color, remaining % when the protocol exposes them

[`useMachineMonitor`](../lib/machine/use-machine-monitor.ts) is the client hook: it persists the toggle + three fields in `localStorage`, configures the server session, and polls `/api/machine` every few seconds so the panel updates while connected (temps, layer/progress, AMS, connection). LAN off keeps the disconnected stub. Live + connected shows status and tiny controls. When the camera stub is on, each poll also runs one `detectFailure()` on a mock frame and includes `cameraDetect` (and a print-doctor hint if suspected). Flag off skips detect.

### Camera stub (flagged, default OFF)

No real camera stream. [`lib/machine/camera.ts`](../lib/machine/camera.ts) is a typed stub so a later revision can attach a LAN JPEG (`futureLanJpegUrl`) and classify failures (spaghetti, nozzle scrape, empty bed).

- Off unless `BAMBU_CAMERA_STUB=1` **or** the Machine-panel **Camera stub** checkbox is on (also off by default; saved in `localStorage`).
- When on, each `/api/machine` poll runs one stub `detectFailure()` (mock frames only). The panel shows a tiny `camera: ok` or `camera: suspected spaghetti` (or scrape / empty bed) line.
- A suspected failure feeds Print doctor as a chat-first hint (pause + physical/settings steps). It does **not** send printer commands or auto-stop the job. `AMS_AUTOFIX` still only applies to AMS feed-loop.
- `detectFailure()` returns `none` or `suspected-failure` with a print-doctor-style hint. Tests use the stub only — no pixels, no sockets.

### AMS feed-loop autofix (flagged, default OFF)

Print doctor always diagnoses “AMS 2 keeps looping” (and similar). Commands are sent **only** when `AMS_AUTOFIX=1`:

1. Safe **pause** if a job is printing.
2. Software autofix through the machine adapter: `ams-stop-feed` then `ams-retry-load` on that slot. On LAN MQTT these map to verified OpenBambuAPI writes: `print.ams_control` `param: "pause"` and `print.ams_change_filament` (0-based tray id).
3. If software cannot fix it, escalate to the richer slot-specific physical guide (numbered steps for AMS 1–4).

Live reports can also raise an `amsHint` from `ams_status` / AMS-family `print_error` (HMS `0C…` hopper/feed). The mock adapter can `injectAmsFeedLoop(slot)` so CI proves pause-then-autofix vs diagnose-only without a printer.

Chat-first: a complaint hits `/api/machine` with `{ complaint }`. When the flag is off the doctor result is diagnosis + physical steps only — no `adapter.send`. When on, the same path pauses then autofixes (or returns the richer physical guide).

### AMS physical-step guides

[`lib/machine/ams-help.ts`](../lib/machine/ams-help.ts) is a small table of structured guides `{ id, symptom, slot?, steps, whenToRetrySoftware? }`:

| id | Symptom |
| --- | --- |
| `ams-feed-loop` | Feed/unfeed loop |
| `ams-load-failed` | Can’t load |
| `ams-spool-empty` | Spool empty / runout |
| `ams-tangled-spool` | Tangled / stuck spool |
| `ams-wet-pa` | Wet PA / nylon (dryer) |
| `ams-ptfe-path` | PTFE path check / jam |

Wording interpolates the live slot (`AMS 2`) from chat, status, or the slot plan when known. Print doctor attaches `amsGuide` so Perfect/Still bad memory can key off the guide id. Live hopper/feed hints can also raise the feed-loop guide on the Machine-panel **AMS help** expand — still no LAN writes unless `AMS_AUTOFIX` is on.

### Print doctor

[`lib/print-doctor.ts`](../lib/print-doctor.ts) is a small, testable keyword matcher. It is printer- and material-aware (P2S + the selected or inferred filament). Fixes are either:

- **setting** — proposed (and marked `autoApplicable` when a later adapter could apply them)
- **physical** — simple hands-on steps when software cannot fix hardware

Chat can also say “use PETG settings” or “best for PA” to switch the Machine-panel material and apply that table. Those presets stay advisory (panel + export metadata). No CAD rewrite. No LLM. Chat-first: “stringing with PETG” or “AMS 2 keeps looping feed/unfeed”.

After a diagnosis, say **perfect** / **still bad** (or tap the tiny chips under the last doctor reply):

- **Perfect** stores the diagnosis + proposed fix in browser `localStorage` (`describeprint.machine.printDoctorMemory`), keyed by `{ printerId, material, symptom }`. The next similar complaint prefers that fix. Empty entries are omitted.
- **Still bad** marks the last suggestion rejected, then tries the next unused tweak for that symptom, the next likely cause from the rule table, or physical steps. Feedback never sends LAN commands.

This is Print Control memory only — not CAD version history / describe-edit undo.

### Time / filament / cost estimate (stub)

[`lib/machine/print-estimate.ts`](../lib/machine/print-estimate.ts) shows an approximate **estimate (stub)** in the Print column (above Print, under the material presets):

- Volume: current job `report.volumeMm3` (STL / mesh signed volume) when present; otherwise the same AABB `report.boundingBoxMm.size` product packing uses.
- Filament: volume × **20% infill** × approximate density (PLA 1.24 / PETG 1.27 / PA 1.14 / ABS 1.04 / TPU 1.21 g/cm³ — typical slicer / datasheet constants, not a spool lot).
- Time: plastic volume ÷ (`printSpeedMms` × `nozzleMm` × `layerHeightMm` × flow) from the selected P2S auto-best preset (default PLA, 0.2 mm layer).
- Cost: grams × user-editable **$/kg** (defaults $20 / $25 / $45 / $22 / $35). Overrides stay in `localStorage` (`describeprint.estimate.costPerKg`).

Empty plate → “Print something first”. Line looks like `~1h 5m · 12 g · $0.24 (stub)`. Recalculates when the result or material changes. No LAN, no farm enqueue, no packing change.

### Project pack export (stub)

[`lib/machine/project-pack.ts`](../lib/machine/project-pack.ts) builds one downloadable zip from the current job:

- `describeprint.3mf` (the existing 3MF writer output) and `describeprint.stl` when present
- `STEPS.md` — template orientation / material / AMS-slot / post-process notes labeled as a stub
- `SHOPPING.md` + `shopping.json` — vendor-agnostic search placeholders (e.g. `PLA 1.75 mm — search: Bambu PLA Basic`). Not store URLs or affiliate claims
- optional `estimate.json` and `print_preset.json`

Print column **Download pack** sits next to STL / 3MF. Empty plate → disabled + “Print something first”. Reuses [`lib/threemf.ts`](../lib/threemf.ts); single-file downloads stay unchanged. No LAN, no farm, no user-profile store.

### Auto-best material presets

The Print column material picker (default **PLA**) reads [`P2S_FILAMENT_PRESETS`](../lib/printers.ts). **PA / nylon** is a P2S-safe table: higher nozzle/bed within 300 °C / 110 °C, low fan, dryer + closed-door notes. Choosing a material updates the compact defaults (temps, speed tier, cooling hint) and stamps the same snapshot onto:

- 3MF model metadata (`DescribePrint:preset_*`) and `Metadata/print_preset.json`
- an adjacent sidecar download (`describeprint.print.json`) next to STL/3MF

No flag. No automatic LAN writes. Advanced knobs stay hidden.

### Multi-filament 3MF → AMS

[`lib/machine/ams.ts`](../lib/machine/ams.ts) maps a design filament list (type + optional color) onto loaded AMS slots:

1. exact type + color
2. type only
3. unmapped (user must load or pick a slot)

`buildAmsSlotPlan()` turns that mapper into an **AMS slot plan** (`AmsSlotPlan { slots: [{ index: 0–3, material, color?, source: live | preset | manual }] }`):

- **Live / connected** — prefer loaded trays (type/color). Empty trays are omitted.
- **Disconnected / mock** — tray 0 is the selected material preset; trays 1–3 stay omitted unless the part declares extra filaments (3MF objects / color regions). No invented geometry.
- **Manual** — Machine-panel reassignment or chat (`use AMS 2 for accent`) marks `source: "manual"`.

The plan is written into 3MF model metadata (`DescribePrint:ams_plan` / `DescribePrint:ams_tray_*`) plus `Metadata/ams_slot_plan.json`. Project pack copies the same sidecar. Single-filament downloads still work. Advisory only — no LAN filament-change commands.

### Mid-print adjust

`pause`, `resume`, `set-speed`, `set-nozzle-temp`, `set-bed-temp` are typed commands. **Risky** commands (nozzle/bed temp while printing) must **pause first**. Mock and `bambu-lan` both enforce that. Safe commands do not pause.

Chat uses the same adapter `send` path as the Machine-panel buttons ([`lib/machine/mid-print-commands.ts`](../lib/machine/mid-print-commands.ts)). Whole-utterance phrases only — CAD prompts such as “pause the hinge clearance” stay on generate.

| Phrase | Command |
| --- | --- |
| `pause now` / `pause the print` / `pause` | safe `pause` |
| `resume` / `continue printing` | `resume` (never sent from reshape / doctor autofix) |
| `slow down` | Bambu level **1** (Silent, 50%) |
| `slow to 50%` / `speed 50%` | nearest of the 1–4 tiers |
| `speed 2` | Bambu level **2** (Standard, 100%) |
| `nozzle 220` / `bed 60` | temp; pause-before-risky while printing |

Bambu `print_speed` mapping (existing `BAMBU_SPEED_LEVELS`):

| Level | Name | Percent |
| --- | --- | --- |
| 1 | silent | 50% |
| 2 | standard | 100% |
| 3 | sport | 124% |
| 4 | ludicrous | 166% |

A percent is snapped to the nearest row before `print.print_speed` is published. Result shows in chat and the Machine panel.

**No surprise LAN.** Commands are sent only when the selected farm machine’s adapter is already connected (LAN MQTT on + connected). Disconnected chat returns “Connect LAN first” plus the on-printer physical tip — no `send`, no fake success. The mock adapter records commands that pass that connected gate so tests can assert phrase → command without a printer.

### Remaining-layer reshape (flagged stub, default OFF)

Chat-first: “reshape the rest”, “emergency reshape remaining layers”, or a **confirmed** camera suspected-failure. Off unless `RESHAPE_REMAINING=1` **or** the Machine-panel **Reshape remaining** checkbox is on (also off by default; saved in `localStorage`).

When **on**:

1. Safe **pause** the live adapter (or record pause-needed on a disconnected mock). **Never resume.**
2. Read live layer / height remaining. The mock can `injectRemainingHeight({ layer, totalLayers, remainingHeightMm })`.
3. Emit a reshape **plan** (not CAD): remaining height H, current Z, pause confirmed, “redesign unprinted upper above Z”.
4. Include a typed **CAD Core handoff** ([`lib/machine/reshape-plan.ts`](../lib/machine/reshape-plan.ts) — `CadReshapeHandoff`) and a **reslice stub** (P2S profile, AMS mapping, `sendGcode: false`).
5. Show the compact plan in chat + Machine panel with **Resume is manual**.

When **off**, Print doctor may still mention reshape as a later option (spaghetti / layer-shift / the reshape phrase). It must **not** pause or emit a live plan (`remainingHeightMm` / `currentZ` / CAD handoff stay empty).

[`lib/machine/reshape.ts`](../lib/machine/reshape.ts) is the orchestrator. Geometry still belongs to Allos CAD Core — this slice does not rewrite OpenSCAD, STL, or 3MF, and does not send gcode.

#### CAD Core handoff (`CadReshapeHandoff`)

For Bella / CAD Core. Print Control emits this; CAD Core consumes it later.

| Field | Meaning |
| --- | --- |
| `owner` | `"allos-cad-core"` |
| `from` | `"allos-print-control"` |
| `kind` | `"redesign-unprinted-upper"` |
| `instruction` | `"redesign unprinted upper above Z"` |
| `currentZ` | Already-printed stump height |
| `remainingHeightMm` / `remainingLayers` | Unprinted remainder |
| `suggestedNextStep` | New OpenSCAD/mesh for the unprinted region only |
| `previousCode` | Optional original-part OpenSCAD from the current generate job / latest in-memory result |
| `stumpCutPlaneBoundsMm` | Optional stump XY bounds at the cut plane (`{ minX, minY, maxX, maxY }` mm) when the job mesh intersects current Z. Omitted when that cut cannot be measured — do not guess from the last-part AABB |
| `layerHeightMm` | Optional layer height (mm): live machine status if present, else the selected material preset (or the last job’s preset). CAD still will not invent `remainingHeightMm` from `remainingLayers` alone |

Do **not** generate that mesh in Print Control.

CAD Core consumes the handoff in [`lib/cad-reshape.ts`](../lib/cad-reshape.ts):

```ts
import { runCadReshapeUpper, parseCadReshapeHandoff } from "@/lib/cad-reshape";
await runCadReshapeUpper({ handoff, prompt, previousCode, fixture: true });
```

Or `POST /api/generate` with `{ prompt, cadHandoff, previousCode?, fixture? }`. After an attempted emergency reshape, the next CAD chat turn sends `cadHandoff` from the doctor plan. The result is the remaining upper only (sits on the cut plane). `cadFeedForReslice` attaches `jobId` / STL / 3MF URLs onto the existing reslice stub (`sendGcode: false`). Resume stays manual.

When the emergency path builds a handoff, Print Control fills those three optionals from real sources and **omits** them when unknown. `remainingHeightMm` / `currentZ` stay live/mock measurements only — never `remainingLayers × layerHeightMm`.

When present, CAD prefers `previousCode`, `stumpCutPlaneBoundsMm`, and `layerHeightMm` from the handoff. XY still falls back to the last part when cut-plane bounds are absent. CAD still refuses to invent `remainingHeightMm` from `remainingLayers` alone, even if `layerHeightMm` is set.

## Profile facts (P2S)

Taken from Bambu’s published P2S specs / FAQ (see sources below):

| Item | Value |
| --- | --- |
| Build volume | 256 × 256 × 256 mm |
| Included nozzle | 0.4 mm (also 0.2 / 0.6 / 0.8) |
| Filament | 1.75 mm |
| Max nozzle | 300 °C |
| Max heatbed | 110 °C |
| Typical AMS | 4 slots (one AMS / AMS 2 Pro). Printer can attach more units later; this slice models the common 4-slot combo. |
| Chamber | Enclosed; **no** active chamber heater |

## Tests

`npm test` must pass **without** a physical printer. Coverage targets: profile tables (including PA), material session parse, doctor diagnoses + “use PETG settings” / “best for PA” / “use AMS 2 for accent”, chat mid-print phrases → mock commands (pause / resume / %→tier / temp) with disconnected = no send and CAD prompts not stolen, 3MF preset metadata / sidecar fields, AMS mapping + **AMS slot plan** (disconnected → tray 0 = selected material, others omitted; live inject 2 slots → plan matches; 3MF metadata contains tray mapping), pause-before-risky, mock connection state machine, flag off = mock, UI toggle + incomplete creds = mock + hint, UI toggle + complete creds selects `bambu-lan` without setting the env flag, env override still works, live adapter + fake/unhealthy endpoint fails safe without leaking secrets, camera stub `detectFailure` (stub only), live poll + detect (flag off = no detect; flag on + mock `none` = `camera: ok`; injected spaghetti / scrape / empty-bed surfaces on the panel and doctor without auto-pause), AMS autofix flag off (no commands) vs flag on (pause then autofix or physical steps), remaining-layer reshape flag off (no pause, no live plan) vs flag on + injected remaining height (pause + plan, no resume, `remainingHeightMm` / `currentZ` present). Handoff optionals (`previousCode`, `stumpCutPlaneBoundsMm`, `layerHeightMm`) are present when a job / live layer height / selected preset exists and omitted when those sources are unknown. `remainingHeightMm` is still not derived from remaining layer count. Farm registry: default one P2S; add / select / remove; selected machine is what adapter `status()` uses; registry ops never perform LAN writes. Farm queue worker: enqueue → `queued`; tick → `active` then `done`; enqueue/tick never select `bambu-lan` or call connect/send. Plate pack: single part fits; two parts pack without overlap; oversized → `fitted: false` + rotate/split advice; placements stay inside the P2S 256×256 mm plate. Print estimate: known cube volume → ballpark grams; material switch changes density/cost; no mesh → null. Project pack: zip includes 3MF + steps + shopping links + `ams_slot_plan.json`; empty result fails cleanly; material name appears in the shopping stub. Print doctor memory: Perfect remembers a fix per printer + filament; Still bad skips that fix next time; PLA memory does not apply to PETG; empty entries omitted; no CAD history imports. AMS physical guides: each id selected from chat; slot interpolation (`AMS 2`); flag off never sends commands; Still bad keys the next guide id.

## Sources

- [Bambu Lab P2S technical specifications](https://bambulab.com/en/p2s/specs)
- [P2S FAQ (Bambu Lab Wiki)](https://wiki.bambulab.com/en/p2s/manual/p2s-faq)
- [Enable Developer Mode (P2S / H2)](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode)
- [OpenBambuAPI MQTT notes](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md)
