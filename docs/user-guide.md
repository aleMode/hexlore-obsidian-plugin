# HexLore for Obsidian: user guide

HexLore turns a note in your vault into a hex-crawl map. You paint the map,
link your existing notes to its hexes, and show your players a live map that
reveals only what they have found. Obsidian keeps the notes; HexLore keeps
the map.

## Install

The plugin is not in the community directory yet. Install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from a release (or
   build them, see the README).
2. Copy them into `<your vault>/.obsidian/plugins/hexlore/`.
3. In Obsidian: **Settings → Community plugins**, turn community plugins on,
   then enable **HexLore**.

The **BRAT** plugin can install and update it from its repository instead.

## Your first map

Click the **HexLore** icon in the left ribbon and choose **New map…** (or, in
a map, **Map menu → New map…**), and give it a name, a folder and a size. The map gets a folder of its own:

```
Name/
  Name.hexmap.md
  Name.hexlore/
  10 Places/   20 Regions/   30 NPCs/     40 Factions/
  50 Quests/   60 Adventures/  70 GM notes/  90 Miscellanea/
```

- `Name.hexmap.md` is the map's **index note**. Opening it opens the map.
  It holds only links, so Obsidian keeps them current when notes are renamed
  or moved.
- `Name.hexlore/` is a folder with the map data (JSON files). Leave it next
  to the index. Renaming or moving either one keeps them connected.
- The numbered folders are the map's **sections** (below): notes you create
  from the map land there, so two maps in one vault never mix their notes.
  The numbers only keep them in this order; rename or move them as you like
  in the Sections list.

To make maps the old way (the index and its data folder straight into the
folder you choose, sharing the default sections at the vault root), turn off
**A folder for each new map** in the plugin's settings. Maps that already
exist are never changed.

Everything is saved as you work. Opening the map's `.hexmap.md` file, from
the file explorer, a link or the quick switcher, shows the map. To read the
index as plain text, use the tab's **Open as Markdown** menu entry (or
right-click the file); **Open as map** in the same menu goes back.

A campaign made in the HexLore desktop app moves over with that app's
**Export to Obsidian vault…**.

## The screen

- **Top bar, left:** fullscreen, the **map menu** (new, open, map settings,
  import, export), quick jump (Ctrl+K), Adventures and Session notes.
- **Top bar, centre:** **Hex** (the map) and **Sketch** (free drawing).
- **Top bar, right:** undo / redo, reset view (Ctrl+0), **Display &
  overlays**, the **players** button, and the map panel.
- **Left of the map:** the tool strip and the paint palette.
- **Right sidebar, Map panel:** the selected hex (its label, notes, who is
  there), regions, sketch swatches, travel votes.
- **Left sidebar, Sections:** the folders of notes this campaign uses.

Move around with a **middle-drag**, **Space + drag** or a two-finger
trackpad scroll. Zoom with the **wheel** or a pinch.

## Map tools

| Key | Tool | How it works |
|---|---|---|
| 1 | **Select** | Click a hex; Ctrl+click adds or removes; drag a box for many. Drag a selection to move it. Right-click for the hex menu. |
| 2 | **Paint** | Pick a biome or a feature icon from the palette (tabs: **Biomes**, **Icons**, **Erase**; the variants of what is picked sit under the grid of its own tab) and paint, with a brush radius. |
| 3 | **River** | Click hex corners in order. **Enter** saves, **Backspace** removes the last point. |
| 4 | **Thread** | Click a hex, then another: a plot thread only you can see. |
| 5 | **Region** | Drag to paint hexes into the active region; Ctrl+drag removes. |
| 6 | **Route** | Roads, trails and borders. Enter saves. Borders stay hidden from players. |
| 7 | **Fog** | Drag to reveal hexes to players; Ctrl+drag hides them. Ctrl+Z undoes a drag. |
| 8 | **Ruler** | Measure a distance (set the scale in **Map scale…**). |

Select a river or road to edit it point by point; a river's width is in its
right-click menu. **Undo** (Ctrl+Z) and **redo** (Ctrl+Shift+Z) cover map
edits, fog of war included; two views of the same map share one history.

