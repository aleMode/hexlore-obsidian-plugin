// Synthetic maps for importer tests (Flutter's test/importer_synth.dart).

import type { SourceGrid } from '../../src/importer/grid_calibration';
import { raster, setRgb, type Raster } from '../../src/importer/raster';

/** Every pixel takes the colour of the cell it falls in (exact tessellation). */
export function paintMap(grid: SourceGrid, w: number, h: number, rgb: (q: number, r: number) => [number, number, number]): Raster {
	const img = raster(w, h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [q, r] = grid.cellAt(x + 0.5, y + 0.5);
			setRgb(img, x, y, ...rgb(q, r));
		}
	}
	return img;
}

/** A black disc "icon" at the centre of (q, r). */
export function stampIcon(img: Raster, grid: SourceGrid, q: number, r: number): void {
	const [cx, cy] = grid.centerOf(q, r);
	const iconR = grid.radius * 0.3;
	for (let y = Math.floor(cy - iconR); y <= Math.ceil(cy + iconR); y++) {
		for (let x = Math.floor(cx - iconR); x <= Math.ceil(cx + iconR); x++) {
			if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
			if ((x - cx) ** 2 + (y - cy) ** 2 <= iconR * iconR) setRgb(img, x, y, 0, 0, 0);
		}
	}
}

/** A black ring "icon" (distinct from the disc for NCC tests). */
export function stampRingIcon(img: Raster, grid: SourceGrid, q: number, r: number): void {
	const [cx, cy] = grid.centerOf(q, r);
	const outerR = grid.radius * 0.35, innerR = grid.radius * 0.2;
	for (let y = Math.floor(cy - outerR); y <= Math.ceil(cy + outerR); y++) {
		for (let x = Math.floor(cx - outerR); x <= Math.ceil(cx + outerR); x++) {
			if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
			const d2 = (x - cx) ** 2 + (y - cy) ** 2;
			if (d2 <= outerR * outerR && d2 >= innerR * innerR) setRgb(img, x, y, 0, 0, 0);
		}
	}
}

/** A seeded PRNG (mulberry32), so tests are reproducible. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
