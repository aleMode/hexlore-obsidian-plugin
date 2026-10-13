# HexLore for Obsidian: technical manual

How the plugin is built and how its parts fit together. The user-facing
side is `docs/user-guide.md`; the design decisions and what is still open
are in `docs/design.md`; the detailed rules for changing each part are in
`CLAUDE.md`.

## 1. What it is

An Obsidian plugin (TypeScript, bundled with esbuild) that is a **map
builder, viewer and player server** for a hex-crawl campaign. It is the
Obsidian port of the HexLore Flutter app and reads and writes the **same map
files** (campaign format 2). Notes stay ordinary vault notes; the map points
at them.

Everything Flutter does is ported except the regional view, and except what
Obsidian already does: the notes editor, page naming, wikilink renaming, the
git-host backup (design §1.1).

The plugin is not declared desktop-only. Desktop-only parts (the player
server, the campaign-folder export) load Node modules lazily, only through
`src/desktop.ts`.

## 2. Repository layout

```
manifest.json, versions.json   Obsidian's plugin manifest and version map
package.json                   scripts and dependencies
esbuild.config.mjs             bundles src/main.ts → main.js (+ dev-vault copy)
eslint.config.mts              includes eslint-plugin-obsidianmd
vitest.config.ts               tests; `obsidian` aliased to test/mocks/
styles.css                     all the plugin's CSS
src/                           the plugin (§4)
test/                          Vitest tests, helpers, the Obsidian stand-in
vendor/                        the contract, COPIED from the Flutter repo (§6)
scripts/                       vendor-from-flutter.mjs, scoped.mjs (build helper)
docs/                          user guide, this manual, design, performance
.github/workflows/             CI and the tag-triggered release
```

## 3. Build, test, develop

Node comes from fnm (`eval "$(fnm env)"` in a fresh shell); CI uses Node 24.

| Command | What it does |
|---|---|
| `npm install` | dependencies |
| `npm test` | Vitest: every test, including the conformance fixtures |
| `npm run lint` | ESLint (with Obsidian's plugin rules) |
| `npm run build` | type-check, then a production bundle |
| `npm run dev` | rebuild on change |
| `npm run vendor` | re-copy the contract from the Flutter repository |
| `npm version <x.y.z>` | bump `manifest.json` and `versions.json` |

Every build also **copies** `main.js`, `manifest.json` and `styles.css` into
a dev vault's `.obsidian/plugins/hexlore/` (plus a `.hotreload` marker for
the Hot Reload plugin). The vault is `$HEXLORE_VAULT`, else
`../obsidian-test-vault`; `HEXLORE_VAULT=none` skips the copy (CI does).

The Flutter repository is found by `$HEXLORE_FLUTTER`, else
`../software_hexlore`.

## 4. Architecture

```
core  ←  storage  ←  view / render / server / importer / sketch / convert
```

