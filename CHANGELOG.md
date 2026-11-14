# Changelog

Changes a user of the plugin would notice. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/) (`vendor/WORKFLOW.md` §6). New
entries go under *Unreleased*; a release moves them under its version.

## [Unreleased]

### Added
- The map view for `.hexmap.md` notes: tools 1–8, Clean and Illustrated
  styles, undo, cut / copy / paste, map scale, resize, explode.
- Hexes ↔ notes: principal note, sections, NPC / quest / place notes,
  templates, "Show this note on the map".
- The player view with travel votes (desktop).
- Sketch view with hexify, trace image and swatch editor.
- Map-image importer.
- Export image (PNG / PDF) and Export as a campaign folder (for the HexLore
  app).
- Command "Create a new map…".
- A new map gets a folder of its own, with a numbered folder for each
  section (Places, Regions, NPCs, Factions, Quests, Adventures, GM notes,
  Miscellanea), so two maps in one vault keep their notes apart. Setting
  "A folder for each new map" turns it off.
- Top bar mirroring the HexLore app's title bar; two-finger pinch and pan.
- "Show maps together…": maps at different scales (say 50, 5 and 1 mile
  hexes) laid over one another at their real sizes, each fading in as you
  zoom to its level. GM only and read-only; drag and resize maps into place
  when unlocked.
- Encounters: **Check** rolls the region's encounter chance
  (`encounter-chance: 2` in its note's properties = 2 in 6) and the table on
  a hit; tables are rolled on the die in their header (2d6, d100, d66…),
  sub-headings (Day / Night) are tables to pick from, dice inside a result
  ("1d4+1 goblins", `dice: 2d6`) are rolled, and indented bullets show as
  detail. The rolls of the session stay listed in the map panel: copy one,
  add it to the session note (the newest note in GM notes), roll it again.
  **Roll encounter** in a hex's right-click menu rolls for its region.
- Fog of war can be undone: a fog-brush drag, reveal / hide, reveal + line of
  sight, reveal all and hide all are each one undo step.
- **Travel here** on a travel vote in the map panel: after you confirm, it
  reveals the hex (alone, or with what is in sight: the dialog remembers
  your last choice), clears the votes and adds the trip to the session note.
- The "player view started" dialog shows a QR code of the link when serving
  on the local network, and the status bar counts the devices connected.
- Quick jump (Ctrl+K) takes coordinates: `F3`, or `q5 r-2`.
- The top bar, the tool strip, the palette, Display & overlays and the panel's
  icon buttons can be reached with Tab and pressed with Enter or Space.

### Changed
- Renderer: tiles, atlas, redraws limited to what an edit touched
  (`docs/performance.md`).
- Paint palette: Biomes, Icons and Erase are tabs, one category at a time,
  and the variants of the picked biome or icon sit under the grid of its own
  tab, so the palette no longer reflows when you pick; it opens on the tab of what is
  picked.
- Everything is reachable from a menu: a **HexLore** ribbon icon (new map,
  open map, show maps together, map panel, sections), right-click a map file
  (open as map / Markdown, player view, export as a campaign folder, maps
  together) or a note on a hex ("Show on the map"), and a **Sidebars** group
  in the Map menu. Of the commands only "Create a new map…", "Show this note
  on the map" and "Open this note as a map" remain, for hotkeys; the others
  moved into the menus.
- Opening a `.hexmap.md` file opens its map from anywhere: the file
  explorer, a link, the quick switcher, a restored workspace (it sometimes
  stayed Markdown before).
- Notes open from the map in a **floating window** over it, ready to edit
  (double-click a hex, click a note in the map panel, create a note for a
  hex); click outside to close it. Setting "Open notes from the map" brings
  back the pane beside the map. Ctrl/Cmd-click a note in the map panel still
  opens a new tab.
- Double-clicking a hex with no note offers to create its first note.
- Clicking a hex shows the map panel if it is closed or behind another tab
  (setting "Show the map panel when a hex is clicked").

- Reveal all / Hide all ask first, and say when connected players will see
  it.
- While the player view runs, clicking the players button opens its menu
  (copy the link, stop) instead of stopping at once and dropping the votes.

- Undo and redo are in the top bar only; the tool strip's and the Sketch
  strip's own pair are gone (the top bar's undoes the sketch in the Sketch
  view).
- Shortcuts in tooltips and messages say Cmd on macOS.
- The session notes menu lists the newest 10, then "All N in Sections".
- Quick jump lists the characters and quests of this map's sections only, not
  of the whole vault.
- On a phone or tablet the player view's entries are gone (it needs a
  computer); the players menu keeps Reveal all / Hide all.
- A hex's text is called its **name** everywhere (it was also "label").

### Fixed
- Undoing a delete after one of the hex's notes was renamed brought back a
  broken link; it now links the note under its new name.
- A note link that could not be saved in the map file was shown anyway,
  silently; it is now reported and the map shows what the file has.
- Starting the player view twice in quick succession could leave a second
  server running until Obsidian quit.
- A sync or git pull landing on a map file while an edit to it waited to be
  saved could be overwritten; the pulled version is now kept (and the
  unsaved edit to that file reported, as when the sync comes first).
- The player server answers only requests addressed to this computer (no
  web page can read the map or vote through it), and one device can hold at
  most 8 voters, so it cannot fill the tally.
- Turning HexLore off no longer removes another plugin's changes to how
  files open (when that plugin was turned on after HexLore).
- Encounter tables were rolled on the width of each range: a 2d6 table gave
  its 2 and 12 three times their odds, `96-00` on a d100 counted as one,
  `- 3 xorn` lost its "x", a day/night table read as nothing, and a nested
  bullet became an encounter.
- Renaming or moving a map's folder, a section folder or a section's
  template left the sections pointing at the old place (empty lists, and new
  notes recreated the old folder). They now follow.
- The Players image export refuses a map saved by a newer HexLore, as the
  player view already did, so a secret it might not know about cannot leak.
- Paint palette: the preview hexes were pinned to the corner of the strip and
  of the palette, one on top of the other: the strip's swatch hid the Select
  tool and the palette's tiles showed no preview. Each now sits in its place,
  and the swatch is a larger hex that fills the strip.
