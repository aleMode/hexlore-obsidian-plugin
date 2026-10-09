import { describe, expect, it } from 'vitest';
import { dartRound } from '../src/core/geometry';
import { SourceGrid } from '../src/importer/grid_calibration';
import { drawnRiver } from '../src/importer/import_session';
import { setRgb, type Raster } from '../src/importer/raster';
import { DEFAULT_TRACE, riverLengthPx, suggestRiverSeeds, traceRivers } from '../src/importer/river_tracer';
import { paintMap } from './helpers/importer_synth';

// Mirrors Flutter's test/importer_river_test.dart (the tracer half).
const LAND: [number, number, number] = [90, 140, 70];
const WATER = 0xff2e6fb0;
const grid = new SourceGrid('flat', 30, 90, 90);
const blank = (w: number, h: number) => paintMap(grid, w, h, () => LAND);
const water = (img: Raster, x: number, y: number) => setRgb(img, x, y, (WATER >> 16) & 0xff, (WATER >> 8) & 0xff, WATER & 0xff);

function paintRiver(img: Raster, points: [number, number][], width: number): void {
	const half = width / 2;
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1]!, [x1, y1] = points[i]!;
		const steps = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2) * 2));
		for (let s = 0; s <= steps; s++) {
			const t = s / steps;
			const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
			for (let dy = -Math.ceil(half); dy <= Math.ceil(half); dy++)
				for (let dx = -Math.ceil(half); dx <= Math.ceil(half); dx++) {
					if (dx * dx + dy * dy > half * half) continue;
					const x = dartRound(cx + dx), y = dartRound(cy + dy);
					if (x >= 0 && y >= 0 && x < img.width && y < img.height) water(img, x, y);
				}
		}
	}
}

function paintDisc(img: Raster, cx: number, cy: number, radius: number): void {
	for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++)
		for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++)
			if (x >= 0 && y >= 0 && x < img.width && y < img.height && (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) water(img, x, y);
}

function distanceToPolyline(p: [number, number], line: [number, number][]): number {
	let best = Infinity;
	for (let i = 1; i < line.length; i++) {
		const [ax, ay] = line[i - 1]!, [bx, by] = line[i]!;
		const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
		const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - ax) * vx + (p[1] - ay) * vy) / len2));
		best = Math.min(best, Math.hypot(p[0] - (ax + t * vx), p[1] - (ay + t * vy)));
	}
	return best;
}

