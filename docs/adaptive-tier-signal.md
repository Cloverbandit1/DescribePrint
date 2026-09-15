# Adaptive qwen tier signal (CAD Core ↔ Desktop Pack)

CAD Core reads a **host contention signal** and switches the local generate
model among **`qwen2.5-coder:32b` ↔ `14b` ↔ `7b` only**. Agent Smith models
(`smith-minicpm5`, `openbmb/minicpm5-*`, anything matching `minicpm5`) are
never selected, pulled, deleted, or retargeted.

Desktop Pack may write this signal from its own adaptive-throttle work. **Do
not** rewrite Desktop Pack auto-start / sleep scripts from CAD Core — only
this small contract.

## Default when the host is clear

`MODEL` unset or `qwen2.5-coder:32b` → **32b**. Adaptive throttle only steps
down while a fresh contention signal (or env override) says the host is busy.

`MODEL=qwen2.5-coder:14b` or `:7b` is a **ceiling**. Throttle may step lighter,
never heavier than that pin. Cloud / non-qwen `MODEL` values are left alone.

## Signal sources (highest last)

CAD merges, then applies hysteresis:

1. **Default** — `{ contention: "clear" }`
2. **File** — `DESCRIBEPRINT_HOST_SIGNAL_PATH`, else the well-known path
   (Windows `%LOCALAPPDATA%\DescribePrint\host-signal.json`,
   macOS `~/Library/Application Support/DescribePrint/host-signal.json`,
   Linux `${XDG_STATE_HOME:-~/.local/state}/describeprint/host-signal.json`)
3. **HTTP GET** — `DESCRIBEPRINT_HOST_SIGNAL_URL` (same JSON). Used only when
   no usable file is present. CAD never POSTs.
4. **Env overrides** (operator / pack launch env):
   - `DESCRIBEPRINT_HOST_CONTENTION` = `clear` | `busy` | `heavy`
     (aliases: `0`/`ok`, `1`/`true`, `2`/`critical`)
   - `DESCRIBEPRINT_HOST_LOAD` = `0.0`–`1.0` (`≥ 0.55` → busy, `≥ 0.80` → heavy)
   - `DESCRIBEPRINT_TIER` = `32b` | `14b` | `7b` (or the full `qwen2.5-coder:*` name)

CAD **never writes** the signal file. Desktop Pack owns create/update/delete.

## JSON schema (version 1)

```json
{
  "version": 1,
  "contention": "clear",
  "load": 0.42,
  "suggestedTier": "14b",
  "updatedAt": "2026-09-15T19:00:00.000Z"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `version` | no | Document as `1` |
| `contention` | yes* | `clear` \| `busy` \| `heavy`. `status` is accepted as an alias |
| `load` | no | `0`–`1`. Used when `contention` is omitted or to reinforce it |
| `suggestedTier` | no | `32b` \| `14b` \| `7b`. Aliases: `tier`, or `model` (`qwen2.5-coder:14b`) |
| `updatedAt` | no | ISO-8601. Signals older than `DESCRIBEPRINT_HOST_SIGNAL_STALE_MS` (default 90s) are treated as **clear** |

`suggestedTier` is a hint. CAD still applies hysteresis and the `MODEL` ceiling,
and will not land on a tier that the last health probe marked missing when a
lighter installed qwen tier exists.

## Hysteresis

- **Step down** after **1** busy/heavy sample (`DESCRIBEPRINT_TIER_STEP_DOWN_STREAK`).
  `busy` moves one tier (32b→14b). `heavy` may jump to 7b when that weight is installed.
- **Step up** one tier at a time after **3** consecutive clear samples **and**
  `DESCRIBEPRINT_TIER_STEP_UP_COOLDOWN_MS` (default 15s) since the last change.
- Holding 14b/7b while the host stays busy does **not** bank step-up credit.

## Generate queue

Overlapping `/api/generate` (and `completeChat`) jobs **wait in order**. They
are not dropped when the tier is switching or the host is contended. The SSE
`queued` event may say “Waiting for the previous local AI job…”.

The active tier is pinned for the duration of a queued job so plan + codegen
use the same qwen weight.

## Health / Local AI badge

`GET /api/health` → `localAi.label` is `Local AI · 32b` (or `14b` / `7b`).
`localAi.model` is the **active** completion model. `localAi.tips` mention the
active tier and that jobs stay queued. Header chip already renders that label.

## Verify step-down / step-up

```bash
# Step down to 14b
printf '%s\n' '{"version":1,"contention":"busy","updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}' \
  > /tmp/dp-host-signal.json
DESCRIBEPRINT_HOST_SIGNAL_PATH=/tmp/dp-host-signal.json curl -s localhost:3000/api/health \
  | jq '.localAi | {label,model,activeTier,contention}'
# expect model qwen2.5-coder:14b, label "Local AI · 14b"

# Heavy → 7b
printf '%s\n' '{"version":1,"contention":"heavy","updatedAt":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"}' \
  > /tmp/dp-host-signal.json
# refresh health twice if you jumped from 32b in one process that already sat on 14b

# Step up: write contention=clear (or delete the file) and wait 3 health polls
# after the 15s cooldown. Expect 7b → 14b → 32b, one hop per qualifying refresh.
```

Env-only equivalent: `DESCRIBEPRINT_HOST_CONTENTION=busy`.

## Remaining stubs

- CAD does not sample RAM/CPU itself — Desktop Pack (or the host) must publish
  the signal. No implicit read of Desktop Pack auto-start / sleep files.
- HTTP signal is GET-only; no auth handshake in this slice.
- Missing lighter weights: CAD stays on the heaviest **installed** qwen tier
  at or below the target when a health probe has run; it will not invent a
  pull of Agent Smith.
- iPhone / PWA chrome is unchanged; the desktop header badge uses health JSON.
