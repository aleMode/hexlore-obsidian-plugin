import { describe, expect, it } from 'vitest';
import { SourceGrid } from '../src/importer/grid_calibration';
import { ORIENTATION_BINS, SHAPE_PATCH_SIDE, buildInkMask, describeCell, shapeSimilarity, type InkDescriptor } from '../src/importer/ink_mask';
import { raster, setRgb, type Raster } from '../src/importer/raster';
import { bootstrapFromConfirmed, isColdTinted, isWarmTinted, matchCell, smoothWithNeighbors, variantFor, type StampMatch } from '../src/importer/stamp_recognizer';

// Mirrors Flutter's test/importer_stamp_test.dart (the hand-labelled
// measurement needs the source image, absent here as in the Flutter repo).
function fill(w: number, h: number, v: number): Raster {
	const img = raster(w, h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setRgb(img, x, y, v, v, v);
	return img;
}

/** package:image's fillCircle (no antialias): d² < r². */
function fillCircle(img: Raster, cx: number, cy: number, r: number, v: number): void {
	for (let y = Math.max(0, cy - r); y <= Math.min(img.height - 1, cy + r); y++)
		for (let x = Math.max(0, cx - r); x <= Math.min(img.width - 1, cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) setRgb(img, x, y, v, v, v);
}

const uniform = (): number[] => new Array<number>(ORIENTATION_BINS).fill(1 / ORIENTATION_BINS);
const ink = (blobs: number): InkDescriptor => ({ shape: [], coverage: 0.1, blobCount: blobs, medianBlobArea: 100, orientation: uniform() });

describe('ink descriptors', () => {
	const grid = new SourceGrid('flat', 90, 100, 100);

	it('a drawn shape is found, a blank field is not', () => {
		const img = fill(200, 200, 180);
		for (const [bx, by] of [[60, 60], [120, 70], [90, 130]] as const) fillCircle(img, bx, by, 7, 40);
		const drawn = describeCell(buildInkMask(img, grid.radius), grid, 0, 0);
		expect(drawn.coverage).toBeGreaterThan(0);
		expect(drawn.blobCount).toBe(3);
		const flat = describeCell(buildInkMask(fill(200, 200, 180), grid.radius), grid, 0, 0);
		expect(flat.coverage).toBeLessThan(0.01);
		expect(flat.blobCount).toBe(0);
	});

	it('ink is found on a light fill and a dark fill alike', () => {
		const g = new SourceGrid('flat', 70, 80, 80);
		for (const bg of [230, 90]) {
			const img = fill(160, 160, bg);
			fillCircle(img, 80, 80, 10, bg - 70);
			expect(describeCell(buildInkMask(img, g.radius), g, 0, 0).blobCount).toBe(1);
		}
	});

	it('orientation separates a ruled field from scattered dots', () => {
		const ruled = fill(200, 200, 190);
		for (let y = 40; y < 160; y += 10) for (let x = 40; x <= 160; x++) setRgb(ruled, x, y, 50, 50, 50);
		const scattered = fill(200, 200, 190);
		for (let i = 0; i < 24; i++) fillCircle(scattered, 50 + ((i * 37) % 100), 50 + ((i * 53) % 100), 3, 50);
		const peak = (h: number[]) => Math.max(...h);
		expect(peak(describeCell(buildInkMask(ruled, 90), grid, 0, 0).orientation)).toBeGreaterThan(peak(describeCell(buildInkMask(scattered, 90), grid, 0, 0).orientation));
	});

	it('shape similarity', () => {
		const n = SHAPE_PATCH_SIDE * SHAPE_PATCH_SIDE;
		const a = Array.from({ length: n }, (_, i) => (i % 7) / 7), c = Array.from({ length: n }, (_, i) => ((i * 3) % 5) / 5);
		expect(shapeSimilarity(a, [...a])).toBeCloseTo(1, 9);
		expect(shapeSimilarity(a, c)).toBeLessThan(0.9);
	});
});

describe('colour as modifier, smoothing, cold starts', () => {
	it('blob count picks the variant; tint is advisory', () => {
		const lab = { l: 55, a: -7, b: 26 };
		expect(variantFor('forest', lab, ink(1))).toBe(0);
		expect(variantFor('forest', lab, ink(3))).toBe(1);
		expect(variantFor('mountain', lab, ink(1))).toBe(0);
		expect(variantFor('mountain', lab, ink(4))).toBe(1);
		expect(isColdTinted({ l: 70, a: -4, b: -12 })).toBe(true);
		expect(isWarmTinted({ l: 70, a: 6, b: 14 })).toBe(true);
		expect(isColdTinted({ l: 70, a: -4, b: 0 })).toBe(false);
	});

	const m = (terrain: StampMatch['terrain'], confidence: number): StampMatch => ({ terrain, terrainVariant: 0, confidence, fromShape: true });
	const ring = (t: StampMatch['terrain']) => ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1'].map((k): [string, StampMatch] => [k, m(t, 0.9)]);

	it('smoothing never overturns confidence, yields only to agreement', () => {
		expect(smoothWithNeighbors(new Map([['0,0', m('desert', 0.9)], ...ring('forest')])).get('0,0')!.terrain).toBe('desert');
		expect(smoothWithNeighbors(new Map([['0,0', m('desert', 0.2)], ...ring('forest')])).get('0,0')!.terrain).toBe('forest');
		const split = new Map<string, StampMatch>([['0,0', m('desert', 0.2)], ['1,0', m('forest', 0.9)], ['1,-1', m('forest', 0.9)], ['0,-1', m('plains', 0.9)], ['-1,0', m('plains', 0.9)]]);
		expect(smoothWithNeighbors(split).get('0,0')!.terrain).toBe('desert');
	});

	it('no prototypes, no answer; nothing confirmed, nothing proposed', () => {
		const d: InkDescriptor = { shape: new Array<number>(SHAPE_PATCH_SIDE ** 2).fill(0.5), coverage: 0.2, blobCount: 2, medianBlobArea: 90, orientation: uniform() };
		expect(matchCell(d, { l: 60, a: 0, b: 10 }, [])).toBeNull();
		expect(bootstrapFromConfirmed([], new Map([['0,0', [d, { l: 60, a: 0, b: 10 }]]])).size).toBe(0);
	});
});
