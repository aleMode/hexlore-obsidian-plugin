# HexLore for Obsidian: design record

The plugin's design decisions, its build record and what is still open.
It started as the two-step plan of 2026-10-08 (step 1: move the Flutter app
to campaign format 2; step 2: build this plugin). **The numbering is kept**,
because the code cites it: "§1.x" is a decision below, "item 2.x" a build
step in §3, "V1…V10" a fact in §4, "Q1…Q11" a question in §5.

"Decision N" (a number with no §) is one of the Flutter app's decision
records, copied into `vendor/docs/decisions/` (index in its `README.md`).

---

## 1. Decisions

### 1.1 Scope and strategy

- **Personal plugin first.** It's installed by hand (or with BRAT) and published
  to the community directory only once it's close to final. The GM is the audience
  and already keeps their notes in Obsidian, so the plugin is a **map builder +
  viewer + player server**. Obsidian handles the notes.
- **Both apps stay.** Flutter is finished to a "definitive" state, then
  maintained and polished on a branch. The plugin lives in a **separate
  repository**.
- **Everything is ported except the regional view** (decision 21, judged
  structurally flawed): the map editor, every tool, fog, sketch + hexify, the
  importer, the player server, Clean and Illustrated.
- **Not ported because Obsidian replaces it:** the notes machinery (decision 3:
  `_pageCache`, page naming, `_syncPageNames`, reserve-on-open,
  wikilink strip/rename), `document_view.dart`, the git-host backup (`lib/sync/`;
  the vault is synced by git), write-behind (decision 26), and the GDK stylus hook
  (decision 18; the browser delivers pressure).
