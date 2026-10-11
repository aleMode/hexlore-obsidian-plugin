// An edit redraws only the tiles its DAMAGE touches (scene.damageSince), so
// the damage must cover every tile whose pixels the edit changes. Proven here
// by brute force: every tile of a map is rendered before and after each kind
// of edit into a canvas that traces what reaches its pixels
// (helpers/tracing_canvas.ts), and any tile whose trace changed must overlap
// the damage. A reach constant in scene.ts that is too small fails here.

import { beforeAll, describe, expect, it } from 'vitest';
import { HEX_RADIUS as R, axialToPixel, gridPixelBounds } from '../src/core/geometry';
import { syntheticMap } from '../src/dev/synthetic';
import { MapPainter } from '../src/render/painter';
import { MapScene, boxesOverlap, type Anchor, type Box, type MapStyle, type SceneHex } from '../src/render/scene';
import { TextureCache } from '../src/render/textures';
import { TILE, TileSet } from '../src/render/tiles';
import { SPEC } from '../src/render/vendor';
import { TracingPath2D, tracingSurface, type TracingSurface } from './helpers/tracing_canvas';

beforeAll(() => {
	(globalThis as Record<string, unknown>).Path2D = TracingPath2D;
});

const STYLES: [MapStyle, boolean][] = [
	['clean', false],
	['illustrated', false],
	['illustrated', true],
];

const painterFor = () => new MapPainter(new TextureCache(tracingSurface, (h) => SPEC.parseHex(h), 1 << 30));

/** The tiles at [scale] covering [win] (scene px; the whole grid when
 *  null) and not overlapping [skip], as id → trace. */
function renderAll(scene: MapScene, painter: MapPainter, style: MapStyle, blend: boolean, scale: number, win: Box | null, skip: Box[] = []) {
	const set = new TileSet({ epoch: scene.epoch, style, blend, dpr: 1 }, scale, scene, painter, tracingSurface, 1 << 20);
	const [gx, gy, gw, gh] = gridPixelBounds(scene.grid);
	const [x0, y0, x1, y1] = win ?? [gx, gy, gx + gw, gy + gh];
	const out = new Map<string, string>();
	for (let j = Math.floor((y0 * scale) / TILE); j <= Math.floor((y1 * scale) / TILE); j++) {
		for (let i = Math.floor((x0 * scale) / TILE); i <= Math.floor((x1 * scale) / TILE); i++) {
			if (skip.some((d) => boxesOverlap(d, set.sceneRect(i, j)))) continue;
			out.set(`${i},${j}`, (set.render(i, j) as unknown as TracingSurface).ops.join('\n'));
		}
	}
	return { set, out };
}

/** The bounding box of [boxes], grown by [pad]. */
function around(boxes: Box[], pad: number): Box {
	return [
		Math.min(...boxes.map((b) => b[0])) - pad,
		Math.min(...boxes.map((b) => b[1])) - pad,
		Math.max(...boxes.map((b) => b[2])) + pad,
		Math.max(...boxes.map((b) => b[3])) + pad,
	];
}

const WATER = (h: SceneHex) => h.terrain === 'sea' || h.terrain === 'lake';

/** A land cell mid-course on the first river that crosses land. */
function riverCell(scene: MapScene): [number, number] {
	for (const river of scene.rivers) {
		for (const a of river.anchors.slice(4)) {
			const h = scene.hexAt(a[1], a[2]);
			if (h && !WATER(h)) return [a[1], a[2]];
		}
	}
	throw new Error('no river over land');
}

function edit(scene: MapScene, [q, r]: [number, number], change: Partial<SceneHex>) {
	scene.setHex({ ...scene.hexAt(q, r)!, ...change });
}

function landBesideFeature(scene: MapScene): [number, number] {
	for (const h of scene.hexes.values()) {
		if (!h.feature) continue;
		for (const [dq, dr] of SPEC.hexEdgeNeighbors) {
			const n = scene.hexAt(h.q + dq, h.r + dr);
			if (n && !WATER(n) && !n.feature) return [n.q, n.r];
		}
	}
	throw new Error('no feature');
}

function firstOf(scene: MapScene, terrain: string): [number, number] {
	for (const h of scene.hexes.values()) if (h.terrain === terrain && !h.feature && h.q > 3) return [h.q, h.r];
	throw new Error(`no ${terrain}`);
}

interface Case {
	name: string;
	/** Runs before the "before" render; what it returns goes to [edit]. */
	setup?: (s: MapScene) => [number, number];
	edit: (s: MapScene, cell: [number, number] | undefined) => void;
}

const flood = (s: MapScene): [number, number] => {
	const cell = riverCell(s);
	edit(s, cell, { terrain: 'lake', terrainVariant: 0, feature: null, name: null });
	return cell;
};

const NORTH = { id: 'region_001', name: 'North', color: '#204060', zOrder: 0 };

