// The map as the renderer sees it: hexes keyed by packed cell, rivers and
// routes as scene-pixel polylines, the grid window — plus everything derived
// from them that does NOT change from frame to frame (terrain groups, fills,
// river courses and mouths, texture obstacles, road marks). player.js redid
// all of that every frame; here it is computed once per revision, lazily.
//
// Built from the map model by scene_from_model.ts; edits replace a hex with
// setHex() and bump the revision.
//
// Every change also records its DAMAGE: the scene rect whose pixels it can
// alter, so cached images (tiles, the overview) redraw only that. A change
// whose reach is not worked out (threads, overlays) bumps the EPOCH instead,
// and everything cached starts over.

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
	/** The hatch and the contour as paths, built on first use and kept with
	 *  the shape (one Path2D, not one per paint). */
	paths?: { hatch: Path2D; contour: Path2D };
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

/** A scene rect as [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

/** How far from its centre anything a hex draws can reach: objects stand
 *  over the hex edge and labels overhang it. The painter's one-cell cull pad
 *  makes the same assumption. */
const HEX_REACH = 2 * R;
/** A hex's change reaches its six neighbours (edges, coast haloes, blend
 *  strips and masks) and whatever they draw. */
const HEX_DAMAGE = Math.sqrt(3) * R + HEX_REACH;
/** A line's change reaches past its anchors: the curve's overshoot and
 *  casing, or a mouth's spill (R), and the objects it clears or lets stand
 *  again, which stand on it — so their cells' centres are within R of it —
 *  and draw within HEX_REACH of those. */
const LINE_DAMAGE = 2 * R + HEX_REACH;
/** Damage entries kept; a consumer further behind starts over. */
const DAMAGE_LOG_MAX = 4096;

