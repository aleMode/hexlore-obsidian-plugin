// The map as the renderer sees it: hexes keyed by packed cell, rivers and
// routes as scene-pixel polylines, the grid window — plus everything derived
// from them that does NOT change from frame to frame (terrain groups, fills,
// river courses and mouths, texture obstacles, road marks). player.js redid
// all of that every frame; here it is computed once per revision, lazily.
//
// Built from the map model by scene_from_model.ts; edits replace a hex with
// setHex() and bump the revision.

import type { Feature, Terrain } from '../core/hex_data';
import { terrainColors } from '../core/hex_data';
import {
	HEX_RADIUS as R,
	axialToPixel,
	pixelToAxial,
	type GridWindow,
	type Point,
} from '../core/geometry';
import { ART } from './art';
import { boundaryEdges, regionHatchSegments } from '../core/region';
import { layoutThreads, type ThreadShape, type ThreadStyle } from '../core/thread_geometry';
import { vertexPixel } from '../core/geometry';
import { SPEC, TEX, type Group, type RiverSplit, type RoadStyle, type TextureVariant } from './vendor';

export type MapStyle = 'clean' | 'illustrated';

/** Anchor kind (v corner, e edge midpoint, c centre), q, r, k. */
export type Anchor = [string, number, number, number];

export interface SceneHex {
	q: number;
	r: number;
	name: string | null;
	terrain: Terrain;
	terrainVariant: number;
	/** Null for none, and for a feature this build doesn't know (drawn as none). */
	feature: Feature | null;
	featureVariant: number;
	featureHidden: boolean;
	/** Legacy fill, kept from the pre-split files. */
	colorOverride: string | null;
	/** Anything but the name (terrain, feature, NPCs, quests, a page). */
	hasContent: boolean;
}

export interface SceneRiver {
	id: string;
	width: number;
	anchors: Anchor[];
}

export interface SceneRoute {
	id: string;
	kind: string;
	color: string;
	width: number;
	playerVisible: boolean;
	anchors: Anchor[];
}

/** Everything a map file set holds that the renderer draws. */
export interface MapData {
	name: string;
	format: number;
	grid: GridWindow;
	hexes: SceneHex[];
	rivers: SceneRiver[];
	routes: SceneRoute[];
	/** Hex ids revealed to players (the GM sees a badge on each). */
	revealed?: string[];
	regions?: SceneRegion[];
	threads?: SceneThread[];
}

export interface SceneRegion {
	id: string;
	name: string;
	color: string;
	zOrder: number;
	cells: [number, number][];
}

export interface SceneThread {
	id: string;
	from: string;
	to: string;
	label: string;
	/** The drawn colour (by type, or the GM's pick). */
	color: string;
	/** Upper-case colour: the thread's group (decision 27). */
	colorKey: string;
	status: string;
	direction: string;
}

/** What the GM shows and hides (decision 27). Part of the base layer. */
export interface Overlays {
	threads: boolean;
	hiddenThreadColors: ReadonlySet<string>;
	threadStyle: ThreadStyle;
	regions: boolean;
	hiddenRegions: ReadonlySet<string>;
	borders: boolean;
	/** Hatch the hexes the GM has not written yet (no name). */
	gmFog: boolean;
	/** The revealed-eye / secret-feature badges. */
	badges: boolean;
}

export const DEFAULT_OVERLAYS: Overlays = {
	threads: true,
	hiddenThreadColors: new Set(),
	threadStyle: 'arc',
	regions: true,
	hiddenRegions: new Set(),
	borders: true,
	gmFog: false,
	badges: true,
};

export interface RegionShape {
	region: SceneRegion;
	/** Pre-clipped hatch: [x0, y0, x1, y1] per stroke. */
	hatch: [number, number, number, number][];
	/** The contour: one segment per boundary edge. */
	contour: [number, number, number, number][];
	bbox: [number, number, number, number];
}

/** How one cell is filled: the unjittered base (ink and texture tones derive
 *  from it) and the colour actually painted. */
export interface CellLook {
	base: string;
	drawn: string;
	painted: boolean;
	texture: TextureVariant | null;
}

export interface RiverGeometry {
	river: SceneRiver;
	/** The anchors in scene px. */
	pts: Point[];
	/** Null when the river never meets water: draw it whole. */
	split: RiverSplit | null;
	/** Per mouth: the land cells its spine crosses and the water cell it opens into. */
	mouths: { land: [number, number][]; dest: [number, number] }[];
	/** Water cells a split river may paint over (cut out of its strokes). */
	nearWater: [number, number][];
	bbox: [number, number, number, number];
}

export interface RouteGeometry {
	route: SceneRoute;
	style: RoadStyle | null; // null: a border
	pts: Point[];
	bbox: [number, number, number, number];
}

