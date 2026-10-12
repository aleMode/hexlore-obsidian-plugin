# Decisions — Rendering: shared spec, outlines, glyphs, Illustrated style, tiles and zoom

Decision records moved verbatim from the root `CLAUDE.md`, whose index
lists every decision number and where it lives. Numbers are stable;
"decision N" anywhere in the notes resolves through that index.

Decisions: 13, 14, 15, 16, 22, 23, 23b, 32, 33.

13. **Shared render spec** (`core/map_palette.dart` + its mirror
    `assets/player/render_spec.js`) — the derivations and constants BOTH
    canvases need. Pure Dart on `'#RRGGBB'` strings (so `core/` stays
    Flutter-free and JS can match it exactly): `relativeLuminance`, `inkFor`,
    `lerpHex`, the FNV-1a `hash2`/`hashUnit`, and the stamp/label constants.
    **Stamp ink is DERIVED FROM THE HEX FILL**, not a constant — one cream
    could not serve a palette spanning jungle `#2D6B3C` to tundra `#B8C8D8`
    (tundra scored 1.45 contrast; derived ink gives 4.6). The trade is
    deliberate: dark biomes give up a little contrast so light ones gain a
    lot — the goal is an EVEN spread, which is what `map_palette_test.dart`
    asserts. `inkLightMix`/`inkDarkMix` are the tuning knobs. `drawStamp`/
    `drawFeatureGlyph`/`drawBiomeStamp` take the ink as a required argument;
    `hex_map.dart` derives it from the fill THAT CELL was painted with (via
    the memoised `inkForColor`), not from the nominal terrain colour. The hash
    is integer-only and explicitly 32-bit masked — the JS mirror **must** use
    `Math.imul`, since a plain `*` overflows the 53-bit mantissa and diverges
    silently. `render_spec_mirror_test.dart` runs the real JS under node
    against the same vectors, so drift fails the build; it skips when node is
    absent. **The palette itself still lives in `hex_data.dart`**;
    `document_view.dart`'s colour-override presets read `terrainColors.values`
    directly (not a hand-copy), so a palette change needs no second edit
    there. It DOES need re-checking against `map_palette_test.dart`'s "palette
    separation" group (no two biomes within dL* 8 / dHue 30, `inkFor` contrast
    > 2.0 for every fill) — that group is what a naive RGB midpoint for a new
    biome colour is most likely to fail, by landing on top of a neighbour's
    lightness rather than its hue.

14. **Cluster outlines.** Cell edges are NOT stroked per hex. Both canvases
    accumulate them into a quiet path (neighbour shares a `terrainGroup`) and a
    boundary path (group changes), then issue two draws — so terrain reads as
    landmasses instead of a honeycomb. Two invariants: each edge is drawn only
    by its `canonicalEdge` owner (every hex stroking its own six paints
    interior edges TWICE — invisible at 1px opaque, but at 22%/55% alpha it
    renders boundaries at ~80% and only where both sides are on screen); and
    the neighbour lookup goes through a packed-int map built during the fill
    pass, never `campaign.getHex`, which allocates a string per call. GM: full
    LOD only (below that one path, plain pen). Player: always, and the fog
    frontier necessarily reads as a boundary. `terrainGroup` folds sea+lake
    into one group, folds missing/`default`/UNKNOWN terrain into `none`, and
    deliberately ignores `colorOverride` — the player payload doesn't carry it,
    so any rule using it could not be evaluated identically on both sides.

15. **Per-hex fill jitter + coastlines.** `jitterFill` nudges a fill ±6%
    lighter/darker by `hash2(q, r)` so a field of one biome doesn't read as a
    component grid. Applied ONLY to painted terrain (jittering the empty
    background is just noise), and the stamp ink is always derived from the
    UNJITTERED fill — ink should be constant per terrain, and a per-cell ink
    would make `hex_map.dart`'s `_inkCache` unbounded. Coast haloes are an
    inset stroke inside any water cell touching PAINTED land (`isCoast`);
    unpainted deliberately doesn't count, or every water hex at the grid edge
    and at the player's fog frontier would be haloed. Coast draws under the
    cluster outlines, and both sit under rivers (`_paintCells` runs before
    `_paintRivers`), so a river bank crossing a coast wins — as intended.
    There is NO per-hex stamp jitter: these stamps are geometric, so a rotated
    triangle reads as a misaligned UI element, not as hand-drawn terrain. And
    there is deliberately no render-time stamp variant — the GM picks variants
    explicitly and a hidden second axis would override that choice.

