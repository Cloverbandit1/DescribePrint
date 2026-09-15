# Machine control (P2S + AMS)

This is the first **printer/machine-control** slice for DescribePrint. It is **not** live send-to-printer, not a digital-twin farm, and not a slicer. CAD generation stays in Allos CAD Core. Windows installers and `/api/health` stay in Allos Desktop Pack (M1).

Default machine remains **Bambu Lab P2S** with one **AMS (4 slots)**.

## What this slice ships

1. A richer P2S **profile** (volume, nozzles, AMS 4 slots, temp limits, PLA/PETG/ABS/TPU auto-best tables) in [`lib/printers.ts`](../lib/printers.ts).
2. A **pluggable machine adapter** interface, a **mock** adapter, and typed stubs for live status, AMS slots, mid-print commands, 3MF→AMS mapping, and a remaining-layer reshape **planner** (ask CAD later — do not rewrite geometry here).
3. A **Print doctor** keyword/rule stub: plain-language defect or machine complaint → structured diagnosis + proposed setting or physical steps. No LLM and no LAN I/O.

The Print column shows a compact **Machine** stub (disconnected, AMS slot count, default filament temps, last doctor result). Chat can route a complaint to Print doctor **without** calling the CAD generate path. STL/3MF export still works with no printer.

## What this slice does not ship

- Real Bambu LAN MQTT/FTPS, cloud, camera, or send-to-printer
- Changes to Ollama host/port or Agent Smith models
- M1 Desktop Pack files (`Start-DescribePrint.cmd`, `scripts/windows/`, `/api/health`, OpenSCAD path discovery)

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
        ├─ mock          ◄── tests + disconnected UI
        └─ bambu-lan     ◄── reserved; not implemented
                 │
                 ▼
        LiveMachineStatus (temps, layer, AMS slots)
        MidPrintCommand  (pause / resume / speed / temp)
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

Register new machines with `registerMachineAdapter`. The default id is `mock`. A future `bambu-lan` id is reserved; this PR must not open sockets.

Credentials (`host`, `serial`, `accessCode`) are typed and validated as strings only. They belong in env or local-only client storage. **Never commit them.**

### LAN connect (later)

Bambu printers historically expose a **local LAN** control path (community stacks typically combine MQTT status/control with file transfer). Topic names, ports, and FTPS details are **not** assumed here. The next implementation step is:

1. Confirm the current P2S LAN protocol against a real device or current public docs.
2. Implement `bambu-lan` behind `MachineAdapter` only.
3. Keep cloud optional/off if LAN works.
4. Read `BAMBU_HOST`, `BAMBU_SERIAL`, `BAMBU_ACCESS_CODE` from env (see `.env.example`). Never log the access code.

Until that adapter exists, `connect()` on the mock flips an in-memory state machine and returns canned `LiveMachineStatus`.

### Live monitor

[`lib/machine/types.ts`](../lib/machine/types.ts) defines `LiveMachineStatus`:

- connection: `disconnected` → `connecting` → `connected` | `error`
- print: `idle` | `printing` | `paused` | `finished`
- nozzle/bed current + target °C
- layer / total layers / progress
- AMS slots: type, color, remaining % when the protocol exposes them

The UI may render a snapshot. There is no live stream in this slice.

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

`pause`, `resume`, `set-speed`, `set-nozzle-temp`, `set-bed-temp` are typed commands. **Risky** commands (nozzle/bed temp while printing) must **pause first**. The mock adapter enforces that. Safe commands do not pause.

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

`npm test` must pass **without** a physical printer. Coverage targets: profile tables, doctor diagnoses, AMS mapping, pause-before-risky, mock connection state machine.

## Sources

- [Bambu Lab P2S technical specifications](https://bambulab.com/en/p2s/specs)
- [P2S FAQ (Bambu Lab Wiki)](https://wiki.bambulab.com/en/p2s/manual/p2s-faq)
