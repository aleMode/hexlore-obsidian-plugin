// Port of Flutter's lib/importer/biome_heuristics.dart (decision 12d): the
// built-in PRIOR — Lab prototypes, several per biome (a biome is a RANGE in
// map art), seeded from HexLore's own fills plus the muted bands real maps
// land in. It ranks below the learned library, runs on GROUP centroids only,
// and may say nothing: parchment, ink and the unpainted grey are refusals.
// The table is the Dart one, value for value (see the Dart file for why each
// band is there and why cool rock-grey is deliberately absent).

import { terrainColors, type Terrain } from '../core/hex_data';
import { argbToLab, deltaE, type LabColor } from './lab';

export const GUESS_MAX_DELTA_E = 30;

export interface BiomeGuess {
	terrain: Terrain;
	confidence: number;
}

export const BUILTIN_BIOME_PROTOTYPES: readonly [string, Terrain | null][] = [
	['#2F5F70', 'sea'],
	['#1E4A63', 'sea'],
	['#35708C', 'sea'],
	['#5A8A9A', 'sea'],
	['#24566B', 'sea'],
	['#787675', 'sea'],
	['#8A8785', 'sea'],
	['#696766', 'sea'],
	['#9AA3A8', 'sea'],
	['#3A7DBF', 'lake'],
	['#4E93CC', 'lake'],
	['#6FA9D6', 'lake'],
	['#30472E', 'forest'],
	['#4F7A46', 'forest'],
	['#6B8F5E', 'forest'],
	['#2C5530', 'forest'],
	['#8A8459', 'forest'],
	['#7A754B', 'forest'],
	['#6E6B45', 'forest'],
	['#2D6B3C', 'jungle'],
	['#1F5A2E', 'jungle'],
	['#35804A', 'jungle'],
	['#C3CE8E', 'plains'],
	['#B8C98A', 'plains'],
	['#D2D89C', 'plains'],
	['#A8BC77', 'plains'],
	['#A5A894', 'plains'],
	['#728459', 'hills'],
	['#7E9160', 'hills'],
	['#8A9668', 'hills'],
	['#98873F', 'hills'],
	['#857A38', 'hills'],
	['#A2924A', 'hills'],
	['#4E5F3F', 'swamp'],
	['#5C6B48', 'swamp'],
	['#43533A', 'swamp'],
	['#E0C48F', 'desert'],
	['#D9B97E', 'desert'],
	['#E8D3A5', 'desert'],
	['#C9A96B', 'desert'],
	['#9E8D61', 'desert'],
	['#B39A6E', 'desert'],
	['#B89C82', 'desert'],
	['#A88A75', 'desert'],
	['#C4A48C', 'desert'],
	['#9C9187', 'mountain'],
	['#8C8078', 'mountain'],
	['#A89C92', 'mountain'],
	['#7A7069', 'mountain'],
	['#B5ABA2', 'mountain'],
	['#CFD9E0', 'tundra'],
	['#E2E9EE', 'tundra'],
	['#BFCBD4', 'tundra'],
	['#F0F4F6', 'tundra'],
	['#BBC4C7', 'tundra'],
	['#839BA6', 'tundra'],
	['#8B3A1A', 'volcano'],
	['#A34A22', 'volcano'],
	['#6E2C14', 'volcano'],
	['#C25A2A', 'volcano'],
	['#F2EAD8', null],
	['#E8DCC0', null],
	['#1A1A1A', null],
	['#8A8A9A', null],
];

const argbOf = (hex: string) => (0xff000000 | parseInt(hex.slice(1), 16)) >>> 0;
const PROTOTYPES: [LabColor, Terrain | null][] = BUILTIN_BIOME_PROTOTYPES.map(([h, t]) => [argbToLab(argbOf(h)), t]);

/** The nearest built-in biome, or null (a refusal won, or nothing is near). */
export function guessBiome(color: LabColor, maxDeltaE = GUESS_MAX_DELTA_E): BiomeGuess | null {
	let best: Terrain | null = null, bestD = Infinity;
	for (const [proto, terrain] of PROTOTYPES) {
		const d = deltaE(color, proto);
		if (d < bestD) {
			bestD = d;
			best = terrain;
		}
	}
	if (best === null || bestD > maxDeltaE) return null;
	return { terrain: best, confidence: 1 - bestD / maxDeltaE };
}

export const guessBiomeArgb = (argb: number, maxDeltaE = GUESS_MAX_DELTA_E) => guessBiome(argbToLab(argb), maxDeltaE);

/** HexLore's own fills guess back to themselves (an exported map re-imports exactly). */
export function selfConsistent(): boolean {
	for (const [t, hex] of Object.entries(terrainColors) as [Terrain, string][]) {
		if (t === 'default') continue;
		if (guessBiome(argbToLab(argbOf(hex)))?.terrain !== t) return false;
	}
	return true;
}
