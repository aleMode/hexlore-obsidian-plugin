# CLAUDE.md — HexLore for Obsidian

The Obsidian port of HexLore. It may still sit in `obsidian-plugin/` of the
Flutter repository, or already be a repository of its own: nothing here may
depend on which. Write it as a repository of its own (no path outside this
folder except through `$HEXLORE_FLUTTER` / `$HEXLORE_VAULT`), and keep
anything private out of it.

- **`docs/design.md`** is the design record: "§1.x" is a decision, "item 2.x"
  a build step (its §3 says what is built and what is left), "V1…V10" a fact
  to check. Read the item before starting on it.
- **"Decision N"** is a Flutter decision record: index in
  `vendor/docs/decisions/README.md`, the WHY behind every rule mirrored here.
- `docs/technical-manual.md` (how it is built), `docs/user-guide.md`,
  `docs/performance.md` (the renderer benchmark; compare against it).

Node comes from fnm (`.node-version` pins 24): run `eval "$(fnm env)"` in a
fresh shell. `npm run check` (lint + test + build, everything a change must
pass) · `npm test` (Vitest) · `npm run dev` (watch). User-visible changes go
in `CHANGELOG.md`.

## How every change is made (read first)

Every change follows the workflow in `vendor/WORKFLOW.md` (copied from the
Flutter repository, which owns it; loaded below). What that means for a
session:

- **Before the first edit, run `/start-change`** (or its steps): classify
  the change as A (this app only), B (both apps, or the shared contract) or
  C (bug / optimization), and work on a branch off an up-to-date `main`.
  **Never edit on `main`.**
- **Kind B starts in `../software_hexlore`, not here.** It is made, committed
  and pushed there first; then `npm run vendor` here, and the failing tests
  are the to-do list. Never edit `vendor/` by hand.
- **A bug fix starts with a failing test; an optimization starts with the
  renderer benchmark** (`docs/performance.md`).
- **Before calling a change done, run `/finish-change`:** `npm run check`
  green, docs and `CHANGELOG.md` updated in the same change, the Flutter app
  checked for the same change or bug, a commit message proposed.
- Never commit, merge, push or tag unless the user asks.
- If the user asks to skip a step, name the step and what it protects in one
  line, then do as they decide.

@vendor/WORKFLOW.md

## The contract comes from Flutter

`vendor/` is a COPY of the Flutter repo's conformance fixtures, converter
fixture pairs, `docs/format-2.md`, `docs/converter.md`, decision records
(`docs/decisions/`, plus the importer's as `importer.md`), the player assets
(render spec, texture and glyph tables) and `variant_ids.lock`.
`vendor/SOURCE` names the Flutter commit. `npm run vendor` finds the Flutter
repository through `$HEXLORE_FLUTTER`, else `../software_hexlore`. Vendor
only from a pushed Flutter commit (CI fails on a "(dirty)" `vendor/SOURCE`),
and name it in the commit that ports the change.

- Never edit `vendor/` by hand. Change Flutter, regenerate its fixtures
  (`HEXLORE_WRITE_CONFORMANCE=1 flutter test test/conformance_test.dart`),
  commit there, then `npm run vendor` here, in the same piece of work.
- `test/conformance.test.ts` runs every fixture case. A function is ported
  when it's registered in `ported` and its cases pass; unported ones show as
  todos. Every function is ported today (item 2.1), so a todo means Flutter
  added one.
- Comparison rules: `vendor/conformance/README.md` (1e-9 relative for
  floats, exact `hash2`).

## Layers

```
core  ←  storage  ←  view / render / server / importer / sketch / convert
```

- `src/core/` is pure TypeScript: no `obsidian`, no DOM, no Node import. It
  mirrors Flutter's `lib/core/` file for file where it can (`map_palette.dart`
  → `map_palette.ts`), so a Dart change is easy to follow here.
- Node modules (`http`, `fs`, `os`) are desktop-only and load lazily,
  ONLY through `src/desktop.ts` (`nodeModule`); the plugin is not declared
  desktop-only. Never `await import('http')` directly: esbuild keeps it,
  Obsidian's renderer cannot resolve it, and the feature silently does
  nothing (the tests, under Node, would still pass).

## Rules carried over from Flutter