- **Mobile comes later.** The plugin does not declare itself desktop-only:
  desktop-only modules (the server, the importer's Ollama) load lazily.
- **Rule for the port:** Obsidian and the platform decide **how** data is stored
  and drawn. They do not decide **what** the data is. The model (axial ids, anchors,
  layers, the player filter) stays identical, because it is the contract between
  the two apps.

### 1.2 File format (format 2)

- **One JSON file per layer** (rivers, routes, regions, threads, fog, sketch, meta),
  **plus the paint layer split into 16×16-hex chunks.** Chunks are cut on the lattice
  (`q` and `unstaggeredRow`), not on the grid window, so a resize never re-splits
  them. On `purezza` that's ~6 chunk files instead of 915 hex files; the whole
  campaign compacted is ~70 KB.
- **Compact JSON, one record per line**, sorted by id or coordinates, so git diffs
  and merges work line by line.
- **The same paths as today** for the layer files that already exist
  (`rivers/rivers.json`, …). Nothing is renamed without a reason.
- **`format: 2`.** It goes up only for **breaking** changes; adding a field
  does not bump it. Whoever opens an older format migrates it. Whoever finds a
  newer one opens it **read-only**.
- **Unknown keys are preserved** in every record, and so are **unknown values**:
  an unknown terrain, feature, variant id, route kind… is drawn with a fallback,
  and the raw value is written back unchanged.
- **Unknown values fail closed for players.** The GM sees the fallback. The
  player filter drops an unknown feature (as if hidden) and an unknown-kind
  route, and never serves an unknown key.
- **A change to what players see always bumps `format`**, even if it is only a
  new key (e.g. a GM-only flag). Otherwise an older app would keep the key,
  ignore it, and serve the secret.
- **Variants are saved by id, not by index** (`"forest/dense"`), and the switch
  happens during the chunk migration. Every manifest entry gets a stable `id`,
  separate from its label, which can still be reworded freely. This retires
  decision 16's "order is persistence". Today
  `json['terrain_variant'] as int?` would **throw** on a string, which is why the
  tolerance matters. **Ids replace indices everywhere one is persisted**: the
  paint chunks, `sketch/hexified.json` (cells are `[terrain, variant]`) and
  the importer's `import_libraries.json`. A stored index past the end of its
  list (the tables changed shape once already) becomes an unknown value,
  `"<terrain>/#<index>"`, and is kept.
- **Sketch coordinates are rounded** to 0.1 scene px and pressure to 2 decimals,
  when an item is **committed** rather than when it is saved, so memory and disk
  never disagree.
  Nothing downstream changes: hexify samples 19 points per cell, and thinning
  already drops points closer than 1.5 px. That makes the file about 3× smaller.
- **Exactly one Markdown file per campaign, the `.hexmap.md` index (plugin
  side).** It holds only links, as **plain Markdown lines, never inside a code
  block**, because Obsidian does not track links inside code blocks. Obsidian keeps
  these links up to date when notes are renamed or moved. The paint chunks stay
  plain JSON. The player server never reads Markdown.
- **On-disk placement (plugin side):** `Purezza.hexmap.md` (the index, and the
  file the map is opened from) with a sibling folder `Purezza.hexlore/` holding
  the JSON layers (`campaign.json`, `paint/`, `rivers/`, …).
- **The underlay and the sketch trace image are links** to images already in the
  vault. There is no copy, and a broken link is harmless. Flutter keeps its own
  copy in `import/`, and the converter translates between the two.
- **Per-device state** (camera, overlay toggles, active tool…) lives in the
  plugin's per-vault `localStorage`. It never goes into synced files, nor into
  plugin `data.json`, which could be synced and would bounce the camera between
  devices.
- **Gone from the plugin's format:** `sync/`, `entries.json`, `pages/`
  (notes live in the vault). NPCs, quests and adventures become notes (§1.5).

### 1.3 Hexes and notes

- **Every hex has three separate things:**
  - **one feature**, the icon: map data, at most one;
  - **one label**, the player-facing name: map data. It stays under the JSON key
    `name`, which now *means* label, so nothing is renamed;
  - **an ordered list of notes, 0..N**, GM content.
- **The label is never derived from a note's title.** The player server never
  reads Markdown, so a note title like "Base Culto bad" can never reach players.
  When a note is created from a hex, the title is **prefilled** with the label;
  after that the two are independent.
- **Link direction B: the map points to the notes.** The `.hexmap.md` index holds
  lines like `- q5_r-2 :: [[Main note]] · [[Other note]]`. Notes carry no plugin
  fields; linking an existing note writes only to the plugin's own file.
- **First in the list = the principal note**, shown on hover and opened on click.
  **Everything in the list = the "main notes"**, shown when the hex is tapped.
  Notes linked from inside those are **secondary**: the map does not store them,
  and the hex panel can list them on request from Obsidian's outgoing links.
- **Notes are created only on request** ("new note here" / "link an existing
  note" / dragging a note onto a hex), never automatically from a feature.
  `purezza` has 44 features but only 15 written notes.
- **No hex-key-document mode.**
- **One note may be linked to several hexes.** It's expected to stay small (a
  dozen at most), so no automatic "make it a region" prompt.
- **NPCs and quests point to PLACE NOTES** (`location: [[Base Culto]]`), not to
  coordinates, so moving hexes never touches NPC notes. An NPC whose place note
  is on several hexes **highlights all of them**. An NPC can also be placed by
  being **in a hex's list itself** (the hermit in an unnamed hex).
- **Cut / copy / paste (decision 29):** the note list is one more field.
  - **Cut** moves the list with the hex.
  - **Copy** duplicates the list: the same notes become linked to the new hex,
    and no note text is duplicated.
  - **The "Fort - 2" naming rule** applies to the label only.
  - **One undo step** covers both files (the paint chunk and the index).
- **A deleted note leaves a dimmed broken link** in the hex panel, with
  "remove" / "relink". Unlinking a note never deletes it.

### 1.4 Sections

- **A section is a named list in the plugin's sidebar, backed by a folder.**
  - **Creating one:** link an existing folder, or create a new one (the plugin
    makes the folder).
  - **Contents:** the notes in that folder, subfolders included.
- **A note is in at most one section, because a file is in one folder.** Copies
  are never needed.
- **Sections and hex links are orthogonal.** A note can sit in "GM notes" **and**
  be linked to a hex.
- **A section is for browsing and for where "new note" lands.** It never changes
  what a hex links to.
- **The default sections mirror Flutter's categories**, so the converter maps them
  one-to-one:

  | Section | Flutter |
  |---|---|
  | Places | `pages/hexes/` |
  | Regions | `pages/regions/` |
  | NPCs | NPC tab |
  | GM notes | `pages/prep/` (Notes ▾) |
  | Adventures | `adventures/` |
  | Unsorted | Unsorted tab |
  | your own sections | custom tabs (`entries.json`) |

- **Nested section folders are not allowed** (see Q11).
- **Sections are set per CAMPAIGN**, stored in the `.hexmap.md` frontmatter. Two
  campaigns may still point at the same folder (e.g. a shared NPC folder).

### 1.5 Import / export and the round trip

- **Map data is shared natively.** Flutter's map files are format 2, and the
  converter copies them **without transforming them**. The converter handles
  only the **notes world**: pages, NPCs, quests, adventures, tabs, underlay
  and trace image.
- **Two converters, one in each app, each writing the OTHER app's format:**
  - **Flutter** has "Export to Obsidian vault…" (Flutter → plugin), in Dart, in
    the Flutter repository;
  - **the plugin** has "Export as a campaign folder…" (plugin → Flutter), in
    TypeScript, in this repository.

  Each app reads only its own format, and knows the other's only well enough to
  write it.
- **One converter document governs both**: `docs/converter.md` in the Flutter
  repository (copied to `vendor/docs/converter.md`). It holds:
  - every mapping in both directions;
  - the round-trip manifest;
  - a **converter contract version**, written into every export, so either side
    can tell when the other was built against an older contract.

  Any design change that touches a mapped field updates the document **first**,
  then both converters. Shared fixture pairs keep the two in step.
- **Flutter → plugin:**

  | Flutter | Plugin |
  |---|---|
  | hex `page_file` + `pages/hexes/*.md` | note moved into the vault + note #1 in the index |
  | page reservations with no file (61 of 76 on `purezza`) | dropped; they were empty |
  | `pages/regions/*.md` | region note + `region_id :: [[note]]` line in the index. The `## Encounters` table keeps working (read from the note). |
  | `pages/prep/*.md` | notes in the GM notes section |
  | `npcs/*.json` | NPC note: frontmatter `role`, `attitude`, `location`, `tags`, …; body = `description` |
  | `quests/*.json` | quest note: frontmatter `hook`, `objectives`, `reward`, `status`, `linked hexes`, …; body = `gm_notes` |
  | `adventures/` | notes with `order` in frontmatter |
  | `entries.json` tabs | sections |
  | `import/underlay.png` | copied into the vault **once**, then linked |
  | `sync/`, `hosts.json` | dropped |
  | `import_libraries.json` | plugin data, same format |

  **An NPC whose hex has no note:** the converter creates a **location note**
  named `<Campaign> <hex code>` (e.g. `Purezza F3`; `displayIdFor(q, r)`, which
  depends on coordinates only), puts a link to the NPC inside it, and makes it #1
  of that hex.
- **Plugin → Flutter.** The **section decides where the file goes; the hex keeps
  only a link.**

  | Note in the plugin | Where it goes in Flutter | What the hex shows |
  |---|---|---|
  | GM notes section, linked to a hex (even as #1) | `pages/prep/` | "also links to" |
  | Places section, #1 of one hex | that hex's page | its page |
  | Places section, #1 of **several** hexes | **copied** as the page of every one of those hexes | — |
  | Linked as #2…N | wherever its section says | "also links to" |
  | In no section / linked to no hex | Unsorted | "also links to" |

  **NPCs:**
  - an NPC whose place spans several hexes → **one copy per hex**;
  - an NPC with no place → Unsorted.

  **Section subfolders are flattened** into the section's root folder (filename
  collisions get `_2`).
- **Flutter shows extra notes as a read-only line** in the hex panel: "also links
  to a.md, b.md". Each entry opens in Flutter's own editor. Information the
  plugin has and Flutter doesn't show rides in fields Flutter preserves (unknown
  keys), so the round trip loses nothing.
