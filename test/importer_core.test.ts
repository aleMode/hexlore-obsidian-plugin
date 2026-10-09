import { describe, expect, it } from 'vitest';
import { TERRAINS, terrainColors } from '../src/core/hex_data';
import { BUILTIN_BIOME_PROTOTYPES, guessBiomeArgb, selfConsistent } from '../src/importer/biome_heuristics';
import { SourceGrid, solveGrid, sourceCells } from '../src/importer/grid_calibration';
import { sampleHex, sampleHexes } from '../src/importer/hex_sampler';
import { argbToLab, deltaE } from '../src/importer/lab';
import { dartRound } from '../src/core/geometry';
import { paintMap, rng, stampIcon } from './helpers/importer_synth';

// Mirrors Flutter's importer_calibration_test / importer_sampler_test /
// biome_heuristics_test.
const argb = (hex: string) => (0xff000000 | parseInt(hex.slice(1), 16)) >>> 0;

describe('grid calibration', () => {
	for (const orientation of ['flat', 'pointy'] as const) {
		it(`centerOf / cellAt round-trip (${orientation})`, () => {
			const grid = new SourceGrid(orientation, 37.5, 101.25, 63);
			const rand = rng(7);
			for (let i = 0; i < 200; i++) {
				const q = Math.floor(rand() * 41) - 20, r = Math.floor(rand() * 41) - 20;
				const [cx, cy] = grid.centerOf(q, r);
				expect(grid.cellAt(cx, cy)).toEqual([q, r]);
				const jx = cx + (rand() - 0.5) * 0.8 * grid.radius * 0.5, jy = cy + (rand() - 0.5) * 0.8 * grid.radius * 0.5;
				expect(grid.cellAt(jx, jy)).toEqual([q, r]);
			}
		});

		it(`solveGrid recovers a known grid from two adjacent centres (${orientation})`, () => {
			const truth = new SourceGrid(orientation, 42, 300, 220);
			for (const [nq, nr] of [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]] as const) {
				const a = truth.centerOf(0, 0), b = truth.centerOf(nq, nr);
				const solved = solveGrid(a, b)!;
				expect(solved.orientation).toBe(orientation);
				expect(solved.radius).toBeCloseTo(42, 9);
				expect(solved.originX).toBeCloseTo(300, 9);
				expect(solved.cellAt(...a)).toEqual([0, 0]);
			}
		});
	}

	it('noisy clicks still pick the right orientation; coincident ones are refused', () => {
		const truth = new SourceGrid('pointy', 30, 90, 90);
		const a = truth.centerOf(0, 0), b = truth.centerOf(1, 0);
		const solved = solveGrid([a[0] + 1.5, a[1] - 1], [b[0] - 1, b[1] + 2])!;
		expect(solved.orientation).toBe('pointy');
		expect(Math.abs(solved.radius - 30)).toBeLessThan(3);
		expect(solveGrid([10, 10], [11, 11])).toBeNull();
	});

	it('sourceCells enumerates exactly the cells whose centre is inside', () => {
		const grid = new SourceGrid('flat', 20, 25, 25);
		const cells = sourceCells(grid, 400, 300);
		expect(new Set(cells.map((c) => c.join())).size).toBe(cells.length);
		let expected = 0;
		for (let q = -30; q <= 30; q++) for (let r = -30; r <= 30; r++) {
			const [cx, cy] = grid.centerOf(q, r);
			if (cx >= 0 && cx < 400 && cy >= 0 && cy < 300) expected++;
		}
		expect(cells).toHaveLength(expected);
		const back = SourceGrid.fromJson(new SourceGrid('pointy', 33.25, -12.5, 800).toJson());
		expect([back.orientation, back.radius, back.originX, back.originY]).toEqual(['pointy', 33.25, -12.5, 800]);
	});
});

describe('hex sampler', () => {
	const grid = new SourceGrid('flat', 24, 40, 40);
	const band = (q: number): [number, number, number] => (q < 2 ? [107, 143, 94] : q < 4 ? [184, 201, 138] : [90, 138, 154]);
	const asArgb = ([r, g, b]: [number, number, number]) => (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;

	it('dominant colour is the painted terrain, flat fills have no edges', () => {
		const img = paintMap(grid, 320, 240, band);
		for (const s of sampleHexes(img, grid, sourceCells(grid, 320, 240))) {
			expect(s.dominantArgb).toBe(asArgb(band(s.q)));
			expect(s.edgeDensity).toBeLessThan(0.01);
		}
	});

	it('a stamp raises edge density; the mode stays the terrain', () => {
		const img = paintMap(grid, 320, 240, band);
		stampIcon(img, grid, 2, 2);
		const plain = sampleHex(img, grid, 2, 3), stamped = sampleHex(img, grid, 2, 2);
		expect(stamped.edgeDensity).toBeGreaterThan(plain.edgeDensity * 5 + 0.01);
		expect(stamped.dominantArgb).toBe(plain.dominantArgb);
	});

	it('crops are square and clamped; pointy sources sample as well', () => {
		const img = paintMap(grid, 320, 240, band);
		const inner = sampleHex(img, grid, 3, 2);
		expect([inner.crop.width, inner.crop.height]).toEqual([dartRound(28.8), dartRound(28.8)]);
		const pointy = new SourceGrid('pointy', 24, 40, 40);
		const pimg = paintMap(pointy, 320, 240, band);
		for (const s of sampleHexes(pimg, pointy, sourceCells(pointy, 320, 240))) expect(s.dominantArgb).toBe(asArgb(band(s.q)));
	});
});

describe('the built-in biome prior', () => {
	it('every palette colour classifies back to its own biome; every biome is reachable', () => {
		expect(selfConsistent()).toBe(true);
		const reachable = new Set(BUILTIN_BIOME_PROTOTYPES.map(([, t]) => t));
		for (const t of TERRAINS) if (t !== 'default') expect(reachable.has(t), t).toBe(true);
		for (const [t, hex] of Object.entries(terrainColors)) if (t !== 'default') expect(guessBiomeArgb(argb(hex))?.terrain).toBe(t);
	});

	it('no two biomes’ prototypes sit within ΔE 5', () => {
		let worst = Infinity;
		const P = BUILTIN_BIOME_PROTOTYPES;
		for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
			if (P[i]![1] === P[j]![1]) continue;
			worst = Math.min(worst, deltaE(argbToLab(argb(P[i]![0])), argbToLab(argb(P[j]![0]))));
		}
		expect(worst).toBeGreaterThan(5);
	});

	it('guesses sensibly, refuses furniture and strangers, confidence falls off', () => {
		expect(guessBiomeArgb(argb('#6B8F5E'))?.terrain).toBe('forest');
		expect(guessBiomeArgb(argb('#B8C98A'))?.terrain).toBe('plains');
		expect(guessBiomeArgb(argb('#5A8A9A'))?.terrain).toBe('sea');
		expect(guessBiomeArgb(argb('#556B2F'))?.terrain).toBe('forest');
		expect(guessBiomeArgb(argb('#4682B4'))?.terrain).toBe('lake');
		for (const h of ['#F2EAD8', '#EDE3C8', '#000000', '#8A8A9A', '#7F5AF0', '#FF00FF']) expect(guessBiomeArgb(argb(h)), h).toBeNull();
		const exact = guessBiomeArgb(argb(terrainColors.desert))!, near = guessBiomeArgb(argb('#D6BC8A'))!;
		expect(exact.confidence).toBeCloseTo(1, 2);
		expect(near.confidence).toBeLessThan(exact.confidence);
		expect(guessBiomeArgb(argb('#556B2F'), 2)).toBeNull();
	});
});
