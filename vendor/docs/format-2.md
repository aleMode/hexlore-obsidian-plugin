# HexLore campaign format 2

The on-disk layout of a HexLore campaign, as written by the Flutter app from
format 2 on, and as the Obsidian plugin will read and write it. This document
is the **map format only**. How notes, NPCs, quests and pages are carried
between the two apps is `docs/converter.md`'s job (`docs/converter.md`).

The code is the reference implementation: `lib/storage/file_manager.dart`
(layout, migration), `lib/core/json_lines.dart` (encoding),
`lib/core/paint_chunks.dart` (chunks), `lib/core/variant_ids.dart` (ids),
`lib/core/json_extra.dart` (unknown keys and values). The decision record is
31 (`docs/decisions/model-and-storage.md`).

---

## 1. Rules that apply to every file

### Versioning
- `campaign.json` carries `"format": 2`. A missing `format` means 1.
- **A reader that finds a newer format opens the campaign READ-ONLY** and
  never writes to it. Its player server refuses to serve it.
- **A reader that finds an older format migrates it** (Flutter: on open; §4).
- `format` goes up only for a BREAKING change. Adding a field does not bump
  it, with one exception:
- **Any change to what players may see bumps `format`**, even when it is
  "only" a new key (a GM-only flag, a new secrecy rule). An older reader
  keeps unknown keys but cannot obey them, so it would serve the secret.

### Encoding
- UTF-8 JSON, written atomically (temp file + rename).
- **One record per line**, compact (`encodeJsonLines`):
  - a top-level array: `[` then one compact element per line, then `]`;
  - a top-level object: one key per line; a key whose value is an array or
    object holds one compact element per line beneath it; anything deeper is
    compact;
  - two-space indentation at those two levels, and a trailing newline.
- Readers must not depend on the whitespace: it is JSON.
- Sorted where the order means nothing: layer arrays by `id` (numeric-aware:
  `route_2` before `route_10`), chunk records by (q, r), `revealed` ids and
  hexify cells by their natural order. **Order-carrying arrays are never
  re-sorted**: sketch `items` (z-order), sketch `swatches` (palette order),
  adventure rows (by `order`), river `vertices` and route `nodes`.

### Defaults
- A key at its default value is usually OMITTED (§3 lists which). A reader
  supplies the default for any missing key.
- Derived values are never stored: a hex's id and display id come from
  (q, r) (decision 1).

### Unknown keys and values
- **Unknown keys are preserved.** Every record keeps the keys it does not
  recognise and writes them back after its own, unchanged.
- **Unknown values are preserved.** A field with a closed set of values
  (terrain, feature, variant id, route kind, thread type / direction /
  status, quest status, tab mode, swatch kind, shape kind, sketch item
  `type`) is read with a FALLBACK, and the original value is written back in
  its own place. Editing that field replaces it.
- **Unknown things fail closed for players**: no unknown key is ever served;
  a hex whose feature is unknown is served like a hidden one (biome only, no
  name); a route of unknown kind is not served.

| Field | Fallback the GM sees |
|---|---|
| hex `terrain` | `default` biome |
| hex `feature` | none (nothing drawn) |
| hex / swatch / hexify variant | variant 0 |
| route `kind` | drawn as a road |
| thread `type` / `direction` / `status` | `Custom` / `bidirectional` / `active` |
| quest `status` | `seed` |
| entry tab `mode` | `global` |
| swatch `kind`, or a biome swatch's unknown `terrain` | `none` (means nothing to hexify) |
| sketch shape `kind` | `line` |
| sketch item `type` | kept verbatim, not drawn, not hit, not hexified |

### Variant ids
- A stamp variant is saved as an **id**, `<terrain-or-feature>/<slug>`;
  index 0 is always `<terrain-or-feature>/default` (and, being the default,
  is usually omitted).
- The table is `lib/core/variant_ids.dart`; both art manifests carry the same
  `id` on every entry; `tool/variant_ids.lock` lists every id ever issued.
  **An id is never removed, reused or renamed.** A label is display text and
  may change freely.
- Readers accept a format-1 integer index too. An id a reader does not know,
  or an index out of range, is kept raw (written back as it was) and drawn as
  variant 0.

---

## 2. Layout