- **A round-trip manifest.** On plugin → Flutter, the converter writes a manifest
  into the Flutter campaign: for each copy and each flattened file, its original
  vault path and a fingerprint of its text. On the way back:
  - unchanged copies merge back into the original, in its original subfolder;
  - if exactly one copy changed, its text wins;
  - if several copies changed differently, the original stays, the others become
    separate notes (`Base Culto (F3)`), and the converter reports it.
- **Flutter-format campaigns live outside the vault**, or in a dot-folder that
  Obsidian ignores. Otherwise `pages/*.md` would show up as duplicate notes.
- **The converter rewrites links in note text** that point at renamed files
  (`_2`, flattening). Flutter resolves `[[Name]]` by its own precedence (hex >
  region > npc > quest > entry), Obsidian by note name.
- **`gmNotesMd` (per-hex GM-notes sidecar) is removed from Flutter.** It has no
  editor anywhere in the UI. Only prep notes remain. Quest `gm_notes` is a
  different field and stays.

### 1.6 Sketch

- **A native port in stages.** **Excalidraw was rejected** as the sketch layer:
  we would rebuild colours-with-meaning, bucket fill, lattice alignment and hexify
  on top of another application, inside a map view we have to build anyway.
- **Same features as Flutter**, including hexify adding pieces to an existing
  map. Input: pen on a tablet or drawing tablet, or a mouse.
- **perfect-freehand in both apps** (MIT; it has a Dart port, whose quality must be
  checked first). The same stroke looks the same in both apps.
- **`sketch.json` is shared with Flutter** (rounded, one item per line). The trace
  image becomes a vault link through the converter.

