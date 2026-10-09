// Port of Flutter's lib/importer/classifier_cascade.dart (decisions 12, 12e,
// 12k): TWO INDEPENDENT RECOGNISERS, one per paint layer.
//
// Biome (every hex answers): 0. a confident STAMP match; 1. a learned colour
// prototype (a contradicted one only at close range, 12i); 2. greedy Lab
// clustering (deterministic, ΔE 8); 3. the built-in prior names what is left,
// on GROUP centroids, and may refuse.
// Structure (may answer none): NCC against learned icon templates scaled by
// an edge-density PRIOR; unmatched stamped-looking hexes grouped `icon? N`.
// The per-hex half (gatherEvidence) depends on nothing but the hex; the
// grouping half is order-dependent and serial.

import { PaintPick } from '../core/hex_paint';
import { guessBiome } from './biome_heuristics';
import type { HexSample } from './hex_sampler';
import type { InkDescriptor } from './ink_mask';
import { argbToLab, deltaE, type LabColor } from './lab';
import { normalizePatch, type ColorPrototype, type IconTemplate, type ImportLibraries } from './libraries';
import type { Raster } from './raster';
import { isColdTinted, isWarmTinted, matchCell, variantFor, type BiomePrototype, type StampMatch } from './stamp_recognizer';

export type PaintLayer = 'biome' | 'structure';

export interface CascadeParams {
	iconEdgeFactor: number;
	iconMinDensityGap: number;
	nccThreshold: number;
	colorMatchDeltaE: number;
	contradictedMatchDeltaE: number;
	clusterDeltaE: number;
	unknownIconNcc: number;
	useBuiltinGuesses: boolean;
	structureConfirm: number;
	structureFloor: number;
	densityPriorFloor: number;
	stampConfirm: number;
}

export const DEFAULT_CASCADE: CascadeParams = {
	iconEdgeFactor: 2.5,
	iconMinDensityGap: 0.02,
	nccThreshold: 0.75,
	colorMatchDeltaE: 12,
	contradictedMatchDeltaE: 5,
	clusterDeltaE: 8,
	unknownIconNcc: 0.6,
	useBuiltinGuesses: true,
	structureConfirm: 0.75,
	structureFloor: 0.5,
	densityPriorFloor: 0.6,
	stampConfirm: 0.55,
};

/** In Dart's enum order (the group sort uses it). */
export const MATCH_SOURCES = ['icon', 'stamp', 'knownColor', 'newCluster', 'unsorted'] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];
export const layerOf = (s: MatchSource): PaintLayer => (s === 'icon' || s === 'unsorted' ? 'structure' : 'biome');

export interface CascadeResult {
	sample: HexSample;
	source: MatchSource;
	label: string;
	pick: PaintPick;
	tags: string[];
	confidence: number;
	ink: InkDescriptor | null;
}

export class CascadeGroup {
	readonly members: CascadeResult[] = [];
	confidence = 0;
	/** The biome came from the built-in table: a guess, shown as such and
	 *  never learned as though confirmed (for icons). */
	guessedBiome = false;

	constructor(
		readonly source: MatchSource,
		readonly label: string,
		public pick: PaintPick = PaintPick.nothing,
		readonly tags: string[] = [],
	) {}

	get layer(): PaintLayer {
		return layerOf(this.source);
	}
}

export interface CascadeOutcome {
	biomes: CascadeGroup[];
	structures: CascadeGroup[];
}

export interface HexEvidence {
	sample: HexSample;
	ink: InkDescriptor | null;
	stamp: StampMatch | null;
	biomeLab: LabColor;
	prototype: ColorPrototype | null;
	prototypeDeltaE: number;
	iconPatch: number[];
	iconName: string | null;
	iconPick: PaintPick;
	iconTags: string[];
	iconScore: number;
}

export function gatherEvidence(samples: HexSample[], libraries: ImportLibraries, params: CascadeParams = DEFAULT_CASCADE, inks?: InkDescriptor[]): HexEvidence[] {
	const templates = libraries.icons.map((t): [IconTemplate, number[]] => [t, lumaVector(t.patch)]);
	return samples.map((s, i) => evidenceFor(s, libraries, templates, params, inks && i < inks.length ? inks[i]! : null, libraries.stamps));
}

