import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { gridPixelBounds } from '../src/core/geometry';
import { syntheticMap } from '../src/dev/synthetic';
import { MapCanvas } from '../src/render/map_canvas';
import { LOD_FULL, LOD_MED, MapPainter, regionInk } from '../src/render/painter';
import { MapScene, type MapData, type MapStyle } from '../src/render/scene';
import { TextureCache } from '../src/render/textures';
import { TILE, TileSet, tilesCovering } from '../src/render/tiles';
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

describe('texture atlas', () => {
	const view = (scale: number): [number, number, number, number] => [3000, 1700, 3000 + 1920 / scale, 1700 + 1080 / scale];
	const ill = (scale: number, dpr = 1) => ({ style: 'illustrated' as const, blend: false, scale, dpr, rect: view(scale) });

	it('packs sprites and texture slices into shared pages', () => {
		let sizes: [number, number][] = [];
		const p = new MapPainter(
			new TextureCache((w, h) => {
				sizes.push([w, h]);
				return fakeSurface(new Map(), w, h);
			}, (h) => SPEC.parseHex(h)),
		);
		const s = new MapScene(syntheticMap(100, 100));
		p.paint(recordingContext(new Map()), s, { ...ill(1), style: 'clean' });
		expect(p.textures.made).toBeGreaterThan(5);
		expect(sizes).toEqual([[2048, 2048], [512, 512]]); // every stamp in one page, and the CPU canvas
		sizes = [];
		const before = p.textures.made;
		p.paint(recordingContext(new Map()), s, ill(1));
		expect(p.textures.made - before).toBeGreaterThan(20);
		expect(sizes.every(([w, h]) => w === 2048 && h === 2048)).toBe(true); // pages only
	});

	it('draws rasters in software and copies their pixels in, or on the GPU', () => {
		const run = (cpu: boolean) => {
			const pages: Counts = new Map(), cpuSide: Counts = new Map();
			const t = new TextureCache((w, h) => fakeSurface(w === 2048 ? pages : cpuSide, w, h), (h) => SPEC.parseHex(h));
			t.cpuRaster = cpu;
			new MapPainter(t).paint(recordingContext(new Map()), new MapScene(syntheticMap(100, 100)), ill(1));
			return { pages, cpuSide, made: t.made };
		};
		const cpu = run(true);
		expect(cpu.pages.get('putImageData')).toBe(cpu.made); // one copy per raster
		expect(cpu.pages.get('fill') ?? 0).toBe(0); // nothing drawn in the page itself
		expect(cpu.cpuSide.get('fill') ?? 0).toBeGreaterThan(100);
		expect(cpu.cpuSide.get('getImageData')).toBe(cpu.made);
		const gpu = run(false);
		expect(gpu.pages.get('putImageData') ?? 0).toBe(0);
		expect(gpu.pages.get('fill') ?? 0).toBeGreaterThan(100);
	});

	it('makes everything a paint draws before drawing any of it', () => {
		// Writing into a page a draw of the same paint had used cost a flush
		// of the page per raster (the benchmark: 150 ms between frames).
		const log: [unknown, string][] = [];
		const props: () => Record<string | symbol, unknown> = () => ({});
		const tracking = (id: unknown): CanvasRenderingContext2D =>
			new Proxy(props(), {
				get(t, key) {
					if (key in t) return t[key];
					if (key === 'measureText') return (x: string) => ({ width: x.length * 6 });
					return (...args: unknown[]) => {
						log.push([key === 'drawImage' ? args[0] : id, String(key)]);
						return { addColorStop() {} };
					};
				},
				set(t, key, v) {
					t[key] = v;
					return true;
				},
			}) as unknown as CanvasRenderingContext2D;
		const p = new MapPainter(
			new TextureCache((w, h) => {
				const surface: { width: number; height: number; getContext: () => CanvasRenderingContext2D } = { width: w, height: h, getContext: () => ctx };
				const ctx = tracking(surface);
				return surface;
			}, (h) => SPEC.parseHex(h)),
		);
		const s = new MapScene(syntheticMap(100, 100));
		for (const params of [ill(1), { ...ill(1), blend: true }, { ...ill(1), style: 'clean' as const }]) {
			p.textures.clear();
			log.length = 0;
			p.paint(tracking('target'), s, params);
			const drawnFrom = new Set<unknown>();
			let late = 0;
			for (const [who, op] of log) {
				if (op === 'drawImage') drawnFrom.add(who);
				else if (drawnFrom.has(who)) late++;
			}
			expect(drawnFrom.size).toBeGreaterThan(0);
			expect(late).toBe(0);
		}
	});

	it('draws Clean stamps once, as sprites, then blits them', () => {
		const p = painter(new Map());
		const s = new MapScene(syntheticMap(100, 100));
		const clean = { ...ill(1), style: 'clean' as const };
		p.paint(recordingContext(new Map()), s, clean);
		const made = p.textures.made;
		expect(made).toBeGreaterThan(5); // one per stamp look, not per hex
		const second: Counts = new Map();
		p.paint(recordingContext(second), s, clean);
		expect(p.textures.made).toBe(made);
		expect(second.get('drawImage') ?? 0).toBeGreaterThan(100); // a stamp per painted hex
		expect(second.get('stroke') ?? 0).toBeLessThan(20); // edges, rivers, roads — no glyph halos
	});

	it('puts sprites in eighth-octave zoom buckets, never enlarged', () => {
		for (const k of [0.3, 1, 1.05, 1.25, 2.7]) {
			const b = TextureCache.spriteBucket(k);
			expect(b).toBeGreaterThanOrEqual(k - 1e-9);
			expect(b / k).toBeLessThan(2 ** (1 / 8) + 1e-9);
		}
		expect(TextureCache.spriteBucket(1)).toBe(1);
	});

	it('makes each blend strip once, not on every paint', () => {
		const p = painter(new Map());
		const s = new MapScene(syntheticMap(100, 100));
		const params = { ...ill(1), blend: true };
		const first: Counts = new Map(), second: Counts = new Map();
		p.paint(recordingContext(first), s, params);
		p.paint(recordingContext(second), s, params);
		expect(first.get('createLinearGradient') ?? 0).toBeGreaterThan(100);
		expect(second.get('createLinearGradient') ?? 0).toBeLessThan(20); // river mouths' fades only
	});

	it('holds a whole 1080p view, with its prefetched ring, without evicting', () => {
		// With 2 pages (the first default) Illustrated + Blend at zoom 1 evicted
		// pages every frame and drew them again: 350 ms frames.
		const p = painter(new Map());
		const s = new MapScene(syntheticMap(100, 100));
		const ring: [number, number, number, number] = [2800, 1500, 2800 + 2600, 1500 + 1500]; // the view and a tile around it
		const params = { style: 'illustrated' as const, blend: true, scale: 1, dpr: 1.25, rect: ring };
		p.paint(recordingContext(new Map()), s, params);
		const made = p.textures.made;
		p.paint(recordingContext(new Map()), s, params);
		expect(p.textures.made).toBe(made);
	});

	it('stays within its page limit, evicting whole pages', () => {
		const counts: Counts = new Map();
		const p = new MapPainter(new TextureCache((w, h) => fakeSurface(counts, w, h), (h) => SPEC.parseHex(h), 1));
		const s = new MapScene(syntheticMap(100, 100));
		for (const x of [0, 2500, 5000]) {
			p.paint(recordingContext(counts), s, { ...ill(1), rect: [x, 1700, x + 1920, 2780] });
			p.textures.beginPaint();
			expect(p.textures.pageCount).toBeLessThanOrEqual(2);
		}
	});

	it('keeps its resolution and LOD until the zoom is clearly past them', () => {
		const t = new TextureCache((w, h) => fakeSurface(new Map(), w, h), (h) => SPEC.parseHex(h));
		expect(t.resolution(48, 1.25)).toEqual({ px: 64, lod: 2 });
		expect(t.resolution(64, 1.25).px).toBe(64); // 80 device px: 1.25× up, kept
		expect(t.resolution(70, 1.25).px).toBe(128); // 87.5: past 1.3×
		expect(t.resolution(40, 1.25).px).toBe(128); // 50 px: 2.56× down, kept
		expect(t.resolution(30, 1.25).px).toBe(64); // past 2.6×
		const l = new TextureCache((w, h) => fakeSurface(new Map(), w, h), (h) => SPEC.parseHex(h));
		expect(l.resolution(23, 1).lod).toBe(1);
		expect(l.resolution(36, 1).lod).toBe(1); // under 34 × 1.15: kept
		expect(l.resolution(40, 1).lod).toBe(2);
		expect(l.resolution(31, 1).lod).toBe(2); // over 34 / 1.15 = 29.6: kept
		expect(l.resolution(29, 1).lod).toBe(1);
		expect(l.resolution(20, 1).lod).toBe(1); // over 22 / 1.15 = 19.1
		expect(l.resolution(18, 1).lod).toBe(0);
	});

	it('draws stand-ins past a frame’s budget, and marks the tile soft', () => {
		const counts: Counts = new Map();
		const tex = new TextureCache((w, h) => fakeSurface(counts, w, h), (h) => SPEC.parseHex(h));
		const p = new MapPainter(tex);
		const s = new MapScene(syntheticMap(60, 40));
		const at = (scale: number) => new TileSet({ epoch: 0, style: 'illustrated', blend: false, dpr: 1 }, scale, s, p, (w, h) => fakeSurface(counts, w, h));
		at(1).render(4, 4); // textures at 64 px
		const made = tex.made;
		tex.beginFrame(0);
		const zoomed = at(2); // 96 px: past 1.3× of 64 → 128 px, none made yet
		zoomed.render(8, 8); // inside the scale-1 tile (4, 4)
		expect(tex.made).toBe(made); // nothing new: the 64 px rasters stood in
		expect(tex.soft).toBeGreaterThan(0);
		expect(zoomed.isSoft(8, 8)).toBe(true);
		tex.beginFrame(1000);
		zoomed.render(8, 8); // inside the scale-1 tile (4, 4)
		expect(zoomed.isSoft(8, 8)).toBe(false);
		expect(tex.made).toBeGreaterThan(made);
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

	it('redraws only the tiles a hex edit touches, in the same frame', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		const [q, r] = canvas.cellAt(960, 540)!;
		scene.setHex({ ...scene.hexAt(q, r)!, terrain: 'desert' });
		win.advance(16);
		const edited = canvas.frame();
		expect(edited.mode).toBe('tiles');
		expect(edited.tilesRendered).toBeGreaterThan(0);
		expect(edited.tilesRendered).toBeLessThanOrEqual(9); // of the view's 40
		// An edit out of view (and past the prefetched ring) renders nothing now.
		for (let i = 0; i < 200; i++) {
			win.advance(16);
			canvas.frame();
		}
		scene.setHex({ ...scene.hexAt(2, 0)!, terrain: 'desert' });
		win.advance(16);
		expect(canvas.frame().tilesRendered).toBe(0);
	});

	it('renders directly after a change it cannot localise, then tiles again', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		scene.setOverlays({ ...scene.overlays, gmFog: true });
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

	it('redoes the overview bands an edit touched, while idle', () => {
		const { canvas, win, scene } = setup();
		const idle = () => {
			const work: (string | null)[] = [];
			for (let i = 0; i < 200; i++) {
				win.advance(16);
				work.push(canvas.frame().background);
			}
			return work;
		};
		const bands = idle().filter((w) => w === 'overview').length;
		const [q, r] = canvas.cellAt(960, 540)!;
		scene.setHex({ ...scene.hexAt(q, r)!, terrain: 'desert' });
		const redone = idle().filter((w) => w === 'overview').length;
		expect(redone).toBeGreaterThan(0);
		expect(redone).toBeLessThan(bands);
	});

	it('does not treat a new scene as an edit', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		scene.setOverlays({ ...scene.overlays, gmFog: true });
		win.advance(16);
		expect(canvas.frame().mode).toBe('direct');
		canvas.setScene(new MapScene(syntheticMap(60, 40)));
		win.advance(16);
		expect(canvas.frame().mode).toBe('tiles');
	});

	it('does idle work in idle callbacks, after the frame, when the browser has them', () => {
		const counts: Counts = new Map();
		const win = new FakeWindow();
		const idle: ((d: { timeRemaining(): number; didTimeout: boolean }) => void)[] = [];
		Object.assign(win, { requestIdleCallback: (cb: (typeof idle)[number]) => idle.push(cb) });
		const canvas = new MapCanvas(fakeHost(counts, 1920, 1080), win as unknown as Window, (w, h) => fakeSurface(counts, w, h));
		canvas.setScene(new MapScene(syntheticMap(60, 40)));
		canvas.resize();
		canvas.camera = { scale: 1, ox: -1000, oy: -800 };
		canvas.frame();
		win.advance(16);
		const f = canvas.frame();
		expect(f.background).toBeNull(); // nothing in the frame itself
		expect(idle.length).toBe(1);
		let budget = 3; // three pieces fit this idle period
		idle.shift()!({ timeRemaining: () => (budget-- > 0 ? 10 : 0), didTimeout: false });
		expect(idle.length).toBe(1); // more to do: asked again
	});

	it('makes a ring tile\'s textures a frame\'s worth at a time, before the tile', () => {
		const { canvas, win } = setup();
		canvas.setStyle('illustrated', false);
		canvas.frame();
		const work: (string | null)[] = [];
		for (let i = 0; i < 400; i++) {
			win.advance(16);
			const made = canvas.texturesMade;
			const s = canvas.frame();
			work.push(s.background);
			if (s.background === 'textures') expect(s.tilesRendered).toBe(0);
			expect(canvas.texturesMade - made).toBeLessThanOrEqual(8); // a cold tile alone needs more
		}
		expect(work).toContain('textures');
		expect(work.filter((w) => w === 'prefetch').length).toBeGreaterThan(10); // the ring still fills
	});

	it('does one piece of idle work per idle callback', () => {
		const counts: Counts = new Map();
		const win = new FakeWindow();
		const idle: ((d: { timeRemaining(): number; didTimeout: boolean }) => void)[] = [];
		Object.assign(win, { requestIdleCallback: (cb: (typeof idle)[number]) => idle.push(cb) });
		const canvas = new MapCanvas(fakeHost(counts, 1920, 1080), win as unknown as Window, (w, h) => fakeSurface(counts, w, h));
		canvas.setScene(new MapScene(syntheticMap(60, 40)));
		canvas.setStyle('illustrated', false);
		canvas.resize();
		canvas.camera = { scale: 1, ox: -1000, oy: -800 };
		canvas.frame();
		win.advance(16);
		canvas.frame();
		const made = canvas.texturesMade;
		idle.shift()!({ timeRemaining: () => 50, didTimeout: false }); // a long idle period
		expect(canvas.texturesMade - made).toBeLessThanOrEqual(8);
		expect(idle.length).toBe(1); // the rest in later callbacks
	});

	it('pre-warms textures only once the camera is still', () => {
		const { canvas, win } = setup();
		canvas.setStyle('illustrated', false);
		const work: (string | null)[] = [];
		for (let i = 0; i < 150; i++) {
			win.advance(16);
			canvas.panBy(-2, 0); // a slow pan: the ring keeps up, idle work runs
			work.push(canvas.frame().background);
		}
		expect(work).toContain('prefetch');
		expect(work).not.toContain('warm');
		win.advance(600); // the pan stops
		const still: (string | null)[] = [];
		for (let i = 0; i < 200; i++) {
			win.advance(16);
			still.push(canvas.frame().background);
		}
		expect(still).toContain('warm');
	});

	it('draws tiles at once for a map opened with its overlays applied', () => {
		// The view sets a new scene, then applies the GM's overlays to it.
		const { canvas, win } = setup();
		const scene = new MapScene(syntheticMap(60, 40));
		canvas.setScene(scene);
		scene.setOverlays({ ...scene.overlays, gmFog: true });
		win.advance(16);
		expect(canvas.frame().mode).toBe('tiles');
	});

	it('keeps its tiles when the same overlays are applied again', () => {
		const { canvas, win, scene } = setup();
		canvas.frame();
		const epoch = scene.epoch;
		scene.setOverlays({ ...scene.overlays, hiddenRegions: new Set(scene.overlays.hiddenRegions) });
		expect(scene.epoch).toBe(epoch);
		win.advance(16);
		const f = canvas.frame();
		expect(f.mode).toBe('tiles');
		expect(f.tilesRendered).toBeLessThanOrEqual(1); // at most the idle prefetch
	});

	it('never zooms out past the medium level of detail', () => {
		const { canvas } = setup();
		for (let i = 0; i < 60; i++) canvas.zoomAt(960, 540, 1 / 1.15);
		expect(canvas.camera.scale * 48).toBeGreaterThanOrEqual(LOD_MED - 1e-9);
	});
});