function parseHexCell(id: string): [number, number] | null {
	const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
	return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Packed cell key; mirrors _cellKey in hex_map.dart. */
export function cellKey(q: number, r: number): number {
	return ((q + 0x8000) << 16) | (r + 0x8000);
}

export const EMPTY_FILL = '#33334D';
export const CANVAS_BG = '#1A1A2E';
// A named hex with nothing else: the empty fill lifted 12% toward white (_fillFor).
const NAMED_FILL = SPEC.lerpHex(EMPTY_FILL, '#FFFFFF', 0.12);

function bbox(pts: Point[]): [number, number, number, number] {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of pts) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	return [x0, y0, x1, y1];
}

export function anchorPixel(a: Anchor): Point {
	const [kind, q, r, k] = a;
	const [cx, cy] = axialToPixel(q, r);
	if (kind === 'c') return [cx, cy];
	if (kind === 'v') {
		const t = (Math.PI / 180) * 60 * k;
		return [cx + R * Math.cos(t), cy + R * Math.sin(t)];
	}
	const ap = (R * Math.sqrt(3)) / 2;
	const t = (Math.PI / 180) * (30 + 60 * k);
	return [cx + ap * Math.cos(t), cy + ap * Math.sin(t)];
}

export class MapScene {
	/** Bumped by every change; tiles and caches key on it. */
	revision = 0;
	readonly name: string;
	readonly format: number;
	readonly grid: GridWindow;
	readonly hexes = new Map<number, SceneHex>();
	rivers: SceneRiver[];
	routes: SceneRoute[];
	regions: SceneRegion[];
	threads: SceneThread[];
	overlays: Overlays = DEFAULT_OVERLAYS;
	/** Revealed cells, by cellKey. */
	readonly revealed = new Set<number>();

	private groupCache: Map<number, Group> | null = null;
	private lookCache: Record<MapStyle, Map<number, CellLook>> = { clean: new Map(), illustrated: new Map() };
	private riverCache: RiverGeometry[] | null = null;
	private routeCache: RouteGeometry[] | null = null;
	private obstacleCache: Map<number, number[][]> | null = null;
	private markCache = new Map<string, { pebbles: number[]; ticks: number[] }>();
	private regionCache = new Map<string, { key: string; shape: RegionShape }>();
	private threadCache: Map<string, ThreadShape> | null = null;

	constructor(data: MapData) {
		this.name = data.name;
		this.format = data.format;
		this.grid = data.grid;
		for (const h of data.hexes) this.hexes.set(cellKey(h.q, h.r), h);
		this.rivers = data.rivers;
		this.routes = data.routes;
		this.regions = data.regions ?? [];
		this.threads = data.threads ?? [];
		for (const id of data.revealed ?? []) {
			const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
			if (m) this.revealed.add(cellKey(Number(m[1]), Number(m[2])));
		}
	}

	hexAt(q: number, r: number): SceneHex | undefined {
		return this.hexes.get(cellKey(q, r));
	}

	/** Replace (or create) a hex, as a brush stroke does. */
	setHex(h: SceneHex): void {
		const key = cellKey(h.q, h.r);
		const wasWater = this.group(h.q, h.r) === SPEC.groupWater;
		this.hexes.set(key, h);
		this.lookCache.clean.delete(key);
		this.lookCache.illustrated.delete(key);
		const group = SPEC.terrainGroup(h.terrain);
		this.groupCache?.set(key, group);
		if (wasWater !== (group === SPEC.groupWater)) this.riverCache = null;
		this.revision++;
	}

	/** Rivers and routes changed. */
	setLines(rivers: SceneRiver[], routes: SceneRoute[]): void {
		this.rivers = rivers;
		this.routes = routes;
		this.riverCache = this.routeCache = this.obstacleCache = null;
		this.markCache.clear();
		this.revision++;
	}

	setRegions(regions: SceneRegion[]): void {
		this.regions = regions;
		this.revision++;
	}

	setThreads(threads: SceneThread[]): void {
		this.threads = threads;
		this.threadCache = null;
		this.revision++;
	}

	setOverlays(o: Overlays): void {
		this.overlays = o;
		this.threadCache = null;
		this.revision++;
	}

