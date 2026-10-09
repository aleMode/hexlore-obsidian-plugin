// Port of Flutter's lib/importer/river_debug.dart (decision 12g): a WINDOW
// onto the river pipeline, never a control over it. Each stage renders as a
// downsampled RGBA overlay (nearest neighbour on purpose: a one-pixel
// centreline averaged away would be a lie); rendering never changes the
// rivers found.

import { dartRound } from '../core/geometry';
import { raster, type Raster } from './raster';
import type { RiverTrace } from './river_tracer';

export type RiverDebugStage = 'none' | 'likeness' | 'ridge' | 'centerlines' | 'mask';

export const RIVER_DEBUG_STAGES: readonly { id: RiverDebugStage; label: string; hint: string }[] = [
	{ id: 'none', label: 'None (rivers only)', hint: 'Overlays are diagnostic only — they never change what gets imported.' },
	{ id: 'likeness', label: '1 · Water likeness', hint: 'Bright where a pixel matches the water colours. If the river is dark here, the seed colour or the tolerance is wrong.' },
	{ id: 'ridge', label: '2 · Ridge response', hint: 'Bright along thin curved shapes. If the river is bright here but missing later, thresholding dropped it.' },
	{ id: 'centerlines', label: '3 · Centrelines', hint: 'What survived thresholding. Gaps here become separate rivers, or none at all if each piece is too short.' },
	{ id: 'mask', label: '4 · After cleanup', hint: 'What is actually traced. Anything present at step 3 and gone here was removed as a lake, a duplicate track, or a spur.' },
];

export const RIVER_DEBUG_MAX_EDGE = 1024;

/** The overlay for [stage], at most 1024 px on its long side, or null. */
export function renderRiverDebugStage(trace: RiverTrace, stage: RiverDebugStage): Raster | null {
	if (stage === 'none') return null;
	const { width: w, height: h } = trace;
	if (w <= 0 || h <= 0) return null;
	const step = Math.max(1, Math.ceil(Math.max(w, h) / RIVER_DEBUG_MAX_EDGE));
	const outW = Math.floor(w / step), outH = Math.floor(h / step);
	if (outW <= 0 || outH <= 0) return null;
	const out = raster(outW, outH);
	let peak = 0;
	if (stage === 'likeness' || stage === 'ridge') {
		for (const v of stage === 'likeness' ? trace.likeness : trace.psi) if (v > peak) peak = v;
		if (peak <= 0) peak = 1;
	}
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			const i = y * step * w + x * step;
			const [r, g, b, a] =
				stage === 'likeness' ? heat(trace.likeness[i]! / peak) : stage === 'ridge' ? heat(Math.pow(Math.min(1, Math.max(0, trace.psi[i]! / peak)), 1 / 3)) : (stage === 'centerlines' ? trace.centerlines[i] : trace.mask[i]) ? HIT : MISS;
			const o = (y * outW + x) * 4;
			out.data[o] = r;
			out.data[o + 1] = g;
			out.data[o + 2] = b;
			out.data[o + 3] = a;
		}
	}
	return out;
}

const HIT: [number, number, number, number] = [255, 240, 80, 255];
const MISS: [number, number, number, number] = [0, 0, 0, 0];

function heat(t: number): [number, number, number, number] {
	const v = Math.min(1, Math.max(0, t));
	if (v < 0.02) return MISS;
	return [dartRound(v * v * 255), dartRound(Math.min(1, v * 1.6) * 220), 255, dartRound(40 + v * 215)];
}
