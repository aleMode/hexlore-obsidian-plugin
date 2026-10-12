# Decisions — Data model, storage, undo, preferences, cut/paste

Decision records moved verbatim from the root `CLAUDE.md`, whose index
lists every decision number and where it lives. Numbers are stable;
"decision N" anywhere in the notes resolves through that index.

Decisions: 1, 1b, 1c, 2, 2b, 3, 9, 10, 11, 26, 28, 29, 31.

1. **Canonical hex id = axial `(q, r)` → `"q0_r0"`.** The map key in `Campaign`,
   the per-hex filename, and every cross-reference. The human `displayId`
   (`"A1"`) is derived, never stored as a foreign key. See `core/hex_data.dart`.

1b. **Terrain = biome + feature (Inkarnate-style split).** `Terrain` is
   BIOMES ONLY (owns the fill color); structures/POIs are `Feature`s — icon-only
   overlays (`city`, `settlement`, `tower`, `ruins`, `dungeon` + the "other"
   set: `lookout`, `mine`, `well`, `pit`, `pyre`, `cage`, `flag`) that never
   change the fill. Both have named stamp variants (`terrainVariantNames` /
   `featureVariantNames`; persisted as `terrain_variant` / `feature` /
   `feature_variant` in hex JSON — by ID since format 2, decision 31 — index
   0 = default; a stored index out of range is kept raw and drawn as 0).
   Legacy files storing `terrain: city|dungeon|ruins|tower` migrate on load
   (`legacyTerrainFeatures`): feature + old fill preserved as `colorOverride`;
   painting a biome CLEARS `colorOverride` (that's how migrated colors retire).
   Stamps are drawn via `app/glyphs.dart`'s `drawBiomeStamp`/`drawFeatureGlyph`
   — see decision 16 for the glyph-vs-procedural split — and are MIRRORED in
   `player.js` (`TERRAIN`/`TERRAIN_GLYPHS` + `GLYPHS`) — keep in sync;
   `player_stamp_tables_test.dart` reads the real JS and fails when a
   procedural biome, or a glyph-based one, drifts. Both take their ink and
   their size/offset constants from the shared render spec (decision 13),
   never their own. A hex's feature stamp
   replaces its biome stamp on canvas; the fill stays the biome's. Paint flows
   through `applyTerrainBatch`/`applyFeatureBatch` → `pushPaintStroke` (full
   `HexPaint` snapshots, one undo per stroke; feature-erase never creates a
   hex). The terrain palette groups Biomes / Structures / Other with a "›"
   per-item variant flyout (last-picked variant remembered per item).

1c. **`PaintPick` (`core/hex_paint.dart`) is the shared paint INTENT**, and
   each of its two layers is THREE-valued: biome = leave alone (`terrain`
   null) / set; feature = leave alone (`feature` null) / set / erase
   (`clearsFeature`). "Leave alone" is the whole reason it exists — it is what
   expresses *"stamp a city here, whatever biome this hex already has"*, which
   a non-nullable `Terrain` cannot say. Do **not** confuse it with
   `app_controller.dart`'s `HexPaint`, which is the full undo SNAPSHOT of a hex
   (non-null terrain, plus `colorOverride`); a pick is what you WANT, a
   snapshot is what IS. It is `core/` because three layers consume it: the map
   toolbar's brush (`main.dart` — `_Brush` was folded into it), the importer's
   pure pipeline (`GroupDecision.pick`, `ImportCell.pick`, `IconTemplate.pick`)
   and `app/paint_picker.dart`. That last one is the shared CHOOSER: a
   `MenuAnchor` cascade (layer → item → variant) whose tree is derived from
   `hex_data.dart`'s tables, never hand-written, so a new biome or variant
   appears in it for free. It is a menu and not a list because biomes,
   features and variants together are well over a hundred leaves — a flat
   `DropdownButton` (what the import wizard used) is unreadable at that size,
   while two levels of submenu keep every choice three short lists away.

2. **`Campaign` is the in-memory authority; the player server re-reads files per
   request** (behind a folder-signature cache). Reveal toggles write
   `player/revealed.json` immediately.

2b. **A save writes only what carries information** (decision 20's measured
   follow-up). Three rules, all in `storage/file_manager.dart`:
   - **A hex with nothing but its coordinates is not persisted.**
     `HexData.hasPersistentContent` is the predicate; `saveHex` DELETES the
     JSON rather than writing it, and `pruneEmptyHexFiles` sweeps an existing
     campaign once at load. A brush erased back to default terrain and a fog
     reveal both CREATE hexes, and on the GM's real campaign 409 of 1103 hex
     files carried nothing else — a third of every backup push. Such a hex
     renders identically absent (`computeState` reads both as
     `HexState.empty`). Markdown sidecars are never deleted by a save.
   - **`revealed.json` is therefore SELF-SUFFICIENT.** A revealed cell with no
     other content has no file, so `loadCampaign` MATERIALISES a hex for every
     revealed id it cannot find (ignoring ids that don't parse). Before this,
     fog depended on a companion file existing — the coupling decision 5's
     "server authority" claim implied but did not have.
   - **Format 2 (decision 31): per CHUNK, not per file.** A contentless hex
     is simply absent from its `paint/` chunk, a chunk left empty is DELETED,
     and `pruneEmptyHexFiles` is a no-op on a format-2 folder (it only ever
     swept format-1 `hexes/`). The rules below hold per record.
   - **Hex JSON omits defaults, and drops derived keys.** `fromJson` supplies
     every default, so a key at its default carries nothing; `id`,
     `display_id` and the dead `notes_file` are derived (decision 1) and a
     stored copy can only go stale. ~330 bytes → ~120. Old full-key files
     still load; the sweep does NOT rewrite verbose files, since rewriting
     1100 of them at open would read as a spurious change and cost a full push.
   - **A hex page is RESERVED on open, WRITTEN on first character.**
     `ensureHexPage` used to create a zero-byte `.md` merely because a hex was
     looked at. The reservation lives in the hex's `page_file`, `loadPage`
     reads a missing page as `''`, and `_syncPageNames` must call
     `_repointPage` after a rename because `renamePage` no-ops on a file that
     does not exist yet — without it the body would be written back under the
     OLD name. `pages/prep/` and `pages/regions/` stay EAGER: those folders
     ARE their own listing, so an empty file there is a real document.
   - `sync/state.json` is written compact (one entry per campaign file, 124 KB
     of mostly indentation, never pushed, never read by a person);
     `sync/attachment.json` stays pretty-printed because it IS pushed.

3. **Markdown is plain `.md` under `pages/`.** Hex main pages, entry pages, prep
   docs, and **region pages** all live there (name-based filenames, `_2` on
   collisions; the path is recorded, never a key). `AppController._pageCache`
   holds bodies; `setPageBody` marks them dirty for the debounce.

9. **Undo** (`app/undo.dart`, `AppController.undoStack`) covers **map edits**:
   terrain strokes, hex naming, hex/thread/river/route create-delete-edit,
   river/route point drags and inserts (one entry per gesture — decision 8c),
   region cell strokes, and hex cut / paste (decision 29; copy changes nothing). NOT: text edits (per-field), reveal toggles / fog
   brush strokes, region create/delete (dialogs). Commands are model+disk
   only; `run` re-runs on redo, `undo` reverses — `push` does not execute
   `run`.

10. **`Route` name clash:** `core/route.dart`'s `Route` collides with Flutter
    Material's `Route`. Any file importing both uses
    `import 'package:flutter/material.dart' hide Route;` (see `hex_map.dart`), or
    imports core route as `show RouteNode` only (see `main.dart`).

11. **Hex remap** (`core/remap.dart`) — one `CellTransform` engine behind
    "Explode map…" (campaign menu › Map: integer scale about the populated centroid;
    REFUSED if the grid window is too small, never auto-resizes) and "move
    selection" (select tool: drag starting on a selected cell shows a
    grid-snapped ghost, red = blocked; drop commits). `applyCellRemap` rewrites
    hexes (rekey via `HexData.copyAt` — q/r are final), thread endpoints,
    npc/quest home refs, region cells, river vertices and route nodes
    (re-canonicalised via the factories; `'e'` winners can flip). Hex pages are
    name-based and wikilinks resolve by name, so no page/link rewriting. Both
    ops are ONE undoable snapshot command each; the undo stack is NOT cleared
    (LIFO makes stale-(q,r) closures unreachable, unlike `resizeGrid` which
    mutates without pushing).

26. **The running app writes the campaign WRITE-BEHIND**
    (`storage/write_behind.dart`, `FileManager(writeBehind:)`). Measured on
    the GM's Windows machine: one synchronous temp-file+rename costs 3.6–4.8
    ms (antivirus scanning each new file is the likely reason), so an
    autosave chunk of 24 hexes froze the UI ~100 ms, a 300-hex stroke
    ~1.2 s, and the fog brush paid ~5 ms per stamp for `revealed.json`. In
    the CPU profile of a brush session `File.rename` alone was 44% of the UI
    isolate. Queued, the same 300 hexes cost the UI 4–8 ms.
    - **One ordered queue per FileManager, and nothing else writes the
      folder.** Every FileManager write goes through `_put`/`_putJson`/`_del`
      /`_mkdirs`, which queue a `WriteOp` when a queue is attached. Batches
      run one at a time in an `Isolate.run` (`runWriteOps`, top-level so it
      can), so order is exactly the queued order — that, not locking, is what
      removes every race between an autosave and a delete, a rename or a
      second write. Ops on one path within a batch coalesce to the last one.
    - **Reads see pending writes**: `loadPage` and `_exists` consult
      `pending()`, `listPageFiles` merges `pendingIn()` (or the page-name
      allocator could hand out a name that is about to exist). A rename is
      queued as a write of the destination + a delete of the source, with the
      content captured at the call, so every op stays single-path.
    - **Anything that reads the FOLDER from disk drains first**
      (`MainShell._flushToDisk`: flush, then `fm.drain()`): window close,
      backup push/pull/restore, reopening a campaign (`_openCampaign` drains
      the old controller's queue before loading — reopening the SAME folder
      after a merge reads it from disk). The player server reads the disk a
      few ms behind; that is its normal polling lag.
    - **Only the app turns it on** (`main()` → `HexLoreApp(writeBehind:
      true)`). Widget tests pump `HexLoreApp`/`MainShell` directly in fake
      async, where an isolate never completes, and every other test expects
      a write to be on disk when the call returns — both keep the
      synchronous default. `write_behind_test.dart` covers the queue and the
      FileManager/AppController paths through it.
    - The background temp file is `<file>.bg.tmp`: still `*.tmp`, so the
      backup's exclusion rule and the player server's `.json`/`.md` filter
      ignore a leftover one. A failed op is reported through
      `WriteBehindQueue.onError` (a toast in the shell) and never stops the
      rest of the batch; if the isolate itself cannot start, the batch runs
      inline rather than being lost.
    - The fog brush's status line moved to its own `ValueNotifier`
      (`_statusN`): a whole-shell `setState` per stamp was 5–16 ms of a
      profiled drag.
    - **Format 2 (decision 31): one op per dirty CHUNK.** `flushAsync`
      groups the dirty hexes by chunk and writes each chunk once, yielding
      between chunks (was: 24 hex files per yield). A chunk is written
      whole from the live model, so `FileManager` keeps the loaded
      campaign's hexes bound (`_hexes`).
    - **The format migration does NOT go through the queue.** The queue
      coalesces ops per path, which folds "marker first … marker deleted
      last" into one trailing delete and loses the order the migration's
      crash safety rests on; it runs once, at open, with `_direct` writes.
    - The synchronous `atomicWrite` retries a refused rename the same way the
      queue does (`renameRetrying`): the lock that hits the queue also hits
      the teardown flush, and a save that fails there is lost.

28. **Every choice that is not a one-off action is REMEMBERED** — a standing
    rule from the GM: session-only state is a bug unless the thing is
    genuinely transient (a selection, a half-drawn line, a drag in flight).
    Two scopes in `storage/settings.dart`, both in `~/.hexlore/config.json`
    and therefore never pushed by the backup and never served:
    - **`ui`** (`uiPrefs` / `setUiPrefs`): this machine's tool settings and
      display toggles — brush radius, route kind and colour, GM fog, sketch
      overlay and its mode, the Overlays panel's expanded sections, sketch
      tool / width / fill / ghost / lattice. The older
      top-level keys (`render_style`, `blend_edges`, `thread_style`,
      `player_server_lan`) stay where they were.
    - **`campaign_view`** (`campaignView` / `updateCampaignView`), keyed by
      `campaignViewKey(folder)` (absolute, `/`-separated, case-folded on
      Windows): what that map was showing — view (hex/sketch/regional),
      camera, the Overlays panel's switches (decision 27), underlay
      visibility, active region, sketch swatch, last thread colour. Ids belonging to one campaign
      live here, not in `ui`; a region id that no longer exists is dropped on
      restore. View state, not campaign data, so two machines can look at
      one campaign differently.
    - **Snapshot, not call sites.** `MainShell.build` snapshots both scopes
      (`_uiPrefsSnapshot` / `_campaignViewSnapshot`) and a 400 ms debounce
      writes whichever moved; dispose, window close and a campaign switch
      write at once. A new toggle is remembered by joining a snapshot — and
      restored by a line in `_restoreUiPrefs` / `_restoreCampaignView`,
      which `shell_smoke_test.dart` catches if forgotten (it seeds every key,
      runs the shell, and expects every value back). The CAMERA is written
      only on leaving a campaign or closing the window (it moves on every
      pan), and `_fitMapToCampaign` restores it instead of fitting when one
      is remembered.
    - **Deliberately not remembered**: the active tool, the armed terrain
      brush, the open document panel — what the GM is DOING, not how they
      like to work. The underlay still starts hidden on a campaign's FIRST
      open (decision 12); after that its last state is kept.
    - Tests that pump the shell MUST set `settings.configDirOverride`
      (decision 20's rule): the shell now reads AND writes the config.

29. **Hex cut / copy / paste moves CONTENT; fog and the lattice stay put**
    (`core/hex_clipboard.dart`, `AppController.copyHexes` / `cutHexes` /
    `pasteHexes`, `app/clipboard_menu_row.dart` — three icons heading the hex
    context menu, and Ctrl+X / Ctrl+C / Ctrl+V on the map's scoped focus so a
    text field keeps its own). It works on the whole selection, keeping its
    shape, and EVERYTHING lines up TOP-LEFT TO TOP-LEFT (`topLeftCell`:
    smallest column, then smallest r — translation-equivariant, so the same
    shape fits exactly): the clipboard's anchor is the copied selection's
    top-left (empty cells included, so a gap in the corner survives) and a
    paste lands it on the current selection's top-left. No selection = the
    shortcuts do nothing. `fitPaste` decides the rest: a paste that would
    write OUTSIDE the selection (fewer hexes selected, another shape) asks
    first, saying how many of those cells already hold content; a BIGGER
    selection just takes the paste in its corner, and the status line says
    how many selected hexes were left alone.
    - **What travels**: biome + variant, feature + variant, `featureHidden`,
      `colorOverride`, tags, name, description, GM notes — and it OVERRIDES
      the target, clearing included (an unnamed paste clears the name).
      **What stays with the cell** (`pastedHex`): player fog, the page
      filename (never shared by two hexes; the rename-at-save pass renames
      the target's), and the target's own NPCs / quests / threads. Rivers,
      routes and region membership never move — they live on the lattice.
    - **A copy carries no references**; a **cut detaches them** — threads
      touching a cut hex, NPC / quest homes, quest linked hexes — and its
      paste re-attaches them at the new ids. A cut hex that was revealed
      leaves a bare revealed hex, so revealed.json needs no rewrite. A thread
      whose other end was deleted meanwhile, or that would join a hex to
      itself, is dropped (reported); an id `nextThreadId` re-issued meanwhile
      is renumbered.
    - **Names**: a clash becomes `"<base> - n"`, smallest free n ≥ 2 (the
      original is #1), numbered from the base so "Fort - 2" copies to
      "Fort - 3" (`copyHexName`). A cut pasted with no clash keeps its name.
    - **A cut pastes ONCE; a copy any number of times.** The clipboard is on
      the controller because undo moves it: undoing a cut empties it (or a
      paste would duplicate the restored hexes), undoing a cut's paste puts
      the cut back even over a later copy (otherwise only undoing the cut
      could reach those hexes). Session-only, deliberately (decision 28's
      "transient" exception).
    - **A paste is all-or-nothing** (`pastePrecheck`): one cell off the grid
      refuses it, since a partial cut paste would lose the rest.
    - Undo of a paste deletes any page file the pasted hex acquired at a save
      (a fresh allocation, or the target's page renamed to the pasted name) —
      it holds pasted text only — and restores the target's snapshot.

31. **Campaign FORMAT 2: paint chunks, variants by id, and nothing unknown
    is lost**. Format 2 is the layout the Obsidian plugin reads and writes;
    Flutter moved first. The spec is `docs/format-2.md`.
    - **The format guard.** `campaign.json`'s `format` is read on EVERY open,
      not only on a backup pull: a newer one opens READ-ONLY
      (`FileManager.readOnly` turns every write primitive into a no-op; the
      shell refuses the editing tools and shows a red READ-ONLY chip) and
      the player server answers 503. An older one is migrated.
    - **Paint chunks.** `paint/c_<cx>_<cy>.json`, `cx = floorDiv(q, 16)`,
      `cy = floorDiv(unstaggeredRow(q, r), 16)` (`core/paint_chunks.dart`):
      cut on the LATTICE, so a grid resize never re-splits one. One hex
      record per line, sorted by (q, r). `purezza`: 915 files → 11.
    - **One encoder** (`core/json_lines.dart`): every campaign JSON file is
      compact, one record per line, newline-terminated; layer arrays sorted
      by id (`compareIds`: `route_2` before `route_10`), order-carrying
      arrays (sketch items, adventure order, line points) never re-sorted.
      `sync_merge` encodes with it too, so a merge equals a save.
    - **Variants by id** (`core/variant_ids.dart`, decision 16). Readers take
      an index OR an id from 1.6 on (hex JSON, `hexified.json`, swatches,
      importer libraries, stamp prototypes); writers emit ids. An unknown id
      or an out-of-range index is kept RAW and drawn as variant 0 — never
      clamped, never a crash.
    - **Unknown keys and values are kept** (`core/json_extra.dart`): every
      model has `extra` (unknown keys, written back after its own) and,
      where a field has a closed set of values, `raw` (the original string,
      written back IN PLACE of the fallback; assigning the field clears it).
      A sketch item of an unknown `type` is kept verbatim
      (`UnknownSketchItem`), never drawn. Players never see any of it
      (decision 4).
    - **The migration** (`FileManager._migrateToFormat2`, on open): marker
      `paint/.migrated-from` = sha1 of the `hexes/*.json` being migrated,
      FIRST; chunks; `hexified.json` / `sketch.json` rewritten with ids;
      `format: 2`; then `hexes/*.json` and the marker deleted. Interrupted
      before the format: the marker matches, migrate again. After: leftovers
      swept on open. Synchronous, never through the write-behind queue
      (decision 26). The GM-notes sidecars are folded into hex pages in the
      same open (the field had no editor).
    - **A format-1 folder with chunks and NO matching marker** means a
      pre-format-2 build saved into a migrated campaign and stamped it
      format 1 again; its `hexes/` holds only what it changed. Never
      resolved silently: `PaintLayoutConflict`, and the shell asks (apply
      its edits over the map / drop them / don't open), before tearing the
      current campaign down. File dates are NOT used: sync, git and copies
      all reset them.
    - **A change to what players see always bumps `format`**, even a new key:
      an older build would keep it, ignore it, and serve the secret.
    - The player server reads either layout by the recorded format (it
      never migrates) and watches `paint/` and `hexes/`.
