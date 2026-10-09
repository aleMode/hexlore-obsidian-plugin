import { describe, expect, it } from 'vitest';
import { PaintPick } from '../src/core/hex_paint';
import { DEFAULT_CASCADE, gatherEvidence, groupEvidence, runCascade, type CascadeGroup, type MatchSource } from '../src/importer/classifier_cascade';
import { SourceGrid, sourceCells } from '../src/importer/grid_calibration';
import { sampleHex, sampleHexes } from '../src/importer/hex_sampler';
import { argbToLab, deltaE } from '../src/importer/lab';
import { ImportLibraries, normalizePatch } from '../src/importer/libraries';
import { PNG_PATCHES } from '../src/importer/png_codec';
import type { Raster } from '../src/importer/raster';
import { paintMap, stampIcon, stampRingIcon } from './helpers/importer_synth';

// Mirrors Flutter's test/importer_cascade_test.dart.
const grid = new SourceGrid('flat', 24, 40, 40);
const FOREST: [number, number, number] = [107, 143, 94];
const PLAINS: [number, number, number] = [184, 201, 138];
const SEA: [number, number, number] = [90, 138, 154];
const band = (q: number): [number, number, number] => (q < 2 ? FOREST : q < 4 ? PLAINS : SEA);
const argbOf = ([r, g, b]: [number, number, number]) => (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
const sampleAll = (g: SourceGrid, img: Raster) => sampleHexes(img, g, sourceCells(g, img.width, img.height));
const groupOf = (groups: CascadeGroup[], source: MatchSource, label?: string) => groups.find((g) => g.source === source && (label === undefined || g.label === label))!;
const cells = (g: CascadeGroup) => new Set(g.members.map((m) => `${m.sample.q},${m.sample.r}`));

describe('Lab colour space', () => {
	it('anchors L and separates greens from blues', () => {
		expect(argbToLab(0xffffffff).l).toBeCloseTo(100, 1);
		expect(argbToLab(0xff000000).l).toBeCloseTo(0, 1);
		const a = argbToLab(argbOf(FOREST));
		expect(deltaE(a, argbToLab(argbOf([110, 148, 97])))).toBeLessThan(5);
		expect(deltaE(a, argbToLab(argbOf(SEA)))).toBeGreaterThan(15);
	});
});

describe('the cascade with empty libraries', () => {
	const stamped = () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		stampIcon(img, grid, 4, 1);
		return img;
	};

	it('bands become three colour-pure clusters; the stamps one icon? group', () => {
		const out = runCascade(sampleAll(grid, stamped()), new ImportLibraries());
		const clusters = out.biomes.filter((g) => g.source === 'newCluster');
		expect(clusters).toHaveLength(3);
		for (const c of clusters) expect(new Set(c.members.map((m) => band(m.sample.q).join()))).toHaveProperty('size', 1);
		expect(cells(groupOf(out.structures, 'unsorted', 'icon? 1'))).toEqual(new Set(['2,2', '4,1']));
		expect(out.structures).toHaveLength(1);
	});

	it('every hex gets ONE biome, the stamped ones too, from around the stamp', () => {
		const img = stamped();
		const total = sampleAll(grid, img).length;
		const out = runCascade(sampleAll(grid, img), new ImportLibraries());
		const biomeCells = out.biomes.flatMap((g) => g.members.map((m) => `${m.sample.q},${m.sample.r}`));
		expect(biomeCells).toHaveLength(total);
		expect(new Set(biomeCells).size).toBe(total);
		const holder = out.biomes.find((g) => cells(g).has('2,2'))!;
		for (const m of holder.members) expect(band(m.sample.q)).toEqual(band(2));
		expect(holder.members.length).toBeGreaterThan(1);
	});
});

describe('learning', () => {
	it('learned colours are recognised next time', () => {
		const lib = new ImportLibraries();
		lib.learnColor(argbOf(FOREST), 'forest');
		lib.learnColor(argbOf(SEA), 'sea');
		const out = runCascade(sampleAll(grid, paintMap(grid, 320, 240, band)), lib);
		const forest = groupOf(out.biomes, 'knownColor', 'forest');
		expect(forest.pick.equals(PaintPick.biome('forest'))).toBe(true);
		for (const m of forest.members) {
			expect(band(m.sample.q)).toEqual(FOREST);
			expect(m.confidence).toBeGreaterThan(0.9);
		}
		const clusters = out.biomes.filter((g) => g.source === 'newCluster');
		expect(clusters).toHaveLength(1);
		expect(band(clusters[0]!.members[0]!.sample.q)).toEqual(PLAINS);
	});

	it('a learned icon matches its stamp elsewhere, not other icons', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		stampIcon(img, grid, 3, 1);
		stampRingIcon(img, grid, 4, 1);
		const lib = new ImportLibraries();
		lib.learnIcon(sampleHex(img, grid, 2, 2).crop, 'skull', PaintPick.nothing, ['danger']);
		const out = runCascade(sampleAll(grid, img), lib, { ...DEFAULT_CASCADE, useBuiltinGuesses: false });
		const skulls = groupOf(out.structures, 'icon', 'skull');
		expect(skulls.tags).toEqual(['danger']);
		expect(skulls.pick.isEmpty).toBe(true);
		expect(cells(skulls).has('2,2') && cells(skulls).has('3,1')).toBe(true);
		expect(cells(skulls).has('4,1')).toBe(false);
		const unknown = out.structures.filter((g) => g.source === 'unsorted');
		expect(unknown).toHaveLength(1);
		expect(cells(unknown[0]!).has('4,1')).toBe(true);
	});

	it('distinct unknown icons split into separate groups', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 1, 1);
		stampIcon(img, grid, 2, 3);
		stampRingIcon(img, grid, 4, 1);
		const unknown = runCascade(sampleAll(grid, img), new ImportLibraries()).structures.filter((g) => g.source === 'unsorted');
		expect(unknown).toHaveLength(2);
		const bySize = [...unknown].sort((a, b) => b.members.length - a.members.length);
		expect(cells(bySize[0]!)).toEqual(new Set(['1,1', '2,3']));
		expect(cells(bySize[1]!)).toEqual(new Set(['4,1']));
	});
});

