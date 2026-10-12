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
- Top bar mirroring the HexLore app's title bar; two-finger pinch and pan.

### Changed
- Renderer: tiles, atlas, redraws limited to what an edit touched
  (`docs/performance.md`).
