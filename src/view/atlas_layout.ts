// "Show maps together" (GM only, read-only): several maps of the vault, each
// at its own scale, laid over one another in REAL DISTANCE. Each map is
// placed by its centre in miles and drawn at the size its own scale gives it
// (`hex_distance`), times a fit factor the GM may change to line it up with
// a source drawn off scale. Placements are the plugin's own, in data.json:
// never in a map's files, so nothing here is shared with the Flutter app.
// No Obsidian or DOM import: unit-tested.

import { HEX_RADIUS as R, MAX_ZOOM, gridPixelBounds, type GridWindow } from '../core/geometry';
import { hexStepPx, type MapScale } from '../core/map_scale';

export interface AtlasPlacement {
	/** The map's centre, miles. */
	x: number;
	y: number;
	/** Drawn size over the size its own scale gives (1 = to scale). */
	fit: number;
}

export interface AtlasLayout {
	/** The maps shown, by index path. */
	shown: string[];
	/** Every map ever placed, by index path (a map hidden keeps its place). */
	maps: Record<string, AtlasPlacement>;
}

/** The world camera: CSS px per mile, and where the world origin is. */
export interface AtlasCamera {
	scale: number;
	ox: number;
	oy: number;
}

export const KM_IN_MI = 0.621371192;
export const FIT_MIN = 0.05;
export const FIT_MAX = 20;

export const emptyLayout = (): AtlasLayout => ({ shown: [], maps: {} });

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read the layout tolerantly (data.json may be hand-edited, or older). */
export function readLayout(raw: unknown): AtlasLayout {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const shown = Array.isArray(o.shown) ? [...new Set(o.shown.filter((p): p is string => typeof p === 'string'))] : [];
	const maps: Record<string, AtlasPlacement> = {};
	if (o.maps && typeof o.maps === 'object') {
		for (const [path, v] of Object.entries(o.maps as Record<string, unknown>)) {
			const p = v as Record<string, unknown> | null;
			if (!p || !finite(p.x) || !finite(p.y)) continue;
			maps[path] = { x: p.x, y: p.y, fit: finite(p.fit) && p.fit > 0 ? clampFit(p.fit) : 1 };
		}
	}
	return { shown, maps };
}

export const clampFit = (fit: number) => Math.min(FIT_MAX, Math.max(FIT_MIN, fit));

/** What one hex of [scale] measures, in miles. */
export const milesPerHex = (scale: MapScale) => scale.hexDistance * (scale.unit === 'km' ? KM_IN_MI : 1);

/** One map as the atlas sees it. */
export interface AtlasMap {
	grid: GridWindow;
	scale: MapScale;
	place: AtlasPlacement;
}

/** Miles per scene px of [m] as drawn. */
const milesPerScenePx = (m: AtlasMap) => (milesPerHex(m.scale) * m.place.fit) / hexStepPx(R);

/** The centre of [grid]'s pixel bounds, scene px. */
function sceneCentre(grid: GridWindow): [number, number] {
	const [x, y, w, h] = gridPixelBounds(grid);
	return [x + w / 2, y + h / 2];
}

/** The map's own camera (MapCanvas: screen = scene · scale + o) under [cam]. */
export function mapCamera(m: AtlasMap, cam: AtlasCamera): AtlasCamera {
	const k = milesPerScenePx(m);
	const [cx, cy] = sceneCentre(m.grid);
	return { scale: cam.scale * k, ox: cam.ox + cam.scale * (m.place.x - cx * k), oy: cam.oy + cam.scale * (m.place.y - cy * k) };
}

/** The map's grid window in miles: [x, y, w, h]. */
export function worldRect(m: AtlasMap): [number, number, number, number] {
	const k = milesPerScenePx(m);
	const [, , w, h] = gridPixelBounds(m.grid);
	return [m.place.x - (w * k) / 2, m.place.y - (h * k) / 2, w * k, h * k];
}

/** Screen px between neighbouring hex centres of [m] under [cam]. */
export const hexPx = (m: AtlasMap, cam: AtlasCamera) => cam.scale * milesPerHex(m.scale) * m.place.fit;

