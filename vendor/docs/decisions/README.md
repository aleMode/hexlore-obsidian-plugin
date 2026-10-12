# Decision index

Every design decision of the HexLore Flutter app, one line each, with the
file that holds its record (the WHY, the measurements, the rejected
alternatives). Numbers are stable, so "decision N" anywhere resolves here.
**Read the record before changing that area.**

| File | Decisions |
|---|---|
| `model-and-storage.md` | 1–3, 9–11, 26, 28, 29, 31 |
| `player-view.md` | 4–5b, 17 |
| `map-editing.md` | 6–8d, 18, 25, 27, 30 |
| `rendering.md` | 13–16, 22, 23, 23b, 32, 33 |
| `sketch.md` | 19, 24 |
| `regional-view.md` | 21 |
| `hexlore_flutter/lib/importer/CLAUDE.md` | 12–12l (copied to `importer.md` in the plugin's `vendor/docs/decisions/`) |
| `hexlore_flutter/lib/sync/CLAUDE.md` | 20 |

File names without a folder are in `docs/decisions/`. **Adding a decision:**
write its record in the file for its area, and add one line below.


- **1** — Canonical hex id = axial `(q, r)` → `"q0_r0"`. → `model-and-storage.md`
- **1b** — Terrain = biome + feature (Inkarnate-style split). → `model-and-storage.md`
- **1c** — `PaintPick` (`core/hex_paint.dart`) is the shared paint INTENT → `model-and-storage.md`
- **2** — `Campaign` is the in-memory authority; the player server re-reads files per request → `model-and-storage.md`
- **2b** — A save writes only what carries information → `model-and-storage.md`
- **3** — Markdown is plain `.md` under `pages/`: name-based filenames, the path recorded but never a key. → `model-and-storage.md`
- **4** — `player_filter.filterCampaignForPlayer` is the ONLY path to players, and the player view is MAP-ONLY. → `player-view.md`
- **4b** — A served hex must lie INSIDE the served grid window → `player-view.md`
- **4c** — A hex's feature can be HIDDEN from players, per hex → `player-view.md`
- **5** — Two-layer fog: GM fog is a runtime hatch; player fog is `fogRevealed` + `player/revealed.json`, bulk reveals through `setRevealedBatch`. → `player-view.md`
- **5b** — Line-of-sight reveal → `player-view.md`
- **6** — Seven exclusive canvas tools (`MapTool`, shortcuts 1–7; the ruler is 8, decision 18); `HexMap` is callback-driven, one viewport-culled painter. → `map-editing.md`
- **7** — Regions: named hex SETS drawn as contour + hatch, GM-only, each with a region page and an `## Encounters` table. → `map-editing.md`
- **8** — Routes: highway / road / trail / border along the shared anchor set (corners, edge midpoints, centres); borders GM-only by default. → `map-editing.md`
- **8b** — Rivers walk the SAME anchor lattice as routes → `map-editing.md`
- **8c** — A river's or route's points are EDITABLE on the GM canvas, ONE POINT AT A TIME → `map-editing.md`
- **8d** — A river ENDS at the shore of a sea or lake hex, in a mouth → `map-editing.md`
- **9** — Undo covers map edits only (not text, fog, region create/delete); commands are model + disk, `push` does not run `run`. → `model-and-storage.md`
- **10** — `Route` name clash with Material: `hide Route`, or import core route as `show RouteNode`. → `model-and-storage.md`
- **11** — Hex remap: one `CellTransform` engine behind "Explode map…" and move-selection, one undoable snapshot each. → `model-and-storage.md`
- **12** — Map-image importer: the pipeline overview, the `importer/` layer, the wizard's state machine. → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12b** — Import placement is a plan, not a flag → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12c** — Rivers are recognised by TRACE-then-SNAP, not by the cascade → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12d** — The importer ships a PRIOR → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12e** — Biome and structure are recognised SEPARATELY → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12f** — Rivers are found by a RIDGE FILTER, not a threshold → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12g** — The river step has a DEBUG stage view → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12h** — Rivers are DRAWN BY HAND by default; tracing is an assist → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12i** — A learned library can make recognition WORSE, so learning is CORRECTIVE → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12j** — The local model has TWO modes, answering different questions → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12k** — Biome recognition is STAMP-LED: what is drawn beats what colour it is → `hexlore_flutter/lib/importer/CLAUDE.md`
- **12l** — The river editor is LINK-FIRST, and drives raw pointer events → `hexlore_flutter/lib/importer/CLAUDE.md`
- **13** — Shared render spec (`map_palette.dart` ↔ `render_spec.js`): stamp ink derived from the fill; the JS hash must use `Math.imul`. → `rendering.md`
- **14** — Cluster outlines: edges collected into a quiet path and a boundary path, each drawn once by its canonical owner. → `rendering.md`
- **15** — Per-hex fill jitter + coastlines: ink from the UNjittered fill; a coast halo only beside painted land. → `rendering.md`
- **16** — Features are all glyphs; biomes are glyph where a good icon exists, else procedural. → `rendering.md`
- **17** — Travel votes are SESSION state, not campaign data. → `player-view.md`
- **18** — Map scale is campaign metadata: scale bar, ruler tool, and the stylus-pressure spike. → `map-editing.md`
- **19** — The Sketch view is a second view of the SAME scene, not a second map → `sketch.md`
- **20** — Campaign backup is the HOST'S REST API, not git → `hexlore_flutter/lib/sync/CLAUDE.md`
- **21** — The Regional view is a READ-ONLY ROLLUP, and it nests by ROSETTE → `regional-view.md`
- **22** — The Illustrated map style: biome = ground TEXTURE, feature = object in a clearing → `rendering.md`
- **23** — Panning is served from TILES; a direct render is batched → `rendering.md`
- **23b** — Zooming stretches what is held; a settled zoom is ONE snapshot → `rendering.md`
- **24** — The Sketch view has a trace image: a reference picture to draw over, with no hex calibration at all → `sketch.md`
- **25** — Roads are a stack, drawn from one shared spec → `map-editing.md`
- **26** — The running app writes the campaign WRITE-BEHIND → `model-and-storage.md`
- **27** — Threads are drawn as a laid-out COURSE, in one of two styles; the GM-only overlays are shown and hidden from ONE Display & overlays panel → `map-editing.md`
- **28** — Every choice that is not a one-off action is REMEMBERED → `model-and-storage.md`
- **29** — Hex cut / copy / paste moves CONTENT; fog and the lattice stay put → `model-and-storage.md`
- **30** — The title bar is grouped by WHAT a control is about: left = the campaign, right = this session → `map-editing.md`
- **31** — Campaign FORMAT 2: paint chunks, variants by id, and nothing unknown is lost → `model-and-storage.md`
- **32** — The image exporter renders the BASE layer offscreen, in tiles; a Players image is drawn from the player payload → `rendering.md`
- **33** — An edit redraws only what its DAMAGE reaches; lines are cut to the painted rect → `rendering.md`

