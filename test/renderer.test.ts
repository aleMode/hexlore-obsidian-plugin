import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { gridPixelBounds } from '../src/core/geometry';
import { syntheticMap } from '../src/dev/synthetic';
import { MapCanvas } from '../src/render/map_canvas';
import { LOD_FULL, LOD_MED, MapPainter, regionInk } from '../src/render/painter';
import { MapScene, type MapData, type MapStyle } from '../src/render/scene';
import { TextureCache } from '../src/render/textures';
import { TILE, tilesCovering } from '../src/render/tiles';
import { SPEC } from '../src/render/vendor';
import { MapModel } from '../src/core/map';
import { sceneDataFromModel } from '../src/render/scene_from_model';
import { LAYERS, LAYER_FILES, applyFile } from '../src/storage/map_codec';
import { FakeWindow, fakeHost, fakeSurface, installPath2D, recordingContext, type Counts } from './helpers/fake_canvas';

beforeAll(installPath2D);

/** purezza from the dev vault, through the real codec (skipped when absent). */
function vaultMap(): MapData | null {
	const dir = new URL('../test-vault/purezza.hexlore/', import.meta.url);
	if (!existsSync(dir)) return null;
	const m = new MapModel();
	const read = (rel: string) => (existsSync(new URL(rel, dir)) ? readFileSync(new URL(rel, dir), 'utf8') : null);
	for (const layer of LAYERS) {
		const text = read(LAYER_FILES[layer]);
		if (text !== null || layer === 'meta') applyFile(m, { layer }, text, 'purezza');
	}
	for (const f of readdirSync(new URL('paint/', dir))) applyFile(m, { chunk: f }, read(`paint/${f}`), 'purezza');
	return sceneDataFromModel(m);
}

function painter(counts: Counts) {
	return new MapPainter(new TextureCache((w, h) => fakeSurface(counts, w, h), (h) => SPEC.parseHex(h)));
}

/** Paint the scene rect a 1920×1080 view covers at [scale], centred on the map. */
function paintView(scene: MapScene, style: MapStyle, blend: boolean, scale: number, counts: Counts) {
	const c = recordingContext(counts);
	const w = 1920 / scale, h = 1080 / scale;
	const [gx, gy, gw, gh] = gridPixelBounds(scene.grid);
	const cx = gx + gw / 2, cy = gy + gh / 2;
	painter(counts).paint(c, scene, { style, blend, scale, dpr: 1, rect: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
}

const maps: [string, () => MapData | null][] = [
	['synthetic 100×100', () => syntheticMap(100, 100)],
	['purezza (test-vault)', vaultMap],
];

describe.each(maps)('painting %s', (_name, load) => {
	const data = load();
	it.skipIf(!data)('draws every style at every level of detail', () => {
		for (const scale of [1, 0.3, 0.1]) {
			for (const [style, blend] of [['clean', false], ['illustrated', false], ['illustrated', true]] as const) {
				const counts: Counts = new Map();
				paintView(new MapScene(data!), style, blend, scale, counts);
				expect(counts.get('fill') ?? 0, `${style} ${blend} ${scale}`).toBeGreaterThan(0);
			}
		}
	});
});

describe('painter', () => {
	const scene = () => new MapScene(syntheticMap(100, 100));

	it('visits only the cells in view, not the whole map', () => {
		const counts: Counts = new Map();
		paintView(scene(), 'clean', false, 1, counts);
		// ~30 × 16 cells on screen, with the one-cell pad; the map has 10 000.
		expect(counts.get('fill')!).toBeLessThan(1500);
	});

	it('draws labels at full detail only', () => {
		const full: Counts = new Map(), medium: Counts = new Map();
		paintView(scene(), 'clean', false, LOD_FULL / 48 + 0.05, full);
		paintView(scene(), 'clean', false, LOD_MED / 48 + 0.05, medium);
		expect(full.get('fillText') ?? 0).toBeGreaterThan(0);
		expect(medium.get('fillText') ?? 0).toBe(0);
	});

	it('draws Illustrated textures through the cache, reusing them', () => {
		const counts: Counts = new Map();
		const p = painter(counts);
		const s = scene();
		const c = recordingContext(counts);
		const params = { style: 'illustrated' as const, blend: false, scale: 1, dpr: 1, rect: [3000, 1700, 4000, 2300] as [number, number, number, number] };
		p.paint(c, s, params);
		const made = p.textures.made;
		expect(made).toBeGreaterThan(0);
		p.paint(c, s, params);
		expect(p.textures.made).toBe(made); // the second frame drew none
	});
});

describe('GM overlays', () => {
	it('draws regions, threads and GM fog, and hides them when asked', () => {
		const data = syntheticMap(30, 20);
		data.regions = [{ id: 'region_001', name: 'North', color: '#204060', zOrder: 0, cells: [[2, 0], [3, 0], [3, 1]] }];
		data.threads = [
			{ id: 'thread_001', from: 'q2_r0', to: 'q8_r-1', label: 'Rumour', color: '#E05555', colorKey: '#E05555', status: 'dormant', direction: 'one-way' },
			{ id: 'thread_002', from: 'q8_r-1', to: 'q2_r0', label: '', color: '#5580E0', colorKey: '#5580E0', status: 'active', direction: 'bidirectional' },
		];
		const scene = new MapScene(data);
		scene.setOverlays({ ...scene.overlays, gmFog: true });
		const shown: Counts = new Map();
		const rect: [number, number, number, number] = [0, -200, 900, 600];
		painter(shown).paint(recordingContext(shown), scene, { style: 'clean', blend: false, scale: 1, dpr: 1, rect });
		expect(scene.threadShapes().size).toBe(2);
		scene.setOverlays({ ...scene.overlays, threads: false, regions: false, gmFog: false });
		expect(scene.threadShapes().size).toBe(0);
		const hidden: Counts = new Map();
		painter(hidden).paint(recordingContext(hidden), scene, { style: 'clean', blend: false, scale: 1, dpr: 1, rect });
		expect(shown.get('stroke')!).toBeGreaterThan(hidden.get('stroke')!);
	});

	it('lifts a dark region colour so it reads on dark ground', () => {
		expect(regionInk('#E8E8E8')).toBe('#E8E8E8'); // light enough: untouched
		const lifted = regionInk('#204060');
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16) / 255) as [number, number, number];
		expect((Math.max(r, g, b) + Math.min(r, g, b)) / 2).toBeCloseTo(0.62, 2);
	});
});