function evidenceFor(sample: HexSample, libraries: ImportLibraries, templates: [IconTemplate, number[]][], params: CascadeParams, ink: InkDescriptor | null, stampProtos: BiomePrototype[]): HexEvidence {
	const biomeLab = argbToLab(sample.biomeArgb);
	let best: ColorPrototype | null = null;
	let bestD = Infinity;
	for (const proto of libraries.colors) {
		const d = deltaE(biomeLab, proto.color);
		if (d < bestD) {
			bestD = d;
			best = proto;
		}
	}
	// A learned prototype the built-in table CONTRADICTS must be a close
	// match to win (decision 12i).
	if (best && bestD > params.contradictedMatchDeltaE) {
		const builtin = guessBiome(biomeLab);
		if (builtin && builtin.terrain !== best.terrain) {
			best = null;
			bestD = Infinity;
		}
	}
	const patch = lumaVector(normalizePatch(sample.crop));
	let bestIcon: IconTemplate | null = null;
	let bestScore = -Infinity;
	for (const [template, vector] of templates) {
		const score = ncc(patch, vector);
		if (score > bestScore) {
			bestScore = score;
			bestIcon = template;
		}
	}
	return {
		sample,
		biomeLab,
		ink,
		stamp: ink ? matchCell(ink, biomeLab, stampProtos) : null,
		prototype: bestD <= params.colorMatchDeltaE ? best : null,
		prototypeDeltaE: bestD,
		iconPatch: patch,
		iconName: bestIcon?.name ?? null,
		iconPick: bestIcon?.pick ?? PaintPick.nothing,
		iconTags: bestIcon?.tags ?? [],
		iconScore: bestIcon ? bestScore : 0,
	};
}

export function groupEvidence(evidence: HexEvidence[], params: CascadeParams = DEFAULT_CASCADE): CascadeOutcome {
	const prior = densityPrior(evidence, params);
	return { biomes: biomeGroups(evidence, params), structures: structureGroups(evidence, prior, params) };
}

export const runCascade = (samples: HexSample[], libraries: ImportLibraries, params: CascadeParams = DEFAULT_CASCADE, inks?: InkDescriptor[]) =>
	groupEvidence(gatherEvidence(samples, libraries, params, inks), params);

function result(sample: HexSample, source: MatchSource, label: string, extra: Partial<CascadeResult> = {}): CascadeResult {
	return { sample, source, label, pick: PaintPick.nothing, tags: [], confidence: 0, ink: null, ...extra };
}

function biomeGroups(evidence: HexEvidence[], params: CascadeParams): CascadeGroup[] {
	const results: CascadeResult[] = [];
	const stampUnmatched: HexEvidence[] = [];
	// Layer 0: the stamp, only when confident.
	for (const e of evidence) {
		const stamp = e.stamp;
		if (stamp && stamp.confidence >= params.stampConfirm) {
			const variant = e.ink ? variantFor(stamp.terrain, e.biomeLab, e.ink) : stamp.terrainVariant;
			results.push(result(e.sample, 'stamp', stamp.terrain, { pick: PaintPick.biome(stamp.terrain, variant), tags: tintTags(e.biomeLab), confidence: stamp.confidence, ink: e.ink }));
			continue;
		}
		stampUnmatched.push(e);
	}
	// Layer 1: learned colour prototypes.
	const pending: HexEvidence[] = [];
	for (const e of stampUnmatched) {
		const proto = e.prototype;
		if (proto) results.push(result(e.sample, 'knownColor', proto.terrain, { pick: PaintPick.biome(proto.terrain, proto.terrainVariant), confidence: 1 - e.prototypeDeltaE / params.colorMatchDeltaE, ink: e.ink }));
		else pending.push(e);
	}
	// Layer 2: greedy clustering, in arrival order (running-mean centroids).
	const centroids: LabColor[] = [];
	const sizes: number[] = [];
	const clusterOf: [HexSample, number, InkDescriptor | null][] = [];
	for (const e of pending) {
		const lab = e.biomeLab;
		let bestI = -1, bestD = Infinity;
		for (let i = 0; i < centroids.length; i++) {
			const d = deltaE(lab, centroids[i]!);
			if (d < bestD) {
				bestD = d;
				bestI = i;
			}
		}
		if (bestI >= 0 && bestD <= params.clusterDeltaE) {
			const n = sizes[bestI]!, c = centroids[bestI]!;
			centroids[bestI] = { l: (c.l * n + lab.l) / (n + 1), a: (c.a * n + lab.a) / (n + 1), b: (c.b * n + lab.b) / (n + 1) };
			sizes[bestI]!++;
			clusterOf.push([e.sample, bestI, e.ink]);
		} else {
			centroids.push(lab);
			sizes.push(1);
			clusterOf.push([e.sample, centroids.length - 1, e.ink]);
		}
	}
	for (const [sample, i, ink] of clusterOf) results.push(result(sample, 'newCluster', `cluster ${i + 1}`, { ink }));
	const groups = group(results);
	if (params.useBuiltinGuesses) guessMissingBiomes(groups);
	return groups;
}

