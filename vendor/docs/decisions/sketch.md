# Decisions — Sketch view and trace image

Decision records moved verbatim from the root `CLAUDE.md`, whose index
lists every decision number and where it lives. Numbers are stable;
"decision N" anywhere in the notes resolves through that index.

Decisions: 19, 24.

19. **The Sketch view is a second view of the SAME scene, not a second map**
    (`core/sketch.dart`, `app/sketch_view.dart`, `app/sketch_toolbar.dart`;
    plan and rationale in `docs/sketch-layer-plan.md`). Every sketch
    coordinate is in scene pixels — the space `axialToPixel` maps hexes
    into — so the lattice ghost under the pen IS the lattice a later
    "hexify" lands on and no calibration step ever exists. The Hex ↔ Sketch
    switch in the toolbar hands the `MapCamera` across (`HexMapController`
    / `SketchViewController` expose `camera`; the incoming view takes it as
    `initialCamera`), so switching keeps your place.
    - **A swatch is a MEANING, its colour is incidental.** `Swatch.kind`
      binds a colour to a biome (+variant), river, road, trail, or nothing
      (annotation ink). The default palette is one swatch per biome in that
      biome's own `terrainColors` fill, plus the three line kinds and light
      inks (light because `canvasBg` is dark). Hexify (phase 3, unbuilt)
      reads the binding; the renderer reads only the colour.
    - **Items are strokes, shapes and labels**, a sealed hierarchy with
      hand-written JSON (`type` discriminator — a future `fill` item slots
      in without a migration), `hitTest` and `bounds` implemented in `core/`
      so the eraser is unit-testable. Strokes store `(x, y, pressure)`
      per point (flat list in JSON); the renderer widens per segment with
      pressure, 30 % at a feather touch. `thinStroke` drops sub-1.5px points
      on release, never mid-stroke, so the live preview follows the pen.
    - **The sketch has its OWN undo stack** (`AppController.sketchUndo`)
      and `MainShell` routes Ctrl+Z to whichever view is showing. One
      shared stack would let Ctrl+Z in the hex view undo a stroke nobody
      can see. Sketch edits go through `addSketchItem` /
      `removeSketchItem` / `editSketchLabel` / `clearSketch`, each one
      command; `markSketchDirty` bumps `sketchRevision`, which is what the
      painter's `ui.Picture` cache keys on — the document is recorded once
      per revision and replayed per frame, so pan/zoom cost is independent
      of stroke count.
    - **Stored at `sketch/sketch.json`, GM-only.** It lives in `Campaign`
      like everything else, but `player_filter` builds its payload
      explicitly, so it is excluded by construction —
      `sketch_storage_test.dart` asserts a label's text never reaches the
      payload. Not in the server's folder-signature glob either (it needs
      not be: nothing served depends on it).
    - **Input is a raw `Listener`** (decisions 12 / 12l); pressure comes
      from `StylusPressure` (decision 18) with the engine's value and 1.0 as
      fallbacks. Right-drag and the pen's eraser end erase whatever the
      tool; middle-drag / Space+drag pan; the label tool turns a drag into a
      pan so a mis-tap never spawns a dialog. Shortcuts are letters (P E L
      R O T H, `[`/`]` for width) on the same scoped `_mapFocus` as the map
      tools; the digit shortcuts belong to the hex view and are not bound
      here, since the two `CallbackShortcuts` are never in the tree together.
    - **Ghosts, not layers.** The hex view's terrain shows through at 35 %
      (`showHexGhost`) and the grid window's cells are stroked faintly
      (`showLattice`, skipped below 4 px radius) — both toggles in the
      panel. The scale bar (`app/scale_bar.dart`, shared with `HexMap`) is
      always drawn. Not built yet from the plan: the swatch editor (the
      default palette covers every biome and line kind).
    - **Re-hexify is protected by a RECORD, not by diffing the sketch**
      (`HexifyRecord` in `core/sketch.dart`, `sketch/hexified.json`,
      `Campaign.hexified`). `applyImport(plan, recordHexify: true)` stores
      exactly what it wrote — cell → (terrain, variant), plus the ids of the
      rivers and routes it created — and the record rides inside the same
      undo entry (undo restores the previous record). The next Hexify runs
      `protectHandEdits`: a recorded cell whose CURRENT paint differs (a
      different biome, or the hex is gone) was edited by hand and is kept;
      a cell the record never touched is the import mode's business like any
      other. The last run's chains that still exist go into
      `ImportPlan.removeRivers` / `removeRoutes` so a re-hexify replaces its
      own rivers instead of stacking duplicates — never a chain the GM drew.
      In `applyImport` removals run BEFORE creations (and undo does the
      reverse) because `nextRiverId` reuses a freed id, so a replaced river
      and its replacement can share one. Both behaviours are switches in the
      dialog, shown only when a record exists.
    - **The hex view can show the sketch** (`HexMap.sketchOverlay`,
      Display & overlays panel): the whole document at 45 % through ONE `saveLayer`
      (so overlapping strokes do not stack opaque), or labels only at full
      strength since annotations are meant to be read. It reuses
      `SketchPictureCache` keyed on `sketchRevision`, same as the sketch
      view's own painter.
    - **Bucket fill works on a TEMPORARY raster** (`sketch/bucket_fill.dart`,
      pure; tool B). Vector strokes have no inside, so every item is stamped
      as ink into a bitmap over the padded viewport at a resolution the VIEW
      chooses (`step`, ≤900 px on the long side, never finer than a screen
      px — what counts as a small gap is a screen-space judgement), the
      click's non-ink component is flooded, and its outer contour is
      crack-followed back into a scene polygon (`SketchFill`, simplified
      by Douglas–Peucker). Three rules: a flood that reaches the raster
      border is a REFUSAL (`notEnclosed`), never a viewport-wide fill; gaps
      close by dilating the ink by `gapPx` before flooding and dilating the
      flood back by the same amount minus real ink, so the fill gets its
      true edge instead of a moat; existing fills are not barriers (a fill
      next to a lake stops at the lake's outline, not its fill). Fills are
      inserted at the BOTTOM of the z-order (`addSketchFill`: below every
      non-fill, above older fills) so outlines stay visible and a newer fill
      still wins over an older one for hexify's topmost-wins rule. Holes
      are not modelled: an island inside a fill is cut out of the flood but
      not of the polygon.
    - **Hexify** (`sketch/hexify.dart`, layer `core ← importer ← sketch ←
      app`; the dialog is `app/hexify_dialog.dart`, the button is in the
      sketch panel) turns the sketch into `ImportCell`s + rivers + routes and
      commits them through `previewImport` / `applyImport` — the import
      wizard's own path, so it inherits the three `ImportMode`s, the
      auto-resize union and ONE undo step. Area is decided by SAMPLING, not
      rasterising: each cell is probed at 19 fixed points (`samplePattern`,
      all inside the hexagon), the TOPMOST biome-swatch item covering a
      point votes (z-order = paint order, so later sea over forest wins as
      on paper), and the majority takes the cell when it reaches
      `minCoverage` (0.5; a slider). No raster means no `package:image` in
      this layer and a result that is stable under a sub-hex nudge.
      Sampling spans the sketch's WHOLE extent and is never culled to the
      grid window — off-grid cells are `planImport`'s call (grow the grid, or
      count as outside). Culling in hexify grew the grid for the rivers while
      leaving the newly-covered cells unpainted.
      River / road / trail strokes are not sampled: they go through
      `snapScenePolyline` (the importer's Viterbi matcher, given a
      scene-space entry point since a sketch stroke is born in scene space)
      and their width multiplier is `strokeWidth / basePx` (river 5.0;
      road 5.0 / trail 3.5, mirroring `routeKindStyle`). A line-kind
      RECT/ELLIPSE, ink, and labels never contribute. `fillSea` makes
      undrawn cells inside the sketch's bounding box sea, bounded so an
      empty corner of a big grid stays dry. Routes joined `ImportPlan`
      (`ImportRoute`, additive like rivers, `RiverNode` records converted
      to `RouteNode`s in `applyImport`) for this.

    - **Coordinates are kept to 0.1 scene px, pressure to 2 decimals**,
      rounded in each item's CONSTRUCTOR (`roundScene` / `roundPressure` in
      `core/sketch.dart`), so committed, loaded and bucket-built items are
      all rounded from birth and memory always equals disk. Rounding on save
      instead would let a reload move a point by up to 0.05 px — enough to
      flip a boundary cell on the next hexify. The live stroke under the pen
      stays unrounded until committed. `purezza`'s sketch.json: 10.7 KB →
      3.8 KB with the one-record-per-line encoding.
    - **Strokes are drawn as perfect-freehand OUTLINES** (`strokeOutline` in
      `app/sketch_view.dart`, the `perfect_freehand` Dart port, MIT), filled.
      The Obsidian plugin uses the original JS library, so a stroke looks the
      same in both apps. Pressure keeps its meaning — a light touch 30 % of
      the nominal width, a full press (and every mouse point) the nominal
      width — which is `size = 0.65·width`, `thinning = 7/13` in the
      library's `size·(1 − t + 2·t·p)`; pressure is the pen's, never
      simulated. `streamline` 0.3 (not 0.5) keeps the drawn line near the
      stored points hexify reads. Only the look changed: hexify, the bucket
      and the eraser still read the stored points and width.

