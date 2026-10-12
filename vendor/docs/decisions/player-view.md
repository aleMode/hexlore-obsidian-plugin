# Decisions — Player view, fog, line of sight, votes

Decision records moved verbatim from the root `CLAUDE.md`, whose index
lists every decision number and where it lives. Numbers are stable;
"decision N" anywhere in the notes resolves through that index.

Decisions: 4, 4b, 4c, 5, 5b, 17.

4. **`player_filter.filterCampaignForPlayer` is the ONLY path to players, and
   the player view is MAP-ONLY.** The payload is exactly
   `{campaign_name, hexes, rivers, routes, grid}`: revealed hexes expose only
   map data (name/terrain+variant/feature+variant/color), never page text,
   tags or GM notes. Tags were served until 2026-10 although no player canvas drew
   them, and a tag gave a hidden feature away; the payload is now pinned by an
   ALLOW-LIST test in both apps (`filter_test.dart`, `player_filter_keys.test.ts`).
   `grid` is EXTENT, not content (min_q/cols/rows/r_shift) — the
   player canvas draws the unexplored lattice so a travel vote can point at a
   cell nobody has been to (see decision 17); every hex inside it stays
   unserved until revealed.
   - **What this build does not understand FAILS CLOSED** (decision 31,
     `core/json_extra.dart`). Unknown keys are kept on every model and
     written back, but the payload is built from explicit keys, so none is
     ever served; a hex whose feature is unknown is served like a
     `featureHidden` one (biome only, no name), and a route of an unknown
     kind is not served. A newer app's rule about what players may see
     would therefore be IGNORED here, not obeyed — so any change to what
     players see bumps the campaign `format` (decision 31), and this build
     opens such a campaign read-only and its server answers 503.
   - **A Players IMAGE is drawn from the same payload** (decision 32):
     `playersCampaign` rebuilds a campaign from `filterCampaignForPlayer`'s
     output, and the exporter renders that, never the GM model — what the
     filter did not serve cannot be drawn by mistake.

4b. **A served hex must lie INSIDE the served grid window**, and the two halves
   of that guarantee live in different layers. `player.js` frames its opening
   view on `hexes` but draws the lattice and validates a vote against `grid`,
   so an out-of-window hex is an island nobody can point at that also drags
   the initial view off the map — and it is invisible to the GM, whose canvas
   has no such cell. Two things produce one:
   - **`resizeGrid` used to leave the fog id behind.** It removes hexes outside
     the new window (the UI confirms and lists them first, so the removal is
     intended) but never rewrote `revealed.json` — and since decision 2b made
     that file SELF-SUFFICIENT, `loadCampaign` materialises a hex for every id
     in it, resurrecting the cell on the player side ONLY. It now calls
     `_writeRevealedFromFlags` when it drops a revealed hex, like the remap
     paths always did. Fog-only cells are the common case here: the brush
     CREATES what it reveals, so such a hex has no JSON file at all and the id
     is its entire existence.
   - **`revealed.json` UNIONS across machines on sync** (decision 20), so a
     co-GM with a larger window contributes ids this one does not cover, with
     nothing broken anywhere. `filterCampaignForPlayer` therefore CLAMPS at the
     boundary — it reads, it does not repair: the campaign folder is untouched
     and the hex is served again if the window ever grows back over it. The
     clamp also bounds rivers and routes for free, since anchor visibility is
     computed from the same `visibleHexIds`.
   `player_sync_test.dart` covers the GM→disk→payload seam end to end (the
   unit tests either side of it never exercised it); `filter_test.dart` pins
   the clamp itself.

   `terrain_variant` is served because the player canvas draws the
   same biome stamps the GM canvas does — the two views are at PARITY for
   fills, stamps and labels, and deliberately differ only in GM-only overlays
   (fog hatch, regions, threads, underlay, badges) and LOD (the player has
   none). Rivers and
   **player-visible routes** are served as runs of consecutive revealed
   anchors, both as `[kind, q, r, k]` since rivers gained the wider anchor set
   (decision 8b) — an anchor is revealed if any touching hex is;
   borders default `playerVisible=false`. **NPCs, quests, threads, regions,
   adventures and pages are GM material and are never served** (re-add behind
   reveal/secret gating — see git history — only if a player UI for them ever
   exists). The map API route is `/api/map` (votes add two more — decision 17).
   The emitted JSON shape must
   stay identical to what `assets/player/player.js` expects — `player.js`
   mirrors `core/geometry.dart` (`axialToPixel`/`vertexPixel`/`nodePixel`);
   keep them in sync. The server (`player_server.dart`) re-reads files behind
   a folder-signature cache whose glob list must cover every file feeding the
   payload (campaign.json, hexes/, rivers, routes, revealed.json); loads run
   in an `Isolate.run` so player polls never jank the GM canvas.