16. **Features are all glyphs; biomes are glyph where a good icon exists, else
    procedural.** Both come from the same generated pipeline
    (`lib/app/glyphs.dart`). Originally ALL biomes were hand-drawn — the
    reasoning was that biomes are AREA TEXTURE repeated across dozens of
    cells, where a vendored silhouette stamped 200 times could read as
    mechanical, unlike features (POINT SYMBOLS, one per hex, that must stay
    distinct — a 1.3px outline of a small angular shape lost what told
    dungeon/tower/ruins/mine apart at ~18px). In practice the texture concern
    only bit for biomes with no good vendored match: **lake and tundra stay
    procedural** (`app/stamps.dart`'s trimmed `_terrainDrawers`); every other
    biome (forest, jungle, mountain, hills, desert, swamp, plains, sea,
    volcano) now renders a game-icons glyph, same as features. A biome's
    variants are always ALL glyph or ALL procedural — never mixed — so
    `drawBiomeStamp` can dispatch per-terrain instead of per-variant.
    `tool/glyphs/gen_glyphs.dart` (author-time, never at build) reads
    `tool/glyphs/manifest.json`'s `features` AND `terrain` sections + the
    vendored SVGs beside it (`tool/glyphs/svg/`, sourced from a local
    game-icons.net archive that is itself NOT vendored — see the CC BY 3.0
    note below) and emits FOUR files in one pass: `lib/core/feature_glyphs.g.dart` /
    `assets/player/feature_glyphs.js` and `lib/core/terrain_glyphs.g.dart` /
    `assets/player/terrain_glyphs.js` — which retired the hand-ported
    `FEATURES` table and most of the hand-ported `TERRAIN` table. Re-run it
    after ANY manifest edit; `glyphs_test.dart` and
    `player_stamp_tables_test.dart` fail if you don't.
    - **`core/glyph_data.dart`'s `Glyph` class is shared** by both tables (it
      used to be feature-only, called `FeatureGlyph`); `app/glyphs.dart` has
      one `_drawGlyph`/`drawGlyph` halo-then-fill primitive (Dart and JS sides
      respectively) that `drawFeatureGlyph` and `drawTerrainGlyph` both call,
      so the two never hand-duplicate the transform math.
    - **`core/svg_path.dart`** parses SVG path data and the generator re-emits
      only absolute `M`/`L`/`C`/`Z`, arcs already converted to cubics, so
      `Path2D` and Dart draw the same curves instead of two approximations.
      Two tokenizer traps are real in this set and unit-tested: numbers run
      together when the next starts with `.` (`10.595.293` is TWO numbers), and
      arc flags may be packed with no separator (`a1 1 0 011 1`). No icon has a
      `fill-rule`, so both renderers use their nonzero default and agree.
    - **Sizing is from TIGHT BOUNDS** measured at generation time (`glyphTransform`
      in `core/glyph_data.dart`, mirrored in the generated JS), not the nominal
      512 box. Glyphs draw halo-then-fill: stroked in the hex's own fill, then
      filled with `inkFor` — that is what keeps a solid mass readable on a fill
      of similar value while features still never change the biome fill (and,
      for glyph biomes, keeps the same visual language as procedural biomes).
      A glyph with manifest `"outline": true` (plains/Grass so far) strokes its
      CONTOUR in ink over a wider halo instead of filling — for silhouettes
      that are already thin strokes, where the fill reads as a blob at hex
      size. Its companion `"open": true` drops the closing segments AT
      GENERATION TIME (the emitted path has no `Z`), so the contour doesn't
      draw the line that closed the silhouette — that is what removes grass's
      ground line. `open` on a filled glyph would be meaningless: fill closes
      subpaths implicitly. `featureStampScale` (0.42) is now SMALLER than
      `terrainStampScale` (0.50): a feature is a marker sitting on terrain,
      and at the old 0.52 it filled the cell.
    - **Variants are persisted BY ID since campaign format 2 (decision 31).**
      Every variant has a stable id (`forest/dead`; index 0 is
      `<kind>/default`) in `core/variant_ids.dart`, mirrored by an `id` on
      every entry of both art manifests and listed in `tool/variant_ids.lock`;
      `variant_ids_test.dart` fails if an id is removed, reused or unlisted.
      The index is still what memory, the generated tables and the player
      payload use, so keep the lists append-only until every reader is on
      format 2. The label STRINGS are display-only and were reworded freely
      when the art changed. **A biome icon MAY repeat across different terrains** (e.g.
      `lorc/dead-wood` is both forest/Dead and swamp/Dead trees) — the ink
      comes from each hex's own fill, so the same silhouette reads differently;
      `glyphs_test.dart` only enforces uniqueness WITHIN one terrain's own list.
    - **CC BY 3.0** needs credit on both surfaces: the campaign menu (HexLore ›)
      "About & credits…" and the player view's footer, both generated from the
      manifest (`glyphCredits`, computed once from every author used across
      BOTH features and terrain, embedded only in the feature-side files).
      `icons/` and the full archive are gitignored — only the SVGs the
      manifest names are vendored.
    - **The pre-migration procedural drawers are archived, not deleted**:
      `tool/archive/stamps_procedural_legacy.dart` and
      `tool/archive/terrain_procedural_legacy.js` (out of `lib/` and
      `assets/player/`, so neither is compiled, bundled or vendored into the
      plugin) hold the original
      hand-drawn versions of every biome that's STILL glyph-based, wrapped in
      a block comment and referenced by nothing, kept only so the two looks
      can still be A/B compared before the glyph migration is called final
      for the rest. Safe to delete once that decision is made. **Hills and
      desert already lost the comparison**: the vendored silhouettes
      (`delapouite/hills.svg`, `lorc/crags.svg`, `delapouite/oasis.svg`,
      `lorc/cracked-glass.svg`) read as solid filled shapes, the GM wanted
      thin stroked geometry back for both, so `_hills`/`_hillsRocky` and
      `_desert`/`_desertCracked` moved out of the legacy file and are live
      again in `app/stamps.dart` + `player.js`'s `TERRAIN` table —
      `manifest.json` no longer has `terrain.hills`/`terrain.desert`
      entries, but the SVGs stay vendored (unreferenced, not deleted) in
      case a verdict is revisited. Desert's CURRENT procedural drawers are
      new geometry designed fresh for the comparison (three receding dune
      ridges; `_tundraCracked`'s crack-line language with four branches
      instead of two, styled as a family) — not a reversion to the
      original pre-migration desert drawers, which are gone for good
      (recoverable only from git history).
    - **Some vendored icons ship inside a circular frame** (game-icons'
      "badge" style — `mountaintop`, `mountains`, `crags` so far) that has to
      come out before the icon works as a hex stamp. It is NOT a separate
      `<circle>` element (that's already excluded by the generator's element
      check) — it's fused into the SAME subpath as the icon's own silhouette
      via nonzero-fill union, so deleting a subpath breaks the shape. What
      worked: boolean-INTERSECT the icon against a disc matching the frame's
      *inner* edge (Inkscape CLI: `select-all;path-intersection`), with the
      disc radius given a safety margin and verified by re-running the
      intersection at several smaller radii — if the result is unchanged, the
      remaining detail is genuine icon geometry, not a clipping artifact.

