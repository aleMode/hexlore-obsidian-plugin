// Port of Flutter's lib/core/hex_data.dart: the terrain and feature tables.
// The hex model itself is in hex.ts.

/** Biomes, in the Dart enum's order. Values are the strings persisted on disk. */
export const TERRAINS = [
	'forest',
	'plains',
	'mountain',
	'sea',
	'hills',
	'desert',
	'swamp',
	'tundra',
	'lake',
	'jungle',
	'volcano',
	'default',
] as const;
export type Terrain = (typeof TERRAINS)[number];

/** Icon-only features stamped over the biome, in the Dart enum's order. */
export const FEATURES = [
	'city',
	'settlement',
	'tower',
	'ruins',
	'dungeon',
	'lookout',
	'mine',
	'well',
	'pit',
	'pyre',
	'cage',
	'flag',
] as const;
export type Feature = (typeof FEATURES)[number];

export function isTerrain(v: unknown): v is Terrain {
	return typeof v === 'string' && (TERRAINS as readonly string[]).includes(v);
}

export function isFeature(v: unknown): v is Feature {
	return typeof v === 'string' && (FEATURES as readonly string[]).includes(v);
}

/** Fill colour per biome: the single source of truth for the palette. */
export const terrainColors: Record<Terrain, string> = {
	forest: '#30472E',
	plains: '#C3CE8E',
	mountain: '#9C9187',
	sea: '#2F5F70',
	hills: '#728459',
	desert: '#E0C48F',
	swamp: '#4E5F3F',
	tundra: '#CFD9E0',
	lake: '#3A7DBF',
	jungle: '#2D6B3C',
	volcano: '#8B3A1A',
	default: '#8A8A9A',
};

/**
 * Pre-split files stored structures AS terrain. On read they become a feature,
 * with the old fill kept as a colour override so the map looks the same.
 */
export const legacyTerrainFeatures: Record<string, [Feature, string]> = {
	city: ['city', '#C8A96E'],
	dungeon: ['dungeon', '#5A5A6E'],
	ruins: ['ruins', '#9A7A6E'],
	tower: ['tower', '#6B5B8C'],
};

/** Canonical hex id for an axial coordinate, e.g. `q0_r0`, `q-1_r2`. */
export function hexIdFor(q: number, r: number): string {
	return `q${q}_r${r}`;
}

/** Display labels of each biome's variants (index-aligned with the ids). */
export const terrainVariantNames: Partial<Record<Terrain, readonly string[]>> = {
	forest: ['Normal', 'Dense', 'Dead'],
	mountain: ['Peak', 'Snowy range'],
	hills: ['Rolling', 'Rocky'],
	desert: ['Dunes', 'Cracked', 'Beach'],
	tundra: ['Snowfield', 'Cracked ice'],
	swamp: ['Reeds', 'Dead trees'],
	plains: ['Grass', 'Fields'],
	volcano: ['Volcano', 'Caldera'],
};

/** Display labels of each feature's variants. */
export const featureVariantNames: Record<Feature, readonly string[]> = {
	city: ['City', 'Town', 'Capital', 'Walled'],
	settlement: ['Camp', 'Tent', 'Village', 'Huts'],
	tower: ['Square', 'Spire', 'Keep', 'Flagged'],
	ruins: ['Columns', 'Rubble', 'Castle', 'Wall'],
	dungeon: ['Gate', 'Crypt', 'Cave', 'Labyrinth'],
	lookout: ['Watchtower', 'Lighthouse', 'Observatory', 'Hill fort'],
	mine: ['Entrance', 'Miner', 'Wagon', 'Minerals'],
	well: ['Well', 'Fountain', 'Cistern'],
	pit: ['Pit', 'Spiked', 'Ladder', 'Excavation'],
	pyre: ['Pyre', 'Campfire', 'Brazier', 'Fire shrine'],
	cage: ['Cage', 'Birdcage', 'Prisoner', 'Bound'],
	flag: ['Banner', 'Pennant', 'Heraldic', 'Tattered'],
};
