import { describe, expect, it } from 'vitest';
import { exportPixelSize, exportScaleForHex, exportTiles, pageHeightMm, pageWidthMm, printLayout, printPages, printScenePxPerMm, type SceneRect } from '../src/core/export_layout';
import { HEX_RADIUS } from '../src/core/geometry';

// Mirrors Flutter's test/export_layout_test.dart.
describe('PNG', () => {
	it('px per hex sets the scale; the size rounds up', () => {
		expect(exportScaleForHex(64) * 2 * HEX_RADIUS).toBeCloseTo(64, 9);
		expect(exportPixelSize([0, 0, 100.2, 50], 2)).toEqual([201, 100]);
	});

	it('tiles cover the image exactly, none above the limit', () => {
		const scene: SceneRect = [-100, 50, 3000, 1100];
		const tiles = exportTiles(scene, 1.5, 1024);
		const [w, h] = exportPixelSize(scene, 1.5);
		let area = 0;
		for (const t of tiles) {
			expect(t.w).toBeLessThanOrEqual(1024);
			expect(t.h).toBeLessThanOrEqual(1024);
			area += t.w * t.h;
			expect(t.scene[0]).toBeCloseTo(scene[0] + t.x / 1.5, 9);
		}
		expect(area).toBe(w * h);
		expect(tiles).toHaveLength(10);
	});
});

describe('print', () => {
	it('a fixed hex width: the scale, and pages that overlap', () => {
		const l = printLayout({ hexWidthMm: 10, overlapMm: 10, marginMm: 8 });
		const scene: SceneRect = [0, 0, 2000, 3000];
		const pxPerMm = printScenePxPerMm(scene, l);
		expect(pxPerMm * 10).toBeCloseTo(2 * HEX_RADIUS, 9);
		const pages = printPages(scene, l);
		const cols = new Set(pages.map((p) => p.col)).size, rows = new Set(pages.map((p) => p.row)).size;
		expect(pages).toHaveLength(cols * rows);
		const a = pages.find((p) => p.row === 0 && p.col === 0)!, b = pages.find((p) => p.row === 0 && p.col === 1)!;
		expect(a.scene[0] + a.scene[2] - b.scene[0]).toBeCloseTo(10 * pxPerMm, 6);
		const last = pages.filter((p) => p.row === 0).at(-1)!;
		expect(last.scene[0] + last.scene[2]).toBeGreaterThanOrEqual(2000 - 1e-6);
		expect(pages[0]!.label).toBe('A1');
		expect(pages.find((p) => p.col === 1 && p.row === 1)!.label).toBe('B2');
	});

	it('fit to N pages wide puts exactly N columns', () => {
		for (const n of [1, 2, 3]) expect(new Set(printPages([0, 0, 5000, 900], printLayout({ pagesWide: n, landscape: true })).map((p) => p.col)).size).toBe(n);
	});

	it('a map smaller than one page is one page; paper and orientation', () => {
		expect(printPages([0, 0, 50, 50], printLayout({ hexWidthMm: 20 })).map((p) => p.label)).toEqual(['A1']);
		const l = printLayout({ paper: 'a3', landscape: true, hexWidthMm: 9 });
		expect([pageWidthMm(l), pageHeightMm(l)]).toEqual([420, 297]);
		expect(() => printLayout({})).toThrow();
	});
});