22. **The Illustrated map style: biome = ground TEXTURE, feature = object in
    a clearing** (`core/texture_data.dart`, `core/terrain_texture.dart`,
    generated `core/texture_tables.g.dart`, `app/texture_paint.dart`; plan,
    phases and the future Blend mode in `docs/illustrated-map-plan.md`).
    A per-machine DISPLAY preference (`render_style` in config.json, campaign
    menu → "Illustrated map style"), never campaign data: no hex JSON, no
    payload, nothing for sync. Clean (decisions 13–16) stays the default.
    The player canvas draws it too (phase 4), from `texture_tables.js`
    (generated with the Dart tables) and `texture_spec.js` (hand mirror of
    `terrain_texture.dart`, held by `texture_spec_mirror_test.dart` under
    node); there it is a per-viewer toggle in localStorage, default
    illustrated, and the payload is unchanged.
    - **Performance is MEASURED, not assumed** (phase 3,
      `integration_test/illustrated_perf_test.dart` via `flutter drive
      --profile`): replaying vector pictures cost 18× Clean, so each cache
      key is also rasterised once per power-of-two resolution
      (`Picture.toImageSync`) and a hex is one `drawImageRect` — which beats
      Clean at normal zoom. Vector pictures only above 256 device px per hex
      radius. Numbers in the plan; re-run it after changing the renderer.
    - **Those rasters are PACKED INTO AN ATLAS and drawn in batches**
      (`_packSome`, `TextureBatch` in `texture_paint.dart`). A draw-call
      census of one Illustrated + blend render at 1080p counted 3,475 draws,
      1,614 of them `drawImageRect` of a raster that was its own image: a
      separate GPU draw and texture switch each. Rasters now move into
      2048 px pages (per bucket, `_maxAtlasPages` LRU) a few hundred per frame
      at the START of a base frame (`beginTextureFrame`), and the ground pass
      and the objects pass collect their draws into a `TextureBatch` that
      issues one `drawRawAtlas` per run of one page — 1,614 draws became 2
      (plus whatever is not packed yet). GPU per frame: 54.6 → 23.3 ms. The
      ground batch is flushed after the cell loop, so badges are now ALWAYS
      deferred past it; the features pass stays unbatched (each feature must
      stay between its own objects). A raster evicted mid-frame may still be
      in a batch, so eviction defers `dispose` to the next frame's start
      (`_disposeNextFrame`; regression test with `debugTextureMaxImages`).
      Clean stamps' atlas is built lazily now (`StampBatch.lazy`): the cell
      pass used to build one at every new zoom bucket, stamps or not.
    - **Arrangements are DATA, flattened lazily.** `gen_textures.dart`
      (author time, like `gen_glyphs.dart`) emits per biome variant K layouts
      of placements `symbol, x, y, size, flip, band` in a unit hex. Clearings,
      depth order and LOD are decided when a layout is SLICED, and each
      distinct (variant, layout, mirror, feature slot, LOD bucket, fill,
      slice) is recorded once into a `ui.Picture`. The cache key holds no hex
      and no revision, so a paint stroke can only select a key, never
      invalidate one — there is nothing to keep in sync.
    - **Symbols carry TONES, not colours** (decision 13 carried over): each
      part is `shape`/`shadow`/`trunk`/`ink`/`ground` with a shade in -1..+1,
      resolved against the hex's ground fill by `textureTones`. Azgaar's
      `#999999` WITH an opacity is a shadow; without one it is a shaded rock
      face — the generator must not conflate them.
    - **The Illustrated ground is the fill moved toward a per-variant tint**
      (`groundTint`/`groundMix`): HexLore's forest fill is dark enough to hide
      the grid and every tree outline under a texture. Still derived from the
      fill, so an override still shows; memoised per (fill, variant).
    - **Ground is clipped to the hex; OBJECTS ARE NOT** (phase 5, the GM
      found icons cut at the hex edge off-putting). `_paintCells` draws in
      three passes: (1) fills + clipped ground slices, then the outlines;
      (2) every visible hex's objects, unclipped, sorted by screen y ACROSS
      hexes — `cellsInRect` yields column by column and adjacent flat-top
      columns are offset half a row, so column order would draw a peak
      behind the neighbour it pokes into; (3) features with their own
      foreground objects, so a neighbour's canopy never buries a place of
      interest; then badges. Object feet must stand inside the hex
      (manifest insets ≤ 0.9, asserted), and an object raster is sized to
      `objectBounds` — the symbols' generated `extent`, shadows and strokes
      included — under a byte budget. `player.js` mirrors all three passes.
    - **Outline = stroke every solid part at 2× width, then fill over it**:
      only the silhouette line survives, no internal seams, no path union.
    - **Layouts are PROGRESSIVE** (sample elimination): every prefix is evenly
      spread, so LOD draws a prefix — taken before the clearing, so zooming
      never makes a clearing's trees jump. A group with `"lead": true` (the
      volcano cone) goes AHEAD of the interleave: interleaving files a
      one-object group mid-list, where a far-zoom prefix drops it.
    - **A variant added later is `"appended": true` in the manifest** (desert
      Beach is the first). Each layout seeds its rng from a running salt in
      manifest order, so a variant inserted mid-manifest would shift the
      salt of every biome after it and rearrange their textures; appended
      variants take their salts after all the others. Symbol indices still
      renumber (first-use order), which changes nothing drawn.
    - **Every biome is MANY small marks from pools of several shapes**, the
      way forest and mountain always were: a few big identical marks (old
      hills: 3 mounds; lake: 2 of ONE ripple) read as one stamp repeated hex
      after hex. Each procedural family has 3–6 shapes; shapes added after
      the first set draw on a SECOND rng (`seed + 1`), so adding one never
      reshapes an existing symbol. `terrain_texture_test.dart` holds a floor
      (≥12 marks per layout, ≥4 distinct symbols per variant).
    - **The feature position is QUANTISED** to 7 slots; a continuous offset
      would make every featured hex its own cache key.
    - Art: Azgaar's Fantasy Map Generator relief symbols (MIT, vendored in
      `tool/texture_gen/azgaar/` — only the symbols the manifest uses — with
      its LICENSE; credited in About) for trees and peaks, PROCEDURAL symbols
      for what the reference draws simpler than any icon (mottling, grass
      mounds, tick marks, hill mounds, furrows, bushes). One hand per layer:
      the survey of other libraries, and why none was added, is in the plan.
    - **`HexMap` paints in TWO LAYERS** (phase 2): the same `_HexMapPainter`
      class with a `_MapLayer` flag, each in its own `RepaintBoundary`.
      Pointer-driven state (hovered cell, cursor, rubber band, move ghost,
      ruler ends) lives in `_Interaction`, a notifier the painters read LIVE;
      a handler that changes only what the OVERLAY draws calls
      `_ix.changed()`, never `setState` — a rebuild repaints the base layer,
      and with textures that is the expensive one. The base painter keeps
      `shouldRepaint => true` on purpose (a missed repaint is a stale map).
      `hex_map_illustrated_test.dart` asserts a hover sweep leaves
      `debugHexMapBasePaints` unchanged. Features in the Illustrated style
      are objects: light stone body, dark outline, baked shadow.
    - **Objects stand OVER rivers and roads, and the ones ON them are left
      out** (round 2). `paint()` runs `_paintCells` (which returns its
      deferred objects), then rivers, routes, then `_paintObjects`. Each
      textured hex gets `localObstacles` from a per-cell segment index
      (`_obstacleSegments`: river bank half-width, route base width; borders
      clear nothing), quantised to 1/100 R so the cache key is stable; the
      object slices' key carries the obstacle signature, the ground slice's
      does not.
    - **Blend mode** (`blend_edges`, both styles, player per-viewer toggle):
      `_paintBlendStrips` grades across every edge between painted hexes of
      different BASE colour, fanning toward both centres (`blendEdgeDepth`),
      after ALL fills and before anything standing on them; edges go quiet;
      in Illustrated, `blendMask` (edges facing a different TERRAIN GROUP)
      drops or spills band objects by `hashUnit(index, band)`. Nothing
      blends into `groupNone`. Band indices are for the UNMIRRORED layout —
      a mirror maps band k to `(8 - k) % 6`.
    - **Features are 2.5D solids** (`drawFeatureSolid` / `drawGlyphSolid`):
      extruded walls, one outline, lit face, clipped inner bevel, per-feature
      `featureMaterials`. Chosen over vendoring 3D art — no licensable set
      covers every variant in one hand. `TexturePartKind.snow` keeps snowcaps
      a cool white; the mountain Range variant is the snowy one.
    - Every biome variant is textured (phase 1); only `default` has none and
      keeps the Clean look. `terrain_texture_test.dart` fails if a variant is
      added to `terrainVariantNames` without a texture. A part whose colour
      MEANS something (lava, a flower) is `accent` and keeps its source
      colour; everything else is toned from the fill.

