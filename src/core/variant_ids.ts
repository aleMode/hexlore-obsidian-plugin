// Port of Flutter's lib/core/variant_ids.dart (decision 31, plan item 1.6).
//
// In memory a variant is an INDEX (the renderer's tables are index-ordered);
// on disk, from format 2 on, it is an id like "forest/dense". Ids are never
// removed or reused: vendor/variant_ids.lock lists every id ever issued.

import type { Feature, Terrain } from './hex_data';

/** Terrain variant ids, index-aligned with the Dart terrainVariantNames. */
export const terrainVariantIdTable: Partial<Record<Terrain, readonly string[]>> = {
	forest: ['forest/default', 'forest/dense', 'forest/dead'],
	mountain: ['mountain/default', 'mountain/snowy-range'],
	hills: ['hills/default', 'hills/rocky'],
	desert: ['desert/default', 'desert/cracked', 'desert/beach'],
	tundra: ['tundra/default', 'tundra/cracked-ice'],
	swamp: ['swamp/default', 'swamp/dead-trees'],
	plains: ['plains/default', 'plains/fields'],
	volcano: ['volcano/default', 'volcano/caldera'],
};

/** Feature variant ids, index-aligned with the Dart featureVariantNames. */
export const featureVariantIdTable: Record<Feature, readonly string[]> = {
	city: ['city/default', 'city/town', 'city/capital', 'city/walled'],
	settlement: ['settlement/default', 'settlement/tent', 'settlement/village', 'settlement/huts'],
	tower: ['tower/default', 'tower/spire', 'tower/keep', 'tower/flagged'],
	ruins: ['ruins/default', 'ruins/rubble', 'ruins/castle', 'ruins/wall'],
	dungeon: ['dungeon/default', 'dungeon/crypt', 'dungeon/cave', 'dungeon/labyrinth'],
	lookout: ['lookout/default', 'lookout/lighthouse', 'lookout/observatory', 'lookout/hill-fort'],
	mine: ['mine/default', 'mine/miner', 'mine/wagon', 'mine/minerals'],
	well: ['well/default', 'well/fountain', 'well/cistern'],
	pit: ['pit/default', 'pit/spiked', 'pit/ladder', 'pit/excavation'],
	pyre: ['pyre/default', 'pyre/campfire', 'pyre/brazier', 'pyre/fire-shrine'],
	cage: ['cage/default', 'cage/birdcage', 'cage/prisoner', 'cage/bound'],
	flag: ['flag/default', 'flag/pennant', 'flag/heraldic', 'flag/tattered'],
};

/** Every variant id of [terrain]; a biome with one look has only `/default`. */
export function terrainVariantIds(terrain: Terrain): readonly string[] {
	return terrainVariantIdTable[terrain] ?? [`${terrain}/default`];
}

/** Every variant id of [feature]. */
export function featureVariantIds(feature: Feature): readonly string[] {
	return featureVariantIdTable[feature] ?? [`${feature}/default`];
}

/** The id of variant [index], or null when out of range (kept raw, never clamped). */
export function terrainVariantId(terrain: Terrain, index: number): string | null {
	return terrainVariantIds(terrain)[index] ?? null;
}

export function featureVariantId(feature: Feature, index: number): string | null {
	return featureVariantIds(feature)[index] ?? null;
}

/** The index of [id] among [terrain]'s variants, or null for an unknown id. */
export function terrainVariantIndex(terrain: Terrain, id: string): number | null {
	const i = terrainVariantIds(terrain).indexOf(id);
	return i < 0 ? null : i;
}

export function featureVariantIndex(feature: Feature, id: string): number | null {
	const i = featureVariantIds(feature).indexOf(id);
	return i < 0 ? null : i;
}

/**
 * A stored variant — an int index (format 1) or an id (format 2) — as an
 * index, or null when it can't be read as one. Absent means variant 0.
 */
export function readTerrainVariant(terrain: Terrain, stored: unknown): number | null {
	if (stored === undefined || stored === null) return 0;
	if (typeof stored === 'number') {
		return Number.isInteger(stored) && terrainVariantId(terrain, stored) !== null ? stored : null;
	}
	if (typeof stored === 'string') return terrainVariantIndex(terrain, stored);
	return null;
}

export function readFeatureVariant(feature: Feature, stored: unknown): number | null {
	if (stored === undefined || stored === null) return 0;
	if (typeof stored === 'number') {
		return Number.isInteger(stored) && featureVariantId(feature, stored) !== null ? stored : null;
	}
	if (typeof stored === 'string') return featureVariantIndex(feature, stored);
	return null;
}
