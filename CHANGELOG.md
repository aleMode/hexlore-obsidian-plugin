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

### Fixed
- Paint palette: the preview hexes were pinned to the corner of the strip and
  of the palette, one on top of the other: the strip's swatch hid the Select
  tool and the palette's tiles showed no preview. Each now sits in its place,
  and the swatch is a larger hex that fills the strip.