- Hex id is axial `"q<q>_r<r>"`; display ids ("A1") are derived, never stored.
- Variants are stored as string ids (format 2); never remove or reuse one.
- Unknown keys and values are kept and written back; players never see them
  (the filter fails closed).
- The ported `player_filter` is the ONLY path to players, and the player
  view is map-only.
- The hash uses `Math.imul`.

## Layout

- `src/core/` — ports of Flutter's `lib/core/` (item 2.1, COMPLETE: every
  conformance fixture passes): geometry, anchors (the river/route lattice),
  hex model, river/route/region/thread models, remap, line of sight, hex
  clipboard, map scale, overlay groups, player filter, river edit + snap,
  sketch model, paint pick, variant ids, paint chunks, campaign meta, and
  `json.ts` (the campaign JSON encoding). `map.ts` is the plugin's model:
  Flutter's Campaign minus what notes replace (NPCs, quests, adventures,
  entries, pages); player fog is a SET of revealed ids.
- `src/sketch/` — bucket fill and hexify (Flutter's `lib/sketch/`).
- `src/storage/` (item 2.2):
  - `map_codec.ts` — format-2 files ↔ model, one file per layer, pure. It
    writes BYTE-IDENTICAL files to Flutter's (test: `map_codec.test.ts`).
  - `map_store.ts` — the loaded map: dirty chunks/layers, 500 ms debounced
    flush, own writes recognised, external changes reloaded per file
    (unsaved edits to that file discarded and reported), unparseable files
    never written, newer format or format 1 READ-ONLY (Flutter migrates 1→2).
  - `vault_fs.ts` (Vault API), `store_registry.ts` (one store per data
    folder, shared by views; vault events batched; flush on quit/unload).
  - `hexmap_index.ts` / `index_file.ts` — the `.hexmap.md` index (below).
- `src/render/` — the GM map renderer (item 2.3):
  - `vendor.ts` loads the vendored spec and art tables (`render_spec.js`,
    `texture_spec.js`, glyph/texture tables) through `scripts/scoped.mjs`,
    which wraps each at BUILD time with a private `globalThis`. They are
    USED, never ported: fix them in Flutter, then `npm run vendor`. The lint
    config forbids the `Function` constructor and won't let it be disabled.
  - `art.ts` is the ART REGISTRY (§1.7): the one place binding a variant id
    to its glyph / texture / procedural stamp. Brush menu, credits and cache
    keys derive from it.
  - `scene.ts` is the render model + per-revision caches (built from the map
    model by `scene_from_model.ts`); `painter.ts` paints a scene RECT
    (culled, with the GM canvas's LOD: <6 px coarse, <14 px fills and
    borders, else stamps / textures / labels); `tiles.ts` + `map_canvas.ts`
    are decisions 23/23b: pan draws 256-px tiles (a few per frame scroll in:
    an Illustrated tile is mostly raster work AFTER the frame), zoom
    stretches what is held and settles into a new set progressively.
  - EDITS: an edit to hexes, lines, regions or fog records its DAMAGE in the
    scene (a scene rect; the reach constants in `scene.ts`), and only the
    tiles and overview bands it touches are redrawn — the visible ones in
    the same frame, neighbouring tiles as ONE paint cut into tiles
    (`renderMany`). A change with no damage (threads, overlays) bumps the
    scene's EPOCH and renders directly until quiet; re-applying the same
    overlays is no change, and the first epoch a canvas sees after
    `setScene` is not an edit. Change what the painter draws beyond a hex
    and `test/tile_damage.test.ts` (every tile traced before and after each
    kind of edit, `test/helpers/tracing_canvas.ts`) tells you if the reach
    must grow; its block parity test checks a tile cut from a block equals
    the tile alone (so nothing a tile needs is culled away).
  - CULLING: a paint costs every river and road crossing its rect, so the
    painter culls road marks, a split river's clip hexes and its mouths to
    the rect, and strokes only the CHUNKS of a solid (undashed, round-capped)
    course that can reach it (`smoothCourse`: one stroke call, so the union
    is the whole stroke). A dashed line is stroked whole. Blend strips (a
    gradient and a polygon per edge) are made once per edge and fill pair
    and kept (`strips`): a gradient is not tied to the context that made it.
  - RASTERS (`textures.ts`): SPRITES (Clean stamps, feature glyphs,
    feature objects; labels stay vector) live in shelf-packed 2048² ATLAS
    pages, evicted whole: drawn once, blitted per hex (Clean direct frames
    50 → 17 ms between frames). Illustrated texture SLICES are in pages
    too, and a paint MAKES EVERY RASTER IT DRAWS FIRST (`prepare`,
    `sprites`): making one into a page the paint had already drawn from
    flushed the page each time (150 ms between frames); a canvas each
    measured worse in direct frames (no batching across canvases). Rasters
    are drawn on a CPU canvas (`willReadFrequently`) and copied into their
    page (`putImageData`, `cpuRaster`): a cold pan makes 500–900, each
    dozens of small paths the GPU process rasterised slowly (cold
    Illustrated pan: 34 ms between frames and 9% dropped on the GPU, 17 ms
    and 2% in software). Sprite boxes are
    worked out only when a sprite is made (a paint asks for each twice). Tiles held as ImageBitmaps were tried
    too: no difference. Texture resolution and object LOD have hysteresis
    (`resolution()`); a frame makes at most 8 new rasters, past that another
    resolution's raster stands in and the tile is SOFT, redone while idle.
    Sprites sit in ⅛-octave zoom buckets. Dropped canvases are released at
    once (size 0); tiles come from a pool and are opaque. CAPACITY matters:
    a 1080p Illustrated + Blend view at zoom 1 needs ~11M px of slices; a
    cache smaller than the view and its ring evicts what it then draws
    again, every frame (350 ms frames measured; a test holds it).
    Pre-warming never evicts: it stops when the cache is nearly full.
  - IDLE WORK runs in `requestIdleCallback`, ONE piece per callback (in the
    frame without it, and in the benchmark): its cost is raster work the
    deadline cannot see. Soft visible tiles; the prefetch ring, each tile's
    new textures made a frame's budget at a time BEFORE the tile (a cold
    tile's few dozen at once dropped frames of a pan); the textures of the
    ring past it (`painter.warm`, only once the camera has been still for
    500 ms: during a pan its GPU work landed between frames); the
    overview. The overlay repaints at
    most once a frame (`paintOverlay`; `paintOverlayNow` to force).
  - The map view tells the map panel about a STROKE once, when it ends (the
    panel rebuilds its DOM on every broadcast), and a change of linked notes
    updates only the hexes whose links came or went (`relinkScene`).
- `src/edit/` — editing (item 2.4), no Obsidian import: `editor.ts` (every
  map change: paint strokes, names, fog + line of sight, feature secrecy,
  rivers / routes point by point (`core/line_edit.ts`, decision 8c: a drag
  moves one point, re-laid from the points at pointer-down, one undo entry
  per gesture), regions (cell strokes undoable; create / delete are not,
  decision 9), threads, delete / cut / copy / paste (decision 29), move
  selection and explode (decision 11, one undoable remap each), resize (not
  undoable, clears the history, like Flutter). Hexes carry their NOTE LINKS:
  the editor keeps `links` (from the index) and writes changes through
  `linkWriter` → `vault.process`, as per-id deltas applied to the file as it
  is then; a delete UNLINKS notes, never deletes them; a paste adds the
  pasted notes after the target's own;
  marks the store dirty, records undo, emits the changed cells), `undo.ts`
  (Flutter's stack + `touches`: entries are dropped when a file they wrote is
  reloaded from disk). `editors.ts`: ONE editor per store, so two views of a
  map share one history.
- `src/view/map_view.ts` — the `.hexmap.md` map view: tools (1–8, decision
  6), selection, context menu, keys (view `Scope`); `toolbar.ts` is the
  tool strip + paint palette (derived from the art registry: named tiles
  with previews drawn by the renderer's own `paintBiomeStamp` / `paintGlyph`
  via `pick_preview.ts`; one category at a time in tabs, Biomes | Icons | Erase, the picked art's variants under the grid of its own tab); a river's
  width is in its right-click menu (presets + exact), not the sidebar; `top_bar.ts`
  mirrors Flutter's title bar (decision 30: left = fullscreen, the map menu,
  quick jump Ctrl+K, adventures, session notes; centre = Hex | Sketch;
  right = undo / redo, reset view Ctrl+0, Display & overlays, the players
  split button, the map panel), its dialogs in `map_menus.ts` — keep its
  menus and entries in step with Flutter's. Fullscreen and the map panel
  button are the plugin's own (Flutter has a window, not a sidebar).
  ONE PLACE PER ACTION: the tab header adds only "Open as Markdown" and the
  "⋯" pane menu adds nothing; anything for the map goes in the top bar or
  its menus. Fullscreen moves the view's `contentEl` into `<body>` (fixed,
  under hover previews / modals / menus) and asks for document fullscreen;
  it ends on the button, Esc with nothing else to clear, another leaf
  becoming active, or the map panel button; `display_panel.ts` is its Display & overlays popover (Flutter's
  `overlay_panel.dart`: overlays per MAP, display per DEVICE, pills for
  one-or-the-other choices). ONE PLACE PER SETTING: what the map shows lives
  only there, never again in the sidebar or the settings tab;
  `inspector_view.ts` is the right-sidebar "Map panel" (follows the active
  map; the selection, regions, sketch tools, travel votes — no display
  choices). `main.ts` switches a Markdown leaf on an index to the map view
  ("Open as Markdown" to go back). ONE PLACE PER ACTION holds outside a map
  too: `plugin_menus.ts` is the ribbon icon's menu (the way into a vault
  with no map yet) and the file menu (right-click a map file or a note); the
  commands are only "Create a new map…", "Show this note on the map",
  "Open this note as a map" (hotkeys) and the dev synthetic map. A new
  action goes in a menu first, never only in the palette.