23. **Panning is served from TILES; a direct render is batched**
    (`app/map_tiles.dart`, `app/stamp_atlas.dart`, `core/region.dart`'s
    `regionHatchSegments`; measured record and harness in
    `docs/pan-performance.md`). On the GM's 39×28 campaign a pan frame took
    ~46–51 ms of raster time — every frame missed its budget — because the
    base layer was re-rendered in full each frame and ~70% of that was the
    per-hex vector stamps. A 30×30 map fits a 1080p window at FULL LOD, so
    LOD never helped. Five rules now, each measured:
    - **The base layer is image tiles while the camera only translates.**
      `MapTileCache` renders 512-device-px tiles at the current zoom and a
      steady pan draws a dozen images (~1 ms); tiles scrolling in are
      prefetched two per frame. The tiles' KEY is everything the base layer
      depends on — `revision` (bumped by `HexMap` on EVERY controller
      notification), zoom, DPR and every base-affecting prop (`_baseKey`, with
      mutable collections COPIED) — and while it keeps changing (a pinch, a
      brush stroke) `paint` declines and the frame is rendered directly. A
      new base-layer prop MUST join `_baseKey`, or tiles will show stale
      content until the next edit: that is the one way this can go wrong.
    - **Both layers draw at the camera offset SNAPPED to device pixels**
      (`snapOffset`), so a tile maps 1:1 onto screen pixels and a tiled frame
      is pixel-identical to a direct one (`hex_map_render_parity_test.dart`).
      The DPR comes from the widget's own view (`MediaQuery`), never
      `PlatformDispatcher.implicitView`: the global one is 3.0 under `flutter
      test`, and a mismatch put tiles on fractional pixels, where the image
      edges anti-aliased into visible seams.
    - **Clean stamps are drawn from a raster ATLAS of white masks**: every
      stamp rendered once per ⅛-octave scale bucket as a halo mask and an ink
      mask, and a frame's stamps are two `drawRawAtlas` calls with per-sprite
      colours (`BlendMode.modulate`). Masks, not coloured sprites, because a
      stamp's halo is its cell's JITTERED fill — coloured sprites would be one
      per cell. Measured 37.2 → 7.9 ms for a whole direct render. Above
      `stampAtlasMaxSpritePx` (few hexes on screen) the vector path is used.
    - **A region's hatch and the GM-fog hatch are PRE-CLIPPED paths**
      (`regionHatchSegments`, cached with the region's shape): no `clipPath`
      per region or per fogged hex, no line per hatch stroke. Pixel-identical
      to the clipped version bar the line ends. GM fog hatches every UNNAMED
      hex (`computeState`), which on the GM's map is all of them: 84 ms before.
    - **What follows the pointer is overlay-only.** The selected river's and
      route's handles moved to the overlay layer, so hover never repaints the
      base layer (it did on every move whenever a river was selected: 47 ms).
    **Fills are deliberately NOT batched.** One `drawVertices` call for all
    fills was built and measured: 2.4 ms saved on a direct render, nothing on
    a pan, but triangles are not anti-aliased — the grid window's edge turned
    jagged and the faint seams between separately anti-aliased hexes, which
    the grid's look was tuned with, disappeared. Revisit only with a way to
    keep both.

23b. **Zooming stretches what is held; a settled zoom is ONE snapshot**
    (`MapTileCache` in `app/map_tiles.dart`, `_BaseTick` in `hex_map.dart`,
    `stickyTextureBucket` / `beginTextureFrame` in `texture_paint.dart`;
    measured record in `docs/pan-performance.md`, "Zooming and editing").
    The design was measured four times on the GM's machine (1080p,
    maximised; the GM zooms ONE NOTCH at a time, ~450 ms apart), and each
    version's failure is why the next exists:
    1. every zoom frame rendered directly: ~18 fps Clean, ~8 Illustrated;
    2. stretched tiles while zooming, all ~20 visible tiles rebuilt when it
       settled (220 ms): every notch settled, 110–265 ms per notch — 20 tiles
       of 512² are ~2.5x the screen's area, dearer than one direct render;
    3. those tiles refined a few per frame: frames cheap on the UI thread,
       but the tiles' GPU work landed BETWEEN frames — 30–107 ms frame spans
       for ~0.3 s per notch, tiles visibly popping in. (The harness missed
       it: build/raster times do not include work between frames. It now
       records each frame's TOTAL SPAN for the slow-wheel cases.)
    4. now:
    - **A settled zoom (or any view the held images cannot serve) is ONE
      screen-sized snapshot**: 1x the screen's area, one frame, swapped in
      whole. The tile grid for that zoom is then built in the BACKGROUND, one
      tile per frame (`backgroundPerFrame`) while the map is idle; a tile is
      pixel-identical to the snapshot under it, so nothing visibly changes,
      and the snapshot is dropped once the grid covers the view. A pan's
      scroll-in renders up to `scrollInPerFrame` tiles before it would rather
      take a new snapshot.
    - **A zoom-gesture frame never renders** (`paintPreview`): the snapshot
      and the last `keptSets` (3) zooms' tile sets, stretched and LAYERED,
      least-stretched on top; nothing past `previewMaxStretch` (4x).
      Underneath them all, an OVERVIEW: the grid window rendered once, small
      (`overviewMaxPx`, and capped below full LOD by the painter's
      `overviewMaxScale` — at full LOD in Illustrated it was a 400 ms frame),
      as the FIRST background job — and by the preview itself if a zoom
      starts before it exists. Queued behind the grid it was rarely there in
      time, and a big zoom-out showed no map (the GM's report, twice).
    - **Background work is split by cost.** Visible tiles the snapshot fully
      covers are COPIED out of it (one image draw, pixel-identical,
      `copyPerFrame`); full renders (edge tiles, the ring, soft tiles) wait
      until the zoom has been quiet for 1 s (`slowBackground`,
      `_BaseTick.zoomQuietNow`, `waitingForQuiet` → `bumpWhenQuiet`).
      Profiled at 1080p, background renders running between the GM's notches
      were most of the UI time of an Illustrated zoom.
    - **The preview resamples with cubic filtering** (`FilterQuality.high`):
      crisper than bilinear when magnifying, at the cost of a few image
      draws.
    - **Tiles are 256 px** (were 512): one 512 px Illustrated tile was
      20–74 ms of GPU at 1080p, so even one background tile per frame made
      runs of 30–110 ms frames after every settle.
    - **The settle is a REFRACTORY period, per style** (`_BaseTick`),
      detected by the painter from the scale changing between frames (wheel,
      pinch, slider and camera animation alike). A settle is one full render:
      ~30–60 ms in Clean, 100–450 ms in Illustrated at 1080p. So Clean
      settles after 400 ms (200 ms once zoomed in past 1.25x of the last
      sharp render) — the GM found the blur "a bit too noticeable" — and
      Illustrated after 600 ms (300 ms past 1.4x), sized to the GM's ~450 ms
      notch rhythm so a run of notches settles once. At 220 ms every notch
      paid a full render. Zooming out never shortens it.
    - **Coming back to a zoom reuses its set**: wheel notches are exact
      factors, so in → out → in lands on a held scale (`sameScale`) and
      renders nothing.
    - **Illustrated textures**: the resolution bucket has HYSTERESIS
      (`stickyTextureBucket`: kept until 1.3x upscale / 2.6x downscale), and a
      frame may make only `textureRastersPerFrame` (8) new rasters
      (`beginTextureFrame`, called by the base painter) — past that a key is
      drawn from its image at another bucket. A render that did so reports
      itself SOFT (the `TileRenderer` returns a bool, from the
      `textureFallbacks` counter) and the cache redoes soft tiles in the
      background. Crossing a bucket used to re-rasterise every texture on
      screen in one frame: 542 images, a 1.5 s frame. The fallback also
      tries the same key at the OTHER object LODs (`_fallbackFor`), and the
      LOD itself has hysteresis (`stickyTextureLod`, 15% past a threshold;
      `textureLodFor`, consulted only at full LOD so the overview cannot
      move it): a GM-sized map's fit-to-view sits at ~20.5 px per hex, just
      under the 22 px LOD threshold, and crossing it re-keyed every object
      slice on screen — ~650 ms of GPU in one settle.
    - **The zoom is NOT in the tiles' key**; it selects a set. A changed key
      (content) still throws everything away and declines to a direct render.
    - **After an edit the tiles come back on their own**: `_onContentChanged`
      restarts a 250 ms idle timer that asks for a base frame. Without it the
      map stayed a DIRECT picture until the next pan, and every frame that
      re-composited the window (a caret blink, a keystroke) re-rasterised the
      whole map: 60–110 ms per frame in Illustrated, measured while typing.
    - **An autosave that changed nothing drawn keeps the tiles.**
      `AppController.notifyingSaveOnly` is true while `_flushRest` notifies
      about a save with no UNANNOUNCED map-visible change: `markHexDirty` and
      the thread/river/region/route/meta marks set `_unannounced` (the
      document panel edits terrain, icons, tags and names that way and has
      always relied on the save's notification to reach the map), `_changed`
      clears it. Hex DESCRIPTION typing uses `markHexTextDirty` unless the
      text flips between empty and non-empty — the only step that can change
      `computeState`.
    - **Illustrated textures are PRE-WARMED while idle** (`_TextureWarmer` in
      `hex_map.dart`, `warmTextures` in `texture_paint.dart`, run as the
      cache's slow background job, alternating with tiles). Measured: a
      settle's 250 ms was textures being MADE for a LOD/area seen for the
      first time — with them warm the same settle cost ~55 ms, and a
      snapshot rendered every frame (`MapTileCache.debugSnapshotEveryFrame`)
      showed offscreen rendering is NOT slower than on-screen. The warmer
      renders 256 px chunks of the area around the view into a discarded
      picture, at a FORCED LOD (`warmTextures` leaves the sticky LOD alone):
      the current LOD around the view, the LOD below over that area, the
      LOD above over the view — what a pan, a zoom out and a zoom in need
      next. It re-plans when zoom, LOD, content or coarse position change.
      FIRST in its queue: the whole grid at the OVERVIEW's zoom, at LOD 0
      and the overview's own raster bucket (forced through `warmTextures`'
      `bucket:` so neither the view's sticky LOD nor its bucket moves). Once
      those are made (`overviewWarm`), the painter lifts the overview's
      medium-LOD cap and the cache renders it again with textures
      (`overviewRender` = `_renderOverview`, same forcing): a plain overview
      showed a zoomed-out map with its mountains gone (the GM's report).
    - Snapshot, tile and overview renders are named timeline events
      (`MapTiles snapshot` / `tile` / `overview`) in a DevTools recording,
      and `MapTileCache.debugMaxRecordMs` keeps each kind's slowest UI time
      for the harness.
    **What is left**: a settle in Illustrated + blend is ~55–85 ms of frame
    span at 720p with warm textures (UI recording ~30–45 ms of it), and the
    first zoom after opening or after an edit meets cold textures.

32. **The image exporter renders the BASE layer offscreen, in tiles; a
    Players image is drawn from the player payload** (`app/image_export.dart`,
    `core/export_layout.dart`).
    - `paintMapForExport` (hex_map.dart) runs the base painter's own
      `_paintScene` with a fixed camera: no tile cache, no overlay layer (no
      selection, handles, hover, ruler, drafts), votes empty, the painter's
      scale bar off, and `beginTextureFrame(1 << 30)` so no Illustrated
      texture is drawn from a softer raster.
    - Output is cut into tiles of at most 2048 px (`exportTiles`) and
      stitched with the `image` package, so no export meets a GPU texture
      limit. Below 28 px per hex the map's full-detail LOD drops labels and
      stamps, so that is the floor.
    - **Players**: the campaign is `playersCampaign(...)` (decision 4), every
      GM overlay off and the GM badges (`gmBadges`: thread dot, reveal eye,
      hidden-feature ring) off. **GM**: the live campaign with the Display &
      overlays switches as they are on screen.
    - Every image carries the scale bar and the credits (`exportCredits`:
      game-icons authors CC BY 3.0 always, Azgaar MIT when Illustrated). PNG:
      a strip under the map. PDF (`pdf` package, Apache-2.0): pages from
      `printPages` — paper, orientation, a hex width in mm or N pages wide, an
      assembly overlap — each with its label (`B2`) and the credits in the
      footer, the scale bar on the map; the PDF's built-in font has no em
      dash, so its text avoids one.

33. **An edit redraws only what its DAMAGE reaches; lines are cut to the
    painted rect** (`core/map_damage.dart`, `AppController.lastMapChange`,
    `MapTileCache.invalidate` / patches, `HexMap._onContentChanged`;
    the Obsidian plugin does the same, see its CLAUDE.md).
    - Before: every campaign notification bumped the tiles' revision, so a
      brush stroke rendered the whole view directly on every frame. The
      plugin's benchmark (100x100, 1080p) measured that path first; doing
      this there took its Illustrated brush stroke from 30% dropped frames
      to 1%.
    - **The controller says which hexes changed**, for the hot paths only:
      `applyTerrainBatch`, `applyFeatureBatch`, `setRevealed`,
      `setRevealedBatch` record cells (and which were or became water).
      Every other map mark (`markHexDirty`, rivers, routes, regions, threads,
      meta, the sketch) and any notification that recorded nothing makes
      `lastMapChange` null: redraw everything, as before. A new hot edit
      that wants the fast path records its cells; anything else need do
      nothing to stay correct.
    - **Damage** (`cellsDamage`): a hex's box reaches its neighbours (shared
      edges, coast haloes, blend strips and masks) and what they draw
      (`damageHexReach` = 2R: objects, labels and badges overhang); a water
      hex also reaches every river passing near (the course is cut at the
      shore, the mouth takes the water's fill). `test/map_damage_test.dart`
      renders before and after each kind of edit, in Clean, Illustrated and
      Illustrated + blend, at fit and zoomed in, and fails if ANY changed
      pixel lies outside the damage (a 0.6R reach fails it).
    - **Tiles**: `invalidate` drops the tiles the damage touches in every
      held set; the current set marks them DIRTY (and those under the
      snapshot, which is stale there). Until a dirty tile is rendered again,
      `paint` draws its area DIRECTLY, clipped (a patch; neighbours as one
      block, `_blocks`): no image per frame, nothing else redrawn, and
      pixel-identical to a direct render (same snapped camera). While edits
      keep coming (`HexMap._editing`, until 250 ms after the last) nothing is
      rendered in the background; then the dirty tiles go first. A fresh
      snapshot clears the dirty tiles it covers. The overview is redone when
      idle. The document panel skips its rebuild for a change that touches
      no hex it shows.
    - **Lines cut to the rect** (`_smoothCourse`, `_polylineCourse`): a tile
      or patch strokes only the runs of 8 segments of a solid, round-capped
      river or road that can reach it (one draw, so the union is the whole
      stroke: a round-capped stroke is the course swept by a disk). Dashed
      strokes stay whole (a cut would restart the dashes). The land clip's
      water cells, the mouths and the road marks are culled to the rect too,
      and each river's sampled course and shore split is cached per campaign
      change (`_riverGeometry`) instead of redone per tile.
      `test/hex_map_lines_cut_test.dart` compares cut and whole renders
      (`debugHexMapWholeLines`).
    - **Blend strips are made once** (`_blendStrips`): a strip's path and
      gradient depend only on its edge and the two fills, so they are kept
      (bounded) instead of rebuilt per strip, per paint, per tile.