describe('the river tracer', () => {
	it('finds a straight painted river and measures its width', () => {
		const img = blank(600, 420);
		const course: [number, number][] = [[80, 210], [520, 210]];
		paintRiver(img, course, 7);
		const rivers = traceRivers(img, grid, [WATER]);
		expect(rivers).toHaveLength(1);
		expect(Math.abs(rivers[0]!.widthPx - 7)).toBeLessThanOrEqual(2.5);
		expect(Math.abs(riverLengthPx(rivers[0]!) - 440)).toBeLessThanOrEqual(40);
		for (const p of rivers[0]!.points) expect(distanceToPolyline(p, course)).toBeLessThan(4);
	});

	it('follows a bending river', () => {
		const img = blank(600, 420);
		paintRiver(img, [[80, 100], [300, 180], [320, 330], [520, 360]], 6);
		const rivers = traceRivers(img, grid, [WATER]);
		expect(rivers).toHaveLength(1);
		expect(riverLengthPx(rivers[0]!)).toBeGreaterThan(500);
	});

	it('rejects a lake but keeps the river feeding it', () => {
		const lake = blank(600, 420);
		paintDisc(lake, 460, 320, 70);
		expect(traceRivers(lake, grid, [WATER])).toEqual([]);
		const withRiver = blank(600, 420);
		paintDisc(withRiver, 460, 320, 70);
		paintRiver(withRiver, [[60, 90], [300, 120]], 6);
		const traced = traceRivers(withRiver, grid, [WATER]);
		expect(traced).toHaveLength(1);
		expect(riverLengthPx(traced[0]!)).toBeGreaterThan(200);
	});

	it('splits a tributary off the main stem, longest first', () => {
		const img = blank(700, 500);
		paintRiver(img, [[60, 250], [640, 250]], 6);
		paintRiver(img, [[350, 250], [360, 460]], 5);
		const rivers = traceRivers(img, grid, [WATER]);
		expect(rivers).toHaveLength(2);
		expect(Math.abs(riverLengthPx(rivers[0]!) - 580)).toBeLessThanOrEqual(60);
		expect(Math.abs(riverLengthPx(rivers[1]!) - 210)).toBeLessThanOrEqual(60);
	});

	it('survives isolated water specks', () => {
		const img = blank(600, 420);
		paintRiver(img, [[80, 210], [520, 210]], 7);
		for (const [x, y] of [[120, 60], [300, 340], [455, 95], [200, 380]] as const) water(img, x, y);
		const rivers = traceRivers(img, grid, [WATER]);
		expect(rivers).toHaveLength(1);
		expect(Math.abs(riverLengthPx(rivers[0]!) - 440)).toBeLessThanOrEqual(40);
	});

	it('finds the river on a map crowded with icon ink', () => {
		const img = blank(900, 700);
		for (let y = 40; y < 420; y += 22) for (let x = 30; x < 880; x += 26) paintRiver(img, [[x, y], [x + 10, y + 12]], 3);
		const course: [number, number][] = [[60, 620], [840, 600]];
		paintRiver(img, course, 8);
		const rivers = traceRivers(img, grid, [WATER]);
		expect(rivers).toHaveLength(1);
		expect(Math.abs(riverLengthPx(rivers[0]!) - 780)).toBeLessThanOrEqual(60);
		for (const p of rivers[0]!.points) expect(distanceToPolyline(p, course)).toBeLessThan(5);
	}, 30000);

	it('minLengthFactor drops icon-sized squiggles; no seeds, no rivers', () => {
		const img = blank(600, 420);
		paintRiver(img, [[80, 210], [520, 210]], 7);
		paintRiver(img, [[120, 60], [180, 90]], 5);
		expect(traceRivers(img, grid, [WATER])).toHaveLength(1);
		expect(traceRivers(img, grid, [WATER], { ...DEFAULT_TRACE, minLengthFactor: 1.2 })).toHaveLength(2);
		expect(traceRivers(img, grid, [])).toEqual([]);
	});

	it('suggestRiverSeeds prefers hints, else finds the blue', () => {
		const img = blank(400, 300);
		paintRiver(img, [[40, 150], [360, 150]], 12);
		expect(suggestRiverSeeds(img, [0xff112233])).toEqual([0xff112233]);
		const [guessed] = suggestRiverSeeds(img);
		expect(guessed! & 0xff).toBeGreaterThan((guessed! >> 16) & 0xff);
	});

	it('a drawn stroke snaps to a connected chain on the lattice', () => {
		const pts: [number, number][] = [];
		for (let x = 100; x <= 400; x += 4) pts.push([x, 200]);
		const d = drawnRiver(pts, grid)!;
		expect(d.vertices.length).toBeGreaterThan(4);
		expect(drawnRiver([[100, 200]], grid)).toBeNull();
	});
});

describe('the river debug view', () => {
	it('renders every stage, small, and never changes the rivers found', async () => {
		const { traceRiversDebug } = await import('../src/importer/river_tracer');
		const { renderRiverDebugStage, RIVER_DEBUG_STAGES } = await import('../src/importer/river_debug');
		const img = blank(600, 420);
		paintRiver(img, [[80, 210], [520, 210]], 7);
		const trace = traceRiversDebug(img, grid, [WATER]);
		expect(renderRiverDebugStage(trace, 'none')).toBeNull();
		for (const s of RIVER_DEBUG_STAGES.slice(1)) {
			const out = renderRiverDebugStage(trace, s.id)!;
			expect(out.width).toBeLessThanOrEqual(1024);
			expect(s.hint.length).toBeGreaterThan(10);
		}
		expect(traceRiversDebug(img, grid, [WATER]).rivers.map(riverLengthPx)).toEqual(trace.rivers.map(riverLengthPx));
	});
});
