// Port of Flutter's lib/importer/stamp_recognizer.dart (decision 12k): biome
// recognition led by what is DRAWN. A cell is matched against one prototype
// per CONFIRMED CELL (never one per biome: averaging measured 10 points
// worse), scoring shape, colour, orientation and blobs at near-equal weights;
// confidence folds in the margin over the runner-up. Colour then picks the
// variant and the tint TAGS, never a biome.

import { type Terrain, isTerrain, terrainVariantNames } from '../core/hex_data';
import { readTerrainVariant, terrainVariantId } from '../core/variant_ids';
import { blobSimilarity, orientationSimilarity, shapeSimilarity, type InkDescriptor } from './ink_mask';
import { deltaE, type LabColor } from './lab';

export interface StampWeights {
	shape: number;
	color: number;
	orientation: number;
	blobs: number;
}

export const DEFAULT_STAMP_WEIGHTS: StampWeights = { shape: 0.4, color: 0.4, orientation: 0.1, blobs: 0.1 };

export class BiomePrototype {
	constructor(
		readonly terrain: Terrain,
		readonly shape: number[],
		readonly color: LabColor,
		readonly orientation: number[],
		readonly blobCount: number,
		readonly medianBlobArea: number,
		readonly terrainVariant = 0,
	) {}

	get ink(): InkDescriptor {
		return { shape: this.shape, coverage: 0, blobCount: this.blobCount, medianBlobArea: this.medianBlobArea, orientation: this.orientation };
	}

	toJson(): Record<string, unknown> {
		return {
			terrain: this.terrain,
			variant: terrainVariantId(this.terrain, this.terrainVariant) ?? this.terrainVariant,
			l: this.color.l,
			a: this.color.a,
			b: this.color.b,
			blobs: this.blobCount,
			area: this.medianBlobArea,
			orient: this.orientation,
			shape: this.shape.map((v) => Math.min(255, Math.max(0, Math.round(v * 255)))),
		};
	}

	static fromJson(j: Record<string, unknown>): BiomePrototype | null {
		if (typeof j.l !== 'number') return null;
		const terrain: Terrain = isTerrain(j.terrain) ? j.terrain : 'default';
		const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
		return new BiomePrototype(
			terrain,
			nums(j.shape).map((v) => v / 255),
			{ l: j.l, a: Number(j.a), b: Number(j.b) },
			nums(j.orient),
			typeof j.blobs === 'number' ? Math.trunc(j.blobs) : 0,
			typeof j.area === 'number' ? j.area : 0,
			readTerrainVariant(terrain, typeof j.variant === 'number' ? Math.trunc(j.variant) : j.variant) ?? 0,
		);
	}
}

export interface StampMatch {
	terrain: Terrain;
	terrainVariant: number;
	confidence: number;
	/** False when the cell had too little ink: colour alone decided. */
	fromShape: boolean;
}

/** Below this ink coverage the shape terms are skipped. */
export const MIN_SHAPE_COVERAGE = 0.02;
const DELTA_E_FLOOR = 30;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function matchCell(ink: InkDescriptor, color: LabColor, prototypes: BiomePrototype[], weights: StampWeights = DEFAULT_STAMP_WEIGHTS): StampMatch | null {
	if (!prototypes.length) return null;
	const useShape = ink.coverage >= MIN_SHAPE_COVERAGE;
	let bestScore = -Infinity, runnerUp = -Infinity;
	let best: BiomePrototype | null = null;
	for (const p of prototypes) {
		let score = weights.color * clamp01(1 - deltaE(color, p.color) / DELTA_E_FLOOR);
		let used = weights.color;
		if (useShape) {
			score += weights.shape * clamp01((shapeSimilarity(ink.shape, p.shape) + 1) / 2);
			used += weights.shape;
			score += weights.orientation * orientationSimilarity(ink.orientation, p.orientation);
			used += weights.orientation;
			score += weights.blobs * blobSimilarity(ink, p.ink);
			used += weights.blobs;
		}
		score = used === 0 ? 0 : score / used;
		if (score > bestScore) {
			runnerUp = bestScore;
			bestScore = score;
			best = p;
		} else if (score > runnerUp) runnerUp = score;
	}
	if (!best) return null;
	const margin = Number.isFinite(runnerUp) ? clamp01(bestScore - runnerUp) : 1;
	const confidence = clamp01(bestScore * (0.6 + 0.4 * Math.min(margin / 0.15, 1)));
	return { terrain: best.terrain, terrainVariant: best.terrainVariant, confidence, fromShape: useShape };
}

