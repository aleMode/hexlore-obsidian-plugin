// Port of HexData (Flutter's lib/core/hex_data.dart): one hex as stored in a
// paint chunk. Unknown keys go to `extra`, unknown values of known fields to
// `raw` (written back in their own place); assigning a field drops its raw
// entry — a repaint replaces an unknown terrain, which is what the GM meant.

import {
	isFeature,
	isTerrain,
	legacyTerrainFeatures,
	terrainColors,
	hexIdFor,
	type Feature,
	type Terrain,
} from './hex_data';
import { bool, int, rawIfUnknown, str, strings, unknownKeys, type Json, type JsonObject } from './json';
import { featureVariantId, readFeatureVariant, readTerrainVariant, terrainVariantId } from './variant_ids';

export type HexState = 'empty' | 'named' | 'populated' | 'linked';

const KNOWN_KEYS = new Set([
	'q',
	'r',
	'name',
	'terrain',
	'terrain_variant',
	'feature',
	'feature_variant',
	'feature_hidden',
	'color_override',
	'page_file',
	'npc_ids',
	'quest_ids',
	'event_ids',
	'tags',
	// Derived or legacy keys an older file may carry: dropped on purpose.
	'id',
	'display_id',
	'notes_file',
	'fog_revealed',
]);

export class Hex {
	name: string | null = null;
	featureHidden = false;
	colorOverride: string | null = null;
	/** Flutter's page path ("hexes/Name.md"): kept, not used by the plugin. */
	pageFile: string | null = null;
	npcIds: string[] = [];
	questIds: string[] = [];
	eventIds: string[] = [];
	tags: string[] = [];
	/** Keys this build does not know, written back unchanged. */
	extra: JsonObject = {};
	/** Original values of terrain / feature / their variants this build did
	 *  not recognise; the fields hold a fallback. */
	raw: JsonObject = {};

	private _terrain: Terrain = 'default';
	private _terrainVariant = 0;
	private _feature: Feature | null = null;
	private _featureVariant = 0;

	constructor(
		readonly q: number,
		readonly r: number,
	) {}

	get id(): string {
		return hexIdFor(this.q, this.r);
	}

	get terrain(): Terrain {
		return this._terrain;
	}
	set terrain(v: Terrain) {
		this._terrain = v;
		delete this.raw.terrain;
		delete this.raw.terrain_variant;
	}

	/** Index into the terrain's variants (0 = default). */
	get terrainVariant(): number {
		return this._terrainVariant;
	}
	set terrainVariant(v: number) {
		this._terrainVariant = v;
		delete this.raw.terrain_variant;
	}

	/** Icon-only overlay. Replacing it KEEPS featureHidden (re-stamping must
	 *  not publish what the GM hid); clearing it resets the flag. */
	get feature(): Feature | null {
		return this._feature;
	}
	set feature(v: Feature | null) {
		if (v === null) this.featureHidden = false;
		this._feature = v;
		delete this.raw.feature;
		delete this.raw.feature_variant;
	}

	get featureVariant(): number {
		return this._featureVariant;
	}
	set featureVariant(v: number) {
		this._featureVariant = v;
		delete this.raw.feature_variant;
	}

	/** The stored feature is one this build doesn't know: drawn as nothing,
	 *  and players learn nothing beyond the biome. */
	get hasUnknownFeature(): boolean {
		return 'feature' in this.raw;
	}

	fillColor(): string {
		return this.colorOverride || terrainColors[this.terrain];
	}

	/** no name → empty; name + threads → linked; name + content → populated;
	 *  name only → named. */
	computeState(threadCount = 0): HexState {
		if (!this.name) return 'empty';
		if (threadCount > 0) return 'linked';
		const hasContent =
			this.terrain !== 'default' || this.feature !== null || this.npcIds.length > 0 || this.questIds.length > 0 || !!this.pageFile;
		return hasContent ? 'populated' : 'named';
	}

	/** Anything worth a record? A hex at every default is not written (2b). */
	get hasPersistentContent(): boolean {
		return (
			this.terrain !== 'default' ||
			this.terrainVariant !== 0 ||
			this.feature !== null ||
			this.featureVariant !== 0 ||
			!!this.name ||
			!!this.colorOverride ||
			!!this.pageFile ||
			this.npcIds.length > 0 ||
			this.questIds.length > 0 ||
			this.eventIds.length > 0 ||
			this.tags.length > 0 ||
			Object.keys(this.extra).length > 0 ||
			Object.keys(this.raw).length > 0
		);
	}

	/** Defaults OMITTED; variants by id; unknown values in their own place,
	 *  unknown keys after. */
	toJson(): JsonObject {
		const o: JsonObject = { q: this.q, r: this.r };
		const raw = this.raw;
		if (this.name) o.name = this.name;
		o.terrain = raw.terrain ?? this.terrain;
		if ('terrain_variant' in raw || this.terrainVariant !== 0) {
			o.terrain_variant = raw.terrain_variant ?? terrainVariantId(this.terrain, this.terrainVariant) ?? this.terrainVariant;
		}
		if (this.hasUnknownFeature || this.feature !== null) o.feature = raw.feature ?? this.feature!;
		if ('feature_variant' in raw || this.featureVariant !== 0) {
			o.feature_variant =
				raw.feature_variant ??
				(this.feature === null ? this.featureVariant : (featureVariantId(this.feature, this.featureVariant) ?? this.featureVariant));
		}
		if (this.featureHidden && (this.feature !== null || this.hasUnknownFeature)) o.feature_hidden = true;
		if (this.colorOverride) o.color_override = this.colorOverride;
		if (this.pageFile) o.page_file = this.pageFile;
		if (this.npcIds.length) o.npc_ids = [...this.npcIds];
		if (this.questIds.length) o.quest_ids = [...this.questIds];
		if (this.eventIds.length) o.event_ids = [...this.eventIds];
		if (this.tags.length) o.tags = [...this.tags];
		return { ...o, ...this.extra };
	}