```
<campaign>/
  campaign.json            meta: format, name, grid window, scale
  entries.json             citation tabs and entries
  paint/c_<cx>_<cy>.json   the hexes, 16×16 per chunk
  rivers/rivers.json       all rivers
  routes/routes.json       all routes (roads, trails, borders)
  regions/regions.json     all regions
  threads/threads.json     all threads
  player/revealed.json     player fog
  npcs/<id>.json           one NPC per file
  quests/<id>.json         one quest per file
  adventures/manifest.json adventure rows; adventures/<id>.md bodies
  pages/<folder>/<Name>.md Markdown pages (hexes/, regions/, prep/, npc/, unsorted/, custom tabs)
  sketch/sketch.json       the sketch layer
  sketch/hexified.json     what the last hexify wrote
  sketch/trace_image.json  + trace_image.png   reference picture
  import/underlay.json     + underlay.png      imported map image
  sync/attachment.json     backup attachment (pushed)
  sync/state.json          this machine's sync state (never pushed)
```

GM-only and never read by the player server: everything except
`campaign.json`, `paint/`, `rivers/`, `routes/` and `player/revealed.json`.
The plugin's own index (`<Name>.hexmap.md`) and its sections are specified
in `docs/converter.md` §3.

---

## 3. Files

### `campaign.json`

| Key | Type | Default | Notes |
|---|---|---|---|
| `format` | int | 1 if absent | always written: `2` |
| `name` | string | folder name | |
| `grid_cols` | int | 10 | grid window width |
| `grid_rows` | int | 10 | grid window height |
| `grid_min_q` | int | 0 | first column |
| `grid_r_shift` | int | 0 | vertical offset of the window |
| `hex_distance` | number | 6.0 | real distance across one hex (> 0) |
| `distance_unit` | `"mi"` \| `"km"` | `"mi"` | |

All keys are always written.

### `paint/c_<cx>_<cy>.json` — the hexes

- **Chunk key:** `cx = floor(q / 16)`, `cy = floor(u / 16)` with the
  unstaggered row `u = r + floor(q / 2)`. Floor division rounds toward −∞.
  The cut is on the lattice, not the grid window: resizing the window never
  moves a hex to another chunk.
- **Content:** a JSON array of hex records, one per line, sorted by q then r.
- A hex with nothing worth saving (every field at its default) has **no
  record**. A chunk with no records is **deleted**, not written empty.
- Player fog is NOT here: see `player/revealed.json`.

Hex record:

| Key | Type | Default (omitted when) | Notes |
|---|---|---|---|
| `q`, `r` | int | required | axial coordinates; the id `q<q>_r<r>` is derived |
| `name` | string | omitted when empty | the player-facing label |
| `terrain` | string | always written | `forest` `plains` `mountain` `sea` `hills` `desert` `swamp` `tundra` `lake` `jungle` `volcano` `default` |
| `terrain_variant` | variant id | omitted when 0 | e.g. `forest/dead` |
| `feature` | string | omitted when none | `city` `settlement` `tower` `ruins` `dungeon` `lookout` `mine` `well` `pit` `pyre` `cage` `flag` |
| `feature_variant` | variant id | omitted when 0 | e.g. `well/cistern` |
| `feature_hidden` | `true` | omitted when false | only with a feature: withheld from players with the name |
| `color_override` | `"#RRGGBB"` | omitted when empty | legacy fill (pre biome/feature split) |
| `page_file` | string | omitted when empty | `pages/`-relative path of the hex page |
| `npc_ids`, `quest_ids`, `event_ids` | string[] | omitted when empty | |
| `tags` | string[] | omitted when empty | GM-only: never served to players |

Legacy terrains `city` / `dungeon` / `ruins` / `tower` (pre-split files) are
migrated on read to a feature plus `color_override`, not preserved as
unknown values.

### `player/revealed.json`

`{"revealed": ["q0_r0", ...]}`, sorted. The authority for player fog: a
revealed id with no hex record is still a revealed (empty) cell.

### `rivers/rivers.json`

Array of rivers, sorted by id: `{"id", "vertices", "width"}`.
- `vertices`: ordered anchors `[kind, q, r, k]` with kind `v` (corner),
  `e` (edge midpoint) or `c` (centre). A legacy `[q, r, c]` triple is a
  corner and is still read.
- `width`: multiplier, 0.25–4.0, default 1.0.

### `routes/routes.json`

Array of routes, sorted by id: `{"id", "kind", "nodes", "color", "width",
"player_visible"}`.
- `kind`: `highway` `road` `trail` `border`.
- `nodes`: ordered `{"kind", "q", "r", "k"}` anchors, as rivers.
- `player_visible`: borders default to `false`; everything else `true`.

### `regions/regions.json`

