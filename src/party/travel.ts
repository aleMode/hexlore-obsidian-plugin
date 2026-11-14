// Travel time and terrain heights: the plugin's own rules (no Flutter
// counterpart), set in the plugin settings. Pure.
//
// The time to ENTER a hex depends on its terrain, or on a road through it.
// Hours are given for hexes of a reference size (3 miles by default) and
// scale with the map's hex size: a 6-mile hex takes twice as long. A travel
// day has a set number of hours (8 by default), so the counter reads in days
// and hours. Defaults (3-mile hexes, 8-hour days): 8 h mountain, desert,
// swamp, volcano; 4 h forest, jungle, tundra; 2 h plains, hills and
// unpainted ground; 1 h on a road; sea and lake cannot be entered on foot.

import { anchorTouchingHexes } from '../core/river';
import { TERRAIN_HEIGHT } from '../core/line_of_sight';
import { TERRAINS, type Terrain } from '../core/hex_data';
import type { MapModel } from '../core/map';
import type { MapScale } from '../core/map_scale';

export interface TravelSettings {
	/** The hex size the hours below are for, in miles. */
	referenceMiles: number;
	/** Hours in a travel day. */
	dayHours: number;
	/** Hours to enter a hex of each terrain; null = cannot be entered. */
	terrainHours: Record<Terrain, number | null>;
	/** Hours to enter a hex a road or highway runs through; null = no effect. */
	roadHours: number | null;
	/** Hours to enter a hex a trail runs through; null = no effect. */
	trailHours: number | null;
	/** Terrain heights for line of sight (decision 5b's defaults). */
	heights: Record<Terrain, number>;
}

export const DEFAULT_TERRAIN_HOURS: Record<Terrain, number | null> = {
	mountain: 8,
	desert: 8,
	swamp: 8,
	volcano: 8,
	forest: 4,
	jungle: 4,
	tundra: 4,
	plains: 2,
	hills: 2,
	default: 2,
	sea: null,
	lake: null,
};

export function defaultTravel(): TravelSettings {
	return {
		referenceMiles: 3,
		dayHours: 8,
		terrainHours: { ...DEFAULT_TERRAIN_HOURS },
		roadHours: 1,
		trailHours: null,
		heights: { ...TERRAIN_HEIGHT },
	};
}

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const hoursOr = (v: unknown, d: number | null): number | null => (v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

/** Read the settings tolerantly (unknown terrains kept out, bad values defaulted). */
export function readTravel(raw: unknown): TravelSettings {
	const d = defaultTravel();
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const hours = o.terrainHours && typeof o.terrainHours === 'object' ? (o.terrainHours as Record<string, unknown>) : {};
	const heights = o.heights && typeof o.heights === 'object' ? (o.heights as Record<string, unknown>) : {};
	for (const t of TERRAINS) {
		if (t in hours) d.terrainHours[t] = hoursOr(hours[t], d.terrainHours[t]);
		const h = heights[t];
		if (typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 10) d.heights[t] = h;
	}
	d.referenceMiles = positive(o.referenceMiles) ?? d.referenceMiles;
	d.dayHours = positive(o.dayHours) ?? d.dayHours;
	if ('roadHours' in o) d.roadHours = hoursOr(o.roadHours, d.roadHours);
	if ('trailHours' in o) d.trailHours = hoursOr(o.trailHours, d.trailHours);
	return d;
}

const KM_PER_MILE = 1.609344;

/** The map's hex size in miles. */
export function hexMiles(scale: MapScale): number {
	return scale.unit === 'km' ? scale.hexDistance / KM_PER_MILE : scale.hexDistance;
}

/** The route kinds running through (q, r): through its centre or across
 *  one of its edges (a route along a border, corner to corner, is not). */
export function routesThrough(model: MapModel, q: number, r: number): Set<string> {
	const out = new Set<string>();
	for (const route of model.routes.values()) {
		if (route.kind === 'border') continue;
		const hit = route.nodes.some((n) => n.kind !== 'v' && anchorTouchingHexes(n).some(([hq, hr]) => hq === q && hr === r));
		if (hit) out.add(route.kind);
	}
	return out;
}

export interface EntryCost {
	/** Hours at this map's hex size; null when the hex cannot be entered. */
	hours: number | null;
	/** What set it: the terrain, "road" or "trail". */
	by: string;
}

/** The time to enter (q, r) on [model]'s map. */
export function entryCost(model: MapModel, q: number, r: number, s: TravelSettings): EntryCost {
	const terrain: Terrain = model.getHex(q, r)?.terrain ?? 'default';
	const factor = hexMiles(model.meta.scale) / s.referenceMiles;
	let hours = s.terrainHours[terrain] ?? null;
	let by: string = terrain;
	const routes = routesThrough(model, q, r);
	const faster = (h: number | null, what: string) => {
		if (h !== null && (hours === null || h < hours)) {
			hours = h;
			by = what;
		}
	};
	if (routes.has('road') || routes.has('highway')) faster(s.roadHours, 'road');
	if (routes.has('trail')) faster(s.trailHours, 'trail');
	return { hours: hours === null ? null : hours * factor, by };
}

/** "5 h", "1 day 3 h", "2 days", "2.5 h": [hours] in days of [dayHours]. */
export function formatHours(hours: number, dayHours: number): string {
	const round = (x: number) => Math.round(x * 10) / 10;
	const total = round(hours);
	const days = Math.floor((total + 1e-9) / dayHours);
	const rest = round(total - days * dayHours);
	const h = `${rest} h`;
	if (!days) return h;
	const d = `${days} day${days === 1 ? '' : 's'}`;
	return rest ? `${d} ${h}` : d;
}