The hex menu (right-click) has rename, cut / copy / paste, reveal or hide
for players, **reveal + line of sight**, hide the feature and name from
players, draw a thread, and delete. **Map menu → Map** has **Map scale…**,
**Resize grid…** and **Explode map…**.

## Hexes and notes

Each hex has a **label** (the name players see), at most one **feature**
icon, and a list of **notes**.

- Select a hex, then in the Map panel: **New note…** (from a template, into
  a section) or **Link a note…**. You can also drag a note from the file
  explorer onto a hex.
- Clicking a hex shows the Map panel if it is closed (setting **Show the map
  panel when a hex is clicked**).
- The **first** note is the hex's **principal note**: Ctrl-hover the hex to
  preview it, double-click the hex to open it. Double-clicking a hex with no
  note offers to create its first one.
- A note opened from the map (a double-click, a click on a note in the Map
  panel, a note just created for a hex) shows in a **floating window** over
  the map, ready to edit; click outside it to close it. The setting **Open
  notes from the map** can open them in a pane beside the map instead. The
  window needs Obsidian's core **Page preview** plugin; without it notes open
  beside the map. Ctrl/Cmd-click a note in the Map panel for a new tab.
- Reorder or unlink notes in the Map panel. Unlinking never deletes a note.
  A note that was deleted shows as a dimmed broken link, with *Relink* and
  *Remove*.
- A note can be linked to several hexes. The label is never taken from a
  note's title, so a note called "Cult base (secret)" never reaches players.
- **Show on the map** (right-click the note, when it is on a hex of an open
  map) centres the map on the hexes of the note; they are highlighted in
  gold. The same is the command **Show this note on the map**, for a hotkey.

### NPCs, quests and places

Give a note `type: npc`, `type: quest` or `type: place` in its frontmatter.
An NPC or quest points to where it is with `location: "[[Place note]]"`
(one link or a list). The Map panel then lists **People and quests here**
for every hex whose notes include that place.

### Sections

A section is a named folder of notes for this campaign. A new map gets
Places, Regions, NPCs, Factions, Quests, Adventures, GM notes and Unsorted
(its folder is "Miscellanea"), each in the map's own folder; a map with no
sections of its own uses Places, Regions, NPCs, GM notes, Adventures and
Unsorted at the vault root. Add your own as you like. Sections are
for browsing and for where new notes land; they never change what a hex
links to. Hover a note in the Sections list to light up its hexes. A
section can name a **template** note.

Templates can use `{{title}}`, `{{hex}}`, `{{map}}`, `{{date}}` and
`{{time}}`. The plugin's settings tab sets the templates folder.

### Regions

Create a region in the Map panel (**New region…**) and paint it with the
Region tool. Link a note to it (or **Create** one): its encounters are
rolled from there, with **Roll** in the Map panel or **Roll encounter** in
the right-click menu of any hex in the region.

The note's `## Encounters` section can be a table or a list:

```
---
encounter-chance: 2 in 6
---
## Encounters
### Day
| 2d6 | Encounter |
|---|---|
| 2 | Dragon |
| 3-6 | 1d4+1 wolves |
| 7-12 | Merchants |
### Night
- 3x Ghouls
- Will-o'-wisp
  - leads travellers into the bog
```

- A table is rolled on the die in its header (`d6`, `2d6`, `d100` or `d%`,
  `d66`); `96-00` and `12+` work as on paper. Further columns are kept.
- A list is rolled with weights (`3x Ghouls`, `3: Ghouls`) or ranges
  (`1-2: Wolves`); an indented bullet is detail of the entry above it.
- Each sub-heading (Day, Night…) is a table of its own: pick it next to
  **Roll**.
