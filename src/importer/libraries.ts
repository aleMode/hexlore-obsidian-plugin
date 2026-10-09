// Port of Flutter's lib/importer/libraries.dart: the importer's GROWING
// knowledge — icon templates, labelled colour prototypes and stamp
// prototypes, learned from confirmations (decisions 12, 12i). In the plugin
// they are plugin data (`import-libraries.json` in the plugin folder), in the
// Flutter app's own format, so a library can be copied between the two.
// Learning is CORRECTIVE: a new prototype evicts conflicting ones.

import { type Feature, type Terrain, isFeature, isTerrain } from '../core/hex_data';
import { PaintPick } from '../core/hex_paint';
import { featureVariantId, readFeatureVariant, readTerrainVariant, terrainVariantId } from '../core/variant_ids';
import { argbToLab, deltaE, type LabColor } from './lab';
import { grayscale, resizeAverage, type Raster } from './raster';
import { BiomePrototype, compactPrototypes } from './stamp_recognizer';

/** Side of the normalised grayscale patch icon templates live at. */
export const ICON_PATCH_SIDE = 32;

export { argbToLab, deltaE, type LabColor } from './lab';

/** A learned fill colour: only ever a biome (a fill cannot imply an icon). */
export interface ColorPrototype {
	color: LabColor;
	terrain: Terrain;
	terrainVariant: number;
}

export interface IconTemplate {
	name: string;
	/** Normalised ICON_PATCH_SIDE² grayscale patch. */
	patch: Raster;
	pick: PaintPick;
	tags: string[];
}

/** An arbitrary crop → the patch format templates are stored in. */
export function normalizePatch(crop: Raster): Raster {
	return grayscale(resizeAverage(crop, ICON_PATCH_SIDE, ICON_PATCH_SIDE));
}

/** PNG coding for icon patches, supplied by the caller (the browser, or a
 *  test): libraries stay free of any image codec. */
export interface PatchCodec {
	encode(patch: Raster): string; // base64 PNG
	decode(base64: string): Raster | null;
}

const terrainOf = (v: unknown): Terrain => (isTerrain(v) ? v : 'default');
const variantOf = (terrain: Terrain, v: unknown) => readTerrainVariant(terrain, typeof v === 'number' ? Math.trunc(v) : v) ?? 0;

export class ImportLibraries {
	/** Two prototypes of DIFFERENT biomes closer than this compete. */
	static readonly CONFLICT_DELTA_E = 12;
	/** Same-biome prototypes closer than this are the same knowledge twice. */
	static readonly DUPLICATE_DELTA_E = 3;

	constructor(
		readonly icons: IconTemplate[] = [],
		readonly colors: ColorPrototype[] = [],
		readonly stamps: BiomePrototype[] = [],
	) {}

	learnStamp(p: BiomePrototype): void {
		this.stamps.push(p);
	}

	learnIcon(crop: Raster, name: string, pick: PaintPick = PaintPick.nothing, tags: string[] = []): void {
		this.icons.push({ name, patch: normalizePatch(crop), pick, tags });
	}

	/** Teach that [dominantArgb] means [terrain]: replaces a same-biome
	 *  near-duplicate and EVICTS any other biome within the conflict radius.
	 *  Returns the prototypes it displaced. */
	learnColor(dominantArgb: number, terrain: Terrain, variant = 0): ColorPrototype[] {
		const color = argbToLab(dominantArgb);
		const displaced: ColorPrototype[] = [];
		const kept = this.colors.filter((existing) => {
			const d = deltaE(color, existing.color);
			const same = existing.terrain === terrain;
			const drop = same ? d < ImportLibraries.DUPLICATE_DELTA_E : d < ImportLibraries.CONFLICT_DELTA_E;
			if (drop && !same) displaced.push(existing);
			return !drop;
		});
		this.colors.splice(0, this.colors.length, ...kept, { color, terrain, terrainVariant: variant });
		return displaced;
	}

	/** Drop contradicting prototypes, keeping the newest of each set. */
	pruneConflicts(): number {
		const kept: ColorPrototype[] = [];
		for (const c of [...this.colors].reverse()) {
			if (!kept.some((k) => k.terrain !== c.terrain && deltaE(k.color, c.color) < ImportLibraries.CONFLICT_DELTA_E)) kept.push(c);
		}
		const removed = this.colors.length - kept.length;
		this.colors.splice(0, this.colors.length, ...kept.reverse());
		return removed;
	}

	toJson(codec: PatchCodec): Record<string, unknown> {
		return {
			icons: this.icons.map((i) => ({
				name: i.name,
				patch_png: codec.encode(i.patch),
				terrain: i.pick.terrain,
				terrain_variant: i.pick.terrain === null ? i.pick.terrainVariant : (terrainVariantId(i.pick.terrain, i.pick.terrainVariant) ?? i.pick.terrainVariant),
				feature: i.pick.feature,
				feature_variant: i.pick.feature === null ? i.pick.featureVariant : (featureVariantId(i.pick.feature, i.pick.featureVariant) ?? i.pick.featureVariant),
				tags: i.tags,
			})),
			colors: this.colors.map((c) => ({ color: c.color, terrain: c.terrain, terrain_variant: terrainVariantId(c.terrain, c.terrainVariant) ?? c.terrainVariant })),
			stamps: compactPrototypes(this.stamps).map((p) => p.toJson()),
		};
	}

	/** Tolerant: a corrupt entry is skipped; a bad file is an empty library. */
	static fromJson(j: unknown, codec: PatchCodec): ImportLibraries {
		const o = j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
		const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
		const icons: IconTemplate[] = [];
		for (const i of list(o.icons)) {
			const patch = typeof i.patch_png === 'string' ? codec.decode(i.patch_png) : null;
			if (!patch || typeof i.name !== 'string') continue;
			const terrain = i.terrain == null ? null : terrainOf(i.terrain);
			const feature: Feature | null = isFeature(i.feature) ? i.feature : null;
			icons.push({
				name: i.name,
				patch,
				pick: new PaintPick(terrain, terrain === null ? 0 : variantOf(terrain, i.terrain_variant), feature, feature === null ? 0 : (readFeatureVariant(feature, typeof i.feature_variant === 'number' ? Math.trunc(i.feature_variant) : i.feature_variant) ?? 0)),
				tags: Array.isArray(i.tags) ? i.tags.filter((t): t is string => typeof t === 'string') : [],
			});
		}
		const colors: ColorPrototype[] = [];
		for (const c of list(o.colors)) {
			const col = c.color as Record<string, unknown> | undefined;
			if (!col || typeof col.l !== 'number') continue;
			const terrain = terrainOf(c.terrain);
			colors.push({ color: { l: col.l, a: Number(col.a), b: Number(col.b) }, terrain, terrainVariant: variantOf(terrain, c.terrain_variant) });
		}
		const stamps: BiomePrototype[] = [];
		for (const p of list(o.stamps)) {
			const s = BiomePrototype.fromJson(p);
			if (s) stamps.push(s);
		}
		return new ImportLibraries(icons, colors, stamps);
	}
}
