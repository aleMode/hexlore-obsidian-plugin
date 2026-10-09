// Port of Flutter's lib/importer/hex_sampler.dart: per-hex statistics of a
// calibrated map image — a square crop, the MODAL colour of an inscribed disc
// (mode, not mean: a mean smears forest green and shadow into mud), the modal
// colour of the disc's OUTER RING (the terrain with a centred stamp left
// out), and the mean luma gradient (the "is a stamp drawn here?" prior). Only
// pixels within 0.8·apothem are read, so borders and grid lines never count.

import { dartRound } from '../core/geometry';
import type { SourceGrid } from './grid_calibration';
import { crop, type Raster } from './raster';

const SQRT3 = Math.sqrt(3);

/** Inner edge of the biome ring, × the disc radius (decision 12e). */
export const BIOME_RING_INNER = 0.55;

export interface HexSample {
	q: number;
	r: number;
	/** Square crop centred on the hex (side ≈ 1.2·R, clamped). */
	crop: Raster;
	/** Modal colour of the whole disc, 0xAARRGGBB. */
	dominantArgb: number;
	/** Modal colour of the outer ring: the terrain around a stamp. */
	biomeArgb: number;
	/** Mean luma gradient in the disc, 0..1. */
	edgeDensity: number;
}

export function sampleHexes(image: Raster, grid: SourceGrid, cells: [number, number][]): HexSample[] {
	return cells.map(([q, r]) => sampleHex(image, grid, q, r));
}

export function sampleHex(image: Raster, grid: SourceGrid, q: number, r: number): HexSample {
	const [cx, cy] = grid.centerOf(q, r);
	const discR = 0.8 * ((grid.radius * SQRT3) / 2);
	const [dominantArgb, biomeArgb, edgeDensity] = discStats(image, cx, cy, discR);
	return { q, r, crop: cropSquare(image, cx, cy, dartRound(1.2 * grid.radius)), dominantArgb, biomeArgb, edgeDensity };
}

function discStats(image: Raster, cx: number, cy: number, discR: number): [number, number, number] {
	const all = new Histogram(), ring = new Histogram();
	let gradSum = 0, gradN = 0;
	const x0 = Math.max(Math.floor(cx - discR), 1), x1 = Math.min(Math.ceil(cx + discR), image.width - 2);
	const y0 = Math.max(Math.floor(cy - discR), 1), y1 = Math.min(Math.ceil(cy + discR), image.height - 2);
	const r2 = discR * discR, inner2 = BIOME_RING_INNER * discR * (BIOME_RING_INNER * discR);
	const d = image.data, w = image.width;
	const luma = (x: number, y: number) => {
		const i = (y * w + x) * 4;
		return 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
	};
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx, dy = y - cy;
			const d2 = dx * dx + dy * dy;
			if (d2 > r2) continue;
			const i = (y * w + x) * 4;
			const pr = d[i]!, pg = d[i + 1]!, pb = d[i + 2]!;
			all.add(pr, pg, pb);
			if (d2 >= inner2) ring.add(pr, pg, pb);
			const gx = Math.abs(luma(x + 1, y) - luma(x - 1, y));
			const gy = Math.abs(luma(x, y + 1) - luma(x, y - 1));
			gradSum += (gx + gy) / 2;
			gradN++;
		}
	}
	if (gradN === 0) return [0xff000000, 0xff000000, 0];
	const dominant = all.mode();
	// A degenerate ring (tiny cell, clipped disc) has no mode of its own.
	const biome = ring.isEmpty ? dominant : ring.mode();
	return [dominant, biome, gradSum / gradN / 255];
}

/** A 4-bit/channel histogram reporting its mode at full precision (the mean
 *  of the winning bin's pixels). Ties go to the first bin to reach the count
 *  (Dart's map order: insertion). */
class Histogram {
	private readonly counts = new Map<number, number>();
	private readonly sums = new Map<number, [number, number, number]>();

	get isEmpty(): boolean {
		return this.counts.size === 0;
	}

	add(r: number, g: number, b: number): void {
		const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		this.counts.set(bin, (this.counts.get(bin) ?? 0) + 1);
		const s = this.sums.get(bin);
		if (s) {
			s[0] += r;
			s[1] += g;
			s[2] += b;
		} else this.sums.set(bin, [r, g, b]);
	}

	mode(): number {
		if (!this.counts.size) return 0xff000000;
		let best = this.counts.keys().next().value!, bestCount = 0;
		for (const [bin, count] of this.counts) {
			if (count > bestCount) {
				bestCount = count;
				best = bin;
			}
		}
		const n = this.counts.get(best)!;
		const [sr, sg, sb] = this.sums.get(best)!;
		const c = (v: number) => Math.min(255, Math.max(0, dartRound(v / n)));
		return (0xff000000 | (c(sr) << 16) | (c(sg) << 8) | c(sb)) >>> 0;
	}
}

/** A square crop centred on (q, r) taking in [rings] of neighbours. */
export function contextCrop(image: Raster, grid: SourceGrid, q: number, r: number, rings = 1): Raster {
	const [cx, cy] = grid.centerOf(q, r);
	return cropSquare(image, cx, cy, dartRound(grid.radius * (1.2 + 2 * rings * SQRT3)));
}

function cropSquare(image: Raster, cx: number, cy: number, side: number): Raster {
	const x0 = Math.min(Math.max(dartRound(cx - side / 2), 0), image.width - 1);
	const y0 = Math.min(Math.max(dartRound(cy - side / 2), 0), image.height - 1);
	return crop(image, x0, y0, Math.min(side, image.width - x0), Math.min(side, image.height - y0));
}