describe('tiles', () => {
	it('cover the viewport exactly', () => {
		const tiles = tilesCovering(1920, 1080, -100, -50, 1);
		const is = new Set(tiles.map(([i]) => i)), js = new Set(tiles.map(([, j]) => j));
		expect(Math.min(...is) * TILE - 100).toBeLessThanOrEqual(0);
		expect((Math.max(...is) + 1) * TILE - 100).toBeGreaterThanOrEqual(1920);
		expect(Math.min(...js) * TILE - 50).toBeLessThanOrEqual(0);
		expect((Math.max(...js) + 1) * TILE - 50).toBeGreaterThanOrEqual(1080);
		expect(tiles).toHaveLength(is.size * js.size);
	});
});

describe('map canvas frames', () => {
	function setup() {
		const counts: Counts = new Map();
		const win = new FakeWindow();
		const canvas = new MapCanvas(fakeHost(counts, 1920, 1080), win as unknown as Window, (w, h) => fakeSurface(counts, w, h));
		const scene = new MapScene(syntheticMap(60, 40));
		canvas.setScene(scene);
		canvas.resize();
		canvas.camera = { scale: 1, ox: -1000, oy: -800 };
		return { canvas, win, scene };
	}

	it('draws tiles, renders only what scrolls in, and stretches while zooming', () => {
		const { canvas, win } = setup();
		const first = canvas.frame();
		expect(first.mode).toBe('tiles');
		win.advance(16);
		canvas.panBy(-5, 0);
		expect(canvas.frame().mode).toBe('tiles');

		canvas.zoomAt(960, 540, 1.15);
		win.advance(16);
		const zooming = canvas.frame();
		expect(zooming.mode).toBe('stretch');
		expect(zooming.tilesRendered).toBe(0); // a zoom preview renders nothing

		win.advance(400); // the wheel is quiet: a set at the new zoom fills in
		const settled = canvas.frame();
		expect(settled.mode).toBe('tiles');
		expect(settled.tilesRendered).toBeGreaterThan(0);
	});

	it('renders directly while the scene is being edited, then tiles again', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		const h = scene.hexAt(10, 0)!;
		scene.setHex({ ...h, terrain: 'desert' });
		win.advance(16);
		expect(canvas.frame().mode).toBe('direct');
		win.advance(400);
		expect(canvas.frame().mode).toBe('tiles');
	});

	it('does idle work one piece per frame: the ring first, then the overview in bands', () => {
		const { canvas, win } = setup();
		canvas.frame();
		const work: (string | null)[] = [];
		for (let i = 0; i < 200; i++) {
			win.advance(16);
			const s = canvas.frame();
			work.push(s.background);
			if (s.background === 'prefetch') expect(s.tilesRendered).toBe(1);
		}
		const first = work.indexOf('overview');
		expect(work.indexOf('prefetch')).toBeLessThan(first);
		expect(work.slice(first).includes('prefetch')).toBe(false);
		expect(work.filter((w) => w === 'overview').length).toBeGreaterThan(1); // banded
		expect(work[work.length - 1]).toBeNull(); // then the view is idle
	});

	it('does not treat a new scene as an edit', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		scene.setHex({ ...scene.hexAt(10, 0)!, terrain: 'desert' });
		win.advance(16);
		expect(canvas.frame().mode).toBe('direct');
		canvas.setScene(new MapScene(syntheticMap(60, 40)));
		win.advance(16);
		expect(canvas.frame().mode).toBe('tiles');
	});

	it('never zooms out past the medium level of detail', () => {
		const { canvas } = setup();
		for (let i = 0; i < 60; i++) canvas.zoomAt(960, 540, 1 / 1.15);
		expect(canvas.camera.scale * 48).toBeGreaterThanOrEqual(LOD_MED - 1e-9);
	});
});