- Input (as Flutter's canvas): left-drag = the tool (select: rubber band);
  middle-drag / Space+drag / trackpad scroll pan; wheel and pinch zoom;
  right-click = cell menu. Raw pointer events only. Wheel vs trackpad is
  guessed per GESTURE (`view/wheel_intent.ts`): one trackpad-looking event
  makes the rest of the gesture pan; never judge events one by one. Space
  counts with the view focused OR the pointer over the map with focus on
  nothing (a tool click moves focus off the map), never in a text field or
  on a control elsewhere; listened in the capture phase. The wheel readout
  is in "Pen and trackpad diagnostics…" (map menu → HexLore).
- Notes (item 2.5): `src/notes/note_meta.ts` (pure) holds the note
  CONVENTIONS — `type: npc | quest | place` in the frontmatter, Flutter's NPC
  and quest fields under the same names, `location` = link(s) to PLACE NOTES
  (never coordinates), templates (`{{title}}`, `{{hex}}`, `{{map}}`,
  `{{date}}`, `{{time}}`), and which hexes a note stands for (the hexes
  listing it + those listing its places). `src/view/vault_notes.ts` applies
  them through Obsidian (resolving links, creating notes, NPCs at a place,
  outgoing links). In the map panel: the hex's notes (reorder, unlink,
  RELINK a broken one), "People and quests here", the secondary notes
  (outgoing links, on request), New note (section, kind, template).
  `src/view/sections_view.ts` is the left-sidebar Sections list (§1.4):
  per-campaign `{name, folder, template?}` in the index frontmatter,
  defaults until changed, nesting refused; hovering a note lights up its
  hexes, notes drag onto hexes. The map view highlights the hexes of the
  note being read (gold), and "Show this note on the map" centres on them.
  A hex holding ONLY notes (no map record) is a hex like any other for
  cut / copy / paste / delete / move / explode / resize.
