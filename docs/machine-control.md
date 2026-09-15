# Machine control (P2S + AMS)

This is the first **printer/machine-control** slice for DescribePrint. It is **not** live send-to-printer, not a digital-twin farm, and not a slicer. CAD generation stays in Allos CAD Core. Windows installers and `/api/health` stay in Allos Desktop Pack (M1).

Default machine remains **Bambu Lab P2S** with one **AMS (4 slots)**.

## What this slice ships

1. A richer P2S **profile** (volume, nozzles, AMS 4 slots, temp limits, PLA/PETG/ABS/TPU auto-best tables) in [`lib/printers.ts`](../lib/printers.ts).
2. A **pluggable machine adapter** interface, a **mock** adapter, and typed stubs for live status, AMS slots, mid-print commands, 3MF→AMS mapping, and a remaining-layer reshape **planner** (ask CAD later — do not rewrite geometry here).
3. A **Print doctor** keyword/rule stub: plain-language defect or machine complaint → structured diagnosis + proposed setting or physical steps. No LLM and no LAN I/O.
4. A **camera / failure-detect stub** (flag off by default) and **AMS feed-loop autofix** (flag off by default).

The Print column shows a compact **Machine** panel. Everyday path: toggle **LAN MQTT**, enter IP / serial / LAN access code (saved in the browser). Off stays disconnected / mock. On with incomplete fields stays mock and shows a short hint — no crash. Env `BAMBU_LAN_MQTT=1` plus creds is a headless/dev override. Live P2S/AMS status and tiny pause/resume/speed/temp controls appear when connected. Chat can route a complaint to Print doctor **without** calling the CAD generate path. STL/3MF export still works with no printer.

## What this slice does not ship

- Bambu Cloud, a real camera stream, send-to-printer FTPS, or remaining-layer CAD reshape
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
        remaining-layer reshape planner (stub)
                 │
                 ▼
        “pause now / remaining height H / ask CAD to restyle”
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
3. If software cannot fix it, return simple physical steps (“pull filament from AMS 2, check PTFE, retry”).

Live reports can also raise an `amsHint` from `ams_status` / AMS-family `print_error` (HMS `0C…` hopper/feed). The mock adapter can `injectAmsFeedLoop(slot)` so CI proves pause-then-autofix vs diagnose-only without a printer.

Chat-first: a complaint hits `/api/machine` with `{ complaint }`. When the flag is off the doctor result is diagnosis only — no `adapter.send`. When on, the same path pauses then autofixes (or returns physical steps).

### Print doctor

[`lib/print-doctor.ts`](../lib/print-doctor.ts) is a small, testable keyword matcher. It is printer- and material-aware (P2S + the selected or inferred filament). Fixes are either:

- **setting** — proposed (and marked `autoApplicable` when a later adapter could apply them)
- **physical** — simple hands-on steps when software cannot fix hardware

No CAD rewrite. No LLM. Chat-first: “stringing with PETG” or “AMS 2 keeps looping feed/unfeed”.

### Multi-filament 3MF → AMS

[`lib/machine/ams.ts`](../lib/machine/ams.ts) maps a design filament list (type + optional color) onto loaded AMS slots:

1. exact type + color
2. type only
3. unmapped (user must load or pick a slot)

V0 3MF export is still single-material. The mapper is the hook for multi-filament 3MF later.

### Mid-print adjust

`pause`, `resume`, `set-speed`, `set-nozzle-temp`, `set-bed-temp` are typed commands. **Risky** commands (nozzle/bed temp while printing) must **pause first**. Mock and `bambu-lan` both enforce that. Safe commands do not pause.

### Remaining-layer reshape (planner stub only)

[`lib/machine/reshape.ts`](../lib/machine/reshape.ts) can say:

- pause now
- remaining height H (and remaining layers when known)
- ask CAD Core to restyle only the unprinted remainder

It does **not** edit OpenSCAD, STL, or 3MF. Geometry reshape belongs to CAD Core.

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

`npm test` must pass **without** a physical printer. Coverage targets: profile tables, doctor diagnoses, AMS mapping, pause-before-risky, mock connection state machine, flag off = mock, UI toggle + incomplete creds = mock + hint, UI toggle + complete creds selects `bambu-lan` without setting the env flag, env override still works, live adapter + fake/unhealthy endpoint fails safe without leaking secrets, camera stub `detectFailure` (stub only), live poll + detect (flag off = no detect; flag on + mock `none` = `camera: ok`; injected spaghetti / scrape / empty-bed surfaces on the panel and doctor without auto-pause), AMS autofix flag off (no commands) vs flag on (pause then autofix or physical steps).

## Sources

- [Bambu Lab P2S technical specifications](https://bambulab.com/en/p2s/specs)
- [P2S FAQ (Bambu Lab Wiki)](https://wiki.bambulab.com/en/p2s/manual/p2s-faq)
- [Enable Developer Mode (P2S / H2)](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode)
- [OpenBambuAPI MQTT notes](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md)
