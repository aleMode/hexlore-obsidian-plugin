# CLAUDE.md — Map-image importer

Loaded automatically when working under `lib/importer/`. The wizard UI is
`lib/app/import_*.dart` and `AppController.applyImport`; read this file
before touching those too. Paths below are relative to `lib/`.

Decisions: 12, 12b, 12h, 12c, 12l, 12k, 12e, 12f, 12g, 12j, 12i, 12d.

12. **Map-image importer** (`lib/importer/` — a fourth layer: `core ← importer
    ← app`, pure Dart + dart:io, no Flutter). "Import map image…" (campaign
    menu) turns a PNG/JPG of a hexmap into terrain. Pipeline, all unit-tested
    via synthetic images (`test/importer_synth.dart`): `grid_calibration.dart`
    solves a `SourceGrid` (flat OR pointy source; orientation inferred) from
    two clicked adjacent hex centres; `hex_sampler.dart` extracts per-cell
    crops + dominant colour (modal, not mean) + **ring colour** (the mode of
    the outer ring only, i.e. the terrain with a centred stamp excluded — see
    decision 12e) + edge density;
    `classifier_cascade.dart` runs TWO INDEPENDENT RECOGNISERS, one per paint
    layer (decision 12e): a BIOME recogniser (learned Lab-colour prototypes →
    greedy colour clusters → **built-in biome guesses**, decision 12d) that
    answers for every hex, and a STRUCTURE recogniser (icon-template NCC →
    unknown-icon groups) that may answer "none". Both GROUP their
    results for batch confirmation (grouping consistency matters, per-hex
    precision doesn't — the user confirms per group, and
    `ImportSession.overrides` is the escape hatch for the few cells a group
    gets wrong: a per-cell `PaintPick` keyed in SOURCE-axial space, so it
    survives the placement drag and beats its group only for that cell — it
    can even rescue one from a skipped group). Overrides are painted with a
    BRUSH, not one click per hex: where a group is wrong it is wrong over a
    REGION, and fixing that a cell at a time is the slow half of the review
    step. Radii are 1 / 7 / 19 hexes (`hexesWithin`), a tap is the shortest
    possible stroke, right-drag erases with the same disc, and the brush only
    paints cells the sampler actually read. Two things about it are load-
    bearing and were both found by using it:
    - **The brush is a raw `Listener`, NOT a `GestureDetector`'s pan
      callbacks**, and arming it turns off `InteractiveViewer`'s `panEnabled`
      AND `scaleEnabled`. A pan recogniser has to win the gesture arena, and
      against the viewer's scale recogniser it loses on a TRACKPAD — a
      two-finger drag arrives as a scale gesture, so the brush painted the cell
      under pointer-down and then went dead for the rest of the stroke.
      Pointer events skip the arena entirely. `dragFrom` in a widget test goes
      through the arena and passes either way, so the regression test drives
      raw pointer events (`startGesture`/`moveTo`) instead.
    - **An override is drawn as WHAT IT PAINTS** — the biome's own fill at 72%
      plus its real `drawBiomeStamp`/`drawFeatureGlyph`, ink derived from that
      fill exactly as `hex_map.dart` does it. The painter therefore takes the
      override MAP, not a set of cells: a bare set can only say "corrected",
      so brushing forest and then lake over part of it looked identical and
      there was no way to confirm the second stroke landed. A biome-less pick
      draws no fill (decision 1c — it left that layer alone, so the cell must
      not look repainted), and `shouldRepaint` compares the map itself since
      replacing a pick leaves the length unchanged. A group's proposal is a
    `PaintPick` (decision 1c), so a recognised icon can mean a feature, a
    biome, both, or neither-but-tags. `libraries.dart` is the
    growing knowledge (`~/.hexlore/import_libraries.json`, global on purpose):
    confirmed clusters/icons are learned so the next map is recognised
    upfront — `ColorPrototype` carries a biome + variant (a FILL cannot imply
    an icon), `IconTemplate` a whole pick; both read pre-variant/pre-feature
    JSON, so an accumulated library survives the upgrade.
    `import_session.dart` is the wizard's testable state machine;
    `app/import_wizard.dart` is thin wiring (test seams: `initialSession`,
    `decodeForDisplay`, `enableOllama`, `traceRiversOnEnter` — note
    `decodeForDisplay: false` means NO image widget is built, so a test that
    needs to click the source map must enable it and pump inside
    `tester.runAsync`, since the PNG decode is real async work).
    The review screen shows groups **undecided first, then largest first**,
    via an index order (`_order`) computed ONCE when groups are adopted and
    never re-sorted as the user works — rows that reshuffle the moment you
    answer one are worse than rows in a stale order. It must be established on
    BOTH entry paths (`_classify` and an `initialSession` handed to
    `initState`), or the list renders empty. Single-key shortcuts (1–9 assign
    the first nine biomes in palette order, S skips, ↑↓ select) hang off a
    scoped `FocusNode`, armed by clicking a tile — scoped, not global, so the
    icon-name and tag `TextField`s keep their digits, the same discipline
    `main.dart` uses for the map tools. Clicking a hex on the source image
    opens that cell's per-hex override (`grid.cellAt` is the calibrated grid's
    own inverse, so it agrees exactly with what the sampler read; a click
    outside the sampled cells selects nothing rather than inventing a hex). Recognition is
    followed by a **RIVER step** (decision 12c — trace the painted
    watercourses, reshape them by dragging) and a **PLACEMENT step**
    (decision 12b) that decides where the map lands and what
    happens to what is already there. Apply =
    `AppController.applyImport` — ONE undoable command setting terrain AND
    merging tags (icons often mean tags, not terrain: a skull on forest stays
    forest).
    Pointy sources land identity-mapped on the flat grid (~30° lattice
    re-orientation, chirality preserved). `underlay.dart` +
    `FileManager.saveUnderlay` persist the source image +
    image→scene affine (`<campaign>/import/`, GM-only, never served);
    `_HexMapPainter` draws it semi-transparent OVER hex fills (hidden on open; toggle and remove
    in the Display & overlays panel). `ollama_classifier.dart` is optional garnish: a
    local Ollama vision model (auto-detected via `/api/tags`; endpoint
    override `ollama_url` in `~/.hexlore/config.json`); the importer never
    depends on it — see decision 12j for the two modes it offers.

