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
*Settings → Community plugins*. Start with the **HexLore** icon in the left
ribbon → **New map…**.

## Network use and files outside the vault

HexLore contacts no remote service, sends no telemetry and makes no
outgoing requests. Two features reach beyond the vault, both desktop only
and both started by you:

- **The player view** runs a small web server on your computer, so your
  players can open the map in a browser. It listens on this computer only
  (`127.0.0.1`, ports 5174–5180) unless you turn on **Serve on the local
  network** in the players menu; then devices on your network can reach it.
  It serves only the map, filtered to what players may see, and takes
  travel votes. It stops when you stop it or close Obsidian.
- **Export as a campaign folder…** writes a copy of the campaign into a
  folder you choose, outside the vault, for the HexLore desktop app.

## Documentation

| Document | For |
|---|---|
| [User guide](docs/user-guide.md) | using the plugin |
| [Technical manual](docs/technical-manual.md) | how it is built |
| [Design record](docs/design.md) | the design decisions, the build record, what is left |
| [Performance](docs/performance.md) | the renderer benchmark and its results |
| [Workflow](vendor/WORKFLOW.md) | how every change is made (copied from the HexLore app's repository) |
| [Changelog](CHANGELOG.md) | what changed, version by version |
| [CLAUDE.md](CLAUDE.md) | the rules for changing the code |
| `vendor/docs/` | the map format, the converter contract and the decision records, copied from the HexLore app |

## Develop

```sh
eval "$(fnm env)"          # Node via fnm
npm install
npm run check              # lint + test + build: what every change must pass
npm test                   # Vitest, including the conformance fixtures
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
PDFs by [pdf-lib](https://pdf-lib.js.org) (MIT); the player link's QR code
by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(MIT).