### 1.7 Art and assets (preparing for packs only)

A full asset-pack system is **deferred**. Three things are done now, because each
costs almost nothing now and a lot later:

1. **Variant ids instead of indices**, during the chunk migration (§1.2).
2. **Unknown values get a fallback and are preserved** (§1.2).
3. **In the plugin: an ART REGISTRY.** The renderer asks it for the glyph or texture
   of (feature | biome, variant). The procedural biomes are registered in it too.
   The brush menu, the credits and the texture cache keys all derive from it.
   `player.js` is meant to receive the art as data from the server instead of
   fixed `.js` script files (not done yet: §3, `/api/art`).

Everything else (pack folders, a compiler, layering, tone classes, PNG stamps,
palette themes, zip trading, licences in the UI) is additive and can come later.

### 1.8 Sync, devices, players

- **The vault is synced with git.** Stay compatible with Obsidian Sync too
  (see §4).
- **The player server is in the same plugin**: opt-in, off by default,
  desktop-only, loaded lazily. Same port window (5174–5180), same LAN toggle, same
  votes. Obsidian must be open for it to run.

### 1.9 Converters vs exporters

- **Both apps are used as they are.** There is no map embedded in notes and no
  partial interop. The **converters** (§1.5) move a WHOLE campaign from one app to
  the other, and that is all they do.
- **Both apps get an image EXPORTER**, with the same options and rules:

  | Option | Choices |
  |---|---|
  | Format | **PNG** or **PDF** |
  | Version | **Players**: rendered from exactly the player server's filter output (`filterCampaignForPlayer`): fog, hidden features and their names, no regions, threads, borders, notes, underlay or sketch. You cannot leak a secret by mistake. **GM**: the GM map as currently displayed, following the Display & overlays switches. |
  | Style | **Clean** or **Illustrated** (blend edges follows the current display preference) |
  | Area | the whole grid window, or the current view |
  | PNG size | pixels per hex (or DPI + map scale). Large maps are rendered in tiles and stitched, so they never hit a GPU texture limit. |
  | PDF layout | **the map only, split across several pages** for large prints: paper size (A4 / A3 / Letter), orientation, scale (hex width in mm, or "fit to N pages"), an assembly overlap (~10 mm), and a small row/column label on each page |

- **Always on the image:**
  - the **scale bar**;
  - a short **credits line** (game-icons is CC BY 3.0 and Azgaar is MIT, so a shared
    image must carry the attribution): in the PDF footer, and in a thin bottom
    strip on the PNG;
  - never anything interactive: no selection, handles, cursor, ruler or vote
    pills.


---

## 2. Step 1: the Flutter side (done)

Built in the Flutter repository, items 1.1–1.14. What the plugin relies on:

- **Format 2** (decision 31): paint chunks, variants by id, compact JSON one
  record per line, unknown keys and values kept, the format guard.
  Specified in `vendor/docs/format-2.md`.
- **Conformance fixtures** (`vendor/conformance/`): the Dart `core` run on
  recorded inputs; the TypeScript `core` must reproduce every output.
- **The converter contract** (`vendor/docs/converter.md`) and its fixture
  pairs (`vendor/converter/`), with Flutter's "Export to Obsidian vault…" and
  its "also links to" line.
- **The image exporter** (decision 32), which item 2.10 follows.

## 3. Step 2: the plugin, item by item

Status on 2026-10-12. Every built item has tests (Flutter's are ported where
they exist), and `test/smoke_views.test.ts` runs every view against a
stand-in for Obsidian.

| Item | What | Status |
|---|---|---|
| 2.0 | Foundations, performance go/no-go, pen check | Built. The renderer benchmark lives on in `src/dev/` (map menu → HexLore → "Benchmark the renderer"); results in `docs/performance.md`. |
| 2.1 | `core` in TypeScript | Built: every conformance case passes. |
| 2.2 | Storage on the vault: format-2 codec, the `.hexmap.md` index, external changes, per-device state | Built. |
| 2.3 | Renderer, art registry, read-only view | Built: Clean, Illustrated, blend; tiles, atlas, damage-based redraws. |
| 2.4 | Editor: tools 1–8, paint picker, undo, cut/copy/paste, point editing, map operations, regions, Display & overlays | Built. |
| 2.5 | Hexes ↔ notes, sections, NPC and quest notes | Built. |
| 2.6 | Player server: filter, votes, ETag, LAN toggle | Built, except `/api/art` (see below). |
| 2.7 | Plugin → Flutter exporter ("Export as a campaign folder…") | Built; the round trip is tested on the fixture pairs. |
| 2.8 | Sketch: pen, eraser, fill, shapes, labels, trace image, hexify, swatch editor | Built. |
| 2.9 | Importer | Built, except the optional Ollama classifier. |
| 2.10 | Image exporter (PNG, PDF) | Built. |
| 2.11 | Polish: Illustrated performance, mobile, publishing | In progress. |

