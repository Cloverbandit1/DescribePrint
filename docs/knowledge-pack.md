# Knowledge pack (characters + tech)

Curated **in-repo** references for SMART_PIPELINE / the plan pass. The planner and codegen consult this pack when a prompt names a known character or tech keyword. Unknown names are omitted — generate continues.

This is **not** a live web crawl, not official licensed measurements, and not a RAG product. It is a versioned stub the planner can actually use for millimeters, proportions, and print-aware notes.

## Where it lives

| Path | Role |
| --- | --- |
| [`lib/knowledge/pack.json`](../lib/knowledge/pack.json) | Versioned entries (`meta.version`) |
| [`lib/knowledge/schema.ts`](../lib/knowledge/schema.ts) | Types + `validateKnowledgePack` |
| [`lib/knowledge/index.ts`](../lib/knowledge/index.ts) | Prompt match, plan seed, notes |
| [`scripts/validate-knowledge-pack.ts`](../scripts/validate-knowledge-pack.ts) | `npm run knowledge:validate` |

Cross-links (do not copy stale numbers into the JSON when a live module already owns them):

- Printer volume / nozzle / material auto-best → [`lib/printers.ts`](../lib/printers.ts)
- Joint radial/axial tables → [`lib/joints.ts`](../lib/joints.ts)
- Fit wizard S/M/L + explicit mm → [`lib/fits.ts`](../lib/fits.ts) (reuses joints.ts; do not fork those numbers)
- Wearable S–XL charts → [`lib/wearable-sizes.ts`](../lib/wearable-sizes.ts)
- Oversize designation → [`lib/alternate-machines.ts`](../lib/alternate-machines.ts)

## Schema (v1.1)

```json
{
  "meta": {
    "version": "1.1.0",
    "kind": "describeprint-knowledge-pack",
    "updated": "YYYY-MM-DD",
    "curated": true,
    "live_web_crawl": false,
    "notes": "explain the stub limit"
  },
  "characters": [
    {
      "id": "kebab-id",
      "name": "human label",
      "category": "helmet | prop | armor | bust",
      "wearableCategory": "helmet_mask",
      "aliases": ["words the user might type"],
      "reference_mm": { "x": 230, "y": 270, "z": 280 },
      "printable_mm": { "x": 165, "y": 195, "z": 200 },
      "features": [{ "name": "visor", "kind": "opening", "dims_mm": { "w": 110, "h": 28 }, "notes": "…" }],
      "notes": ["honest limits"],
      "sources": ["why these millimeters"]
    }
  ],
  "tech": [
    {
      "id": "petg",
      "name": "PETG",
      "category": "material | nozzle | layer | joint | printer | technique",
      "aliases": ["petg"],
      "crossLinks": { "filament": "petg", "printer": "bambu-lab-p2s", "joints": true },
      "planHints": { "layer_height_mm": 0.2, "nozzle_mm": 0.4 },
      "notes": ["print-aware hint"]
    }
  ]
}
```

- `reference_mm` = typical 1:1 / wearable envelope (may exceed the P2S 256³ bed).
- `printable_mm` = default plan size that fits the current printer. Used unless the user asks for 1:1 / wearable / life-size.
- `id` is `[a-z][a-z0-9-]*` and unique across characters + tech.
- Extra JSON keys are allowed; required fields are not.

## How to add an entry

1. Edit `lib/knowledge/pack.json`.
2. For a **character / prop**: pick a kebab `id`, human `name`, `aliases` the user will actually type, both millimeter envelopes, a few named features, honest notes, and a source line. Use `wearableCategory` when a wearable chart applies.
3. For **tech**: prefer a `crossLinks` pointer (`filament`, `printer`, `joints`) over duplicating live tables. Add `aliases` that are specific (`petg`, `0.4 mm nozzle`) — do not alias generic words like `bed` or `part`.
4. Bump `meta.version` (semver) and set `meta.updated` to today when the published set changes.
5. Keep `meta.live_web_crawl` **false**. Do not add a crawler.
6. Validate:

```bash
npm run knowledge:validate
npm test
```

## How the plan pass uses it

1. `buildPlanPrompt` appends a pack excerpt when the prompt matches.
2. `normalizeCadPlan` seeds `overall_mm` + missing features from the pack, then still applies bed / wall / hole rules.
3. Job notes get a one-line pack summary (fixture path included).
4. No match → `knowledge` is omitted. Invalid pack JSON fails open to an empty pack (generate does not crash).
5. Named character without display vs 1:1 / wearable → the plan marks `needs_user_choice` and the Prepare chat shows scale chips. Pack growth is deferred; interactive choices own that fork.

## How to verify

```bash
npm run knowledge:validate
npm test -- tests/knowledge-pack.test.ts tests/pipeline.test.ts tests/llm.test.ts
```

Prompts that should hit the pack:

- `stormtrooper helmet` → display 165×195×200 mm + dome/visor/neck_ring features
- `mandalorian helmet` → display 170×200×195 mm + dome/t_visor/cheek/rangefinder
- `wearable mandalorian helmet` → 1:1 reference 235×280×270 mm (exceeds P2S)
- `captain america shield` → display 200 mm disc; 1:1 is ~610 mm (not a licensed spec)
- `20mm cube with 5mm hole in PETG` → PETG tech notes (dry spool, 0.2 mm layer, P2S auto-best)
- `20mm cube with a 0.6 mm nozzle` → 0.6 mm nozzle + 2.4 mm wall hint (printers.ts supported set)
- `clip with a cantilever snap` → snap-fit notes from joints.ts (0.3 mm/side, 1.6 mm beam)
- `xyzzy warrior helmet` → no character hit, no crash

v1.1 is still a **curated stub**: typical fan-print bands and print-tech cross-links, not official licensed measurements, not a live crawl. Remaining gaps: more characters, more materials than the five FilamentIds, no RAG.
