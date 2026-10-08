// A synthetic worst-case map for the renderer benchmark: every cell of a
// cols × rows window painted, features, names, rivers and roads sprinkled
// deterministically (hash2), so every run is identical.

import { terrainVariantIds, featureVariantIds } from '../core/variant_ids';
import type { Feature, Terrain } from '../core/hex_data';
import { hash2, hashUnit } from '../core/map_palette';
import type { Anchor, MapData, SceneHex } from '../render/scene';

const FEATURE_POOL: Feature[] = ['city', 'settlement', 'tower', 'ruins', 'dungeon', 'mine', 'well'];
const DIRS: [number, number][] = [
	[1, 0],
	[1, -1],
	[0, -1],
	[-1, 0],
	[-1, 1],
	[0, 1],
];

/** Smooth value noise in 0..1, from hash2 on a coarse lattice. */
function noise(q: number, u: number, salt: number, cell = 9): number {
	const x = q / cell, y = u / cell;
	const x0 = Math.floor(x), y0 = Math.floor(y);
	const fx = x - x0, fy = y - y0;
	const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
	const v = (a: number, b: number) => hashUnit(a, b, salt);
	const top = v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx;
	const bottom = v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx;
	return top * (1 - sy) + bottom * sy;
}

function biome(height: number, wet: number): Terrain {
	if (height < 0.28) return 'sea';
	if (height < 0.32) return wet > 0.5 ? 'lake' : 'desert';
	if (height > 0.82) return wet > 0.6 ? 'tundra' : 'volcano';
	if (height > 0.7) return 'mountain';
	if (height > 0.6) return 'hills';
	if (wet > 0.68) return 'swamp';
	if (wet > 0.55) return 'jungle';
	if (wet > 0.38) return 'forest';
	if (wet < 0.22) return 'desert';
	return 'plains';
}

export function syntheticMap(cols = 100, rows = 100): MapData {
	const hexes: SceneHex[] = [];
	const inMap = new Set<string>();
	for (let q = 0; q < cols; q++) {
		const rStart = -Math.floor(q / 2);
		for (let r = rStart; r < rStart + rows; r++) {
			const u = r + Math.floor(q / 2);
			const terrain = biome(noise(q, u, 1), noise(q, u, 2, 13));
			const pick = hash2(q, r, 3);
			const water = terrain === 'sea' || terrain === 'lake';
			const feature = !water && pick % 33 === 0 ? FEATURE_POOL[pick % FEATURE_POOL.length]! : null;
			hexes.push({
				q,
				r,
				name: !water && hash2(q, r, 4) % 97 === 0 ? `Place ${q}.${u}` : null,
				terrain,
				terrainVariant: hash2(q, r, 5) % terrainVariantIds(terrain).length,
				feature,
				featureVariant: feature ? hash2(q, r, 6) % featureVariantIds(feature).length : 0,
				featureHidden: false,
				colorOverride: null,
				hasContent: true,
			});
			inMap.add(`${q},${r}`);
		}
	}
	// Rivers and roads: random walks over neighbouring hex centres.
	const walk = (seed: number, length: number): Anchor[] => {
		let q = 5 + (hash2(seed, 0, 7) % (cols - 10));
		let r = -Math.floor(q / 2) + 5 + (hash2(seed, 0, 8) % (rows - 10));
		let dir = hash2(seed, 0, 9) % 6;
		const pts: Anchor[] = [['c', q, r, 0]];
		for (let i = 1; i < length; i++) {
			const turn = hash2(seed, i, 10) % 5;
			if (turn === 0) dir = (dir + 1) % 6;
			else if (turn === 1) dir = (dir + 5) % 6;
			const [dq, dr] = DIRS[dir]!;
			if (!inMap.has(`${q + dq},${r + dr}`)) break;
			q += dq;
			r += dr;
			pts.push(['c', q, r, 0]);
		}
		return pts;
	};
	const kinds = ['highway', 'road', 'road', 'trail', 'trail', 'trail', 'border'];
	return {
		name: `Synthetic ${cols}×${rows}`,
		format: 2,
		grid: { minQ: 0, cols, rows, rShift: 0 },
		hexes,
		rivers: Array.from({ length: 10 }, (_, i) => ({ id: `river_${i}`, width: 1, anchors: walk(100 + i, 45) })),
		routes: kinds.map((kind, i) => ({
			id: `route_${i}`,
			kind,
			color: kind === 'border' ? '#8B1E3F' : '#6B4A2F',
			width: 1,
			playerVisible: kind !== 'border',
			anchors: walk(200 + i, 70),
		})),
	};
}
