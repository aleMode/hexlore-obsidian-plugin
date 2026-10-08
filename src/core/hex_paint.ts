// Port of Flutter's lib/core/hex_paint.dart (decision 1c): PaintPick, the
// shared paint INTENT. Each of its two layers (biome, feature) may say "no
// opinion", which is what lets a biome brush leave icons alone and an icon
// stamp leave the fill alone.

import { featureVariantNames, terrainVariantNames, type Feature, type Terrain } from './hex_data';

export class PaintPick {
	constructor(
		readonly terrain: Terrain | null = null,
		readonly terrainVariant = 0,
		readonly feature: Feature | null = null,
		readonly featureVariant = 0,
		/** Erase the feature layer (never together with a feature). */
		readonly clearsFeature = false,
	) {
		if (clearsFeature && feature !== null) throw new Error('a pick cannot both set and erase the feature layer');
	}

	static biome(t: Terrain, variant = 0): PaintPick {
		return new PaintPick(t, variant);
	}

	static featureOnly(f: Feature, variant = 0): PaintPick {
		return new PaintPick(null, 0, f, variant);
	}

	static featureEraser(): PaintPick {
		return new PaintPick(null, 0, null, 0, true);
	}

	static readonly nothing = new PaintPick();

	get paintsBiome(): boolean {
		return this.terrain !== null;
	}
	get paintsFeature(): boolean {
		return this.feature !== null || this.clearsFeature;
	}
	get isEmpty(): boolean {
		return !this.paintsBiome && !this.paintsFeature;
	}

	withBiome(t: Terrain | null, variant = 0): PaintPick {
		return new PaintPick(t, t === null ? 0 : variant, this.feature, this.featureVariant, this.clearsFeature);
	}

	withFeature(f: Feature | null, variant = 0): PaintPick {
		return new PaintPick(this.terrain, this.terrainVariant, f, f === null ? 0 : variant);
	}

	equals(o: PaintPick | null | undefined): boolean {
		return (
			!!o &&
			o.terrain === this.terrain &&
			o.terrainVariant === this.terrainVariant &&
			o.feature === this.feature &&
			o.featureVariant === this.featureVariant &&
			o.clearsFeature === this.clearsFeature
		);
	}

	describe(): string {
		if (this.clearsFeature && !this.paintsBiome) return 'Erase icon';
		const label = (value: string, variant: number, names: readonly string[] | undefined) => {
			const head = value[0]!.toUpperCase() + value.slice(1);
			const name = names?.length ? names[Math.min(Math.max(variant, 0), names.length - 1)] : undefined;
			return variant > 0 && name ? `${head} · ${name}` : head;
		};
		const parts: string[] = [];
		if (this.terrain) {
			parts.push(this.terrain === 'default' ? 'Erase terrain' : label(this.terrain, this.terrainVariant, terrainVariantNames[this.terrain]));
		}
		if (this.feature) parts.push(label(this.feature, this.featureVariant, featureVariantNames[this.feature]));
		if (this.clearsFeature) parts.push('erase icon');
		return parts.length ? parts.join(' + ') : 'Keep as is';
	}
}
