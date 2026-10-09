import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { printLayout, printPages } from '../src/core/export_layout';
import { Hex } from '../src/core/hex';
import { toPlain, type JsonObject } from '../src/core/json';
import { MapModel } from '../src/core/map';
import { filterCampaignForPlayer } from '../src/core/player_filter';
import { Region } from '../src/core/region';
import { Thread } from '../src/core/thread';
import { exportCredits, exportPdf, exportPng, exportScene, type ImageExportOptions } from '../src/render/image_export';
import { playersSceneData } from '../src/render/players_scene';
import { DEFAULT_OVERLAYS } from '../src/render/scene';
import { sceneDataFromModel } from '../src/render/scene_from_model';
import { fakeSurface, installPath2D, type Counts } from './helpers/fake_canvas';

// A 1×1 transparent PNG: what the fake surfaces "encode" to.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

function gmModel(): MapModel {
	const m = new MapModel();
	m.meta.name = 'Purezza';
	const add = (q: number, r: number, f: (h: Hex) => void) => {
		const h = new Hex(q, r);
		f(h);
		m.hexes.set(h.id, h);
	};
	add(0, 0, (h) => {
		h.terrain = 'forest';
		h.name = 'Shown';
	});
	add(1, 0, (h) => {
		h.terrain = 'mountain';
		h.feature = 'tower';
		h.name = 'Dragon lair';
		h.featureHidden = true;
	});
	add(2, 0, (h) => {
		h.terrain = 'plains';
		h.name = 'Unrevealed secret';
	});
	m.revealed.add('q0_r0');
	m.revealed.add('q1_r0');
	const g = new Region('region_001');
	g.name = 'Cult lands';
	g.cells = [[0, 0]];
	m.regions.set(g.id, g);
	m.threads.set('thread_001', new Thread('thread_001', 'q0_r0', 'q1_r0'));
	return m;
}

const options = (o: Partial<ImageExportOptions> = {}): ImageExportOptions => ({
	format: 'png',
	version: 'players',
	style: 'clean',
	blend: false,
	area: 'grid',
	pxPerHex: 64,
	print: printLayout({ hexWidthMm: 12 }),
	dpi: 100,
	...o,
});

beforeAll(() => installPath2D());

describe('the Players version (secrecy, plan 1.14 / 2.10)', () => {
	it('is built from the filter payload: nothing the filter did not serve', () => {
		const data = playersSceneData(toPlain(filterCampaignForPlayer(gmModel())) as JsonObject, 2);
		expect(data.hexes.map((h) => `${h.q},${h.r}`).sort()).toEqual(['0,0', '1,0']);
		const lair = data.hexes.find((h) => h.q === 1)!;
		expect(lair.feature).toBeNull(); // hidden feature…
		expect(lair.name).toBeNull(); // …takes its name with it
		expect(data.regions).toEqual([]);
		expect(data.threads).toEqual([]);
		expect(JSON.stringify(data)).not.toContain('Unrevealed secret');
		expect(JSON.stringify(data)).not.toContain('Dragon lair');
		expect(JSON.stringify(data)).not.toContain('Cult lands');
	});
});

describe('rendering', () => {
	const src = (m = gmModel()) => ({ data: sceneDataFromModel(m), overlays: DEFAULT_OVERLAYS, mapScale: m.meta.scale, name: m.meta.name });

	it('a PNG is the map plus a footer strip, at the asked size', async () => {
		const counts: Counts = new Map();
		let size: [number, number] = [0, 0];
		const res = await exportPng(src(), options(), (w, h) => {
			if (!size[0]) size = [w, h];
			return fakeSurface(counts, w, h);
		}, async () => PNG);
		expect(res.bytes).toBe(PNG);
		const rect = exportScene(gmModel().meta.grid, 'grid');
		expect(size[0]).toBe(Math.ceil(rect[2] * (64 / 96)));
		expect(size[1]).toBeGreaterThan(Math.ceil(rect[3] * (64 / 96))); // + the footer
		expect(counts.get('fillText') ?? 0).toBeGreaterThan(0); // credits, scale bar
	});

	it('a PDF has one page per print page, labelled', async () => {
		const o = options({ format: 'pdf', print: printLayout({ hexWidthMm: 40, overlapMm: 10 }) });
		const res = await exportPdf(src(), o, (w, h) => fakeSurface(new Map(), w, h), async () => PNG);
		const pdf = await PDFDocument.load(res.bytes);
		const want = printPages(exportScene(gmModel().meta.grid, 'grid'), o.print).length;
		expect(want).toBeGreaterThan(1);
		expect(pdf.getPageCount()).toBe(want);
		expect(pdf.getTitle()).toBe('Purezza');
	});

	it('credits name the icon authors, and the textures only when used', () => {
		expect(exportCredits('clean')).toMatch(/^Icons: game-icons\.net, by .+ \(CC BY 3\.0\) {2}· {2}Made with HexLore$/);
		expect(exportCredits('illustrated')).toContain('Textures:');
	});
});
