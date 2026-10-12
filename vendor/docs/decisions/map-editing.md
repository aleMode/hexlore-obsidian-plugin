# Decisions — Map tools: regions, rivers, routes, roads, threads, scale, title bar

Decision records moved verbatim from the root `CLAUDE.md`, whose index
lists every decision number and where it lives. Numbers are stable;
"decision N" anywhere in the notes resolves through that index.

Decisions: 6, 7, 8, 8b, 8c, 8d, 18, 25, 27, 30.

6. **Seven exclusive canvas tools** (`enum MapTool`, shortcuts 1–7, Esc →
   select): `select`, `terrain`, `river`, `thread`, `region`, `route`, `fog`.
   The **fog tool** is the player-visibility editor: left-drag reveals, Ctrl+
   drag hides, sharing the terrain brush radius; stamps flow through
   `AppController.setRevealedBatch` (one revealed.json write + one notify per
   stamp; hexes it creates are dirty-marked so reveals survive a reload).
   `main.dart`'s `_setTool` tears down the previous tool's in-progress state
   before engaging the new one. `HexMap` is callback-driven — it emits
   `onRiverVertex` / `onRouteNode` / `onRegionPaint` / `onFogPaint` / taps,
   and the shell wires them to the controller. The map is ONE `CustomPainter` (`_HexMapPainter`) painting only
   the cells intersecting the viewport (`geo.cellsInRect`), so cost is O(visible)
   regardless of grid size; LOD keys on on-screen hex radius. A steady pan
   does not re-render it at all — it is served from image tiles (decision 23).

7. **Regions** (`core/region.dart`) — a named SET of hexes rendered as a
   contoured (`boundaryEdges`: an edge is on the outline iff the hex across it
   isn't a member — handles concave shapes / holes) + hatch-filled overlay,
   **GM-only**, with an attached `pages/regions/<Name>.md` page. The page carries
   a `## Encounters` table (`core/region_encounters.dart`: weighted list `- 2:x`
   or dN table `| 1-3 | x |`; `rollEncounter` is weight-proportional). Region
   cell-paint is undoable as one snapshot per drag (`pushRegionCellsChange`);
   create/delete are structural (dialogs, not undo). Removing hexes has THREE
   entry points because the first was undiscoverable: Ctrl+drag with the
   region tool (status bar only), the region panel's Add/Remove toggle (which
   inverts the gesture, so Ctrl+drag always means "the other one"), and the
   hex context menu's "Remove … from region X", one entry per region the
   selection touches (`removeRegionCells`, one undo entry). The overlay is
   drawn in `regionInk` — the GM's hue with lightness lifted to ≥0.62 — with
   a dark halo under a 4.5 px contour, so it reads on dark AND light terrain. Regions join the wikilink
   namespace (precedence **hex > region > npc > quest > entry**) and participate
   in link strip/rename via `AppController._contentPageFiles()`.

8. **Routes** (`core/route.dart`) — roads / trails / borders drawn along the
   shared anchor set: corner vertices **+ edge midpoints + hex centres**
   (`RouteNode` kinds `v`/`e`/`c`, each with one canonical form; `nearestRouteNode`
   snaps a pixel to the nearest allowed anchor). Routes had this set first and
   rivers were corner-only; **rivers now share it** — see decision 8b. Kinds: **highway / road /
   trail** (a STACKED look, decision 25) and border (one dash-dot stroke). Highways,
   roads and trails are player-served; **borders
   default `playerVisible=false`** (GM-only). Create/delete/point-delete are
   undoable like rivers.