24. **The Sketch view has a trace image: a reference picture to draw over,
    with no hex calibration at all** (`core/trace_image.dart`,
    `app/sketch_view.dart`, `app/sketch_toolbar.dart`). Not the import
    underlay (decision 12) — that one carries an affine to line a SOURCE MAP
    up with the hexes it was imported into, and is GM-canvas-only. This one
    is just a placement (centre + size, scene px) and a fade, because its
    only job is letting a hand trace over a scanned map or a screenshot —
    calibration would imply a use (importing) this isn't.
    - **File-backed, not campaign state.** `sketch/trace_image.png` +
      `sketch/trace_image.json` (`FileManager.saveTraceImage` /
      `saveTraceImageConfig` / `loadTraceImage` / `deleteTraceImage`, mirroring
      the underlay's own file pair). Like the underlay, it is decoded once and
      held as `ui.Image?` + `TraceImageConfig?` in `MainShell` state, not on
      `Campaign` — it is display state, not sketch content, so it never rides
      the undo stack, is invisible to sync/merge, and `player_filter` never
      sees it by construction (there is nothing on `Campaign` to filter out).
    - **Dropped or picked, never pasted.** `desktop_drop`'s `DropTarget` wraps
      the sketch canvas for drag-and-drop; "Load image…" in the toolbar opens
      the same `file_selector` already used elsewhere. Clipboard paste was
      deliberately left out: the only cross-platform option
      (`super_clipboard`) pulls in a Rust toolchain / precompiled-binary
      download for every contributor and CI run, which is a heavier build
      dependency than this feature is worth. Revisit only if that changes.
    - **Placement is drag-the-body / drag-the-corner, gated on the Pan tool.**
      Every other sketch tool needs the full canvas for its own gesture (a
      pen stroke, a bucket click), so the image is only grabbable while Pan is
      armed — pressing its body moves it, its bottom-right corner (a fixed
      on-screen hit radius, like the river handles) resizes it keeping the
      image's own aspect ratio, and pressing empty canvas still pans as usual.
      `locked` (a toolbar toggle) turns off both, for once it's positioned and
      the GM wants Pan-drag to mean pan again.
    - **One report per gesture, not per frame** (`onTraceImageMoved`), same
      discipline as a river-node drag (decision 8c) — the live drag position
      is local widget state (`_traceLive`) fed straight to the painter, and
      only the final placement reaches the shell. The shell itself debounces
      the write (400 ms) since a slider (opacity) can also fire rapidly, and
      flushes synchronously on window close and on campaign switch — a
      pending write must land on the OLD campaign's file manager, not
      whatever `controller.fm` points to once a new campaign is bound.
    - **Drawn UNDER everything** (ghosts, document, in-progress stroke) — it
      is a backdrop, never something a stroke has to render around, and its
      outline + resize handle are shown only while Pan is armed and the image
      is unlocked, so they never sit on screen as a permanent distraction
      while the GM is drawing.