- `src/server/` — the player view (item 2.6). `player_server.ts` is the
  HTTP server (Node `http` passed in; tests run it on a real socket): the
  player page (`assets.ts`: vendor/player/ files as text, `?raw` imports),
  `/api/map` = the ported `player_filter` output with an ETag (304 while
  unchanged; `player.js` sends it back), `/api/votes`, `POST /api/vote`
  (`core/travel_votes.ts`, in memory, checked against the GRID). Ports
  5174–5180, localhost unless "Serve on the local network" (players menu)
  is on. `control.ts` is the Obsidian side: one map served at a time, from its LIVE store model (a
  reveal reaches players on the next poll), a newer format refused (503),
  `http`/`os` through `nodeModule`, a failed start told to the GM (never
  a rejected promise nobody awaits), `started_modal.ts` (on every start: the link, who can open
  it, how reveals and votes work; the GM can turn it into a notice),
  status-bar link, vote badges on the GM map, the travel
  votes in the map panel (start / stop are the players button only).
  `/api/art` (the registry as data) is NOT done: it needs
  `player.js` to take its tables from the server, a Flutter-side change.
- `src/convert/` — "Export as a campaign folder…" (item 2.7), following
  `vendor/docs/converter.md` §5 (the contract BOTH converters follow;
  Flutter's is `hexlore_flutter/lib/convert/`). `flutter_export.ts` is the
  pure planner (map copy with `page_file` / `also_links`, notes placed by
  SECTION, NPC/quest notes → records, links rewritten to Flutter names,
  `roundtrip.json` with FNV-1a fingerprints); `write.ts` writes with Node
  `fs` outside the vault and sweeps stale files from the folders it owns;
  `export_command.ts` gathers notes through Obsidian (§5.1). Fixtures:
  `vendor/converter/` — `test/convert.test.ts` exports
  `flutter_to_plugin/expected` and compares with `plugin_to_flutter/
  expected` (`HEXLORE_WRITE_CONVERTER=1` writes it into the Flutter repo,
  then `npm run vendor`); Flutter's `converter_roundtrip_test.dart` checks
  the trip back. `src/notes/npc_page.ts` ports Flutter's NPC page sections.
- Image export (item 2.10, Flutter's decision 32): `core/export_layout.ts`
  (Flutter's export_layout.dart: tiles, pages, scale), `render/image_export.ts`
  (the map painter offscreen, tile by tile; PNG with a scale-bar + credits
  strip; PDF via pdf-lib (MIT), one raster per overlapping page, labelled),
  `render/players_scene.ts` (the PLAYERS version is built from the filter's
  payload, never the model — the secrecy test asserts on that data), and
  `view/image_export_modal.ts` (the options; the file lands beside the map
  in the vault and opens).
- The Sketch view (item 2.8, decisions 19 / 24) is a MODE of the map view
  (`view/sketch_mode.ts`): the same camera, a canvas of its own over the
  map's, and the map below dimmed to 35 % as the hex ghost (the shared
  renderer). Tools P E B L R O T H, `[`/`]` width; raw pointer events with
  `getCoalescedEvents`, a `desynchronized` 2D context, pen pressure as the
  pen reports it (a pen reporting none gets a hint), right-drag / the
  eraser end erase. Strokes are perfect-freehand OUTLINES (the JS library,
  MIT; `size = 0.65·width`, `thinning = 7/13`, `streamline = 0.3`, as
  Flutter). The sketch has its OWN history (`editor.sketchUndo`; Ctrl+Z
  goes to the view showing). Bucket fill goes UNDER every non-fill.
  Hexify (`view/hexify_modal.ts`) = `sketch/hexify.ts` → `core/import_plan.ts`
  (Flutter's import_plan.dart) → `editor.applyImport` (ONE undo step,
  removals before creations, the `HexifyRecord`). The trace image
  (`view/trace_image.ts`) is a vault image linked from the index
  (`trace-image:`), placed by Flutter's own `sketch/trace_image.json`;
  display state, never undoable. The swatch editor (stage 3) is in the map
  panel. "Sketch overlay" (Display & overlays) shows it in the hex view
  faintly, or its labels only (the mode is kept while hidden).
- The importer (item 2.9, decisions 12–12l; READ
  `vendor/docs/decisions/importer.md` before changing it):
  `src/importer/` ports Flutter's `lib/importer/` file for file, on plain
  RGBA `Raster`s (`raster.ts` mirrors package:image's average resize,
  grayscale and truncating stores). Calibration, sampler, Lab + the
  built-in prior, ink mask + stamp recogniser, the two-recogniser cascade,
  corrective libraries (icon patches as base64 PNG via UPNG — import it as
  in `png_codec.ts`: its ESM build has only a default export), the session
  state machine, river tracer + ridge filter (Float32 storage, Dart's
  iteration order and `dartRound`) + debug stages, the underlay affine.
  Tests are the Flutter ones, ported; the ground-truth harness needs the
  user's image and skips, as in Flutter. `view/import_wizard.ts` is the
  wizard (pick a vault image → two clicks → review with a fix brush →
  draw / trace rivers → drag to place → `editor.applyImport`, ONE undo
  step); libraries live in the plugin folder (`import-libraries.json`,
  Flutter's format); the picture can stay as the map's underlay
  (`underlay:` link + `import/underlay.json`), drawn translucent over the
  fills from Display & overlays. NOT ported: the optional Ollama
  classifier, and the multi-isolate fan-out (chunks yield to the UI instead).
- "Show maps together" (§1.10, item 2.12): `view/atlas_view.ts` +
  pure `view/atlas_layout.ts`. GM-only, read-only, maps in a world frame in
  miles, one TRANSPARENT MapCanvas per map (`setCamera`; the scene
  `paintedOnly`: nothing but painted hexes covers the map below), canvases
  sized at every paint, layout in `data.json`
  (`atlas`). Never write a placement into a map or the index: that would
  make it contract.
- `src/settings.ts` — vault settings (data.json), declarative
  `getSettingDefinitions` (Obsidian 1.13): only what has no better home
  (the templates folder, `mapFolders`: a new map gets a folder of its own
  with numbered section folders, `MAP_FOLDER_SECTIONS`, names kept as the
  converter's); `playerLan` is stored here, switched from the players menu.
- `src/dev/` — the synthetic 100×100 map and the renderer benchmark (map
  menu → HexLore → "Benchmark the renderer"); keep it to compare renderer changes.

## The `.hexmap.md` index (grammar v1, `hexlore-index: 1`)

Frontmatter: `hexlore-plugin: map`, `hexlore-index`, `format`, `data` (the
sibling data folder), `underlay`, `sections` (list of `{name, folder}`; no
nesting). Body: two sections are the plugin's, same line grammar —
`## Hexes`: `- q5_r-2 :: [[Main note]] · [[Other note]]` (first link =
principal note); `## Regions`: `- region_001 :: [[Region note]]` (the note
encounters are rolled from; Flutter's region `page_file` is kept as is).
Everything else in the file is left byte for byte; a section line that does
not parse is kept verbatim and reported, never dropped. The contract is
`vendor/docs/converter.md` §3: a grammar change is made there first (in the
Flutter repository, by its change procedure), then here.

## Rules that bite

- **Doubles:** Dart writes a double as `6.0`. Every field Dart types as
  `double` is written through `dbl()` (core/json.ts), and files are read with
  `parseJson` (which keeps `x.0` numbers as JsonDouble so unknown keys
  round-trip). Read numbers with `num()` / `int()`. Forgetting `dbl()` makes
  every save by the other app a changed line in git.
- **Unknown keys and values** are kept (`extra` / `raw`, as in Dart) and
  written back in place; assigning a field drops its raw value.
- **A `Setting` is a thenable** (Obsidian's `Setting.then(cb)` calls
  `cb(this)` and returns `this`): never resolve a promise with one, e.g.
  `p.then((s) => row.setDesc(…))`. It loops forever in microtasks and
  freezes Obsidian. Use braces. The test stand-in's `Setting.then` throws
  instead, so the smoke tests catch it.
- **Sort ties:** Dart's `List.sort` is unstable, JS's is stable. Equal keys
  can order differently (noted in `river_snap.ts`); the fixtures agree today.

Per-device state (camera per map, style/blend) is in `app.saveLocalStorage`,
never in synced files (§1.2).

## Dev vault

The dev vault holds a real campaign (`purezza`, exported from Flutter), so it
is NEVER part of this repository: it is the private repository
`aleMode/obsidian-test-vault`, checked out at `../obsidian-test-vault/`, and
`test-vault` here is a git-ignored symlink to it (`test/renderer.test.ts`
renders its campaign when present). Every build (`npm run dev` / `npm run
build`) COPIES `main.js`, `manifest.json` and `styles.css` into that vault's
`.obsidian/plugins/hexlore/` (copies, so a machine that never builds can open
the vault as it is); `HEXLORE_VAULT=<path>` installs into another vault,
`HEXLORE_VAULT=none` skips it. Commit the vault's copy with the source change,
or the downloaded vault runs an older plugin. The vault's `.gitignore` keeps
`workspace.json` and `.trash/` per device.