4c. **A hex's feature can be HIDDEN from players, per hex**
   (`HexData.featureHidden`, `feature_hidden` in hex JSON, omitted when false).
   A revealed hex whose flag is set is served with its BIOME only —
   `feature`/`feature_variant`/`name` go out as null/0/null (a name like
   "Dragon's Lair" gives the feature away as surely as the icon; the player
   view falls back to the display id) — until the GM clears it (hex
   context menu "Hide/Reveal feature…", which covers the whole selection and
   takes its sense from `allFeaturesHidden`; hex panel checkbox;
   `setFeatureHiddenBatch`). `player.js` needed no change: a null feature
   already draws the biome stamp. There is no campaign-wide switch.
   - **The flag lives in hex JSON, not revealed.json.** Fog needs revealed.json
     because a fog-only hex has no file; a hex with a feature always has one,
     so remap/resize/sync-merge/undo-copy all work with no extra rewrite
     paths. Cost: it rides the 500 ms debounce.
   - **Replacing a feature KEEPS the flag** (the GM hid what stands on this
     hex; re-stamping must not publish it); erasing the feature clears it
     (the setter on `HexData.feature`, so every paint path gets it).
   - The fog brush / "Reveal + line of sight" never touch it, and hiding a
     feature never reveals the hex.
   - The GM canvas draws a slashed ring on hexes whose feature is hidden.
     Known leaks it does not close: a TAG that says "#dungeon", and a
     legacy-migrated `colorOverride` that kept an old
     city/dungeon fill.
   - Format stays 1: an older app that pulls such a campaign drops the key on
     its next push (the "readers preserving unknown keys" gap) and would
     un-hide the feature.

5. **Two-layer fog:** *GM fog* is a runtime hatch on unwritten hexes (never
   persisted); *player fog* is `HexData.fogRevealed` + `player/revealed.json`
   (the server authority; excluded from per-hex JSON). Every bulk reveal path
   goes through `setRevealedBatch` (one revealed.json write, one notify), and
   the hex context menu's reveal covers the WHOLE selection: its sense comes
   from `AppController.allRevealed(selection)`, not from the clicked hex, so a
   partly-revealed selection still offers to reveal.

5b. **Line-of-sight reveal** (`core/line_of_sight.dart`, pure — the terrain
   lookup is injected, so the rule is testable without a campaign). The hex
   context menu's *"Reveal + line of sight"* reveals a hex AND what it can
   see; the plain "Reveal" is untouched, so this is always an explicit choice.
   Two independent rules, both required:
   - **Range**: sight drops one height unit per hex, so a target is in range
     when `height(target) + distance <= height(origin)`. From a mountain (2):
     two hexes of plains, one of hills, none over another mountain.
   - **Occlusion**: the sightline is the ray from the observer's height to the
     TARGET's height — per target, not one global slope, which is what makes a
     shadow a WEDGE rather than a half-line (an obstacle can hide the ground
     just behind it while flatter ground further out stays visible). Grazing
     counts as blocked, and the comparison is done in integers (both sides
     multiplied by the distance) so a tie is a tie rather than a floating-point
     coin flip.
   `terrainHeight` is the tuning knob (volcano 3, mountain 2, hills 1,
   forest/jungle/swamp 1, everything else 0 — forest, jungle and swamp are 1
   because what grows on them stops a sightline as well as a hill does, not
   because the ground is raised; swamp earns it through both its variants,
   reeds and standing dead trees). Height is per BIOME, **not per stamp
   variant**: a caldera is a collapsed cone, dunes are raised and a dead wood
   has no canopy, but modelling those would trade one memorable rule for a
   list of exceptions a GM has to recall mid-session.
   Three deliberate limits: sight does **not** chain (a revealed hex does not
   go on to reveal its own surroundings — on connected lowland that would
   flood a continent from one click); `minRadius` 1 always reveals the six
   neighbours, or flat ground would show nothing at all; and the result is
   **clamped to the grid window** in `AppController.sightFrom`, because
   `setRevealedBatch` CREATES the hexes it reveals and an unclamped sightline
   off the edge would litter the campaign with off-map hexes. A tall hex that
   blocks is not itself revealed unless it is in range or in the neighbour
   ring — distant peaks stay hidden, which is unrealistic but deliberate:
   where the rule is ambiguous, fog reveals less.

17. **Travel votes are SESSION state, not campaign data.** Players each hold
    ONE standing vote for where the party goes next; the tally
    (`core/travel_votes.dart`, pure Dart) lives in the running `PlayerServer`
    and `stop()` empties it. **Nothing about votes touches disk** — no
    campaign file, no `player_filter` change — which is what keeps the
    "server never writes into the campaign folder" invariant true even though
    a vote is the one thing a player may WRITE.
    - Two routes beyond `/api/map`: `POST /api/vote`
      (`{voter, name, q, r}`; omit q/r to withdraw) and
      `GET /api/votes?voter=<id>`. Voter ids are opaque, client-generated
      (localStorage) and **never emitted** — the payload carries display names
      and counts, plus `your_hex` for the asking voter only.
    - **The grid window, not the revealed set, bounds a legal vote**
      (`cellInGrid`): pointing at unexplored ground is most of the point. That
      is why the payload carries `grid` and why `player.js` now mirrors
      `pixelToAxial`/`axialRound`/`colRStart`/`cellsInRect` — hit-testing can no
      longer just scan the served hexes. `dartRound` in the JS exists because
      Dart's `.round()` breaks ties away from zero and `Math.round` doesn't.
    - The server holds `VoteTally` + an `onVotesChanged` callback (a plain
      closure, not a Listenable — `server/` stays Flutter-free); `MainShell`
      turns it into a `setState` + a status line naming who voted for what, and
      passes `voteCounts` to `HexMap`, which paints a numbered pill at EVERY
      LOD (a vote is a handful of cells and "where is the party pointing?" is
      exactly the question a culled badge fails to answer).
    - Caps are deliberate (`maxVoters`, `maxVoterNameLength`, `_maxVoteBody`):
      the endpoint is reachable by anyone on the GM's LAN. A full tally still
      lets its KNOWN voters change their minds, or the ballot box would freeze.