12b. **Import placement is a plan, not a flag** (`importer/import_plan.dart`).
    The wizard's fourth step (`_Step.place`) resolves a recognised map against
    the campaign into an `ImportPlan` — writes / clears / new grid window /
    skip counts — which `AppController.applyImport` then EXECUTES. The split is
    what lets the wizard show a live tally (`previewImport` re-runs on every
    drag of the ghost) using the exact code path that will run on Apply, and it
    keeps the whole decision unit-testable with no campaign or widget tree.
    `import_plan.dart` is deliberately free of `package:image` so
    `app_controller.dart` can import it without pulling in the decoder.
    - Three `ImportMode`s, all PAINT-LAYER ONLY (biome + feature overlay) —
      names, notes, tags, pages, NPCs, quests, threads, rivers, routes, regions
      and fog are never touched by any of them: `overwrite` (covered cells take
      what was recognised for them), `skipOccupied` (a cell holding a biome OR
      a feature is left alone; a merely NAMED hex is not "occupied" and does
      get painted), and `replaceAll` (strip biome + feature + colorOverride off
      EVERY hex first, then drop the map in — its repainted cells lose their
      old icons too, via `plan.clearFeatures`, or the sweep would spare exactly
      the cells it covers).
    - **A mode only decides what happens to paint the import DOESN'T supply.**
      An `ImportCell` carries a `PaintPick` (decision 1c), and each of its two
      layers can say "no opinion": where it has one it is written in every
      mode, where it doesn't the hex keeps its own value. That is what lets a
      biome-only import leave hand-placed icons alone (the old hard-coded
      behaviour, now a consequence rather than a special case) AND lets an
      icon-only import stamp a city without repainting the fill — including
      leaving `colorOverride` intact, since only a biome write retires a tint.
      `clearFeatures` is the single exception: mode iii sweeps an
      un-recognised icon off a repainted cell, but never overrides one the
      import DID recognise.
    - **The resize is solved BEFORE the outside-the-window test**, or the plan
      would report cells as skipped that the resize is about to rescue.
      `fitGridWindow` (in `core/geometry.dart`, keyed on `unstaggeredRow` so a
      window is `u ∈ [rShift, rShift+rows)` for every column at once) fits the
      import footprint **unioned with every existing hex** and pads +10%
      (`importResizePad`). The union is the whole safety argument: the window
      may shrink, but it can never drop a hex, so `applyImport` can adopt it
      via `_setGridWindow` — no deletions, and NO `undoStack.clear()`, unlike
      `resizeGrid`. Resize + clears + writes are ONE command; undo restores the
      old window too.
    - `app/import_placement_map.dart` is the drag surface: a self-contained
      fit-to-view mini-map, NOT `HexMap`. Reusing the real canvas would mean
      threading a placement mode through `MainShell` for a preview that needs
      no culling, no LOD and no tools. It fits one scale/offset from the union
      of the grid window and the ghost — so a map dragged off the edge stays
      visible, which is exactly when the user needs to see it — and converts
      pointer deltas to whole-cell moves through `pixelToAxial`, which is what
      makes the drag grid-snapped for free.
    - The default anchor centres the footprint on the current window, computed
      by rounding a PIXEL delta back through `pixelToAxial`. `axialToPixel` is
      linear, so that yields the nearest lattice translation; centring in
      axial space directly does not work, because an odd `dq` shifts different
      columns' `u` by different amounts.

