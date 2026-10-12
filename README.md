# HexLore for Obsidian

A hex-crawl **map builder, viewer and player server** inside Obsidian. Paint
a hex map, link your notes to its hexes, and show your players a live map in
their browser that reveals only what they have found. Obsidian keeps the
notes; HexLore keeps the map.

It is the Obsidian version of the HexLore desktop app and reads and writes
the same map files, so a campaign can move between the two.

**Status:** personal use, installed by hand (or with BRAT). Not in the
community directory yet.

## Install

Copy `main.js`, `manifest.json` and `styles.css` from a release into
`<vault>/.obsidian/plugins/hexlore/`, then enable **HexLore** under
*Settings → Community plugins*. Start with the command **HexLore: Create a
new map…**.

## Documentation

| Document | For |
|---|---|
| [User guide](docs/user-guide.md) | using the plugin |
| [Technical manual](docs/technical-manual.md) | how it is built |
| [Design record](docs/design.md) | the design decisions, the build record, what is left |
| [Performance](docs/performance.md) | the renderer benchmark and its results |
| [CLAUDE.md](CLAUDE.md) | the rules for changing the code |
| `vendor/docs/` | the map format, the converter contract and the decision records, copied from the HexLore app |

## Develop

```sh
eval "$(fnm env)"          # Node via fnm
npm install
npm test                   # Vitest, including the conformance fixtures
npm run lint
npm run dev                # rebuild main.js on change, copied into the dev vault
npm run build              # type-check + production bundle
npm run vendor             # re-copy the contract from the HexLore app's repository
```

Each build is copied into a dev vault: `$HEXLORE_VAULT`, else
`../obsidian-test-vault` (`HEXLORE_VAULT=none` to skip). `npm run vendor`
finds the HexLore app's repository through `$HEXLORE_FLUTTER`.

## Credits

Feature and biome icons from [game-icons.net](https://game-icons.net)
(CC BY 3.0; authors listed in *About and credits*). Illustrated terrain
symbols from Azgaar's Fantasy Map Generator (MIT). Strokes by
[perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT);
PDFs by [pdf-lib](https://pdf-lib.js.org) (MIT).