Array, sorted by id: `{"id", "name", "cells": [[q, r], ...], "color",
"z_order", "page_file"}`. GM-only. (`layer` from older files is dropped.)

### `threads/threads.json`

Array, sorted by id: `{"id", "from_hex", "to_hex", "type", "label", "color",
"direction", "status"}`. GM-only.
- `type`: `Quest Chain` `NPC Relationship` `Faction` `Rumor` `Trade Route`
  `Secret` `Custom`.
- `direction`: `bidirectional` `one-way`. `status`: `active` `dormant`
  `resolved`. `color`: `"#RRGGBB"` or `""` for "by type".

### `npcs/<id>.json`, `quests/<id>.json`

NPC: `id name hex_id role attitude description secret tags linked_npc_ids
linked_quest_ids notes_file is_secret`. Quest: `id title hex_id hook
objectives reward status gm_notes linked_hex_ids linked_npc_ids tags
unresolved is_secret`; `status` is `seed` `active` `dormant` `resolved`
`failed`. All keys always written. GM-only.

### `adventures/manifest.json`

Array of `{"id", "title", "order"}`, sorted by `order` then id. The body of
each is `adventures/<id>.md`.

### `entries.json`

`{"tabs": [{"name", "fixed", "mode"}], "entries": {"<id>": {"id", "name",
"tab", "npc_id", "page_file"}}}`. `mode`: `global` `local`.

### `sketch/sketch.json`

`{"version": 1, "next_id", "swatches": [...], "items": [...]}`.
- **Swatch** `{"id", "name", "color", "kind", "terrain"?, "variant"?}`:
  `kind` is `none` `biome` `river` `road` `trail`; `terrain` and `variant`
  (an id, omitted when 0) only for a biome swatch.
- **Items** are in z-order (later on top). Every item has `type` and `id`:
  - `stroke`: `swatch`, `width`, `points` = flat `[x, y, p, x, y, p, ...]`;
  - `shape`: `kind` (`line` `rect` `ellipse`), `swatch`, `width`, `x1 y1 x2
    y2`, `filled` (omitted when false);
  - `fill`: `swatch`, `polygon` = flat `[x, y, ...]` (implicitly closed);
  - `label`: `text`, `x`, `y`, `size`, `color`.
- **Precision:** scene coordinates and sizes to 0.1 px, pressure to 2
  decimals. Items are rounded when created, so what is in memory is exactly
  what is on disk.

### `sketch/hexified.json`

`{"cells": {"<q>_<r>": [terrain, variant-id], ...}, "rivers": [ids],
"routes": [ids]}`, cells sorted by (q, r). What the last hexify painted; a
cell whose current paint differs was edited by hand since.

### `sketch/trace_image.json`, `import/underlay.json`

Placement of a GM-only reference image next to its `.png`:
trace image `{center_x, center_y, width, height, opacity, visible, locked}`;
underlay `{grid: {orientation, radius, origin_x, origin_y}, anchor_q,
anchor_r, min_q, min_r}`.

---

## 4. Migration from format 1

Format 1 stored each hex in `hexes/q<q>_r<r>.json` with variant INDICES. On
open, in this order:

1. `paint/.migrated-from` is written: a sha1 of the `hexes/*.json` being
   migrated (names and contents, sorted).
2. The chunks are written (variants as ids). An index out of range is kept
   raw.
3. `sketch/hexified.json` and `sketch/sketch.json` are rewritten with
   variant ids, when present and readable.
4. `campaign.json` gets `"format": 2`.
5. `hexes/*.json` and the marker are deleted. Legacy Markdown sidecars in
   `hexes/` are then folded into hex pages, and `hexes/` goes once empty.

**Interrupted:** a format-1 folder whose `paint/` marker matches its
`hexes/` is migrated again from scratch; a format-2 folder with leftover
`hexes/*.json` has them swept.

**A format-1 folder with chunks but no matching marker** was saved by a
pre-format-2 build after the migration (that build writes only the hexes it
changed and stamps `format: 1`). It is never resolved silently: the GM
chooses to apply that build's hexes over the chunks, to drop them, or not to
open the campaign.

**Backups:** migrate on one machine and push; on any other machine, pull
before opening the campaign.

---

## 5. Not part of format 2

- The **player payload** (`/api/map`) is a wire format, not a file: it stays
  index-based (`player.js` indexes its generated tables), and is built from
  explicit keys only.
- **Per-device state** (camera, tools, overlay toggles) lives in the app's
  config (`~/.hexlore/config.json`), never in the campaign.
