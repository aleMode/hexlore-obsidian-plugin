# The HexLore converters

How a WHOLE campaign moves between the Flutter app and the Obsidian plugin.
There are two converters, one in each app, each writing the OTHER app's
format:

| Direction | Where | Code |
|---|---|---|
| Flutter → plugin | Flutter, "Export to Obsidian vault…" | `hexlore_flutter/lib/convert/vault_export.dart` (map), `notes_export.dart` (notes) |
| plugin → Flutter | plugin, "Export as a campaign folder…" | the plugin's `src/convert/` |

This file lives in the Flutter repository; the plugin keeps a copy in
`vendor/docs/converter.md` (`npm run vendor`).

Each app reads only its own format. **The map files are shared as they are**
(`docs/format-2.md`); a converter moves the notes world around them.

**This document comes first.** A change to a mapped field (hex, region, NPC,
quest, adventure, entry), to the notes structure of either app, or to the
`.hexmap.md` index grammar:

1. updates this document;
2. bumps the contract version if old exports would be read wrongly;
3. regenerates the fixture pairs (§6);
4. updates BOTH converters before either is released.

## 1. Contract version

**Version 1.** It is written into every export: `hexlore-converter: 1` in the
index frontmatter (Flutter → plugin) and `"converter": 1` in the round-trip
manifest (plugin → Flutter). A converter that finds a NEWER version than it
knows warns before running and never deletes anything.

## 2. Shared rules

- **Names.** A file name is the thing's name with `\ / : * ? " < > | # ^ [ ]`
  and control characters turned into spaces, spaces collapsed, trimmed
  (`Untitled` if nothing is left). A clash in one folder (case-insensitive)
  gets ` 2`, ` 3`… in the vault and `_2`, `_3`… in Flutter (Flutter's own
  rule for pages).
- **Fingerprint** of a text: FNV-1a 32-bit over its UTF-8 bytes, as 8
  lowercase hex digits. Both converters compute it the same way (fixture:
  `fingerprint("HexLore") = "36d3677e"`; see the tests).
- **Hex ids** are canonical axial ids (`q5_r-2`); display ids (`F3`) are
  derived and only appear in names made for people.
- **Nothing GM-only reaches players** either way: notes never feed the player
  filter, which reads map files only.

## 3. The plugin's notes model (what Flutter → plugin produces)

The vault side, as the plugin reads it:

- **The index** `<Name>.hexmap.md` (grammar v1): frontmatter
  `hexlore-plugin: map`, `hexlore-index: 1`, `hexlore-converter: 1`,
  `format`, `data` (the sibling data folder, relative to the index),
  `underlay`, `trace-image`, `sections`. The body has two sections that
  belong to the plugin, with one line grammar:
  - `## Hexes`: `- q5_r-2 :: [[Main note]] · [[Other note]]`. A hex's first
    note is its PRINCIPAL note.
  - `## Regions`: `- region_001 :: [[Region note]]`, the note encounters are
    rolled from.

  Links are plain Markdown lines, never in a code block (Obsidian does not
  track links there). Everything else in the file is left byte for byte, and
  a section line that does not parse is kept verbatim and reported, never
  dropped.
- **Sections**: `sections: [{name, folder, template?}]`, folders as VAULT
  paths. No nesting.
