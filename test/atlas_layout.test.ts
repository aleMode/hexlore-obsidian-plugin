import { describe, expect, it } from 'vitest';
import { HEX_RADIUS as R, axialToPixel, gridPixelBounds, type GridWindow } from '../src/core/geometry';
import { MapScale, hexStepPx } from '../src/core/map_scale';
import {
	FADE_IN_FROM,
	FULL_UNTIL,
	GHOST,
	GONE_AT,
	GHOST_AT,
	atlasOpacity,
	frameRects,
	hexPx,
	mapCamera,
	milesPerHex,
	readLayout,
	renamePaths,
	scaleMismatch,
	stackOrder,
	toScreen,
	worldRect,
	zoomLimits,
	type AtlasMap,
} from '../src/view/atlas_layout';

const grid: GridWindow = { minQ: 0, cols: 20, rows: 12, rShift: 0 };
const map = (hexDistance: number, unit: 'mi' | 'km' = 'mi', place = { x: 0, y: 0, fit: 1 }): AtlasMap => ({ grid, scale: new MapScale(hexDistance, unit), place });
const cam = { scale: 2, ox: 100, oy: 50 };

describe('maps together: placement in real distance', () => {
	it('a map is drawn at its own scale: neighbouring hexes are one hex distance apart', () => {
		const m = map(25, 'mi', { x: 300, y: -40, fit: 1 });
		const c = mapCamera(m, cam);
		const [ax, ay] = axialToPixel(3, 4, R);
		const [bx, by] = axialToPixel(4, 4, R);
		const step = Math.hypot((bx - ax) * c.scale, (by - ay) * c.scale);
		expect(step).toBeCloseTo(25 * cam.scale, 9); // 25 miles at 2 px per mile
		expect(hexPx(m, cam)).toBeCloseTo(step, 9);
	});

	it('the grid centre lands on the placement; the world rect is the grid at that scale', () => {
		const m = map(5, 'mi', { x: 300, y: -40, fit: 1.5 });
		const c = mapCamera(m, cam);
		const [x, y, w, h] = gridPixelBounds(grid);
		const centre = [c.ox + (x + w / 2) * c.scale, c.oy + (y + h / 2) * c.scale];
		const want = toScreen(cam, 300, -40);
		expect(centre[0]).toBeCloseTo(want[0], 9);
		expect(centre[1]).toBeCloseTo(want[1], 9);
		const [, , ww, wh] = worldRect(m);
		expect(ww).toBeCloseTo(((w * 5 * 1.5) / hexStepPx(R)), 9);
		expect(wh / ww).toBeCloseTo(h / w, 9); // never stretched
	});

	it('kilometres are converted: a 10 km hex is 6.2 miles', () => {
		expect(milesPerHex(new MapScale(10, 'km'))).toBeCloseTo(6.21371192, 6);
		expect(hexPx(map(10, 'km'), { scale: 1, ox: 0, oy: 0 }) / hexPx(map(10, 'mi'), { scale: 1, ox: 0, oy: 0 })).toBeCloseTo(0.621371192, 9);
	});

	it('the coarsest map is at the bottom, the most detailed on top', () => {
		const order = stackOrder([
			{ path: 'b', map: map(5) },
			{ path: 'a', map: map(50) },
			{ path: 'c', map: map(5, 'mi', { x: 0, y: 0, fit: 6 }) },
		]);
		expect(order.map((o) => o.path)).toEqual(['a', 'c', 'b']);
	});

	it('zoom limits keep the coarsest map visible and the finest legible', () => {
		const [min, max] = zoomLimits([map(50), map(5)]);
		expect(min * 50).toBeCloseTo(3, 9);
		expect(max * 5).toBeCloseTo(300, 9);
	});

	it('frames a set of rects in the view', () => {
		const c = frameRects([[0, 0, 100, 50], [200, 100, 10, 10]], 1000, 500)!;
		const [x0, y0] = toScreen(c, 0, 0), [x1, y1] = toScreen(c, 210, 110);
		expect(x0).toBeGreaterThanOrEqual(0);
		expect(y0).toBeGreaterThanOrEqual(0);
		expect(x1).toBeLessThanOrEqual(1000);
		expect(y1).toBeLessThanOrEqual(500);
		expect(frameRects([], 100, 100)).toBeNull();
	});
});

describe('maps together: opacity by zoom', () => {
	it('fades in, is full at its own zoom, fades to a ghost past it, then is gone', () => {
		expect(atlasOpacity(FADE_IN_FROM - 0.1)).toBe(0);
		expect(atlasOpacity(5)).toBeGreaterThan(0);
		expect(atlasOpacity(5)).toBeLessThan(1);
		expect(atlasOpacity(40)).toBe(1);
		expect(atlasOpacity(FULL_UNTIL)).toBe(1);
		expect(atlasOpacity(GHOST_AT)).toBeCloseTo(GHOST, 9);
		expect(atlasOpacity(GONE_AT)).toBe(0);
		expect(atlasOpacity(Number.NaN)).toBe(0);
	});

	it('never rises again on the way past its zoom', () => {
		let last = 1;
		for (let px = FULL_UNTIL; px <= GONE_AT + 10; px += 1) {
			const o = atlasOpacity(px);
			expect(o).toBeLessThanOrEqual(last + 1e-12);
			last = o;
		}
	});
});

describe('maps together: the layout in data.json', () => {
	it('reads tolerantly: bad entries dropped, the fit clamped, duplicates once', () => {
		const l = readLayout({ shown: ['a.hexmap.md', 'a.hexmap.md', 3], maps: { 'a.hexmap.md': { x: 1, y: 2, fit: 900 }, 'b.hexmap.md': { x: 'no' }, 'c.hexmap.md': { x: 0, y: 0 } } });
		expect(l.shown).toEqual(['a.hexmap.md']);
		expect(l.maps).toEqual({ 'a.hexmap.md': { x: 1, y: 2, fit: 20 }, 'c.hexmap.md': { x: 0, y: 0, fit: 1 } });
		expect(readLayout(undefined)).toEqual({ shown: [], maps: {} });
	});

	it('follows a renamed map, and a renamed folder above maps', () => {
		const l = readLayout({ shown: ['W/Europe/Europe.hexmap.md', 'Rome.hexmap.md'], maps: { 'W/Europe/Europe.hexmap.md': { x: 1, y: 2, fit: 1 }, 'Rome.hexmap.md': { x: 3, y: 4, fit: 1 } } });
		const a = renamePaths(l, 'Rome.hexmap.md', 'Roma.hexmap.md');
		expect(a.shown).toEqual(['W/Europe/Europe.hexmap.md', 'Roma.hexmap.md']);
		expect(a.maps['Roma.hexmap.md']).toEqual({ x: 3, y: 4, fit: 1 });
		const b = renamePaths(a, 'W', 'World');
		expect(Object.keys(b.maps).sort()).toEqual(['Roma.hexmap.md', 'World/Europe/Europe.hexmap.md']);
		// "W" is not a prefix of "Wx/…": only whole folder names move.
		expect(renamePaths(l, 'W/Eur', 'X')).toBe(l);
	});

	it('says when a map is drawn off its own scale', () => {
		expect(scaleMismatch(map(5))).toBeNull();
		expect(scaleMismatch(map(5, 'mi', { x: 0, y: 0, fit: 0.86 }))).toBe('Shown at 1 hex ≈ 4.3 mi (the map says 5 mi)');
		expect(scaleMismatch(map(10, 'km', { x: 0, y: 0, fit: 2 }))).toBe('Shown at 1 hex ≈ 20 km (the map says 10 km)');
	});
});