	/** A region's contour and hatch, cached until its cells change. */
	regionShape(g: SceneRegion): RegionShape {
		const key = g.cells.map(([q, r]) => `${q},${r}`).join(';');
		const hit = this.regionCache.get(g.id);
		if (hit && hit.key === key) return { ...hit.shape, region: g };
		const hatch = regionHatchSegments(g.cells, 11);
		const contour = boundaryEdges(g.cells).map(([a, b]) => {
			const [ax, ay] = vertexPixel(a[0], a[1], a[2]);
			const [bx, by] = vertexPixel(b[0], b[1], b[2]);
			return [ax, ay, bx, by] as [number, number, number, number];
		});
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const [ax, ay, bx, by] of contour) {
			x0 = Math.min(x0, ax, bx);
			y0 = Math.min(y0, ay, by);
			x1 = Math.max(x1, ax, bx);
			y1 = Math.max(y1, ay, by);
		}
		const shape = { region: g, hatch, contour, bbox: [x0 - 4, y0 - 4, x1 + 4, y1 + 4] as [number, number, number, number] };
		this.regionCache.set(g.id, { key, shape });
		return shape;
	}

	/** The courses of the visible threads (a hidden colour neither draws nor
	 *  hit-tests, and the fan closes up around it). */
	threadShapes(): Map<string, ThreadShape> {
		if (this.threadCache) return this.threadCache;
		const o = this.overlays;
		const links = o.threads
			? this.threads
					.filter((t) => !o.hiddenThreadColors.has(t.colorKey))
					.flatMap((t) => {
						const a = parseHexCell(t.from), b = parseHexCell(t.to);
						return a && b ? [{ id: t.id, from: t.from, to: t.to, a: axialToPixel(a[0], a[1]), b: axialToPixel(b[0], b[1]) }] : [];
					})
			: [];
		this.threadCache = layoutThreads(links, o.threadStyle);
		return this.threadCache;
	}

	/** Remove the hex at (q, r) (erased, undone). */
	removeHex(q: number, r: number): void {
		const key = cellKey(q, r);
		if (!this.hexes.has(key)) return;
		const wasWater = this.group(q, r) === SPEC.groupWater;
		this.hexes.delete(key);
		this.lookCache.clean.delete(key);
		this.lookCache.illustrated.delete(key);
		this.groupCache?.delete(key);
		if (wasWater) this.riverCache = null;
		this.revision++;
	}

	isRevealed(q: number, r: number): boolean {
		return this.revealed.has(cellKey(q, r));
	}

	/** Player fog changed for [cells] (the badges are in the base layer). */
	setRevealed(cells: [number, number][], revealed: (q: number, r: number) => boolean): void {
		for (const [q, r] of cells) {
			if (revealed(q, r)) this.revealed.add(cellKey(q, r));
			else this.revealed.delete(cellKey(q, r));
		}
		if (cells.length) this.revision++;
	}

	/** Terrain group of a cell (none for an empty one). */
	group(q: number, r: number): Group {
		if (!this.groupCache) {
			this.groupCache = new Map();
			for (const [k, h] of this.hexes) this.groupCache.set(k, SPEC.terrainGroup(h.terrain));
		}
		return this.groupCache.get(cellKey(q, r)) ?? SPEC.groupNone;
	}

	isWater(q: number, r: number): boolean {
		return this.group(q, r) === SPEC.groupWater;
	}

	/** The cell's fill, as Flutter's _cellLook: by state, then the texture's
	 *  ground, then the per-cell lightness jitter on painted terrain. */
	look(q: number, r: number, style: MapStyle): CellLook {
		const key = cellKey(q, r);
		const cache = this.lookCache[style];
		const hit = cache.get(key);
		if (hit) return hit;
		const h = this.hexes.get(key);
		let look: CellLook;
		if (!h) {
			look = { base: EMPTY_FILL, drawn: EMPTY_FILL, painted: false, texture: null };
		} else {
			const painted = h.terrain !== 'default';
			const named = !!h.name;
			const fill = h.colorOverride || terrainColors[h.terrain];
			const flat = !named ? (painted ? fill : EMPTY_FILL) : h.hasContent ? fill : NAMED_FILL;
			const texture = style === 'illustrated' && painted ? ART.texture(h.terrain, h.terrainVariant) : null;
			const base = texture ? TEX.textureGroundFill(flat, texture) : flat;
			look = { base, drawn: painted ? SPEC.jitterFill(base, q, r) : base, painted, texture };
		}
		cache.set(key, look);
		return look;
	}

	/** Rivers with their courses sampled and cut at the shore, once. */
	riverGeometry(): RiverGeometry[] {
		if (this.riverCache) return this.riverCache;
		const wet = (x: number, y: number) => {
			const [q, r] = pixelToAxial(x, y);
			return this.isWater(q, r);
		};
		this.riverCache = this.rivers
			.filter((river) => river.anchors.length >= 2)
			.map((river) => {
				const pts = river.anchors.map(anchorPixel);
				const samples = SPEC.sampleSmoothCourse(pts, R * SPEC.riverCourseStep);
				const split = SPEC.splitCourseAtWater(samples, wet, R);
				const nearWater = new Map<number, [number, number]>();
				const mouths: RiverGeometry['mouths'] = [];
				if (split) {
					const seen = new Set<number>();
					for (const [x, y] of samples) {
						const [q, r] = pixelToAxial(x, y);
						if (seen.has(cellKey(q, r))) continue;
						seen.add(cellKey(q, r));
						for (const [dq, dr] of [[0, 0] as [number, number], ...SPEC.hexEdgeNeighbors]) {
							if (this.isWater(q + dq, r + dr)) nearWater.set(cellKey(q + dq, r + dr), [q + dq, r + dr]);
						}
					}
					for (const m of split.mouths) {
						const land = new Map<number, [number, number]>();
						for (const [x, y] of m.spine) {
							const [q, r] = pixelToAxial(x, y);
							if (!this.isWater(q, r)) land.set(cellKey(q, r), [q, r]);
						}
						const shore = m.spine[m.spine.length - 1]!;
						const dest = pixelToAxial(shore[0] + m.into[0] * R * 0.1, shore[1] + m.into[1] * R * 0.1);
						mouths.push({ land: [...land.values()], dest });
					}
				}
				const pad = R;
				const [x0, y0, x1, y1] = bbox(pts);
				return {
					river,
					pts,
					split,
					mouths,
					nearWater: [...nearWater.values()],
					bbox: [x0 - pad, y0 - pad, x1 + pad, y1 + pad] as [number, number, number, number],
				};
			});
		return this.riverCache;
	}

	/** Routes in scene px, lowest rank first (a bigger road's casing goes over). */
	routeGeometry(): RouteGeometry[] {
		if (this.routeCache) return this.routeCache;
		const rank = (k: string) => SPEC.roadKindsByRank.indexOf(k);
		this.routeCache = this.routes
			.filter((r) => r.anchors.length >= 2)
			.map((route) => {
				const pts = route.anchors.map(anchorPixel);
				// A kind this build does not know is drawn as a road (format-2 §1).
				const style = SPEC.roadStyleOf(route.kind) ?? (route.kind === 'border' ? null : SPEC.roadStyleOf('road'));
				// A curve overshoots its control points by a sixth of a span;
				// a hex radius covers that and any casing.
				const [x0, y0, x1, y1] = bbox(pts);
				return { route, style, pts, bbox: [x0 - R, y0 - R, x1 + R, y1 + R] as [number, number, number, number] };
			})
			.sort((a, b) => rank(a.route.kind) - rank(b.route.kind));
		return this.routeCache;
	}

	/** Illustrated pebbles and paving joints of a road, once per route. */
	roadMarks(g: RouteGeometry): { pebbles: number[]; ticks: number[] } {
		const key = `${g.route.id}|${g.route.kind}|${g.route.width}`;
		let marks = this.markCache.get(key);
		if (!marks) {
			const first = g.route.anchors[0]!;
			marks = SPEC.roadMarks(g.style!, SPEC.smoothPolyline(g.pts), g.route.width, first[1] * 73 + first[2]);
			this.markCache.set(key, marks);
		}
		return marks;
	}

	/** Rivers and non-border roads as [x1, y1, x2, y2, halfWidth] segments, per
	 *  cell whose objects they can touch (Illustrated leaves those out). */
	obstacleSegments(): Map<number, number[][]> {
		if (this.obstacleCache) return this.obstacleCache;
		const out = new Map<number, number[][]>();
		const add = (pts: Point[], halfWidth: number) => {
			for (let i = 0; i + 1 < pts.length; i++) {
				const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
				const seg = [ax, ay, bx, by, halfWidth];
				const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (R * 0.5)));
				const cells = new Set<number>();
				for (let j = 0; j <= steps; j++) {
					const t = j / steps;
					const [q, r] = pixelToAxial(ax + (bx - ax) * t, ay + (by - ay) * t);
					cells.add(cellKey(q, r));
					for (const [dq, dr] of SPEC.hexEdgeNeighbors) cells.add(cellKey(q + dq, r + dr));
				}
				for (const k of cells) {
					let list = out.get(k);
					if (!list) out.set(k, (list = []));
					list.push(seg);
				}
			}
		};
		for (const river of this.rivers) add(river.anchors.map(anchorPixel), (8 * river.width) / 2);
		for (const g of this.routeGeometry()) {
			if (g.style) add(g.pts, SPEC.roadCasingWidth(g.style, g.route.width) / 2);
		}
		this.obstacleCache = out;
		return out;
	}

	/** Every stored hex's coordinates. */
	*cells(): Generator<[number, number]> {
		for (const h of this.hexes.values()) yield [h.q, h.r];
	}
}