	/** Tolerant: legacy structure terrains migrate to a feature with their
	 *  old fill BEFORE the unknown-value rule; unknowns go to extra / raw. */
	static fromJson(json: JsonObject): Hex | null {
		const q = int(json.q), r = int(json.r);
		if (q === undefined || r === undefined) return null;
		const h = new Hex(q, r);
		const rawTerrain = json.terrain;
		const legacy = typeof rawTerrain === 'string' ? legacyTerrainFeatures[rawTerrain] : undefined;
		const terrain = isTerrain(rawTerrain) ? rawTerrain : null;
		const rawFeature = json.feature;
		const feature = isFeature(rawFeature) ? rawFeature : null;
		const rawTV = json.terrain_variant, rawFV = json.feature_variant;
		const unknownTerrain = !legacy && rawTerrain !== undefined && rawTerrain !== null && terrain === null;
		const unknownFeature = rawFeature !== undefined && rawFeature !== null && feature === null;
		const baseTerrain: Terrain = legacy ? 'default' : (terrain ?? 'default');
		const tIndex = unknownTerrain ? null : readTerrainVariant(baseTerrain, rawTV);
		const effectiveFeature = feature ?? legacy?.[0] ?? null;
		const fIndex = unknownFeature
			? null
			: effectiveFeature === null
				? rawFV === undefined || rawFV === null
					? 0
					: null
				: readFeatureVariant(effectiveFeature, rawFV);

		h._terrain = baseTerrain;
		h._terrainVariant = tIndex ?? 0;
		h._feature = effectiveFeature;
		h._featureVariant = fIndex ?? 0;
		h.name = str(json.name) || null;
		h.featureHidden = bool(json.feature_hidden) ?? false;
		h.colorOverride = str(json.color_override) ?? legacy?.[1] ?? null;
		h.pageFile = str(json.page_file) ?? null;
		h.npcIds = strings(json.npc_ids) ?? [];
		h.questIds = strings(json.quest_ids) ?? [];
		h.eventIds = strings(json.event_ids) ?? [];
		h.tags = strings(json.tags) ?? [];
		h.extra = unknownKeys(json, KNOWN_KEYS);
		h.raw = {
			...rawIfUnknown('terrain', rawTerrain, !unknownTerrain),
			...rawIfUnknown('feature', rawFeature, !unknownFeature),
			...rawIfUnknown('terrain_variant', rawTV, tIndex !== null),
			...rawIfUnknown('feature_variant', rawFV, fIndex !== null),
		};
		return h;
	}

	copy(): Hex {
		return this.copyAt(this.q, this.r);
	}

	/** Everything, rehomed at (q, r). */
	copyAt(q: number, r: number): Hex {
		const h = new Hex(q, r);
		h._terrain = this._terrain;
		h._terrainVariant = this._terrainVariant;
		h._feature = this._feature;
		h._featureVariant = this._featureVariant;
		h.name = this.name;
		h.featureHidden = this.featureHidden;
		h.colorOverride = this.colorOverride;
		h.pageFile = this.pageFile;
		h.npcIds = [...this.npcIds];
		h.questIds = [...this.questIds];
		h.eventIds = [...this.eventIds];
		h.tags = [...this.tags];
		h.extra = structuredJson(this.extra);
		h.raw = structuredJson(this.raw);
		return h;
	}
}

/** A deep copy that keeps JsonDouble markers. */
export function structuredJson<T extends Json>(v: T): T {
	if (Array.isArray(v)) return v.map((x) => structuredJson(x)) as T;
	if (v !== null && typeof v === 'object' && v.constructor === Object) {
		const o: JsonObject = {};
		for (const [k, x] of Object.entries(v as JsonObject)) o[k] = structuredJson(x);
		return o as T;
	}
	return v;
}

const COLUMN_A = 'A'.charCodeAt(0);

/** Bijective base-26 column label (A … Z, AA …); negative columns get `-`. */
function columnLabel(q: number): string {
	if (q < 0) return `-${columnLabel(-q - 1)}`;
	let label = '';
	let n = q;
	for (;;) {
		label = String.fromCharCode(COLUMN_A + (n % 26)) + label;
		n = Math.trunc(n / 26) - 1;
		if (n < 0) break;
	}
	return label;
}

/** The human-facing id ("A1"): derived, never stored (decision 1). */
export function displayIdFor(q: number, r: number): string {
	return `${columnLabel(q)}${r + 1}`;
}

/** Inverse of hexIdFor; null when [id] isn't a canonical hex id. */
export function parseHexId(id: string): [number, number] | null {
	const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
	return m ? [Number(m[1]), Number(m[2])] : null;
}