const CASES: Case[] = [
	{ name: 'repaint a hex beside a feature', edit: (s) => edit(s, landBesideFeature(s), { terrain: 'desert', terrainVariant: 0 }) },
	{ name: 'repaint a forest hex', edit: (s) => edit(s, firstOf(s, 'forest'), { terrain: 'mountain', terrainVariant: 0 }) },
	{ name: 'name a hex', edit: (s) => edit(s, firstOf(s, 'plains'), { name: 'A rather long place name' }) },
	{ name: 'add a feature to a forest', edit: (s) => edit(s, firstOf(s, 'forest'), { feature: 'tower', featureVariant: 0 }) },
	{ name: 'hide a feature from players', edit: (s) => edit(s, landBesideFeature(s), { feature: 'ruins', featureHidden: true }) },
	{ name: 'flood a cell on a river', edit: (s) => void flood(s) },
	{ name: 'drain a lake on a river', setup: flood, edit: (s, cell) => edit(s, cell!, { terrain: 'plains', terrainVariant: 0 }) },
	{ name: "change a river mouth's water", setup: flood, edit: (s, cell) => edit(s, cell!, { terrain: 'sea', terrainVariant: 0 }) },
	{ name: 'erase a hex on a river', edit: (s) => s.removeHex(...riverCell(s)) },
	{
		name: 'move a river point',
		edit: (s) =>
			s.setLines(
				s.rivers.map((r, i) => (i === 0 ? { ...r, anchors: r.anchors.map((a, k) => (k === 6 ? (['v', a[1], a[2], 2] as typeof a) : a)) } : r)),
				s.routes,
			),
	},
	{ name: 'retype a road', edit: (s) => s.setLines(s.rivers, s.routes.map((r, i) => (i === 1 ? { ...r, kind: 'highway' } : r))) },
	{
		name: 'add a short trail through a forest',
		edit: (s) => {
			const [q, r] = firstOf(s, 'forest');
			const anchors: Anchor[] = [['c', q, r, 0], ['v', q, r, 0]];
			s.setLines(s.rivers, [...s.routes, { id: 'route_new', kind: 'trail', color: '#6B4A2F', width: 1, playerVisible: true, anchors }]);
		},
	},
	{
		name: 'add a short river through a forest',
		edit: (s) => {
			const [q, r] = firstOf(s, 'forest');
			const anchors: Anchor[] = [['e', q, r, 1], ['e', q, r, 4]];
			s.setLines([...s.rivers, { id: 'river_new', width: 1, anchors }], s.routes);
		},
	},
	{ name: 'add a region', edit: (s) => s.setRegions([{ ...NORTH, cells: [[6, 0], [7, 0], [7, 1], [8, 0]] }]) },
	{
		name: 'grow a region',
		setup: (s) => {
			s.setRegions([{ ...NORTH, cells: [[6, 0], [7, 0]] }]);
			return [0, 0];
		},
		edit: (s) => s.setRegions([{ ...NORTH, cells: [[6, 0], [7, 0], [7, 1]] }]),
	},
	{ name: 'reveal a hex', edit: (s) => s.setRevealed([[10, -2]], () => true) },
];

/** Whole map at a far zoom (anything an edit reaches far away), then the
 *  ring of tiles just outside the damage at a near zoom, where a tile is
 *  less than a hex radius across (a damage box a little too small shows
 *  there; tiles inside the damage may change, so they are not drawn). */
const PASSES: { scale: number; ring: boolean }[] = [
	{ scale: 0.3, ring: false },
	{ scale: 3, ring: true },
];

describe.each(STYLES)('the damage of an edit (%s, blend %s)', (style, blend) => {
	const shared = painterFor(); // textures are keyed by content: one cache serves every case
	it.each(CASES.map((c) => [c.name, c] as const))('covers every tile it changes: %s', (_name, c) => {
		for (const { scale, ring } of PASSES) {
			const scene = new MapScene(syntheticMap(24, 16));
			const cell = c.setup?.(scene);
			const painter = shared;
			// The ring: learnt by editing a copy first.
			let win: Box | null = null;
			let inside: Box[] = [];
			if (ring) {
				const probe = new MapScene(syntheticMap(24, 16));
				c.setup?.(probe);
				const rev = probe.revision;
				c.edit(probe, cell);
				inside = probe.damageSince(rev)!;
				win = around(inside, 4 * R);
			}
			const before = renderAll(scene, painter, style, blend, scale, win, inside);
			const rev = scene.revision;
			c.edit(scene, cell);
			const damage = scene.damageSince(rev);
			expect(damage, 'a hex, line, region or fog edit records its damage').not.toBeNull();
			const after = renderAll(scene, painter, style, blend, scale, win, inside);
			const changed = [...after.out].filter(([id, t]) => before.out.get(id) !== t).map(([id]) => id);
			if (!ring) expect(changed.length, 'the edit shows').toBeGreaterThan(0);
			const missed = changed.filter((id) => {
				const [i, j] = id.split(',').map(Number) as [number, number];
				return !damage!.some((d) => boxesOverlap(d, after.set.sceneRect(i, j)));
			});
			expect(missed, `scale ${scale}: changed tiles outside the damage`).toEqual([]);
			// And the set drawn before drops every tile that changed.
			const dropped = before.set.catchUp();
			expect(dropped).not.toBe(false);
			const ids = new Set((dropped as [number, number][]).map(([i, j]) => `${i},${j}`));
			expect(changed.filter((id) => !ids.has(id))).toEqual([]);
		}
	});
});

