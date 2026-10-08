import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURES, TERRAINS } from '../src/core/hex_data';
import { featureVariantIds, terrainVariantIds } from '../src/core/variant_ids';
import { ART } from '../src/render/art';
import { FEATURE_GLYPHS, TERRAIN_GLYPHS, TEXTURES } from '../src/render/vendor';

describe('art registry', () => {
	it('lists every variant id of every biome and feature, in table order', () => {
		for (const t of TERRAINS) expect(ART.biome(t)!.variants.map((v) => v.id)).toEqual(terrainVariantIds(t));
		for (const f of FEATURES) expect(ART.feature(f)!.variants.map((v) => v.id)).toEqual(featureVariantIds(f));
	});

	// The vendored tables are index-ordered; the registry binds them to ids by
	// position, so a table that changed length means the ids no longer line up.
	it('has exactly one art entry per variant id', () => {
		for (const f of FEATURES) expect(FEATURE_GLYPHS.glyphs[f]?.length, f).toBe(featureVariantIds(f).length);
		for (const t of TERRAINS) {
			const glyphs = TERRAIN_GLYPHS.glyphs[t];
			if (glyphs) expect(glyphs.length, t).toBe(terrainVariantIds(t).length);
			const textures = TEXTURES.variants[t];
			if (textures) expect(textures.length, t).toBe(terrainVariantIds(t).length);
		}
	});

	it('draws every painted biome in Clean, procedurally where there is no glyph', () => {
		for (const t of TERRAINS) {
			if (t === 'default') continue;
			for (let i = 0; i < terrainVariantIds(t).length; i++) {
				expect(ART.biomeStamp(t, i), `${t}/${i}`).not.toBeNull();
			}
		}
		expect(ART.biomeStamp('lake', 0)!.kind).toBe('procedural');
		expect(ART.biomeStamp('forest', 2)!.kind).toBe('glyph');
	});

	it('falls back to variant 0 for an index out of range', () => {
		expect(ART.biomeVariantId('forest', 99)).toBe('forest/default');
		expect(ART.featureGlyph('city', -1)!.id).toBe('city/default');
	});

	it('credits every art source', () => {
		const names = ART.credits().map((c) => c.name);
		expect(names).toContain('Lorc');
		expect(names.some((n) => n.startsWith('Azgaar'))).toBe(true);
	});

	it('only uses ids the lock file has issued', () => {
		const lock = new Set(
			readFileSync(new URL('../vendor/variant_ids.lock', import.meta.url), 'utf8')
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith('#')),
		);
		for (const b of ART.allBiomes()) for (const v of b.variants) if (b.variants.length > 1) expect(lock.has(v.id), v.id).toBe(true);
		for (const f of ART.allFeatures()) for (const v of f.variants) expect(lock.has(v.id), v.id).toBe(true);
	});
});