/** The terrain variant from the ink: blob count, or a dominant direction
 *  (ruled fields) for plains. */
export function variantFor(terrain: Terrain, _color: LabColor, ink: InkDescriptor): number {
	const names = terrainVariantNames[terrain];
	if (!names || names.length < 2) return 0;
	switch (terrain) {
		case 'forest':
			return ink.blobCount >= 2 ? 1 : 0;
		case 'mountain':
		case 'hills':
			return ink.blobCount >= 3 ? 1 : 0;
		case 'desert':
		case 'tundra':
			return ink.blobCount >= 4 ? 1 : 0;
		case 'plains':
			return Math.max(0, ...ink.orientation) > 0.34 ? 1 : 0;
		default:
			return 0;
	}
}

export const isColdTinted = (c: LabColor) => c.b < -6;
export const isWarmTinted = (c: LabColor) => c.b > 4;

/** One prototype per confirmed cell. */
export function learnPrototypes(confirmed: [Terrain, number, InkDescriptor, LabColor][]): BiomePrototype[] {
	return confirmed.map(([t, v, ink, color]) => new BiomePrototype(t, ink.shape, color, ink.orientation, ink.blobCount, ink.medianBlobArea, v));
}

/** The cells just confirmed on THIS map as exemplars for the rest of it
 *  (the same hand, by construction). */
export function bootstrapFromConfirmed(
	confirmed: [Terrain, number, InkDescriptor, LabColor][],
	pending: Map<string, [InkDescriptor, LabColor]>,
	minConfidence = 0.55,
	weights: StampWeights = DEFAULT_STAMP_WEIGHTS,
): Map<string, StampMatch> {
	const out = new Map<string, StampMatch>();
	if (!confirmed.length) return out;
	const protos = learnPrototypes(confirmed);
	for (const [cell, [ink, color]] of pending) {
		const m = matchCell(ink, color, protos, weights);
		if (m && m.confidence >= minConfidence) out.set(cell, m);
	}
	return out;
}

/** Bound the library at save time: per (biome, variant) drop near-duplicate
 *  exemplars (newest kept), at most [perBiomeCap] each. */
export function compactPrototypes(protos: BiomePrototype[], redundantSimilarity = 0.97, perBiomeCap = 24): BiomePrototype[] {
	const byBiome = new Map<string, BiomePrototype[]>();
	for (const p of protos) {
		const k = `${p.terrain}/${p.terrainVariant}`;
		(byBiome.get(k) ?? byBiome.set(k, []).get(k)!).push(p);
	}
	const out: BiomePrototype[] = [];
	for (const members of byBiome.values()) {
		const kept: BiomePrototype[] = [];
		for (const p of [...members].reverse()) {
			const redundant = kept.some((k) => shapeSimilarity(p.shape, k.shape) > redundantSimilarity && deltaE(p.color, k.color) < 2);
			if (!redundant) kept.push(p);
			if (kept.length >= perBiomeCap) break;
		}
		out.push(...kept.reverse());
	}
	return out;
}

/** Neighbour smoothing (implemented, UNMEASURED — decision 12k): only an
 *  unsure answer may yield, and only to a strongly agreed neighbourhood.
 *  Keys are "q,r". */
export function smoothWithNeighbors(matches: Map<string, StampMatch>, maxConfidence = 0.55, minAgreeing = 4): Map<string, StampMatch> {
	const DIRS = [
		[1, 0],
		[1, -1],
		[0, -1],
		[-1, 0],
		[-1, 1],
		[0, 1],
	] as const;
	const out = new Map<string, StampMatch>();
	for (const [cell, match] of matches) {
		if (match.confidence > maxConfidence) {
			out.set(cell, match);
			continue;
		}
		const [q, r] = cell.split(',').map(Number) as [number, number];
		const votes = new Map<Terrain, number>();
		for (const [dq, dr] of DIRS) {
			const n = matches.get(`${q + dq},${r + dr}`);
			if (n) votes.set(n.terrain, (votes.get(n.terrain) ?? 0) + 1);
		}
		let winner: Terrain | null = null, top = 0;
		for (const [t, c] of votes) {
			if (c > top) {
				top = c;
				winner = t;
			}
		}
		out.set(cell, winner !== null && top >= minAgreeing && winner !== match.terrain ? { terrain: winner, terrainVariant: 0, confidence: maxConfidence, fromShape: match.fromShape } : match);
	}
	return out;
}