- **Note kinds** (the plugin's `src/notes/note_meta.ts`): `type: npc`,
  `type: quest`, `type: place`; others are plain. NPCs and quests point at
  PLACE NOTES through `location` (one link or a list), never at coordinates.
- **Round-trip keys** in a note's frontmatter (left alone by the plugin):
  `hexlore-id` (the Flutter id: `npc_003`, `quest_001`, `adv_002`) and
  `hexlore-extra` (the Flutter record's unknown keys, as an object).

## 4. Flutter → plugin

The GM picks a destination folder D. If D or a parent holds `.obsidian/`,
that is the vault root R; otherwise R = D. Every path below is under D;
links and section folders are written as R-relative paths.

### 4.1 Files

| Flutter | Vault |
|---|---|
| map files (format 2) | `D/<Name>.hexlore/`, unchanged (1.12a) |
| `import/underlay.png`, `sketch/trace_image.png` | `D/<Name> underlay.png`, `D/<Name> trace.png`, linked from the index |
| hex `page_file` → `pages/hexes/X.md` (exists, not empty) | `Places/X.md`, the hex's note #1 (a page named by its hex id, `q5_r1.md`, becomes `Places/<Campaign> <display id>.md`) |
| page reservations with no file, empty pages | dropped |
| region `page_file` → `pages/regions/X.md` | `Regions/X.md` + `- <region id> :: [[…]]` |
| `pages/prep/*.md` | `GM notes/*.md` |
| `npcs/<id>.json` (+ its page) | `NPCs/<Name>.md` (§4.2) |
| `quests/<id>.json` | `Quests/<Title>.md` (§4.3) |
| `adventures/<id>.md` + manifest row | `Adventures/<Title>.md`, frontmatter `order`, `hexlore-id` |
| entries in the `Unsorted` tab | `Unsorted/<page>.md` |
| entries in the `NPC` tab | merged into the NPC's note (by `npc_id`); one with no NPC → `NPCs/` as a plain note |
| entries in a custom tab T | `<T>/<page>.md`, and T becomes a section |
| `sync/`, `hosts.json` | dropped (this machine's) |

Sections written: Places, Regions, NPCs, GM notes, Adventures, Unsorted (the
defaults), plus Quests when there are quests, plus one per custom tab — each
`{name, folder: "<D>/<name>"}` with D R-relative.

The hex records keep their `page_file` (the plugin does not use it; it rides
along for the way back).

### 4.2 NPC notes

Frontmatter: `type: npc`, `role`, `attitude`, `location` (a link to the
place note of `hex_id`, or `""`), `tags`, `npcs` (links to the NPC notes of
`linked_npc_ids`), `quests` (links to the quest notes of `linked_quest_ids`),
`secret: true` when `is_secret`, `hexlore-id`, `hexlore-extra` when the
record has unknown keys.

Body: the NPC's page in Flutter's own form (`npc_page.dart`) with its
`# Description` and `# Secret` sections — `updatePageFromNpc(page, npc)` on
the page named by `notes_file` (or an empty one) — minus the `# Role` and
`# Attitude` sections, which are in the frontmatter.

### 4.3 Quest notes

Frontmatter: `type: quest`, `status`, `hook`, `objectives`, `reward`,
`location` (links to the place notes of `hex_id` then `linked_hex_ids`),
`npcs` (links), `tags`, `secret: true` when `is_secret`, `unresolved: true`
when set, `hexlore-id`, `hexlore-extra`. An unknown `status` is written as
it is. Body: `gm_notes`.

### 4.4 Location notes

An NPC or quest whose hex has no note, and a `[[link]]` to a hex NAME whose
hex has no note (Q2), get a **location note** so the link has a place to
point at: `Places/<hex name>.md` for a named hex, else
`Places/<Campaign> <display id>.md` (e.g. `Purezza F3`). Body: a title and a
list of links to the NPCs and quests there. It becomes the hex's note #1.

### 4.5 Links in note text

`[[Name]]`, `[[Name|alias]]`, `[[Name#Heading]]` are resolved Flutter's way:
by name, case-insensitive, precedence **hex > region > NPC > quest > entry**
(`Campaign.nameIndex`). A resolved link becomes a path-qualified one, keeping
what the reader saw: `[[<R-relative path>#Heading|alias or Name]]`. A link
that does not resolve is left as it is.

### 4.6 Re-export and collisions

- `D/<Name>.hexlore/` is replaced whole.
- An existing index is MERGED: its frontmatter gets the export's keys (its
  `sections` stay when the GM set them), and in `## Regions` / `## Hexes`
  each id lists the exported links first, then the ones only the vault had.
  Everything else in it (the GM's text) stays.
- A note whose file already exists with DIFFERENT text is a conflict. The
  GM chooses: keep the vault's (default) or replace it. Unchanged files are
  not rewritten.
- **When the campaign carries a round-trip manifest** (`roundtrip.json`, it
  came from the plugin, §5.4), each manifest entry's file goes back to its
  original vault path, and copies collapse (§5.4).

## 5. Plugin → Flutter

The GM picks a folder OUTSIDE the vault (a Flutter campaign must not sit in
a vault, or its `pages/*.md` show up as duplicate notes; a dot-folder works
too, Obsidian ignores those). The map files are copied, then the notes are
placed by **section**; the hex keeps only a link.

### 5.1 Which notes go

Every note linked from the index (hexes, regions), every note in a section
folder, and every NPC or quest note those link through `location`.

### 5.2 Where each note goes

| Note | Flutter |
|---|---|
| Places section, #1 of one hex | `pages/hexes/<name>.md`, that hex's `page_file` |
| Places section, #1 of SEVERAL hexes | copied as the page of each (`<name>.md`, `<name>_2.md`…) |
| linked to a region (`## Regions`) | `pages/regions/<name>.md`, the region's `page_file` |
| Regions section, not linked | `pages/regions/<name>.md` |
| GM notes section | `pages/prep/<name>.md` |
| Adventures section | `adventures/adv_NNN.md` + manifest row (`order` from frontmatter) |
| `type: npc` (any section) | `npcs/<id>.json` + `pages/npc/<name>.md` + an NPC-tab entry; one copy per hex of its places |
| `type: quest` (any section) | `quests/<id>.json` (`hex_id` = first place hex, `linked_hex_ids` = the rest) |
| a custom section S | `pages/<s>/<name>.md` + an entry in tab S |
| linked as #2…N, or in no section, or Places but #1 of no hex | `pages/unsorted/<name>.md` + an Unsorted entry |

- Ids come from `hexlore-id` when the note has one and it is free, else the
  next free (`npc_001`…). `hexlore-extra` is spread back into the record.
- **Section subfolders are flattened** into the section's folder; clashes get
  `_2`.
- **Hexes** list every note after #1 in an extra key, `also_links`: the
  `pages/`-relative paths (Flutter keeps it as an unknown key, shows it
  read-only, 1.13). The paint chunks are re-encoded with these `page_file`
  and `also_links` values; everything else in them is unchanged.
- **NPCs**: `description` and `secret` come from the body's `# Description`
  and `# Secret` sections, `role` and `attitude` from the frontmatter; the
  page is the body with those four sections synced (`updatePageFromNpc`).
- **Links** in note text become `[[<Flutter name>|<what was shown>]]`, the
  Flutter name being the hex's name, region's name, NPC's name, quest's
  title or entry's name that note became. A link to a note that became no
  named thing keeps its note name.

### 5.3 Flutter side

- The hex panel shows `also_links` as a read-only "Also links to" list; each
  entry opens in Flutter's page editor.
- Flutter keeps `also_links` and `roundtrip.json` as they are when it saves.

### 5.4 The round-trip manifest

`roundtrip.json` at the Flutter campaign's root:

```json
{
  "converter": 1,
  "vault_index": "Campaigns/purezza.hexmap.md",
  "files": [
    {"flutter": "pages/hexes/Base Culto.md", "vault": "Campaigns/Places/Base Culto.md", "fingerprint": "1a2b3c4d"},
    {"flutter": "npcs/npc_001.json", "vault": "Campaigns/NPCs/Hermit.md", "fingerprint": "…"}
  ]
}
```

`fingerprint` is the fingerprint of the text the export wrote (for an NPC or
quest: of its page or `gm_notes`). On the way back (Flutter → plugin), the
entries are grouped by `vault` path:

- every copy unchanged → written once, to its original path;
- exactly one copy changed → its text wins;
- several changed differently → the first changed copy is written to the
  original path, each other one becomes a separate note
  `<name> (<display id of its hex>)`, and the exporter reports it.

Section subfolders come back too: the original path is used, not the
section's root.

## 6. Fixture pairs

Under `hexlore_flutter/test/fixtures/converter/` (the plugin vendors them):

- `flutter_to_plugin/input/` — a Flutter campaign; `.../expected/` — the
  vault folder the export writes. `test/notes_export_test.dart` runs it
  (`HEXLORE_WRITE_CONVERTER=1` regenerates `expected/`).
- `plugin_to_flutter/` — the plugin's direction, run by
  the plugin's `test/convert.test.ts`.

## 7. Mapped keys

The JSON keys of the records both converters read or write. Checked by
`hexlore_flutter/test/converter_contract_test.dart`: a model change fails it
until this list — and §4/§5 and both converters — are updated. (A hex's map
keys are copied, not mapped; listed so a change to them is still noticed.)

- `hex`: `q` `r` `name` `terrain` `color_override` `page_file` `npc_ids` `quest_ids` `event_ids` `tags` (plus the plugin's also_links, kept as an unknown key)
- `region`: `id` `name` `cells` `color` `z_order` `page_file`
- `npc`: `id` `name` `hex_id` `role` `attitude` `description` `secret` `tags` `linked_npc_ids` `linked_quest_ids` `notes_file` `is_secret`
- `quest`: `id` `title` `hex_id` `hook` `objectives` `reward` `status` `gm_notes` `linked_hex_ids` `linked_npc_ids` `tags` `unresolved` `is_secret`
- `adventure`: `id` `title` `order`
- `entry`: `id` `name` `tab` `npc_id` `page_file`
- `tab`: `name` `fixed` `mode`
