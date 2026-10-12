# Renderer performance inside Obsidian

The measured record for the map renderer (design item 2.0's go/no-go, then
2.11). Its Flutter counterpart is the Flutter repository's
`docs/pan-performance.md`; the techniques are the same (Flutter decisions 23,
23b and 33), and the plugin's renderer notes are in `CLAUDE.md` (Layout →
`src/render/`).

## How to measure

Map menu → HexLore → **Benchmark the renderer** (`src/dev/bench.ts`). It
opens the synthetic 100 × 100 map (`src/dev/synthetic.ts`, also available as
the command "Open the synthetic 100×100 test map"), drives every scenario
below with the real renderer, and writes a `HexLore benchmark <date>.md`
note at the vault root. Compare a renderer change against the table below,
on the same machine.

- *frame*: time inside the frame (tiles drawn and any rendered).
- *interval*: time between animation frames, raster work included.
- *dropped*: intervals over 1.5 refresh periods.
- **Verdict:** OK when frame p95 ≤ 16.7 ms and ≤ 5 % of frames are dropped.

## Latest result (2026-10-11 09:49)

Windows, Obsidian API 1.13.7, 1920×1080 CSS px at device pixel ratio 1.25,
60 Hz, hex radius 48 px at zoom 1.0, 10 000 hexes. Times in ms.

| Style | Scenario | frame median | frame p95 | frame max | interval p95 | dropped | verdict |
|---|---|---:|---:|---:|---:|---:|---|
| Clean | pan at fit (scale 0.13) | 0.4 | 1.0 | 12.5 | 17.0 | 0% | OK |
| Clean | pan at zoom 1.0 | 0.4 | 3.5 | 11.2 | 17.0 | 0% | OK |
| Clean | pan at zoom 1.0, direct (no tiles) | 2.8 | 3.6 | 4.8 | 17.1 | 0% | OK |
| Clean | wheel zoom 1 notch/frame, then settle | 0.2 | 7.4 | 8.8 | 17.1 | 0% | OK |
| Clean | brush stroke, 300 hexes | 1.7 | 2.5 | 3.8 | 17.1 | 0% | OK |
| Illustrated | pan at fit (scale 0.13) | 0.4 | 1.1 | 16.5 | 17.1 | 0% | OK |
| Illustrated | pan at zoom 1.0 | 0.5 | 13.8 | 35.2 | 17.1 | 2% | OK |
| Illustrated | pan at zoom 1.0, direct (no tiles) | 5.7 | 8.9 | 13.6 | 17.0 | 1% | OK |
| Illustrated | wheel zoom 1 notch/frame, then settle | 0.2 | 6.4 | 8.4 | 17.1 | 0% | OK |
| Illustrated | brush stroke, 300 hexes | 2.6 | 4.3 | 6.3 | 17.0 | 0% | OK |
| Illustrated | pan at zoom 1.0, textures drawn on the GPU † | 0.5 | 5.5 | 12.5 | 33.6 | 9% | slow |
| Illustrated + Blend | pan at fit (scale 0.13) | 0.4 | 1.0 | 19.7 | 17.0 | 1% | OK |
| Illustrated + Blend | pan at zoom 1.0 | 1.5 | 24.7 | 42.9 | 17.4 | 5% | **slow** |
| Illustrated + Blend | pan at zoom 1.0, direct (no tiles) | 9.7 | 11.5 | 22.7 | 17.1 | 2% | OK |
| Illustrated + Blend | wheel zoom 1 notch/frame, then settle | 0.2 | 10.6 | 12.5 | 17.0 | 1% | OK |
| Illustrated + Blend | pan at zoom 1.0, textures drawn on the GPU † | 0.5 | 8.7 | 30.6 | 50.1 | 12% | slow |

† The rejected alternative, kept as a comparison: textures rasterised by the
GPU process instead of on a CPU canvas and copied into the atlas. It is why
the renderer draws them in software (`cpuRaster` in `src/render/textures.ts`).

**Open:** Illustrated + Blend panning at zoom 1.0. A cold pan makes about
900 texture rasters; the frame p95 is 24.7 ms.

## Before this round (2026-10-11 09:19)

The same benchmark half an hour earlier, before rasters moved to a CPU canvas
and the per-frame raster cap and idle-time pre-warming were tuned:

| Style | Scenario | frame p95 | interval p95 | dropped |
|---|---|---:|---:|---:|
| Clean | pan at zoom 1.0 | 6.7 | 33.8 | 9% |
| Clean | pan at zoom 1.0, direct | 11.9 | 100.3 | 36% |
| Illustrated | pan at zoom 1.0 | 10.2 | 148.7 | 15% |
| Illustrated + Blend | pan at zoom 1.0 | 12.6 | 116.7 | 21% |
| Illustrated + Blend | pan at zoom 1.0, direct | 21.4 | 33.4 | 30% |