- Dice in a result ("1d4+1 wolves", or Dice Roller's `` `dice: 2d6` ``) are
  rolled too.
- **Check** rolls `encounter-chance` (`2` means 2 in 6; `1 in 8` works) and
  the table when it hits.

The session's rolls stay listed under the regions: copy one, add it to the
session note (the newest note in the **GM notes** section), or roll that
table again.

## Display & overlays

Choose the map style (**Clean** or **Illustrated**, optional blended biome
edges), and show or hide threads, regions, borders, GM fog on hexes with no
notes, player badges, the import underlay and the sketch overlay. Display
choices are per device; overlay choices are per map.

## Show maps together

For maps of the same world at different scales (a continent in 50-mile
hexes, a forest in 5-mile hexes, a city's surroundings in 1-mile hexes),
**Show maps together…** (the ribbon icon, **Map menu → Show maps
together…**, or right-click a map file) lays them over one another at their real sizes. It is for you
only: players never see it, and it changes no map.

1. Tick the maps to show; each one is listed with its scale. **Show** opens
   the view.
2. Zoom in and out: each map comes in as you reach its own zoom and fades to
   a faint ghost past it, so the detailed map shows over the coarse one.
   A map too small to draw is still outlined, with its name. Only painted
   hexes are drawn: empty hexes, and hexes with only a name or notes, let
   the map below show through.
3. The view is **Locked**: a drag pans, and a double-click opens the map
   under the pointer. Click **Locked** to start **Arranging**: drag a map to
   move it, or drag a corner to resize it about its centre. **Place** in the
   list puts a map's centre where you click next. **Centre** shows a map at
   its own zoom, and **Open** opens it.
4. A new map is drawn at the size its own scale gives it. If you resize it
   to match a source drawn off scale, the list says so (for example "Shown
   at 1 hex ≈ 4.3 mi (the map says 5 mi)"), and **To scale** puts it back.

Where each map sits is saved with the plugin's settings and synced with the
vault; the zoom is per device. Renaming or moving a map keeps its place.

## The player view (desktop only)

1. Click the **players** button (or right-click the map file → **Start the
   player view**). A window shows the link, by default `http://127.0.0.1:5174`.
2. To let players open it on their phones, turn on **Serve on the local
   network** in the players menu. On Windows, allow Obsidian through the
   firewall on private networks when asked.
3. Reveal hexes with the Fog tool, the hex menu, or **Reveal all / Hide all**
   in the players menu (both ask first). Players see each change within a
   few seconds; Ctrl+Z takes a reveal back.
4. While the view runs, the players button opens its menu: copy the link, or
   stop.

Players see only the revealed map: terrain, icons and labels that are not
hidden, and rivers, roads and trails near what they have explored. Notes
are never served. Players can vote where the party goes next; votes show on
your map and in the Map panel. Obsidian must stay open while players use it.

## Sketch

Click **Sketch** in the top bar to draw over the map at its scale: **P** pen,
**E** eraser, **B** bucket fill, **L** line, **R** rectangle, **O** ellipse,
**T** label, **H** pan, **[** / **]** width. Pen pressure is used, and the
pen's eraser end erases. Colours are swatches with a meaning (edit them in
the Map panel). A **trace image** from the vault can sit under the sketch.
**Hexify** turns what you drew into hex terrain, in one undo step.

## Import a map picture

**Map menu → Import map image…**: pick an image from the vault, click the
centres of two neighbouring hexes, review and fix what was recognised, draw
the rivers, drag the result into place and apply it. One Ctrl+Z undoes it.
The picture can stay as an underlay (Display & overlays).

## Export

- **Export image (PNG / PDF)…**: the **Players** version shows only what
  players can see; the **GM** version shows the map as on screen. The file is
  saved next to the map and opened.
- **Export as a campaign folder…** (desktop only): writes the campaign in
  the HexLore desktop app's format, outside the vault, with your notes as
  its pages, NPCs and quests.

## Keyboard (in the map view)

| Keys | Action |
|---|---|
| 1–8 | Map tools |
| Esc | Back to Select; cancel a drawing; leave fullscreen |
| Enter / Backspace | Save / undo the last point of a river or route |
| Delete | Delete the selection |
| F2 | Rename the selected hex |
| Ctrl+X / C / V | Cut / copy / paste hexes (with their note links) |
| Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y | Undo, redo |
| Ctrl+K | Quick jump |
| Ctrl+0 | Reset the view |
| P E B L R O T H, [ ] | Sketch tools and width (Sketch view) |

## On a phone or tablet

Maps open and can be read, with two-finger pinch and pan. Editing on a phone
is untested. The player view and the campaign-folder export need the
desktop app.
