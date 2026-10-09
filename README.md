# HexLore for Obsidian

A hex-crawl map builder, viewer and player server inside Obsidian: the
Obsidian port of the HexLore Flutter app. Work in progress; installed by hand
for now.

## Develop

```sh
eval "$(fnm env)"          # Node via fnm
npm install
npm test                   # conformance fixtures vs the TypeScript core
npm run dev                # rebuild main.js on change, copied into the dev vault
npm run vendor             # re-copy the contract from the Flutter repository
```

## Try it without building

Open `../obsidian-test-vault` as a vault in Obsidian (Open folder as vault) and
turn on community plugins: the built plugin is already in it
(`.obsidian/plugins/hexlore/`), refreshed by every build. The vault holds two
maps: `purezza.hexmap.md` (the map exported earlier, for editing tests) and
`purezza from HexLore/purezza.hexmap.md` (the full export, with the Flutter
pages as notes).

See `CLAUDE.md` for how this repository stays in step with the Flutter app.