describe('libraries', () => {
	it('round-trip through JSON and still classify', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		const lib = new ImportLibraries();
		lib.learnColor(argbOf(FOREST), 'forest');
		lib.learnIcon(sampleHex(img, grid, 2, 2).crop, 'skull', PaintPick.biome('swamp'), ['danger']);
		const loaded = ImportLibraries.fromJson(JSON.parse(JSON.stringify(lib.toJson(PNG_PATCHES))), PNG_PATCHES);
		expect(loaded.colors.map((c) => c.terrain)).toEqual(['forest']);
		expect(loaded.icons[0]!.pick.equals(PaintPick.biome('swamp'))).toBe(true);
		expect(loaded.icons[0]!.tags).toEqual(['danger']);
		stampIcon(img, grid, 3, 3);
		const skulls = groupOf(runCascade(sampleAll(grid, img), loaded).structures, 'icon', 'skull');
		expect(cells(skulls).has('2,2') && cells(skulls).has('3,3')).toBe(true);
		expect(ImportLibraries.fromJson('nonsense', PNG_PATCHES).icons).toEqual([]);
	});

	it('read a library written before features and variants', () => {
		const g = new SourceGrid('flat', 20, 30, 30);
		const img = paintMap(g, 200, 160, () => FOREST);
		stampIcon(img, g, 2, 2);
		const legacy = ImportLibraries.fromJson(
			{
				colors: [{ color: argbToLab(argbOf(FOREST)), terrain: 'forest' }],
				icons: [{ name: 'skull', patch_png: PNG_PATCHES.encode(normalizePatch(sampleHex(img, g, 2, 2).crop)), terrain: 'swamp', tags: ['danger'] }],
			},
			PNG_PATCHES,
		);
		expect(legacy.colors[0]!.terrainVariant).toBe(0);
		expect(legacy.icons[0]!.pick.equals(PaintPick.biome('swamp'))).toBe(true);
		expect(groupOf(runCascade(sampleAll(g, img), legacy).structures, 'icon', 'skull').members.length).toBeGreaterThan(0);
	});

	it('learning is corrective: a conflicting colour is evicted', () => {
		const lib = new ImportLibraries();
		lib.learnColor(argbOf(FOREST), 'forest');
		const displaced = lib.learnColor(argbOf([110, 146, 96]), 'hills');
		expect(displaced.map((p) => p.terrain)).toEqual(['forest']);
		expect(lib.colors.map((c) => c.terrain)).toEqual(['hills']);
		lib.colors.push({ color: argbToLab(argbOf(FOREST)), terrain: 'forest', terrainVariant: 0 });
		expect(lib.pruneConflicts()).toBe(1);
		expect(lib.colors.map((c) => c.terrain)).toEqual(['forest']); // the newest survives
	});
});

describe('the parallel split', () => {
	it('chunked evidence groups exactly like the serial run', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		stampRingIcon(img, grid, 4, 1);
		const samples = sampleAll(grid, img);
		const lib = new ImportLibraries();
		lib.learnColor(argbOf(FOREST), 'forest');
		const serial = runCascade(samples, lib);
		for (const workers of [2, 3, 5, 7]) {
			const size = Math.ceil(samples.length / workers);
			const ev = [];
			for (let s = 0; s < samples.length; s += size) ev.push(...gatherEvidence(samples.slice(s, s + size), lib));
			const par = groupEvidence(ev);
			expect(par.biomes.map((g) => [g.label, [...cells(g)].join()])).toEqual(serial.biomes.map((g) => [g.label, [...cells(g)].join()]));
			expect(par.structures).toHaveLength(serial.structures.length);
		}
	});
});

describe('structure confidence', () => {
	it('only real matches clear the floor; an icon never proposes a biome', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		stampIcon(img, grid, 3, 1);
		const lib = new ImportLibraries();
		lib.learnIcon(sampleHex(img, grid, 2, 2).crop, 'tower', PaintPick.biome('hills').withFeature('tower'));
		const out = runCascade(sampleAll(grid, img), lib, { ...DEFAULT_CASCADE, useBuiltinGuesses: false });
		const towers = groupOf(out.structures, 'icon', 'tower');
		expect(towers.confidence).toBeGreaterThanOrEqual(DEFAULT_CASCADE.structureFloor);
		expect(towers.pick.feature).toBe('tower');
		expect(towers.pick.paintsBiome).toBe(false);
		expect(new Set(out.structures.flatMap((g) => [...cells(g)]))).toEqual(new Set(['2,2', '3,1']));
	});
});