export const toScreen = (cam: AtlasCamera, x: number, y: number): [number, number] => [cam.ox + x * cam.scale, cam.oy + y * cam.scale];
export const toWorld = (cam: AtlasCamera, sx: number, sy: number): [number, number] => [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];

// ----- opacity -----------------------------------------------------------------

/** Below this many px a hex is not drawn: the map is its outline only. */
export const FADE_IN_FROM = 2;
/** Fully drawn from here… */
export const FADE_IN_TO = 10;
/** …to here, then it fades to a ghost (context around a smaller map)… */
export const FULL_UNTIL = 120;
export const GHOST_AT = 240;
export const GHOST = 0.3;
/** …and is gone past the renderer's own zoom limit. */
export const GONE_FROM = 280;
export const GONE_AT = hexStepPx(R) * MAX_ZOOM;

const smooth = (a: number, b: number, v: number) => {
	const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** How opaque a map is with hexes [px] apart on screen: most at its own
 *  working zoom, fading in as it is approached, to a ghost past it. 0 = not
 *  drawn. */
export function atlasOpacity(px: number): number {
	if (!(px >= FADE_IN_FROM) || px >= GONE_AT) return 0;
	const fadeIn = smooth(FADE_IN_FROM, FADE_IN_TO, px);
	const toGhost = 1 - (1 - GHOST) * smooth(FULL_UNTIL, GHOST_AT, px);
	const gone = 1 - smooth(GONE_FROM, GONE_AT, px);
	return fadeIn * toGhost * gone;
}

/** Bottom to top: the coarsest map first, so the detailed one lies over it;
 *  ties by path. */
export function stackOrder<T extends { path: string; map: AtlasMap }>(maps: readonly T[]): T[] {
	const size = (m: AtlasMap) => milesPerHex(m.scale) * m.place.fit;
	return [...maps].sort((a, b) => size(b.map) - size(a.map) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The world camera's zoom limits for [maps]: the coarsest map's hexes no
 *  smaller than 3 px, the finest no larger than 300 px. */
export function zoomLimits(maps: readonly AtlasMap[]): [number, number] {
	if (!maps.length) return [1e-6, 1e6];
	const sizes = maps.map((m) => milesPerHex(m.scale) * m.place.fit);
	const min = 3 / Math.max(...sizes), max = 300 / Math.min(...sizes);
	return [Math.min(min, max), Math.max(min, max)];
}

/** A camera framing [rects] (miles) in a [w]×[h] view, with a margin. */
export function frameRects(rects: readonly [number, number, number, number][], w: number, h: number): AtlasCamera | null {
	if (!rects.length || w <= 0 || h <= 0) return null;
	const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
	const x1 = Math.max(...rects.map((r) => r[0] + r[2])), y1 = Math.max(...rects.map((r) => r[1] + r[3]));
	const scale = Math.min((w * 0.9) / Math.max(x1 - x0, 1e-9), (h * 0.9) / Math.max(y1 - y0, 1e-9));
	return { scale, ox: w / 2 - ((x0 + x1) / 2) * scale, oy: h / 2 - ((y0 + y1) / 2) * scale };
}

/** "Shown at 1 hex ≈ 4.3 mi (the map says 5 mi)", or null when to scale. */
export function scaleMismatch(m: AtlasMap): string | null {
	if (Math.abs(m.place.fit - 1) < 0.005) return null;
	const shown = m.scale.hexDistance * m.place.fit;
	const round = (v: number) => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
	return `Shown at 1 hex ≈ ${round(shown)} ${m.scale.unit} (the map says ${round(m.scale.hexDistance)} ${m.scale.unit})`;
}

/** The layout after [from] was renamed to [to] (a map's index, or a folder
 *  above maps); the same object when nothing moved. */
export function renamePaths(layout: AtlasLayout, from: string, to: string): AtlasLayout {
	const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
	let changed = false;
	const maps: Record<string, AtlasPlacement> = {};
	for (const [p, v] of Object.entries(layout.maps)) {
		const n = move(p);
		if (n !== p) changed = true;
		maps[n] = v;
	}
	const shown = layout.shown.map((p) => {
		const n = move(p);
		if (n !== p) changed = true;
		return n;
	});
	return changed ? { shown, maps } : layout;
}