/** A map with a bit of everything the base layer draws: a river mouth, roads
 *  with marks, a region, threads, GM fog, a revealed hex. Returns the mouth. */
function busyScene(): { scene: MapScene; mouth: [number, number] } {
	const data = syntheticMap(24, 16);
	data.threads = [
		{ id: 'thread_001', from: 'q4_r0', to: 'q12_r-3', label: 'Rumour', color: '#E05555', colorKey: '#E05555', status: 'active', direction: 'one-way' },
	];
	const scene = new MapScene(data);
	const mouth = flood(scene);
	scene.setRegions([{ ...NORTH, cells: [[mouth[0], mouth[1]], [mouth[0] + 1, mouth[1]], [mouth[0], mouth[1] + 1]] }]);
	scene.setRevealed([[mouth[0] - 1, mouth[1]]], () => true);
	scene.setOverlays({ ...scene.overlays, gmFog: true });
	return { scene, mouth };
}

describe.each(STYLES)('a block of tiles (%s, blend %s)', (style, blend) => {
	// Every paint is culled to its rect; a block is one paint over several
	// tiles. Each tile cut from a block must match the tile painted alone —
	// so nothing a tile needs is culled away (a pebble, a clip hex, a mouth,
	// a cell in the pad) when the rect is the tile's own.
	it('paints each tile as that tile painted alone', () => {
		const { scene, mouth } = busyScene();
		const painter = painterFor();
		const [mx, my] = axialToPixel(...mouth);
		for (const scale of [1, 0.3]) {
			const key = { epoch: scene.epoch, style, blend, dpr: 1 };
			const ci = Math.floor((mx * scale) / TILE), cj = Math.floor((my * scale) / TILE);
			const cells: [number, number][] = [];
			for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) cells.push([i, j]);
			const alone = new TileSet(key, scale, scene, painter, (w, h) => tracingSurface(w, h, { clamp: true }), 1 << 20);
			for (const [ti, tj] of cells) {
				const own = (alone.render(ti, tj) as unknown as TracingSurface).ops;
				let block: TracingSurface | null = null;
				const window: [number, number, number, number] = [(ti - ci + 1) * TILE, (tj - cj + 1) * TILE, TILE, TILE];
				const set = new TileSet(key, scale, scene, painter, (w, h) => {
					const s = tracingSurface(w, h, { window, clamp: true });
					if (w > TILE) block = s;
					return s;
				});
				expect(set.renderMany(cells)).toBe(9);
				expect(block, 'the nine tiles are painted as one block').not.toBeNull();
				expect(block!.ops, `scale ${scale}, tile ${ti},${tj}`).toEqual(own);
			}
		}
	});
});

describe('damage', () => {
	it('of one painted hex is a few tiles, not the view', () => {
		const scene = new MapScene(syntheticMap(60, 40));
		const set = new TileSet({ epoch: 0, style: 'clean', blend: false, dpr: 1.25 }, 1, scene, painterFor(), tracingSurface);
		for (let j = 0; j < 8; j++) for (let i = 0; i < 14; i++) set.render(i, j); // a 1080p view and more
		edit(scene, [20, -6], { terrain: 'desert', terrainVariant: 0 });
		const dropped = set.catchUp() as [number, number][];
		expect(dropped.length).toBeGreaterThan(0);
		expect(dropped.length).toBeLessThanOrEqual(9);
	});

	it('is unknown past an epoch change, and a set from before starts over', () => {
		const scene = new MapScene(syntheticMap(30, 20));
		const set = new TileSet({ epoch: 0, style: 'clean', blend: false, dpr: 1 }, 1, scene, painterFor(), tracingSurface);
		const rev = scene.revision;
		edit(scene, [5, 0], { terrain: 'desert' });
		expect(scene.damageSince(rev)?.length).toBeGreaterThan(0);
		scene.setOverlays({ ...scene.overlays, gmFog: true });
		expect(scene.damageSince(rev)).toBeNull();
		expect(scene.damageSince(scene.revision)).toEqual([]);
		expect(set.catchUp()).toBe(false);
	});
});
