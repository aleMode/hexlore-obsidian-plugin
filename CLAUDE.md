# CLAUDE.md — HexLore for Obsidian

The Obsidian port of HexLore. **For now it lives in `obsidian-plugin/` of the
Flutter repository** (one GitHub repo, so both sync together); it moves to its
own repository later (`git subtree split --prefix=obsidian-plugin` keeps its
history). Nothing in this folder may depend on that: write it as if it were a
repository of its own, and keep anything private out of it. **Read
`../obsidian-plugin-plan.md` §3 before starting an item** (the numbers
2.0–2.11 below are that plan's). `../CLAUDE.md`'s decision index explains the
WHY behind every rule mirrored here.

Node comes from fnm: run `eval "$(fnm env)"` in a fresh shell.
`npm test` (Vitest) · `npm run lint` · `npm run build` · `npm run dev` (watch).

## The contract comes from Flutter

`vendor/` is a COPY of the Flutter repo's conformance fixtures,
`docs/format-2.md`, the player assets (render spec, texture and glyph tables)
and `variant_ids.lock`. `vendor/SOURCE` names the Flutter commit.

- Never edit `vendor/` by hand. Change Flutter, regenerate its fixtures
  (`HEXLORE_WRITE_CONFORMANCE=1 flutter test test/conformance_test.dart`),
  commit there, then `npm run vendor` here, in the same piece of work.
- `test/conformance.test.ts` runs every fixture case. A function is ported
  when it's registered in `ported` and its cases pass; unported ones show as
  todos, so the todo list is the remaining `core` work (item 2.1).
- Comparison rules: `vendor/conformance/README.md` (1e-9 relative for
  floats, exact `hash2`).

## Layers

```
core  ←  storage  ←  view / render / server / importer / sketch / convert
```

- `src/core/` is pure TypeScript: no `obsidian`, no DOM, no Node import. It
  mirrors Flutter's `lib/core/` file for file where it can (`map_palette.dart`
  → `map_palette.ts`), so a Dart change is easy to follow here.
- Node modules (`http`, `fs`) are desktop-only and load lazily
  (`Platform.isDesktop`); the plugin is not declared desktop-only.

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
    are decisions 23/23b: pan draws 512-px tiles, zoom stretches what is
    held and settles into a new set progressively, an edit renders directly
    until quiet.
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
  tool strip + paint palette (derived from the art registry);
  `inspector_view.ts` is the right-sidebar "Map panel" (follows the active
  map). `main.ts` switches a Markdown leaf on an index to the map view
  ("Open as Markdown" to go back).
- Input (as Flutter's canvas): left-drag = the tool (select: rubber band);
  middle-drag / Space+drag / trackpad scroll pan; wheel and pinch zoom;
  right-click = cell menu. Raw pointer events only.
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
  5174–5180, localhost unless the LAN setting is on. `control.ts` is the
  Obsidian side: one map served at a time, from its LIVE store model (a
  reveal reaches players on the next poll), a newer format refused (503),
  `http`/`os` imported only under `Platform.isDesktop` (the lint rule wants
  that guard), status-bar link, vote badges on the GM map, "Player view"
  in the map panel. `/api/art` (the registry as data) is NOT done: it needs
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
  panel. "Sketch over the map" (Display) shows it in the hex view faintly,
  or its labels only.
- The importer (item 2.9, decisions 12–12l; READ
  `../hexlore_flutter/lib/importer/CLAUDE.md` before changing it):
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
  fills from the Display panel. NOT ported: the optional Ollama
  classifier, and the multi-isolate fan-out (chunks yield to the UI instead).
- `src/settings.ts` — vault settings (data.json), declarative
  `getSettingDefinitions` (Obsidian 1.13); other modules add groups.
- `src/dev/` — the synthetic 100×100 map and the renderer benchmark (pane
  menu → "Benchmark the renderer"); keep it to compare renderer changes.

## The `.hexmap.md` index (grammar v1, `hexlore-index: 1`)

Frontmatter: `hexlore-plugin: map`, `hexlore-index`, `format`, `data` (the
sibling data folder), `underlay`, `sections` (list of `{name, folder}`; no
nesting). Body: two sections are the plugin's, same line grammar —
`## Hexes`: `- q5_r-2 :: [[Main note]] · [[Other note]]` (first link =
principal note); `## Regions`: `- region_001 :: [[Region note]]` (the note
encounters are rolled from; Flutter's region `page_file` is kept as is).
Everything else in the file is left byte for byte; a section line that does
not parse is kept verbatim and reported, never dropped. Not yet in
`docs/format-2.md`: it gets recorded with the converter (plan item 1.11) —
keep this description and the code in step until then.

## Rules that bite

- **Doubles:** Dart writes a double as `6.0`. Every field Dart types as
  `double` is written through `dbl()` (core/json.ts), and files are read with
  `parseJson` (which keeps `x.0` numbers as JsonDouble so unknown keys
  round-trip). Read numbers with `num()` / `int()`. Forgetting `dbl()` makes
  every save by the other app a changed line in git.
- **Unknown keys and values** are kept (`extra` / `raw`, as in Dart) and
  written back in place; assigning a field drops its raw value.
- **Sort ties:** Dart's `List.sort` is unstable, JS's is stable. Equal keys
  can order differently (noted in `river_snap.ts`); the fixtures agree today.

Per-device state (camera per map, style/blend) is in `app.saveLocalStorage`,
never in synced files (§1.2).

## Dev vault

The dev vault holds a real campaign (`purezza`, exported from Flutter), so it
is NOT part of the plugin: it is `../obsidian-test-vault/`, committed in the
(private) Flutter repository, and `test-vault` here is a git-ignored symlink
to it. Every build (`npm run dev` / `npm run build`) COPIES `main.js`,
`manifest.json` and `styles.css` into that vault's
`.obsidian/plugins/hexlore/` (copies, so a machine that never builds can open
the vault as it is); `HEXLORE_VAULT=<path>` installs into another vault,
`HEXLORE_VAULT=none` skips it. Commit the vault's copy with the source change,
or the downloaded vault runs an older plugin. The vault's `.gitignore` keeps
`workspace.json` and `.trash/` per device.