### What is left

- **Checking inside the real Obsidian.** Everything after 2.5's notes panel
  has been tested against the stand-in only.
- **The facts in §4**, none of which has been recorded as checked.
- **Illustrated performance** (`docs/performance.md`): one benchmark
  scenario is still over budget, Illustrated + Blend panning at zoom 1.0
  (frame p95 24.7 ms, 5 % dropped). Left to try: label sprites, rendering in
  a worker (only if still needed).
- **`/api/art`** (item 2.6, §1.7 point 3): the player page still loads the
  art tables as fixed scripts. Serving them as data needs `player.js` to take
  its tables from the server, a change made in the Flutter repository first.
- **The Ollama classifier** (item 2.9): optional, desktop only.
- **Mobile:** reading the map works, with two-finger pinch and pan. Editing on
  a phone is untested.
- **Publishing** (item 2.11): a licence (`package.json` says `UNLICENSED`),
  the repository name (Q10), a release, then the community directory (V9).

### Deferred, outside both steps

- The full asset-pack system (§1.7 lists what is already prepared).
- The regional view (Flutter decision 21; not ported).

---

## 4. Facts to check (unverified)

| # | Claim | Why it matters | When |
|---|---|---|---|
| V1 | Obsidian Sync syncs non-Markdown files only when "other file types" is on | `.json` map files wouldn't sync | 2.0 |
| V2 | Obsidian Sync takes the last-modified version of non-Markdown files on conflict | merge behaviour of the layer files | 2.0 |
| V3 | Obsidian Sync per-file size limit (recalled: 5 MB Standard) | the underlay was 6.1 MB | 2.0 |
| V4 | Renaming a note updates wikilinks in the index list **and** in frontmatter properties | the index and underlay links depend on it | 2.0 |
| V5 | Obsidian ignores dot-folders | where a Flutter-format campaign may live | 2.0 |
| V6 | `Vault.append` exists | an append-only sketch file, as an optimisation only | 2.8 |
| V7 | The Dart perfect-freehand port: licence, maintenance, quality | item 1.8 | 1.8 |
| V8 | Pen pressure reaches Obsidian on Windows with Windows Ink | the sketch | 2.0 |
| V9 | Community review policy for plugins with a LAN server | publishing only | 2.11 |
| V10 | Licence and quality of Flutter's `pdf` package, and of pdf-lib / jsPDF | the PDF export | 1.14 / 2.10 |

---

## 5. Questions

### Resolved (2026-10-08)

| # | Question | Answer |
|---|---|---|
| Q1 | Where does the converter run? | **Both apps, each writing the other's format** (1.12 in Flutter, 2.7 in the plugin), governed by `docs/converter.md` (1.11). |
| Q3 | Sections per vault or per campaign? | **Per campaign**, in the `.hexmap.md` frontmatter. |
| Q4 | Where does the data folder sit? | `<Name>.hexmap.md` + a sibling `<Name>.hexlore/`. |
| Q5 | Variant ids: strings everywhere or mixed? | **Strings everywhere** in format 2. |
| Q9 | Undo when a file changes underneath | Drop the undo entries touching the reloaded files, with a notice. Keep the rest. |
| Q6 | Exports | Both apps are used as they are: **no map embedded in notes**. The converters move WHOLE campaigns only. **An image exporter (PNG + PDF) in BOTH apps**, with the same options (§1.9): Players/GM, Clean/Illustrated, and a PDF that is the map only, split across pages. |

### Still open (each default stands until changed)

| # | Question | Default |
|---|---|---|
| Q2 | Flutter → plugin: a link in note text to a hex **name** with no note | **Create the location note** (the same rule as NPCs). |
| Q7 | Close the known secrecy leaks (a `#dungeon` tag, a legacy `colorOverride`) in the Flutter app? | **Deferred.** Not related to the port. |
| Q8 | Does the regional view stay in Flutter? | **Stays as is**, only excluded from the plugin. |
| Q10 | Plugin repository name and location; minimum Obsidian version | `hexlore-obsidian`, a sibling of the Flutter repository; `minAppVersion` 1.13.0 (`manifest.json`). |
| Q11 | Nested section folders | **Refused** (one section per folder tree). |
