// The ART REGISTRY (obsidian-plugin-plan.md §1.7): the one place that knows
// which drawing stands for (biome | feature, variant). The renderer asks it;
// the brush menu, the credits and the texture cache keys derive from it.
//
// Variants are addressed by INDEX in memory (the tables are index-ordered)
// and by ID on disk (core/variant_ids.ts). The registry binds the two: every
// entry carries its variant id, which is what cache keys use, so reordering a
// table later can't make a cache serve the wrong art.
//
// Built-in art only for now. Packs (deferred) would register more entries.

import {
	FEATURES,
	TERRAINS,
	featureVariantNames,
	terrainVariantNames,
	type Feature,
	type Terrain,
} from '../core/hex_data';
import { featureVariantIds, terrainVariantIds } from '../core/variant_ids';
import { PROCEDURAL_STAMPS, type ProceduralStamp } from './procedural';
import {
	FEATURE_GLYPHS,
	TERRAIN_GLYPHS,
	TEXTURES,
	type Credit,
	type Glyph,
	type GlyphTable,
	type TextureVariant,
} from './vendor';

export type Stamp =
	| { kind: 'glyph'; id: string; table: GlyphTable; glyph: Glyph }
	| { kind: 'procedural'; id: string; draw: ProceduralStamp };

/** One variant as the brush menu lists it. */
export interface VariantEntry {
	id: string;
	label: string;
}

export interface BiomeArt {
	terrain: Terrain;
	variants: VariantEntry[];
	/** Clean style: the stamp per variant (null: the biome is fill-only). */
	stamps: (Stamp | null)[];
	/** Illustrated style: the ground texture per variant (null: none yet). */
	textures: (TextureVariant | null)[];
}

export interface FeatureArt {
	feature: Feature;
	variants: VariantEntry[];
	glyphs: (Stamp & { kind: 'glyph' })[];
}

/** Index-aligned lookups; an index out of range falls back to variant 0. */
function at<T>(list: readonly T[], index: number): T | undefined {
	return list[index >= 0 && index < list.length ? index : 0];
}

export class ArtRegistry {
	private readonly biomes = new Map<Terrain, BiomeArt>();
	private readonly features = new Map<Feature, FeatureArt>();
	private readonly creditList: Credit[] = [];

	registerBiome(art: BiomeArt): void {
		this.biomes.set(art.terrain, art);
	}

	registerFeature(art: FeatureArt): void {
		this.features.set(art.feature, art);
	}

	registerCredits(credits: Credit[]): void {
		for (const c of credits) {
			if (!this.creditList.some((x) => x.name === c.name)) this.creditList.push(c);
		}
	}

	biome(terrain: Terrain): BiomeArt | undefined {
		return this.biomes.get(terrain);
	}

	feature(feature: Feature): FeatureArt | undefined {
		return this.features.get(feature);
	}

	/** The Clean-style stamp of (terrain, variant), or null. */
	biomeStamp(terrain: Terrain, variant: number): Stamp | null {
		const b = this.biomes.get(terrain);
		return b ? (at(b.stamps, variant) ?? null) : null;
	}

	/** The Illustrated ground texture of (terrain, variant), or null. */
	texture(terrain: Terrain, variant: number): TextureVariant | null {
		const b = this.biomes.get(terrain);
		return b ? (at(b.textures, variant) ?? null) : null;
	}

	/** The variant id of (terrain, variant) — the texture cache keys on it. */
	biomeVariantId(terrain: Terrain, variant: number): string {
		const b = this.biomes.get(terrain);
		return (b && at(b.variants, variant)?.id) ?? `${terrain}/default`;
	}

	/** The glyph of (feature, variant), or null. */
	featureGlyph(feature: Feature, variant: number): (Stamp & { kind: 'glyph' }) | null {
		const f = this.features.get(feature);
		return f ? (at(f.glyphs, variant) ?? null) : null;
	}

	/** Every biome / feature in palette order, for the brush menu. */
	allBiomes(): BiomeArt[] {
		return TERRAINS.map((t) => this.biomes.get(t)).filter((b): b is BiomeArt => !!b);
	}

	allFeatures(): FeatureArt[] {
		return FEATURES.map((f) => this.features.get(f)).filter((f): f is FeatureArt => !!f);
	}

	credits(): readonly Credit[] {
		return this.creditList;
	}
}

/** The registry of the art that ships with the plugin. */
export function builtInArt(): ArtRegistry {
	const reg = new ArtRegistry();
	for (const terrain of TERRAINS) {
		const ids = terrainVariantIds(terrain);
		const labels = terrainVariantNames[terrain] ?? ['Default'];
		const glyphs = TERRAIN_GLYPHS.glyphs[terrain] ?? [];
		const drawn = PROCEDURAL_STAMPS[terrain] ?? [];
		const textures = TEXTURES.variants[terrain] ?? [];
		reg.registerBiome({
			terrain,
			variants: ids.map((id, i) => ({ id, label: labels[i] ?? id })),
			stamps: ids.map((id, i): Stamp | null => {
				const glyph = glyphs.length ? at(glyphs, i) : undefined;
				if (glyph) return { kind: 'glyph', id, table: TERRAIN_GLYPHS, glyph };
				const draw = drawn.length ? at(drawn, i) : undefined;
				return draw ? { kind: 'procedural', id, draw } : null;
			}),
			textures: ids.map((_id, i) => (textures.length ? (at(textures, i) ?? null) : null)),
		});
	}
	for (const feature of FEATURES) {
		const ids = featureVariantIds(feature);
		const labels = featureVariantNames[feature];
		const glyphs = FEATURE_GLYPHS.glyphs[feature] ?? [];
		reg.registerFeature({
			feature,
			variants: ids.map((id, i) => ({ id, label: labels[i] ?? id })),
			glyphs: glyphs.length
				? ids.map((id, i) => ({ kind: 'glyph' as const, id, table: FEATURE_GLYPHS, glyph: at(glyphs, i)! }))
				: [],
		});
	}
	reg.registerCredits(
		(FEATURE_GLYPHS.credits ?? []).map((c) => ({ ...c, license: c.license ?? 'CC BY 3.0' })),
	);
	reg.registerCredits(TEXTURES.credits);
	return reg;
}

/** The shared instance the views draw with. */
export const ART = builtInArt();
