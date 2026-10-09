import { describe, expect, it } from 'vitest';
import { PaintPick } from '../src/core/hex_paint';
import { planImport } from '../src/core/import_plan';
import { MapEditor } from '../src/edit/editor';
import { DEFAULT_CASCADE } from '../src/importer/classifier_cascade';
import { SourceGrid } from '../src/importer/grid_calibration';
import { ImportSession, RiverDraft, classifyImage, drawnRiver } from '../src/importer/import_session';
import { ImportLibraries } from '../src/importer/libraries';
import { UnderlayConfig } from '../src/importer/underlay';
import { axialToPixel } from '../src/core/geometry';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { paintMap, stampIcon } from './helpers/importer_synth';
import { MemoryFs } from './helpers/memory_fs';

// Mirrors Flutter's importer_session_test / importer_underlay_test.
const truth = new SourceGrid('flat', 24, 40, 40);
const FOREST: [number, number, number] = [107, 143, 94];
const SEA: [number, number, number] = [90, 138, 154];
const twoBands = (q: number): [number, number, number] => (q < 3 ? FOREST : SEA);

describe('the import session', () => {
	it('end to end: calibrate → classify → decide → apply → learn', async () => {
		const image = paintMap(truth, 320, 240, twoBands);
		stampIcon(image, truth, 1, 1);
		const session = new ImportSession(image);
		const a = truth.centerOf(0, 0), b = truth.centerOf(1, 0);
		expect(session.calibrate([a[0] + 1, a[1] - 1], [b[0], b[1] + 1])).toBe(true);
		expect(session.grid!.orientation).toBe('flat');
		expect(session.cellCount).toBeGreaterThan(20);
		const lib = new ImportLibraries();
		session.adoptGroups(classifyImage(image, session.grid!, lib, { ...DEFAULT_CASCADE, useBuiltinGuesses: false }));
		expect(session.groups.filter((g) => g.source === 'newCluster')).toHaveLength(2);
		expect(session.ready).toBe(false);
		for (const g of session.groups) {
			const d = session.decisionOf(g);
			if (g.source === 'newCluster') d.pick = PaintPick.biome(twoBands(g.members[0]!.sample.q) === FOREST ? 'forest' : 'sea');
			if (g.source === 'unsorted') {
				d.pick = PaintPick.biome('forest');
				d.tags = ['danger'];
				d.iconName = 'skull';
			}
		}
		expect(session.ready).toBe(true);
		session.anchor = [2, 3];
		const entries = session.buildEntries();
		expect(entries).toHaveLength(session.biomeGroups.reduce((n, g) => n + g.members.length, 0));
		expect(new Set(entries.map((e) => `${e.q},${e.r}`)).size).toBe(entries.length);
		expect(Math.min(...entries.map((e) => e.q))).toBe(2);
		expect(Math.min(...entries.map((e) => e.r))).toBe(3);

		// Apply through the editor.
		const fs = new MemoryFs(Object.fromEntries(encodeAll(fixtureMap())));
		const store = await MapStore.open(fs, 'X', { set: () => 0, clear: () => {} });
		const editor = new MapEditor(store);
		const plan = planImport({ entries, mode: 'overwrite', autoResize: true, currentWindow: store.model.meta.grid, existingCells: [...store.model.hexes.values()].map((h): [number, number] => [h.q, h.r]), occupiedCells: new Set() });
		const out = editor.applyImport(plan);
		expect(out.skippedOutside).toBe(0);
		const [dq, dr] = session.cellOffset;
		const stamped = store.model.getHex(1 + dq, 1 + dr)!;
		expect(stamped.terrain).toBe('forest');
		expect(stamped.tags).toContain('danger');

		session.learnConfirmed(lib);
		expect(lib.colors).toHaveLength(2);
		expect(lib.icons.map((i) => i.name)).toEqual(['skull']);
		const rerun = classifyImage(image, session.grid!, lib);
		expect(rerun.biomes.filter((g) => g.source === 'newCluster')).toEqual([]);
		expect(rerun.structures.filter((g) => g.source === 'unsorted')).toEqual([]);
		expect(rerun.structures.filter((g) => g.source === 'icon')).toHaveLength(1);
	});

	it('an override beats both layers and rescues a skipped cell', () => {
		const image = paintMap(truth, 200, 160, () => FOREST);
		const s = new ImportSession(image);
		s.grid = truth;
		s.adoptGroups(classifyImage(image, truth, new ImportLibraries()));
		for (const g of s.groups) s.decisionOf(g).skip = true;
		s.overrides.set('1,1', PaintPick.biome('swamp'));
		const entries = s.buildEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.pick.terrain).toBe('swamp');
	});

	it('drawn rivers snap to the lattice, cut and trim', () => {
		const pts: [number, number][] = [];
		for (let x = 40; x <= 200; x += 5) pts.push([x, 60]);
		const d = drawnRiver(pts, truth)!;
		expect(d.vertices.length).toBeGreaterThan(3);
		const halves = d.cutLink(Math.floor(d.vertices.length / 2));
		expect(halves).toHaveLength(2);
		expect(new RiverDraft(d.vertices.slice(0, 2), 1).cutLink(0)).toEqual([]);
	});
});

describe('the underlay transform', () => {
	for (const orientation of ['flat', 'pointy'] as const) {
		it(`image hex centres land on campaign centres (${orientation})`, () => {
			const grid = new SourceGrid(orientation, 31, 77, 42.5);
			const cfg = new UnderlayConfig(grid, [3, -2], [-1, 2]);
			const [a, b, c, d, tx, ty] = cfg.sceneTransform();
			for (const [sq, sr] of [[-1, 2], [0, 0], [4, -3], [7, 5], [2, 2]] as const) {
				const [ix, iy] = grid.centerOf(sq, sr);
				const [ex, ey] = axialToPixel(3 + sq + 1, -2 + sr - 2);
				expect(a * ix + b * iy + tx).toBeCloseTo(ex, 6);
				expect(c * ix + d * iy + ty).toBeCloseTo(ey, 6);
			}
		});
	}

	it('round-trips through JSON', () => {
		const cfg = new UnderlayConfig(new SourceGrid('pointy', 20, 1, 2), [5, 6], [-2, 0]);
		const back = UnderlayConfig.fromJson(JSON.parse(JSON.stringify(cfg.toJson())) as Record<string, unknown>)!;
		expect(back.sceneTransform()).toEqual(cfg.sceneTransform());
	});
});