12h. **Rivers are DRAWN BY HAND by default; tracing is an assist**
    (`drawnRiver` in `import_session.dart`, `ImportRiverMap.drawing` +
    `onDrawStroke`, the wizard's `_drawSection` / `_autoTraceSection`).
    Automatic tracing has to answer two questions — "where is the river?" and
    "which lattice edges is that?" — and only the second was ever reliable.
    Decisions 12c and 12f are the record of how hard the first one is on real
    map art: five distinct filter bugs, two performance cliffs, and a result
    that still always needs checking. A person pointing at the river answers
    it exactly and instantly, so the pen is the default and the ridge pipeline
    is kept behind a collapsed "Trace automatically" section for maps it suits.
    - **The stroke replaces the TRACER, not the SNAPPER.** `drawnRiver` runs
      the very same `snapPolyline` Viterbi match the automatic path uses, so a
      drawn river and a traced one are the same object and everything
      downstream (handles, point deletion, placement translation, apply)
      treats them identically — no second code path. That is also what turns a
      wobbly freehand line into a clean chain of hex edges instead of a
      staircase, which is the half of the pipeline that always worked.
    - **The pen owns the drag outright while it is on.** Drawing and panning
      are the same gesture; requiring a modifier to draw would defeat a manual
      mode. A Pen / Pan-edit toggle switches between them, and the in-progress
      stroke is painted RAW (pre-snap) so what the user sees while dragging is
      their own input and what appears on pen-up is the lattice's answer.
    - **A drawn line has no width**, so the caller states one
      (`_drawWidthPx`, a slider); existing rivers keep their own.
    - **Tracing REPLACES the list**, drawn rivers included, and the button
      says so. Adding instead would stack duplicates on a second run with no
      way to tell a re-found river from a new one.
    - The river step no longer traces on ENTRY. It was spending tens of
      seconds up front to produce rivers the user is most likely to delete;
      seeds are still prepared there so the assist is one click away.

12c. **Rivers are recognised by TRACE-then-SNAP, not by the cascade**
    (`importer/river_tracer.dart` + `importer/river_snap.dart`, plus the
    wizard's `_Step.rivers` and `app/import_river_map.dart`). Since 12h this
    is the ASSIST path, not the default, but it is unchanged and still what
    the debug view (12g) diagnoses. The cascade
    answers "what is in this hex?", one label per cell; a river is a thin
    continuous curve that crosses cells without belonging to any, and
    `RiverPath` is a chain of canonical VERTICES. So rivers get their own
    pipeline, and the two halves are split on purpose: the tracer knows pixels
    and no hex topology, the snapper knows topology and never imports
    `package:image` (which is also what keeps it unit-testable and lets
    `app/` reuse `nearestVertexAxial` for the drag handler). A road/trail
    tracer would reuse the first half with a different snapper.
    - **Tracer**: continuous water-LIKENESS field (5-bit LUT over `argbToLab`,
      or a full-res map re-converts the same green a hundred thousand times) →
      RIDGE FILTER (decision 12f) → non-maxima suppression → hysteresis →
      per-pixel lake rejection → parallel-track suppression → branch graph →
      gap linking → longest-stem decomposition → duplicate/loop rejection.
      Since `RiverPath` cannot branch, each network is decomposed by
      repeatedly extracting its longest path — main stem first, then the
      tributaries that hung off it.
      **Colour is a FIELD, not a verdict**: the old binary mask forced one
      tolerance to serve two jobs and no value worked — loose enough for an
      anti-aliased river also caught the sea and every shadow, tight enough to
      exclude them broke the river into dashes the length filter then
      discarded. `waterLikeness` returns 1 at a seed colour falling to 0 at
      `tolerance` ΔE, and the ridge filter judges SHAPE instead.
    - **Decomposition is per COMPONENT and length-filtered**, because a real
      map's skeleton is not one river network: every tree, mountain, icon and
      letter whose ink fell inside the tolerance is a component of its own,
      thousands of them. `decompose(minLengthPx)` rejects a component whose
      total ink is shorter than one river before walking it, and stops
      extracting from a component once its longest remaining path is too
      short. A flat "extract the longest path, repeat" loop under a fixed
      budget could not: it spent the budget on icons in raster order and never
      reached the watercourse (which is why the real-map trace used to find
      junk near the top of the image and nothing else). `minLengthFactor`
      (3.0 × radius, a slider in the wizard) is therefore THE junk filter —
      no colour rule separates a tree glyph from a squiggle, but length does.
      Spur pruning stays clamped to a spur's own scale (≤1.2 × radius) no
      matter how high that goes, or a stem's real short tributaries would be
      shaved off with the thinning artefacts. Degree-0 skeleton specks are
      skipped when scanning for node-free rings — anti-aliased ink leaves
      plenty, and walking their empty neighbour list used to throw, which the
      wizard surfaced as "no rivers found" on every real map.
    - **A guessed seed is a placeholder** (`ImportSession.riverSeedsAreGuessed`
      / `addRiverSeed`): with no confirmed sea/lake hexes to hint from,
      `suggestRiverSeeds` returns whatever blue the image has (an icy biome, a
      sea border), and on a map whose rivers are brown that guess only
      contributes noise. So the FIRST eyedropper pick replaces it wholesale;
      later picks accumulate, since a map may use two shades.
    - **Snapper**: a small Viterbi map-match (candidate vertices per resampled
      point; emission = distance to the ink, transition = penalty for moving
      FURTHER than the curve did), then A* over `vertexNeighbors` to fill the
      gaps between chosen states. A greedy nearest-vertex snap is what this
      exists to avoid: where a curve runs down the middle of an edge, nearest
      flips between the two ends and the result is a staircase the user then
      has to drag straight (`importer_river_test.dart` asserts the chain stays
      within 1.35× the lattice's own zigzag floor).
    - **Vertices come out in SOURCE-AXIAL space**, so the snap happens ONCE
      and the placement drag only re-adds an integer offset
      (`translateVertices`) — the lattice is translation-invariant, corner c
      of (q,r) shifted by (dq,dr) is corner c of (q+dq,r+dr). A pointy-top
      source needs no special case either: source axial = campaign axial by
      identity, so running it through flat-top vertex geometry performs the
      same ~30° re-orientation the terrain import already performs.
    - Width is measured, not guessed: the median distance-transform value
      along a chain, scaled by `hexRadius / sourceRadius` and divided by
      `riverBaseStrokePx` (5.0, mirroring `hex_map.dart`'s water layer).
      `riverWidthMin`/`Max` moved to `core/river.dart` so the model, the width
      editor in `main.dart` and this conversion share one definition.
    - **Rivers are ADDITIVE in every `ImportMode`** — the modes govern the
      biome layer only, and a river the GM drew by hand is exactly what an
      import must not silently delete. They ride inside the same undoable
      command as the terrain (one Ctrl+Z), and their vertices join the
      auto-resize union via `vertexTouchingHexes`, so a rivers-only import
      still grows the grid sensibly.
    - The editor (`app/import_river_map.dart`) draws them over the SOURCE
      IMAGE, because the question this step asks is "did the machine follow
      the ink?" — only visible against the painting. It is not `HexMap` and
      not an `InteractiveViewer` (which would win the pan gesture a point drag
      needs): it owns its scale/offset. Dragging a point re-walks the
      neighbouring links along the lattice (`RiverDraft.movePoint`), so a long
      drag can never break the chain; right-click deletes a point and bridges
      the gap the same way. See 12l for how a gesture is routed.

12l. **The river editor is LINK-FIRST, and drives raw pointer events**
    (`app/import_river_map.dart`). Exposing one handle per anchor and nothing
    else made every correction a hunt for the right dot among dozens a few
    pixels apart — and a snapped river has a point at EVERY lattice step it
    takes, so the dots are always dense (denser still since 8b). A LINK is the
    big target between them, and the two things a GM wants to say about a
    stretch of river map onto it directly:
    - **Tap a link — delete it.** Cutting mid-course yields TWO rivers
      (`RiverDraft.cutLink`), which is the honest answer for a model with no
      branches; cutting an end link drops the orphaned single point, which is
      how "trim this end" falls out of the same operation for free.
    - **Drag a link — bend it**, by inserting an anchor where the pointer
      landed (`insertOnLink`) and continuing to drag THAT anchor. One gesture
      creates and places the point.
    - **The tap/drag choice is deferred to the first movement, never decided
      at pointer-down.** Inserting on down would make every intended tap
      create a point and then cut a different link than the one aimed at.
    - **A handle beats the links that meet at it**, in the drag path AND the
      tap path — the handle sits on both of its links, so without the tap-path
      check the more specific target is unreachable by tap (a real bug the
      widget test caught).
    - **Gestures are a raw `Listener`, never a `GestureDetector`** — the same
      lesson decision 12 records for the review brush, and here BOTH halves
      matter because panning and point-dragging are the same physical gesture.
      An arena recogniser loses a two-finger trackpad drag to a competing
      scale recogniser, so the stroke dies after the first event. Pinch is
      assembled by hand from the live pointer map, `PointerPanZoom*` covers
      macOS-style synthesised trackpad gestures (without it a trackpad pinch
      does nothing there), a trackpad two-finger SCROLL pans while Ctrl+scroll
      and the mouse wheel zoom, and a tap-slop threshold is applied by hand
      since raw events carry no such notion. `import_river_map_gesture_test.dart`
      drives all of it with `startGesture`/`moveTo` for the same reason.
    - `app/import_placement_map.dart` got the same treatment: its fit-to-view
      is still the DEFAULT (decision 12b) but is now composed with a user
      zoom/pan on top — a big campaign fits to a scale where the GM cannot see
      which cells the ghost covers — with a "Fit" button shown only once the
      view has moved. A drag starting ON the ghost moves the import; anywhere
      else pans.

12k. **Biome recognition is STAMP-LED: what is drawn beats what colour it is**
    (`importer/ink_mask.dart` + `importer/stamp_recognizer.dart`). The cascade
    used to ask colour to name the biome and sampled AROUND any stamp to keep
    ink out of the answer (12e). Measured against 121 hand-labelled cells of a
    real map (`test/fixtures/groundtruth/`, harness in
    `importer_groundtruth_test.dart`), that design scores **19.0%** — below
    the 39.7% of answering "mountain" for every hex. This is the record of
    what replaced it and, as importantly, of what was tried and rejected.
    - **The evidence is complementary, not a hierarchy.** Leave-one-out on
      those cells: shape alone 66.1%, colour alone 71.9%, **the two together
      83.5%**. Shape alone is WORSE than colour alone — the win is that they
      fail on DIFFERENT cells (shape confuses plains/mountain, colour confuses
      plains/forest). So the weights are near-equal (`StampWeights`, 0.4 / 0.4
      / 0.1 / 0.1) and the plateau is broad: anywhere from 0.3 to 0.7 on the
      shape/colour split lands within 2.4 points. Not a tuned constant.
    - **The error this exists to fix.** Snowy mountain read as tundra was 39 of
      121 cells. No colour rule can ever fix it: snowy rock and tundra ARE the
      same colour. Only the hachure separates them, and mountain recall goes
      6/48 → 45/48. A cool-grey mountain prototype was the obvious repair and
      `biome_heuristics_test.dart`'s separation guard REJECTED every candidate
      (the colour measured off the art sits 4.5 ΔE from a SEA prototype) — so
      the table stays deliberately silent there, with a note saying why, and
      the shape layer answers instead.
    - **Ink is a local-contrast primitive, not a threshold.** A global luma cut
      cannot work — that map's snow fills are brighter than its forest fills.
      `blur(luma) − luma` is stably bimodal (ink fraction moves only 19.4% →
      12.6% as the threshold triples), so `inkThreshold` is chosen from a
      plateau rather than tuned. Read through `toUint8List()`, never
      `getPixel`: that alone was 6.1s → 1.6s on a 2048px map.
    - **One prototype per CONFIRMED CELL, never one per biome.** Averaging a
      biome's exemplars measured **10 points worse** (72.7% vs 83.5%) and
      destroyed `plains` specifically (28 cells → 9), because plains on real
      art is grass, scrub, ruled fields and open ground whose mean shape
      resembles none of them. k-means into k exemplars does not recover it
      either (k=2 → 75.2%, k=3 → 66.9%). `compactPrototypes` bounds the
      library at save time instead.
    - **Colour becomes a MODIFIER once shape has named the biome.** Inside one
      map's 48 mountain cells b* spans −17.6 to +16.4. In a colour-first design
      that spread is precisely the noise that dragged snowy mountains into
      tundra; here it is signal — `variantFor` picks the terrain variant and
      `isColdTinted`/`isWarmTinted` become TAGS (`cold`/`arid`), never a
      biome, because HexLore has no snowy-mountain terrain and inventing one
      from a tint would claim more than the evidence supports.
    - **Blob count is a VARIANT selector, not a biome signal.** Discriminative
      within a biome (forest: 1 tree / 2 / 3+ over 6 / 11 / 5 cells) and
      useless across one (every biome's mean sits near 2). Ink COVERAGE alone
      scores 25.6% — below the majority baseline — so "how much ink" is never
      asked to say "what".
    - **There is deliberately NO built-in shape prior**, and this is the one
      part that was investigated and abandoned rather than built. Two cells of
      the same biome by the SAME cartographer correlate at a median of only
      0.16 (vs 0.08 across biomes): the signal works by nearest-neighbour over
      many exemplars, not because any shape is canonical. A prototype from
      another hand — or from HexLore's own geometric glyphs — would correlate
      lower still, and a prior that fires wrongly is worse than none (12d's
      lesson). So the shape library is BOOTSTRAPPED from the user instead:
      `bootstrapFromConfirmed` turns the groups just confirmed on THIS map into
      exemplars for the rest of it, which is by construction the same hand.
      Measured precision of its proposals: 5 seeds → 63.6%, 20 → 74.5%,
      40 → 80.0%.
    - **Cold vs warm is reported separately and both numbers matter.** A first
      import on a fresh machine is still colour-only (**19.0%**); once the
      library holds this art it reaches **78.5%**. Quoting only one of those
      would mislead in one direction or the other, so the harness prints both.
    - `clusterDeltaE` dropped 14 → 8 on the same evidence: asking what each
      radius makes ACHIEVABLE (label every cluster with its majority truth)
      gives 67.8% at 14, 75.2% at 10, **81.8% at 8**. At 14 one group swallowed
      43% of the map, because greedy single-link CHAINS across a continuum
      (snow → rock → tan hill → olive plain). Complete-link was measured too
      and buys only 1.6 points — it is not the fix, contrary to first
      appearances.
    - **Neighbour smoothing is implemented but UNMEASURED**, and constrained
      accordingly: it may only overturn a low-confidence answer, and only on a
      strongly agreed neighbourhood. The labelled sample was scattered across
      colour clusters to cover the space, so only 21 of 121 cells have 2+
      labelled neighbours — smoothing scored identically there, which is a NULL
      result, not a negative one. Measuring it honestly needs a second ground
      truth of contiguous PATCHES.

12e. **Biome and structure are recognised SEPARATELY** (`classifier_cascade.dart`).
    Every hex has a biome and may additionally carry a structure; those are
    different questions with different evidence, so they get one recogniser
    each, each with its own confidence, confirmed in its own list. This
    replaced a design where `edgeDensity` ROUTED a hex to one branch or the
    other, which was wrong in both directions and unrecoverable in both,
    because the branch was exclusive: hand-painted forest or hatched mountains
    gated as "icons" never reached the colour layers AT ALL (a textured map
    lost a chunk of its terrain to `icon? N` groups — a large part of why
    terrain recognition was only "more or less"), while a faint tower never
    cleared the gate and was never matched against any template.
    - **Density is a PRIOR, not a gate.** `_densityPrior` maps edge density to
      a confidence multiplier: 1.0 at the old gate, `densityPriorFloor` (0.6)
      at the map's median, interpolated between, and never below the floor —
      so a flat hex with an excellent template match can still be found.
      Nothing is ever routed away from a recogniser.
    - **The biome under a stamp comes from AROUND it.** `HexSample.biomeArgb`
      is the mode of the outer ring only (inside `biomeRingInner` = 0.55 of the
      sampling disc is where a stamp sits; the renderer's own stamps are
      0.42–0.50 of hex radius). A stamped hex therefore joins a REAL biome
      group instead of only ever getting a built-in guess. The built-in prior
      (decision 12d) stays as the fallback and now also reads `biomeArgb`, so
      even its guesses see terrain rather than icon ink. `learnColor` must be
      trained on `biomeArgb` too (`_meanBiomeColor`) — matching and learning on
      two different statistics would drift apart on exactly the stamped hexes
      the ring sampling exists for.
    - **An icon never proposes a biome.** `_structureHalf` keeps only the
      feature half of a learned template's meaning. Under the old design
      `_iconMeaning` had to *detect* whether a structure group's biome was an
      untouched built-in guess and strip it; now a structure decision only ever
      names a feature, so dropping the biome half is simply correct rather than
      a heuristic. An icon's meaning is what it draws — the terrain under it
      varies by location, and learning "this tower means hills" from one
      hillside would mislabel every tower after it.
    - **The two layers merge in `buildEntries`**, through `PaintPick`'s own
      `withBiome`/`withFeature` — which is exactly the "leave the other layer
      alone" decision 1c exists to express. One entry per CELL, not one per
      group membership: a stamped hex is a member of both a biome group and a
      structure group. `decisions` is keyed by `(layer, source, label)`, since
      both recognisers can emit a group called `cluster 1`.
    - **Readiness and seeding differ per layer.** A biome group must paint or
      be skipped (a hex with no biome is not a meaningful import) and starts
      confirmed when it has a proposal; a structure group may be left undecided
      — that reads as "no structure here", the common case — and starts
      confirmed only above `structureConfirm` (the review step's sensitivity
      slider, three bands: ≥0.75 confirmed, 0.5–0.75 proposed-but-undecided,
      <0.5 not proposed). Moving the slider re-seeds only UNTOUCHED rows.
    - **Recognition is split across isolates, grouping is not.**
      `gatherEvidence` (sampling, NCC, prototype ΔE) reads nothing but the hex
      it is given, so `chunkCells`/`gatherChunk` fan it out and `classifyChunked`
      reassembles IN CELL ORDER; `groupEvidence` (greedy clustering) then runs
      once, serially. That order-dependence is the whole reason clustering is
      not parallelised — a chunk-dependent grouping would make the same map
      present different groups run to run, which the confirm-per-group design
      cannot survive. `importer_cascade_test.dart` asserts identical groups at
      2/3/5/7-way splits.

12f. **Rivers are found by a RIDGE FILTER, not a threshold**
    (`importer/ridge_filter.dart`) — a port of the multiscale singularity index
    Isikdogan et al. use for satellite river extraction (arXiv:1506.08670),
    adapted to painted maps. Pure Dart on a `Float32List`; it knows nothing
    about colour, hexes or `package:image`, so it is unit-testable against
    synthetic ridges and reusable for a future road tracer.
    `ψ = |J₀|·J₂ / (1 + J₁²)` along the local dominant orientation: the
    numerator peaks on a crest, and the denominator is what SUPPRESSES EDGES
    (a step edge has a large first derivative, a ridge has none at its crest)
    — which matters because a map is full of coastlines and biome boundaries.
    Five things had to change from the published method, each found by testing:
    - **The input must be DEBIASED** (`field − blur(field, 5·minScale)`). J₀ is
      a magnitude, so on a raw field any large bright region — a lake, a sea,
      the bright side of a coastline — carries a big J₀ and outscores the thin
      line. Without it a step edge beat a ridge 6:1; with it the ridge wins
      3.4:1. The abstracts omit this; only the reference source shows it.
    - **σ₁ (the edge-suppression scale) is fixed at `minScale · 1.7754`**, not
      scaled per octave. Scaled, it blurs so wide that a few scales up it no
      longer overlaps a step edge, the denominator goes to 1 exactly where it
      is needed, and a straight coastline grows a bright parallel side lobe
      that thins into a convincing false river.
    - **Gamma normalisation is per-scale σ²**. Constant normalisation means a
      coarse scale can never win the argmax, so every ridge reports the minimum
      width AND a wide band is detected by fine scales responding to its two
      EDGES rather than a coarse scale responding to its centre — a doubled
      centreline, then two rivers where there is one.
    - **`minScale` is 1.6, not the reference's 1.2.** A painted river is a
      flat-coloured PLATEAU, not a bump: below the band's own scale the filter
      finds no ridge in the middle (the field is constant there) and responds
      to the shoulders instead. Raising the floor is not monotonic — the ladder
      is geometric, so each value lands its rungs on different feature widths;
      1.6 clears the whole synthetic suite, 1.2 and 2.0 do not. Tuned, not
      derived: re-run the suite if the ladder or normalisation changes.
    - **NMS steps along the true perpendicular, interpolated**, not along one
      of four quantised lattice axes. On a SHALLOW SLOPE the quantised bin
      flips between horizontal and diagonal, alternate stretches are compared
      along different directions, and one river comes out as two parallel
      broken tracks.
    **Thresholding is peak-relative, not Otsu** (`centerlineThreshold`).
    Otsu is the literature's choice and is wrong here: after suppression there
    is only ONE class left (everything off a ridge is exactly zero), so the
    only variance it can find is between a river's uniform body and the spike
    at its endpoints — it returned ~50× the body's level and kept 20 of 516
    detected pixels. Hysteresis then keeps every component of `≥ low` that
    contains one pixel `≥ high`, which is what lets a stretch fading under a
    label survive BECAUSE it is attached to a confident one.
    Three artefacts get their own defences, each because nothing earlier can
    see them: `_dropParallelTracks` (compares only ACROSS the ridge — a disc
    search erases everything, since response varies along a river too),
    `_dropDuplicateCourses` (>70% of a course within `duplicateSpacingPx` of a
    longer one; a real tributary shares only its junction), and
    `_dropEnclosingLoops` (a lake's shore is a ridge that nothing local can
    refuse — its crest sits inside the water so its likeness is as high as a
    river's, and its reported width is a small river's; what it cannot hide is
    that it comes back to where it started, as one loop or as two arcs sharing
    both endpoints).
    **Gap linking** (`_SkeletonGraph.linkGaps`) rejoins ends that a label,
    bridge glyph or road crossing interrupted — a mandatory stage in the
    literature, and its absence is why a trace could find everything except the
    river. `maxGapAngle` is deliberately generous (~80°): the intuition that
    two halves of one river are aimed at each other holds only across a
    STRAIGHT gap, and the response weakens exactly where a river turns sharply,
    so the breaks most needing a bridge are the ones whose tangents differ
    most. What stops it fusing unrelated rivers is that both ends must point
    along the join AND the gap must be short. Since gap linking is also the one
    stage that can invent a river outright — a map's icons sit at regular
    spacing, each pointing at its neighbour, and 500 of them threaded into 33
    false rivers — `maxBridgedFraction` (0.8) rejects a course that is mostly
    bridge rather than ink. The usable window is 0.7–0.9: below it a real river
    with sharp corners is rejected, above it the icon columns come back.
    **Coarse scales run on a DOWNSAMPLED copy** (`downsampleAbove`, 4.0). Cost
    per scale grows with kernel radius, which grows with σ, so the coarse end
    dominates: a 3.3MP map took 96s at ten scales and 22s at four. Halving the
    working image whenever σ passes the threshold makes each octave cost about
    what the first did — 10.9s for ten scales, and nearly FLAT in the scale
    count. Nothing that matters is lost: a feature needing σ≥8 spans many
    pixels either way, and the argmax it wins is used for width, not for
    locating the crest. Real maps now trace in 29s (2048²) and 64s (4096²).
    **Known limit**: a river sloping less than ~1 px per 40 still fragments
    (its crest sits between two pixel rows and steps sideways), which the
    `snapper` tests document rather than paper over.

12g. **The river step has a DEBUG stage view** (`importer/river_debug.dart`,
    the wizard's `_debugSection`) — a window onto the pipeline, never a control
    over it, and labelled as such in the UI.
    It exists because a river trace that goes wrong reports the SAME SYMPTOM
    whatever the cause: an empty list. A wrong seed colour, too tight a
    tolerance, the ridge filter finding a shore instead of a channel, and
    decomposition cutting one river into fragments are indistinguishable from
    outside, and the step's advice ("add the river colour, or raise the
    tolerance") names only two of them. `RiverDebugStage` walks the pipeline in
    order — likeness → ridge response → centrelines → after cleanup — so the
    first stage that looks wrong is the one at fault, and each carries a `hint`
    saying what to conclude when it does. This is the terrain step's own
    superpower ported over: that screen works not because its classifier is
    better but because it SHOWS what the machine saw.
    - **One pass, not two** (`traceSnapAndRender`): the rivers and the picture
      come from the same trace, so they cannot drift apart if a parameter
      changed between two calls — precisely the confusion a diagnostic exists
      to remove. Switching stage re-runs the trace rather than caching the
      buffers: four full-resolution intermediates of a 4096px map cost far more
      memory than the pass costs time, and it already runs off the UI thread.
    - **Overlays are downsampled to `riverDebugMaxEdge` (1024) and use
      NEAREST-neighbour**, deliberately despite the aliasing — a one-pixel
      centreline averaged away would be a lie about what the stage contains.
      Continuous stages scale against their own peak (ψ runs around 1e-3, so
      absolute values mean nothing to a reader while the shape is the point)
      with a cube-root ramp so faint stretches stay visible.
    - `importer_river_debug_test.dart` asserts the property that makes it safe
      to leave switched on: **rendering a stage does not change the rivers
      found**, for every stage.

12j. **The local model has TWO modes, answering different questions**
    (`OllamaClassifier.suggest` / `suggestInContext`, the wizard's
    `_suggestLabels` / `_sweepAllCells`). Both are optional and additive;
    neither replaces the deterministic cascade.
    - **Label the undecided groups** (the original): one call per UNDECIDED
      group, on a bare tile crop. Cheap — a handful of requests — and it only
      fills gaps: it may overrule a built-in colour guess (a model that LOOKS
      at the tile beats nearest-colour) but never a learned match, an icon
      template, or the user's own choice.
    - **Read every hex in context** (the sweep): one call per CELL, on a crop
      that includes a ring of NEIGHBOURS (`contextCrop`, `sweepContextRings`),
      asking for a biome *and* a structure. This is the answer to "the
      GROUPING itself is wrong here" — clustering gives one label to
      everything of a similar colour, so where two biomes are painted in
      near-identical shades no per-group decision can separate them, while a
      model seeing each hex in context can tell a patch inside a wood from one
      inside a range. One ring, not more: beyond that the target hex is too
      small in the image for the model to say anything specific about IT,
      which sets the ceiling rather than token cost.
    - **The sweep writes `session.overrides`**, the same per-cell layer the
      fix-up brush uses. That is what makes its answers reviewable, individually
      brush-correctable, and visible as real stamps on the review canvas —
      rather than an opaque second opinion. It therefore BEATS group decisions
      for the cells it touches, which is why it is behind a confirmation
      dialog that names the cost and says how many existing fixes it will
      overwrite.
    - It is minutes of work on a real map, so it reports progress per hex and
      is CANCELLABLE, keeping what it has already read. A per-hex failure is
      counted and reported at the end, never fatal: one bad hex out of hundreds
      must not take the pass down.
    - `suggestInContext` may return a `Feature`; `suggest` deliberately does
      not. A feature is a per-CELL fact, and the group pass answers per group,
      where a structure belongs to the structure recogniser's own decision. An
      unrecognised feature name is dropped rather than mapped onto a
      near-neighbour — `icon` already carries the model's own wording.

12i. **A learned library can make recognition WORSE, so learning is
    CORRECTIVE** (`ImportLibraries.learnColor` / `pruneConflicts`, and the
    review screen's "Forget" control). Learned prototypes rank ABOVE the
    built-in table (12d), which is right for corrections and dangerous for
    mistakes — and nothing used to tell the two apart.
    - **The failure, observed on a real library.** `learnColor` recorded a
      group's MEAN colour under whatever label the group was confirmed with.
      A heterogeneous "mountain" group averaging grey rock with tan hillside
      taught `mountain L=62 a=4.7 b=16.4` — a warm tan. Because layer 1 beats
      the prior, that one prototype then captured every desert and hill on
      every later map. Eight prototypes, five of which contradicted the
      built-in table and two of which contradicted EACH OTHER at ΔE 8.2 (inside
      the 12.0 match radius, so they fought hex by hex), collapsed a 455-hex
      map from 5 sensible groups into 3: `mountain:232 hills:202 forest:21`,
      with desert and tundra gone entirely. The symptom reads as a recogniser
      bug — it is stale data, and re-importing never escapes it.
    - **Three defences.** `learnColor` now EVICTS any prototype of a different
      biome within `conflictDeltaE` (12.0, the match radius — two prototypes
      closer than that are competing) and merges same-biome duplicates within
      `duplicateDeltaE` (3.0, kept tight because a biome is a RANGE and several
      prototypes per biome is the point). `pruneConflicts` repairs a library
      that already went bad, keeping the newest of each conflicting set, and
      runs on every `loadLibraries` so an existing file self-heals.
      `CascadeParams.contradictedMatchDeltaE` (5.0, mirroring the built-in
      table's own separation floor) is the third: a learned prototype that
      CONTRADICTS a built-in guess must be a close match to win, not merely the
      nearest thing within 12 ΔE.
    - **What is deliberately NOT fixed in the recogniser.** A prototype
      learned from a colour at ΔE ~3 still beats the table, even when the table
      is confident and right. That is indistinguishable from a correction —
      both say "this exact colour means X" — and blocking it would make
      relabelling impossible, which is worse. So a mislabelled group teaches an
      equally strong lie, and the repair is UNLEARNING: the review screen shows
      how many learned colours are in play and offers to forget them, shown
      only when there are any. Colours only — learned ICONS are matched by
      shape against a specific stamp, cannot capture a biome they were never
      taught, and discarding a user's icon names as collateral would be its own
      bug.

12d. **The importer ships a PRIOR** (`importer/biome_heuristics.dart`), because
    `ImportLibraries` starting empty is not a neutral default — it means a GM
    who has trained one machine gets everything recognised there and NOTHING on
    a second one, and hand-labels every group. The prior is a table of Lab
    prototypes (several per biome: a biome is a RANGE in map art, not a point)
    seeded from `terrainColors` — so a map exported from HexLore re-imports
    exactly, which `biome_heuristics_test.dart` asserts as `selfConsistent` —
    and extended with the colours hand-painted and generator-made maps land in.
    Three rules keep it from doing harm:
    - **It ranks below the learned library.** Layers 1–2 (icon templates,
      learned prototypes) run first and a guess never overrules them.
    - **It runs on GROUP centroids, AFTER clustering** (`_guessMissingBiomes`),
      so it can only fill in a LABEL — it can never change how hexes group, and
      grouping consistency is what the whole confirm-per-group design rests on.
    - **It is allowed to say nothing.** Parchment, ink and HexLore's own
      unpainted grey are "refusal" prototypes mapping to no biome: a confident
      wrong guess on a map's background is worse than a blank, so when one of
      them wins, `guessBiome` returns null rather than falling through to the
      nearest runner-up.
    **The table must cover DESATURATED art, and that is where it keeps
    failing.** Its first version was seeded from HexLore's own saturated
    palette, which is not a neutral starting point but a biased one: the
    nearest prototype to an olive forest is a green HILL, and to a grey-green
    plain a grey MOUNTAIN, so a muted map came back confidently mislabelled
    rather than blank. Two real maps each exposed a missing band — a
    parchment-toned regional map whose entire land palette sat in the olive/tan
    gap between "neutral grey" (mountain) and "bright yellow" (desert), and a
    continental map whose ocean is a near-neutral slate `#787675` that landed
    on mountain's greys, so most of the image read as mountains. Both were
    fixed by adding prototypes, not by loosening thresholds. Where a colour is
    GENUINELY ambiguous the prior should stay silent instead: neutral grey-green
    grassland is indistinguishable from weathered rock, and
    `biome_heuristics_test.dart`'s separation guard (no two biomes' prototypes
    within ΔE 5) is what catches an addition that claims otherwise — it caught
    exactly that during this work.

    It also fires for ICON groups, which is the payoff of the pick split
    (decision 1c): a stamped hex's dominant colour is the terrain UNDER the
    stamp — evidence the cascade refuses to colour-MATCH (it would bury the
    icon) but which is fine for the biome half alone. So `icon? 1` arrives as
    "jungle, feature undecided" instead of blank. `CascadeGroup.guessedBiome`
    marks these so the review screen can show them as guesses, and so
    `learnConfirmed` can treat them correctly: a confirmed cluster guess IS
    learned (upgrading it to a layer-2 match next time), but a guessed biome on
    an ICON is dropped before `learnIcon` (`_iconMeaning`) — an icon's meaning
    is its feature and tags, while the terrain under it varies by location, so
    learning "this tower means hills" from one hillside would mislabel every
    tower after it. `CascadeParams.useBuiltinGuesses` turns the whole layer off
    for tests that want to observe the raw cascade.