export function boxesOverlap(a: Box, b: Box): boolean {
	return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function around(x: number, y: number, pad: number): Box {
	return [x - pad, y - pad, x + pad, y + pad];
}

function grow(b: Box, pad: number): Box {
	return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function sameOverlays(a: Overlays, b: Overlays): boolean {
	return (
		a.threads === b.threads &&
		a.threadStyle === b.threadStyle &&
		a.regions === b.regions &&
		a.borders === b.borders &&
		a.gmFog === b.gmFog &&
		a.badges === b.badges &&
		sameSet(a.hiddenThreadColors, b.hiddenThreadColors) &&
		sameSet(a.hiddenRegions, b.hiddenRegions)
	);
}

/** The entries of [a] and [b] that are not in both (moved, edited, added or
 *  removed), compared by content: a line or region has no other identity
 *  the renderer can trust. */
function changed<T>(a: T[], b: T[]): T[] {
	const keyed = (xs: T[]) => new Map(xs.map((x) => [JSON.stringify(x), x]));
	const ka = keyed(a), kb = keyed(b);
	return [...ka].filter(([k]) => !kb.has(k)).concat([...kb].filter(([k]) => !ka.has(k))).map(([, x]) => x);
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
	/** Bumped by every change. */
	revision = 0;
	/** Bumped by a change with no recorded damage: cached images start over. */
	epoch = 0;
	readonly name: string;
	readonly format: number;
	readonly grid: GridWindow;
	readonly hexes = new Map<number, SceneHex>();
	rivers: SceneRiver[];
	routes: SceneRoute[];
	regions: SceneRegion[];
	threads: SceneThread[];
	overlays: Overlays = DEFAULT_OVERLAYS;
	/** Draw only the cells with terrain painted: no empty cells, no hexes
	 *  holding only a name or notes ("Show maps together", where a map lies
	 *  over another). Set before the first paint. */
	paintedOnly = false;
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
	/** What each revision after [damageFloor] touched, oldest first. */
	private damage: { revision: number; box: Box }[] = [];
	private damageFloor = 0;

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
		const group = SPEC.terrainGroup(h.terrain);
		const damage = this.hexDamage(h.q, h.r, wasWater || group === SPEC.groupWater);
		this.hexes.set(key, h);
		this.lookCache.clean.delete(key);
		this.lookCache.illustrated.delete(key);
		this.groupCache?.set(key, group);
		if (wasWater !== (group === SPEC.groupWater)) this.riverCache = null;
		this.touch(damage);
	}

	/** What a change to hex (q, r) can alter. A water hex also reaches the
	 *  rivers near it: their courses are cut at the shore, and their mouths
	 *  take the water's fill. Called BEFORE the change, while the rivers are
	 *  still laid out as they are on screen. */
	private hexDamage(q: number, r: number, water: boolean): Box[] {
		const [cx, cy] = axialToPixel(q, r);
		const near = around(cx, cy, HEX_DAMAGE);
		const out = [near];
		if (water) {
			for (const g of this.riverGeometry()) if (boxesOverlap(g.bbox, near)) out.push(grow(g.bbox, R));
		}
		return out;
	}

	/** Rivers and routes changed. */
	setLines(rivers: SceneRiver[], routes: SceneRoute[]): void {
		const reach = (anchors: Anchor[]) => (anchors.length ? grow(bbox(anchors.map(anchorPixel)), LINE_DAMAGE) : null);
		const damage = [...changed(this.rivers, rivers), ...changed(this.routes, routes)]
			.map((l) => reach(l.anchors))
			.filter((b): b is Box => b !== null);
		this.rivers = rivers;
		this.routes = routes;
		this.riverCache = this.routeCache = this.obstacleCache = null;
		this.markCache.clear();
		this.touch(damage);
	}

	setRegions(regions: SceneRegion[]): void {
		const damage: Box[] = [];
		for (const g of changed(this.regions, regions)) {
			// The contour's casing straddles the outer edges.
			if (g.cells.length) damage.push(grow(bbox(g.cells.map(([q, r]) => axialToPixel(q, r))), R + 8));
		}
		this.regions = regions;
		this.touch(damage);
	}

	setThreads(threads: SceneThread[]): void {
		this.threads = threads;
		this.threadCache = null;
		this.touchAll(); // the courses fan out around each other, map-wide
	}

	setOverlays(o: Overlays): void {
		// Every display change re-applies the overlays of every open map: an
		// unchanged set must not start a new epoch (every tile redrawn).
		if (sameOverlays(this.overlays, o)) return;
		this.overlays = o;
		this.threadCache = null;
		this.touchAll();
	}

	/** The scene rects changed since [revision], or null when that is not
	 *  known (an epoch change, or too far back): redraw everything. */
	damageSince(revision: number): Box[] | null {
		if (revision < this.damageFloor) return null;
		const out: Box[] = [];
		for (let i = this.damage.length - 1; i >= 0 && this.damage[i]!.revision > revision; i--) out.push(this.damage[i]!.box);
		return out;
	}

	private touch(boxes: Box[]): void {
		this.revision++;
		for (const box of boxes) this.damage.push({ revision: this.revision, box });
		if (this.damage.length > DAMAGE_LOG_MAX) {
			const dropped = this.damage.splice(0, this.damage.length - DAMAGE_LOG_MAX / 2);
			this.damageFloor = dropped[dropped.length - 1]!.revision;
		}
	}

	private touchAll(): void {
		this.revision++;
		this.epoch++;
		this.damage = [];
		this.damageFloor = this.revision;
	}

	/** A region's contour and hatch, cached until its cells change. */
	regionShape(g: SceneRegion): RegionShape {
		const key = g.cells.map(([q, r]) => `${q},${r}`).join(';');
		const hit = this.regionCache.get(g.id);
		if (hit && hit.key === key) {
			hit.shape.region = g; // its colour or name may have changed, not its cells
			return hit.shape;
		}
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
		const damage = this.hexDamage(q, r, wasWater);
		this.hexes.delete(key);
		this.lookCache.clean.delete(key);
		this.lookCache.illustrated.delete(key);
		this.groupCache?.delete(key);
		if (wasWater) this.riverCache = null;
		this.touch(damage);
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
		if (cells.length) this.touch(cells.map(([q, r]) => around(...axialToPixel(q, r), R))); // the badges
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