8b. **Rivers walk the SAME anchor lattice as routes** (`core/river.dart`'s
   `RiverNode`, `core/geometry.dart`'s `anchorNeighbors`/`nearestAnchor`).
   A river used to be corner-vertices ONLY, which is a strictly poorer lattice,
   and it was wrong in a way no editor could fix: painted rivers on real map
   art run down the MIDDLE of hexes and across their edges at least as often as
   they track the corner web, so a snapped course sat visibly off the ink and
   dragging could not correct it — the points did not exist. Rivers therefore
   adopt the route vocabulary verbatim rather than growing a parallel one, so
   the two share canonicalisation, pixel mapping (`anchorPixel`) and visibility
   (`riverNodeTouchingHexes` mirrors `routeNodeTouchingHexes`).
   - **The graph is the SHORT-STEP one** and deliberately not the full
     "everything within R" graph: corner↔edge at R/2, edge↔centre at the
     apothem, corner↔corner at R. A centre is reached only THROUGH an edge
     midpoint. Short steps are what let a snapped river hug a curve, and
     dropping the centre→corner hop is also what keeps the graph SYMMETRIC —
     A* and the Viterbi pass both walk it in either direction, so a one-way
     edge surfaces later as a river that cannot be re-walked after a drag.
   - **Corner↔edge adjacency is decided by ENDPOINTS, never by distance**
     (`edgeEndVertices`). Six edge midpoints sit at exactly R/2 from any
     corner: the three whose edges end there and three that merely pass near.
     A distance test cannot separate them — both are R/2 to the last decimal —
     and admitting the wrong three breaks symmetry. Both sides of the relation
     are computed from the same helper so they cannot drift apart.
   - **Persistence is a WIDENING, not a break.** An anchor is stored as
     `[q, r, c]` (legacy corner) or `[kind, q, r, k]` (current); `riverNodeFrom`
     reads both, discriminating on whether element 0 is a string, and writing
     ALWAYS emits the kind so a file cannot drift back to a shape that has no
     room for a centre. `player.js`'s `riverAnchorPixel` mirrors exactly this,
     and the served payload widened with it (`revealedRiverSegments` now emits
     `[kind, q, r, k]`, like routes always did).
   - **Tautness is measured by PATH LENGTH, not anchor count.** The widened
     lattice offers roughly twice as many anchors along the same course, so a
     STRAIGHTER chain legitimately contains MORE of them and a count bound
     reads the improvement as a regression. Measured on a horizontal course:
     the corner-only lattice could not beat a 1.333× detour (2R of travel per
     1.5R of progress — the staircase this replaced), the widened one comes out
     at ~1.295×. `importer_river_test.dart` asserts the ratio, not the count.
   - `remap.dart` rebuilds river anchors through the canonical factories for
     the same reason routes are rebuilt: now that a river carries `'e'`
     anchors, the lexicographically-smaller-hex winner can flip when only one
     side of an edge moved.

8c. **A river's or route's points are EDITABLE on the GM canvas, ONE POINT
    AT A TIME** (`core/line_edit.dart`: `moveLinePoint` / `insertLinePoint` /
    `nearestLineSegment`, generic over the anchor type so rivers' `RiverNode`
    records and routes' `RouteNode`s share them). Select a river or a route
    with the select tool and its anchors become handles: tap one to HOLD it
    (Del then deletes it — `MainShell._onDeleteKey`, which falls back to
    deleting the hex selection), drag one to move THAT point to the nearest
    anchor, double-click the line's body to add a point on the link under the
    click. `HexMap` speaks one vocabulary for both kinds (`LineKind`,
    `onLineNodeSelect/Drag/DragEnd/Insert`, anchors as `RiverNode` and
    converted to `RouteNode` in the shell); `_selectedLine` is the selected
    river, else the selected route, and the shell never selects both.
    - **A drag moves one point and adds none.** It used to re-walk the links
      either side along the lattice (`river_edit.dart`'s `moveRiverNode`),
      which inserted a point at every lattice step — the GM wanted the point
      they grabbed to move and nothing else. A hand-drawn line has no
      one-step-per-link invariant anyway: the river and route tools join
      whatever anchors were clicked. Landing on a NEIGHBOUR merges the two
      (that is how a drag shortens a line); an edit that would leave fewer
      than two points is refused, not stored.
    - **The import wizard keeps the lattice re-walk** (`river_edit.dart`,
      `RiverDraft`, decision 12l). A traced river has a point at every lattice
      step and that editor's link operations rely on it, so the two editors
      now deliberately differ here.
    - **Every frame is re-laid from the course as it stood at POINTER-DOWN**
      (`moveRiverNodeLive` / `moveRouteNodeLive`'s `from:`), never from the
      live one: a frame where the point merged into a neighbour would
      otherwise fossilise the merge and shift the index the drag holds.
      `hex_map_line_edit_test.dart` asserts a drag passing over a neighbour
      leaves no trace. The shell holds the snapshot; `HexMap` holds only the
      original index.
    - **One undo entry per GESTURE** (decision 9): a drag is sealed by
      `pushRiverNodesChange` / `pushRouteNodesChange` on release (the live
      moves are NOT undoable on their own); a double-click insert is one
      entry (`insertRiverNode` / `insertRouteNode`).
    - **Double-click is detected by hand** (`_clickSelectedLine`; the canvas is
      a raw `Listener`, decision 12): two plain clicks on the SELECTED line's
      body within `kDoubleTapTimeout` and 12 px. The line must already be
      selected at the FIRST click, so a fast double-click on an unselected
      river selects it and nothing more. A click on the selected line's body
      keeps it selected even where another line crosses it.
    - **A handle beats every other meaning a press on the map has** (rubber
      band, selection drag, hex click) — it is the smallest, most deliberately
      aimed target on screen. Only the SELECTED line's handles are live.
    - **The anchor field is shown while a handle is in flight** (either kind:
      rivers and routes share the lattice), all three anchor kinds. It is the
      densest thing the painter draws, so it is LOD-gated: nothing below
      `_lodMed`, corners only below `_lodFull`.

8d. **A river ENDS at the shore of a sea or lake hex, in a mouth**
    (`core/river_mouth.dart`, mirrored in `render_spec.js` and held to it by
    `render_spec_mirror_test.dart`; drawn by `_paintRivers` / `drawRivers`).
    A river used to be stroked straight across water — dark banks, round
    cap and all — so it read as a blue worm lying on the lake. Now the
    smoothed course is sampled (`sampleSmoothCourse`), cut where it enters
    water (`splitCourseAtWater`), and only the dry runs are stroked; each
    shore end gets a trumpet-shaped MOUTH (`mouthOutline`, `riverMouthFlare`)
    in the bank and water passes, then a gradient overlay that fades the
    river into the DRAWN fill of the water hex (`_cellLook`, jitter and
    Illustrated ground included — a lake is the river's own blue, the sea is
    darker) and spills `riverMouthSpill` past the shore, opening the
    coastline stroke and halo where the river comes in.
    - **A split river is drawn CLIPPED TO LAND, and each mouth to its own
      land cells.** The first version only stopped the course at the shore,
      and the GM's map showed what that misses: a course ending on the TIP
      of a land corner (two lake hexes and a desert) laid half its flared
      mouth, brown banks and all, over the lake; a mouth whose spine ran in
      one hex poked a bank spike into the next land hex; and a river meeting
      the coast at a slant ended in a square cut with one corner standing on
      land. So: the bank/water/glint passes clip to the view minus the water
      cells near split rivers (wound against the rect, so nonzero cuts holes
      and edges shared by two water cells cancel without a seam); each mouth
      also clips to the land cells its spine runs through (its fade: those
      plus the water cell it opens into); and each mouth FLANK is carried on
      along the course's final heading until it reaches water
      (`mouthOutline(wet:, extend:)`), so the clip makes the coastline itself
      the mouth's end. The fade's `riverMouthSpill` is short (0.18 R): it
      only has to open the coastline stroke, and more blots out the GM-fog
      or region hatch inside the water hex.
    - **Water is a predicate over scene pixels**, so the geometry knows no
      hexes. GM: `terrainGroup == groupWater`, memoised per cell. Player:
      REVEALED water only — a river running into fog is drawn as before.
    - **An end ON the shore is a mouth** (12 probes around the endpoint): the
      GM usually finishes a river on the shore corner or edge midpoint, whose
      course never enters the water hex at all.
    - **Runs shorter than `riverMinRun` are absorbed**, so a course grazing a
      water corner is neither notched nor given two mouths.
    - A river that never meets water still strokes its smooth cubic path,
      exactly as before; a split one is stroked as a fine polyline
      (`riverCourseStep` = R/12, sub-pixel sagitta). The selection highlight
      and hit-testing still use the whole course.
    - Not handled: a river running exactly ALONG a coast (anchors on shared
      water/land edges) classifies arbitrarily per sample; short flickers are
      absorbed, longer ones are cut.

18. **Map scale is campaign metadata** (`core/map_scale.dart`; `hex_distance` +
    `distance_unit` in campaign.json, default 6 mi, read tolerantly so a
    pre-scale file loads). "One hex" as a DISTANCE is the flat-to-flat width
    (`hexStepPx` = √3·R scene px), the hexcrawl convention — not the corner
    radius. Two consumers so far, both on the GM canvas and both in SCREEN
    space so they keep a constant pixel size at any zoom: the **scale bar**
    (bottom-left, always on; `pickScaleBar` chooses the largest 1/2/5×10ⁿ
    real-world length that fits `_scaleBarMaxPx`, so it always reads as a
    round number) and the **ruler tool** (`MapTool.ruler`, shortcut 8:
    drag to measure; `rulerMeasure` is pure and reports straight-line
    hex-widths plus the axial step count between the endpoint cells, null
    off-grid; the last measurement stays drawn after release and is cleared
    by a tool change in `didUpdateWidget`). `AppController.setScale` is a
    setting, not a map edit — meta-dirty, not undoable. Not served to
    players (the payload shape in decision 4 is unchanged). This is phase 0
    of `docs/sketch-layer-plan.md` (a pen-first sketch layer that hexifies
    on demand); "Stylus diagnostics…" in the campaign menu (HexLore ›)
    (`app/stylus_probe.dart`) is that plan's spike — it shows what the
    engine delivers per pointer event (kind, pressure, tilt) so the sketch
    pen can be designed against this machine's tablet, not the docs.
    **Spike result (XP-Pen Star G640, GTK 3.24, Wayland, Flutter 3.41):
    the embedder labels the pen `stylus` but delivers pressure 0** — the
    engine library calls `gdk_device_get_source` and never
    `gdk_event_get_axis`, so the axis is dropped one layer above GTK. The
    fix is in OUR runner, not the engine: `linux/runner/my_application.cc`
    installs a GLOBAL GDK event hook (`gdk_event_handler_set`, forwarding to
    `gtk_main_do_event`), reads `GDK_AXIS_PRESSURE`/`XTILT`/`YTILT` off each
    motion/button event, and streams
    `[x, y, pressure, xtilt, ytilt, time_ms, source]` (source = the
    GdkInputSource: 1 pen, 2 eraser, 0 mouse …) on the `hexlore/stylus` event
    channel while Dart listens — every pointer source, so the probe can show
    what GTK thinks the device is; Dart keeps pen/eraser only. On subscribe
    the runner answers with a ping (source -1) and logs counters to stderr
    (`hexlore/stylus: …`), so a live channel is provable from the terminal
    with no pen at all. `MainShell.initState` starts the listener, so the
    first stroke anywhere already has pressure. A signal handler on the FlView or the window
    does NOT work — the embedder receives input on a GtkEventBox inside the
    view and returns TRUE, so nothing propagates (the first attempt, and why
    the hook is global). `app/stylus_pressure.dart` pairs a sample with its
    pointer event by TIME (`pressureFor(event.timeStamp)`: the engine stamps
    `gdk_event_get_time()` ms as microseconds; exact match, else nearest
    within 8 ms) — never by position, whose origin differs between the GDK
    window and the view — with a NEWEST-PEN-SAMPLE fallback, which is what
    actually fires today: the two clocks disagree on this machine and the
    exact match never lands (parked TODO in `docs/sketch-layer-plan.md`).
    Measured 2026-09-07: 631 pen samples, pressure 0.00–0.57, varying — so
    pressure IS obtainable. A sample carries pressure -1 when GTK had no axis,
    so the probe can tell "hook never ran" from "no axis"; `pressureFor`
    returns null for those and on any platform without the channel, so
    callers fall back to a fixed width.

25. **Roads are a stack, drawn from one shared spec** (`core/road_style.dart`
    + its mirror in `render_spec.js`; `road_style_test.dart` holds them). Three
    kinds — `highway` (new, pale paving, paved joints), `road` (the old
    default, so no file changes meaning), `trail` (thin, irregular dashes,
    faint casing) — all just strings in `Route.kind`, no migration; borders
    stay a single dash-dot stroke and are NOT roads.
    - **Layers**: every CASING, then every BODY, then every CORE (worn centre /
      a highway's centre dashes), so roads merge where they meet instead of
      the upper one cutting the lower one's body; a bigger road's casing lies
      over a smaller one's (`roadKindsByRank`). Casing colour is DERIVED from
      the route's own colour (toward dark, toward light when the body is
      already near black) — same reasoning as stamp ink (decision 13). The
      route's colour is still the body colour; the panel swaps to a kind's
      default only if the colour was still the old kind's default.
    - **Roads are smoothed** with the same Catmull-Rom the rivers use. Stored
      nodes are untouched; the obstacle index (Illustrated) still uses the raw
      polyline with the CASING half-width.
    - **Illustrated adds marks** (pebbles on road/trail, paving joints on a
      highway) at full LOD only. `roadMarks` walks the FLATTENED curve
      (`smoothPolyline`), deterministic from a seed (first node), memoised per
      route on the GM side — flattening in one pure place is what lets Dart and
      JS place identical marks.
    - **Sketch/hexify only know road and trail** (swatch kinds); a highway can
      be drawn in the hex view but not from a sketch yet.

27. **Threads are drawn as a laid-out COURSE, in one of two styles; the
    GM-only overlays are shown and hidden from ONE Display & overlays panel**
    (`core/thread_geometry.dart`, `core/overlay_filter.dart`,
    `app/overlay_panel.dart`, `_paintThreads` in `hex_map.dart`, the
    toolbar's Display & overlays (sliders) button `_viewPanelButton` in `main.dart`, and
    "Hide threads of this colour" on a thread's right-click menu). Threads
    used to be a 2.5 px centre-to-centre line: two threads between the same
    hexes coincided (the second was invisible), every thread leaving a hex
    started under its stamp, arrowheads were 10 px, and colours vanished on
    fills of similar hue.
    - **Geometry is pure and shared by painter and hit-test**
      (`layoutThreads`, `visibleThreadShapes`). Ends are TRIMMED to a ring at
      `threadEndTrim` (0.5 R, just outside a stamp), so threads leaving one
      hex read as separate spokes. Threads joining the same pair are FANNED:
      sideways offsets (straight style) or growing bows (curved). Curved
      threads bow to the RIGHT of travel, so A→B and B→A separate on their
      own. A hit-test walks the drawn course, never the bare segment.
    - **Two styles, a per-machine preference** (`thread_style` in
      config.json, Display & overlays panel "Threads"): **Arc** (curved, the default)
      and Ribbon (straight), both with a dark casing, a dot at the source, a
      15 px arrowhead at the target, mid-course chevrons on one-way threads
      (none under a label), dots at both ends for two-way ones. A third,
      Comet (a taper from hairline to broad end, the width as the direction
      cue), was rendered for comparison and dropped by the GM; a config that
      still says `comet` parses to Arc. Dormant = dashed, resolved =
      faded/dotted. Labels
      are pills at the course midpoint, full LOD only. Sizes are scene units
      with a screen floor (`k`), so threads do not thin to hairlines zoomed
      out. `test/thread_style_capture_test.dart` (opt-in,
      `HEXLORE_THREAD_OUT`) renders both over a scene built to show the
      failure cases. Threads stay GM-only; nothing here touches the payload.
    - **A thread's colour is "by type" ('') or the GM's pick** (dialog swatch
      row). Files written before the picker STORED the derived colour; it
      was never the GM's choice, so `Thread.fromJson` reads a colour equal to
      `colorFor(type, status)` back as '' — otherwise a later type change
      would keep the stale colour.
    - **EDITING lives with each tool; SHOWING lives in the Overlays panel.**
      Sub-groups are created where their objects are edited — a region IS a
      sub-group (named and coloured in the region sidebar), a thread COLOUR
      is a sub-group (picked in the thread dialog, which starts on the last
      colour used, `thread_color` in the campaign view). The panel lists, in
      this order: Threads and Regions — each a section with its own eye,
      expandable to one eye per sub-group — then Borders, the import
      Underlay and the Sketch overlay as single switches (the last with a
      "Labels only" mode chip that does not itself show the overlay). Fog of
      war is deliberately absent: it is the player view's truth, not
      clutter. The underlay and sketch-overlay toggles (and removing the underlay) moved
      here from the campaign menu.
    - **A hidden section keeps its sub-groups' own switches**
      (`_threadsShown` vs `_hiddenThreadColors`, `_regionsShown` vs
      `_hiddenRegionIds`), so showing it again restores exactly what was
      showing; sub-rows under a hidden section are dimmed but still
      switchable. Regions hide by ID, threads by `Thread.colorKey`
      (upper-case `#RRGGBB`). A hidden thread or border neither draws nor
      hit-tests, the thread fan closes up around a gap, and hiding a selected
      thread or border deselects it.
    - **What the GM is working on is never hidden**: creating or editing a
      thread shows its colour (and the section), creating or selecting a
      region in the sidebar — or entering the region tool, which selects one
      — shows that region, and finishing a border shows borders. The
      Display & overlays button shows as active while anything that EXISTS is hidden
      (a hidden thread must not look deleted); the underlay and sketch
      overlay are off by default, so they do not count.
    - **Region LAYERS are gone.** `Region.layer` existed with a visibility
      checkbox per layer, but no UI ever assigned one, so every region sat on
      `'default'`. Removed from the model (an old file's `layer` key is
      ignored and dropped on the next save) along with the sidebar section.
      Hide-by-region-colour went with it: a region is its own sub-group.
    - Every switch is remembered per campaign (decision 28): `threads_shown`,
      `hidden_thread_colors`, `regions_shown`, `hidden_region_ids`,
      `borders_shown`, `underlay_visible`; the panel's expanded sections and
      the sketch overlay's mode are machine prefs. All are in `_baseKey`
      (decision 23) via `HexMap`'s `showThreads` / `hiddenThreadColors` /
      `showRegions` / `hiddenRegionIds` / `showBorders`, or tiles would keep
      showing what was just hidden.

30. **The title bar is grouped by WHAT a control is about: left = the
    campaign, right = this session** (`_leftToolbarGroup` /
    `_rightToolbarGroup` in `main.dart`, `DisplayPrefsPanel` in
    `app/overlay_panel.dart`, `test/toolbar_test.dart`). The centre (view
    switch + tools 1–8) is unchanged. Before this, a "Campaign settings" gear
    held seven unrelated groups (map ops, import, players' fog, display
    prefs, backup, diagnostics, About), and backup, display, underlay and
    players were each split between two places.
    - **Left**: the campaign menu, LABELLED with the campaign's name (New,
      Open, Open from a git host; Map › scale / resize / explode; Import ›;
      HexLore › stylus diagnostics, About); the backup SPLIT button (the cloud
      keeps its status-driven action, the ▾ holds push-with-message, pull,
      restore, settings, detach); then content — quick jump, Adventures, and
      Notes ▾, which lists the prep documents directly (rename / delete
      inline) and holds Unassigned entities.
    - **Right**: undo / redo (beside the tools whose work they undo), reset
      view, the Display & overlays panel, the players SPLIT button (the icon
      starts / stops the server; the ▾ holds the URL, the LAN switch and
      reveal all / hide all), the window buttons. Thin dividers separate the
      clusters.
    - **Display & overlays is one panel in two labelled halves** because the
      halves are remembered differently (decision 28): overlays per
      CAMPAIGN (decision 27's panel, plus a trash icon that removes the
      underlay), display per MACHINE (map style, blend edges, thread style,
      GM fog). Its icon is sliders: the eye is the Fog of war tool's and
      layers the Region tool's.
    - **The campaign name shows only from a 1240 px window up**
      (`MediaQuery`, capped at 140 px and ellipsised). At the 1024 px minimum
      the flanks plus the tool row do not fit — they did not before either:
      the centre group scrolled by 80 px there, now by 53 — so the button
      shrinks to its icon and the menu's first line names the campaign.
      `toolbar_test.dart` measures both widths at desktop density (the
      Windows variant: 40 px icon buttons, not the test default's 48) and
      sizes the test VIEW (`tester.view.physicalSize`), since
      `setSurfaceSize` leaves `MediaQuery` at 800 × 600.
    - Every menu is a `MenuAnchor`. The two closed from code (a notes row's
      rename / delete, the panel's remove-underlay, each of which opens a
      dialog) have their own `MenuController`. The notes list is read inside a
      `Builder`, so the folder is listed only while the menu is open. Menu
      actions still dispatch through `_campaignMenu(choice)`.
