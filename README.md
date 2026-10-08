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

See `CLAUDE.md` for how this repository stays in step with the Flutter app.