| Folder | What it holds |
|---|---|
| `src/core/` | Pure TypeScript (no `obsidian`, no DOM, no Node): ports of Flutter's `lib/core/`, file for file where possible. Geometry and anchors, hex and line models, regions, threads, remap, line of sight, hex clipboard, map scale, overlay filter, **player filter**, river edit and snap, sketch model, variant ids, paint chunks, `json.ts` (the campaign JSON encoding), and `map.ts` (the plugin's model: Flutter's Campaign minus what notes replace). |
| `src/storage/` | The map on the vault. `map_codec.ts` (format-2 files ↔ model, byte-identical to Flutter's output), `map_store.ts` (the loaded map: dirty files, 500 ms debounced flush, external changes, read-only rules), `store_registry.ts` (one store per data folder, shared by views), `vault_fs.ts`, `hexmap_index.ts` / `index_file.ts` (the `.hexmap.md` index), `data_link.ts` (keeps `data:` right across renames). |
| `src/render/` | The renderer. `scene.ts` (render model + caches), `painter.ts` (paints a scene rect), `tiles.ts` + `map_canvas.ts` (tiled pan, stretched zoom), `textures.ts` (atlas pages for sprites and texture slices), `art.ts` (the art registry), `vendor.ts` (loads the vendored JS spec and tables), `image_export.ts`, `players_scene.ts`. |
| `src/edit/` | Editing without Obsidian: `editor.ts` (every map change), `undo.ts`, `editors.ts` (one editor per store). |
| `src/view/` | Obsidian views and UI: `map_view.ts` (the map), `top_bar.ts`, `toolbar.ts`, `display_panel.ts`, `inspector_view.ts` (the Map panel), `sections_view.ts`, `sketch_mode.ts`, `import_wizard.ts`, modals. |
| `src/notes/` | Note conventions (`note_meta.ts`: kinds, `location`, templates, which hexes a note stands for), NPC page sections. |
| `src/server/` | The player server (`player_server.ts`, Node `http` passed in), its Obsidian side (`control.ts`), the player page assets. |
| `src/convert/` | "Export as a campaign folder…": `flutter_export.ts` (pure planner), `write.ts` (Node `fs`), `export_command.ts`. |
| `src/importer/` | Port of Flutter's importer on plain RGBA rasters. |
| `src/sketch/` | Bucket fill and hexify. |
| `src/dev/` | The synthetic 100 × 100 map and the renderer benchmark. |
| `src/main.ts` | The plugin: views, commands, the index → map view switch, rename following. |

### Data flow

1. Opening a `.hexmap.md` note switches its leaf to the map view (the
   Excalidraw pattern; "Open as Markdown" escapes it).
2. The view asks the **store registry** for the store of the index's data
   folder. The store reads every layer file and chunk through `map_codec`.
3. The view builds a **scene** from the model and the index's note links,
   and the **map canvas** paints it in tiles.
4. A tool gesture calls the **editor**. The editor changes the model, records
   undo, marks files dirty, writes note-link changes to the index
   (`vault.process`, as per-hex deltas), and reports the changed cells.
5. The scene records the edit's **damage** (a scene rect); only the tiles it
   touches are redrawn.
6. The store flushes dirty files after 500 ms, and on quit. It recognises its
   own writes; a change made elsewhere (git pull, another device) reloads
   that file only, and undo entries that touched it are dropped with a
   notice.

## 5. The files

- **The map data folder** `<Name>.hexlore/` is campaign format 2, exactly as
  the Flutter app writes it (`vendor/docs/format-2.md`): `campaign.json`,
  `paint/` chunks, one file per layer, `player/revealed.json`, `sketch/`,
  `import/underlay.json`.
- **The index** `<Name>.hexmap.md` is the plugin's only Markdown file:
  frontmatter (`hexlore-plugin: map`, `hexlore-index: 1`, `data`,
  `underlay`, `trace-image`, `sections`) and two link sections, `## Hexes`
  and `## Regions`. The grammar is in `vendor/docs/converter.md` §3.
  Everything else in the file is left byte for byte.
- **Per-device state** (camera, style, blend, panel state) is in
  `app.saveLocalStorage`, never in synced files. **Vault settings** are in the
  plugin's `data.json` (the templates folder, the LAN switch, "A folder
  for each new map", the "Show maps together" layout).
- **A new map** (`createMap`, `view/map_menus.ts`) goes in a folder of its
  own: `<Name>/<Name>.hexmap.md`, `<Name>/<Name>.hexlore/` and the numbered
  section folders of `MAP_FOLDER_SECTIONS` (`storage/hexmap_index.ts`),
  written into the index as its `sections`. The section NAMES stay the
  converter's; only the folders are numbered. With the setting off, the
  index and data folder go straight into the chosen folder and the index
  has no `sections` (the defaults at the vault root apply).
- **Read-only cases:** a newer format, a format-1 folder (the Flutter app
  migrates those), or a file that cannot be parsed (never written back).

## 6. The contract with the Flutter app

`vendor/` is a copy of files from the Flutter repository; `vendor/SOURCE`
names the commit. Never edit it by hand: change Flutter, commit there, then
`npm run vendor` here.

| Vendored | Used for |
|---|---|
| `conformance/` | `test/conformance.test.ts` runs every case against the TypeScript `core` (floats to 1e-9 relative, `hash2` exact; `conformance/README.md`). |
| `converter/` | the converter fixture pairs (`test/convert.test.ts`). |
| `docs/format-2.md`, `docs/converter.md` | the specifications. |
| `docs/decisions/` | the Flutter decision records ("decision N"), with `importer.md` for decisions 12–12l. |
| `player/` | the player page, `render_spec.js`, `texture_spec.js`, glyph and texture tables. The renderer USES these (wrapped at build time by `scripts/scoped.mjs`); they are never ported. |
| `variant_ids.lock` | every variant id ever issued (`test/art.test.ts`). |

JSON compatibility details: a Dart `double` field is written through `dbl()`
so it prints as `6.0`; files are read with `parseJson`, which keeps `x.0`
numbers so unknown keys round-trip byte for byte. Unknown keys and values
are kept (`extra` / `raw`) and written back.

## 7. Rendering

- **Two styles**: Clean (fills, stamps, outlines, coastlines) and Illustrated
  (ground textures, features as objects in a clearing, optional blended
  edges), from the vendored spec, so the map matches the Flutter app and the
  player page.
- **Levels of detail** by on-screen hex radius: under 6 px coarse, under
  14 px fills and borders, above that stamps, textures and labels.
- **Tiles**: panning draws 256 px tiles; zooming stretches what is held and
  settles into a new set progressively.
- **Damage**: an edit redraws only the tiles and overview bands its damage
  rect touches. `test/tile_damage.test.ts` traces every tile before and after
  each kind of edit; change what the painter draws beyond a hex and it tells
  you whether the reach constants must grow.
- **Rasters**: sprites and texture slices live in 2048² atlas pages, drawn on
  a CPU canvas and copied in. A frame makes at most 8 new rasters; tiles that
  had to use a stand-in are redone while idle. Idle work runs one piece per
  `requestIdleCallback`.
- Measured record and the benchmark: `docs/performance.md`.

- **Show maps together** (`view/atlas_view.ts`, the maths in the pure
  `view/atlas_layout.ts`): a read-only GM view of several maps in one WORLD
  frame measured in miles (km converted). A map is placed by its centre and
  a fit factor (1 = the size its `hex_distance` gives); its own MapCanvas
  gets a camera derived from the world camera (`mapCamera`, set with
  `MapCanvas.setCamera`, which bypasses the map view's zoom limits), is
  TRANSPARENT (`new MapCanvas(…, { transparent: true })`: base, tiles and
  overview cleared instead of filled; the map view stays opaque, cheaper to
  composite) and paints only hexes with terrain (`MapScene.paintedOnly`: no
  empty cells, no hex holding only a name or notes), sits in a layer
  clipped to its grid (`clip-path`), and takes an opacity from its
  on-screen hex size (`atlasOpacity`: in from 2 px, full 10–120 px, a ghost
  by 240 px, gone at the renderer's own zoom limit). A map at opacity 0 or
  off screen is hidden and not rendered. Coarsest at the bottom. The
  canvases are sized to the stage at every paint (and a `ResizeObserver`
  asks for one): Obsidian's `onResize` misses a view laid out after it
  opened, and a canvas left at its old size is stretched. A hidden map's
  layer measures 0, so its canvas is sized when it is shown again, never
  while hidden (sized to 0, it stayed blank for good). Scenes are
  rebuilt on the store's `saved` / `reloaded` events (stores shared with
  the map views through the registry). The layout is `atlas` in
  `data.json`; renames follow (`renamePaths`); the camera is per device.
  Not in the shared contract: nothing is written to a map.

## 8. Notes and sections

- A hex's notes are the links on its `## Hexes` line; the first is the
  principal note. The editor writes changes through a link writer
  (`vault.process`) applied to the file as it is at that moment.
- `note_meta.ts` holds the conventions: `type: npc | quest | place`,
  `location` (links to place notes, never coordinates), templates
  (`{{title}}`, `{{hex}}`, `{{map}}`, `{{date}}`, `{{time}}`). A note stands
  for the hexes that list it plus the hexes that list its places.
- Sections are `{name, folder, template?}` in the index frontmatter, one per
  folder tree, no nesting.

## 9. Player server

`src/server/player_server.ts` serves the player page (vendored assets),
`/api/map` (the ported player filter's output, with an ETag), `/api/votes`
and `POST /api/vote` (travel votes, in memory). Ports 5174–5180, localhost
unless "Serve on the local network" is on. `control.ts` serves one map at a
time from its **live** store model, refuses a newer format (503) and reports
a failed start to the GM. The filter is the ONLY path to players, and it is
map-only: notes are never read.

## 10. Exports, sketch, importer

- **Image export** (`render/image_export.ts`): the painter offscreen, tile by
  tile; PNG with a scale bar and credits strip; PDF through pdf-lib, split
  across pages. The Players version is built from the filter's payload,
  never from the model.
- **Campaign-folder export** (`src/convert/`): follows
  `vendor/docs/converter.md` §5. Notes are placed by section, NPC and quest
  notes become records, links are rewritten to Flutter names, and a
  round-trip manifest with FNV-1a fingerprints lets a later export to Obsidian
  collapse copies back.
- **Sketch** (`view/sketch_mode.ts`): a mode of the map view with its own
  canvas and its own undo history. Strokes are perfect-freehand outlines with
  Flutter's parameters. Hexify goes through `core/import_plan.ts` and
  `editor.applyImport` as one undo step.
- **Importer** (`src/importer/`, `view/import_wizard.ts`): Flutter's pipeline
  file for file (read `vendor/docs/decisions/importer.md` first). Libraries
  are stored in the plugin folder in Flutter's format. Not ported: the Ollama
  classifier and the multi-isolate fan-out (chunks yield to the UI instead).

## 11. Tests

- `npm test` runs everything under `test/`. The `obsidian` module is replaced
  by `test/mocks/obsidian.ts`; `test/smoke_views.test.ts` runs every view
  against it.
- Most tests are ports of the Flutter ones. The conformance and converter
  tests run on the vendored fixtures.
- `test/renderer.test.ts` also renders the dev vault's real campaign when
  `test-vault/` (a git-ignored link to the dev vault) exists, and skips it
  otherwise.
- `HEXLORE_WRITE_CONVERTER=1 npm test -- convert` writes the plugin → Flutter
  fixture into the Flutter repository; then commit there and re-vendor.

## 12. Releasing

1. `npm version <x.y.z>` updates `manifest.json`, `versions.json` and
   creates the tag (no `v` prefix, `.npmrc`).
2. Push the tag. `.github/workflows/release.yml` builds and creates a
   **draft** GitHub release with `main.js`, `manifest.json` and `styles.css`
   and build provenance.
3. Publish the draft. BRAT users get it from there.
4. For the community directory: the repository must be public, with a
   licence and a README, and `manifest.json` at its root; then open a pull
   request on `obsidianmd/obsidian-releases` (design §3, V9).