/** Colour tint as TAGS once the stamp named the biome. */
function tintTags(lab: LabColor): string[] {
	if (isColdTinted(lab)) return ['cold'];
	if (isWarmTinted(lab)) return ['arid'];
	return [];
}

/** Layer 3, after grouping: name what nothing else could, per GROUP. */
function guessMissingBiomes(groups: CascadeGroup[]): void {
	for (const g of groups) {
		if (g.pick.paintsBiome || !g.members.length) continue;
		let l = 0, a = 0, b = 0;
		for (const m of g.members) {
			const lab = argbToLab(m.sample.biomeArgb);
			l += lab.l;
			a += lab.a;
			b += lab.b;
		}
		const n = g.members.length;
		const guess = guessBiome({ l: l / n, a: a / n, b: b / n });
		if (!guess) continue;
		g.pick = g.pick.withBiome(guess.terrain);
		g.guessedBiome = true;
	}
}

/** Edge density → structure confidence multiplier: 1 at the old gate, the
 *  floor at the map's median, interpolated between, never below the floor. */
function densityPrior(evidence: HexEvidence[], params: CascadeParams): (d: number) => number {
	const densities = evidence.map((e) => e.sample.edgeDensity).sort((a, b) => a - b);
	const median = densities.length ? densities[Math.floor(densities.length / 2)]! : 0;
	const gate = Math.max(median * params.iconEdgeFactor, median + params.iconMinDensityGap);
	const span = gate - median;
	return (d) => {
		if (d >= gate || span <= 0) return 1;
		const t = Math.min(1, Math.max(0, (d - median) / span));
		return params.densityPriorFloor + (1 - params.densityPriorFloor) * t;
	};
}

function structureGroups(evidence: HexEvidence[], prior: (d: number) => number, params: CascadeParams): CascadeGroup[] {
	const results: CascadeResult[] = [];
	const unknown: HexEvidence[] = [];
	for (const e of evidence) {
		const confidence = e.iconScore * prior(e.sample.edgeDensity);
		if (e.iconName !== null && e.iconScore >= params.nccThreshold) {
			if (confidence < params.structureFloor) continue;
			results.push(result(e.sample, 'icon', e.iconName, { pick: structureHalf(e.iconPick), tags: e.iconTags, confidence }));
			continue;
		}
		if (prior(e.sample.edgeDensity) >= 1) unknown.push(e);
	}
	const reps: number[][] = [];
	for (const e of unknown) {
		let bestI = -1, bestScore = -Infinity;
		for (let i = 0; i < reps.length; i++) {
			const score = ncc(e.iconPatch, reps[i]!);
			if (score > bestScore) {
				bestScore = score;
				bestI = i;
			}
		}
		if (bestI < 0 || bestScore < params.unknownIconNcc) {
			reps.push(e.iconPatch);
			bestI = reps.length - 1;
		}
		results.push(result(e.sample, 'unsorted', `icon? ${bestI + 1}`));
	}
	return group(results);
}

/** Only the feature half of a template's meaning applies on this layer. */
function structureHalf(pick: PaintPick): PaintPick {
	return pick.feature === null ? PaintPick.nothing : PaintPick.featureOnly(pick.feature, pick.featureVariant);
}

function group(results: CascadeResult[]): CascadeGroup[] {
	const byKey = new Map<string, CascadeGroup>();
	for (const r of results) {
		const key = `${r.source}\u0000${r.label}`;
		let g = byKey.get(key);
		if (!g) byKey.set(key, (g = new CascadeGroup(r.source, r.label, r.pick, r.tags)));
		g.members.push(r);
	}
	for (const g of byKey.values()) g.confidence = g.members.length ? g.members.reduce((a, m) => a + m.confidence, 0) / g.members.length : 0;
	return [...byKey.values()].sort(
		(a, b) => MATCH_SOURCES.indexOf(a.source) - MATCH_SOURCES.indexOf(b.source) || b.members.length - a.members.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
	);
}

export function lumaVector(patch: Raster): number[] {
	const v: number[] = [];
	for (let i = 0; i < patch.data.length; i += 4) v.push(0.299 * patch.data[i]! + 0.587 * patch.data[i + 1]! + 0.114 * patch.data[i + 2]!);
	return v;
}

/** Zero-mean normalised cross-correlation (−1..1); flat vectors give 0. */
export function ncc(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	if (!n) return 0;
	let ma = 0, mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i]!;
		mb += b[i]!;
	}
	ma /= n;
	mb /= n;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) {
		const da = a[i]! - ma, db = b[i]! - mb;
		dot += da * db;
		na += da * da;
		nb += db * db;
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}
