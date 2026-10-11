// The base layer of a GM map view: one function that paints a scene rect.
// The same code draws a whole frame (a direct render) and one tile.
//
// Ported from player.js (the player canvas), adjusted to the GM canvas it
// mirrors (Flutter's _HexMapPainter._paintScene):
// - it draws in SCENE coordinates under the caller's transform;
// - it visits only the cells in the rect (player.js drew every hex, every frame);
// - it has the GM canvas's levels of detail: below LOD_MED px of hex radius,
//   coarse squares; below LOD_FULL, fills and borders only; at LOD_FULL and up,
//   stamps, textures and labels;
// - empty grid cells are drawn (the GM lays out the whole window), and cell
//   edges and coastlines keep a constant SCREEN width, as on the GM canvas.

import {
	HEX_RADIUS as R,
	axialToPixel,
	cellsInRect,
	hexCorners,
	pixelToAxial,
	type Point,
} from '../core/geometry';
import { ART, type Stamp } from './art';
import { regionHatchSegments } from '../core/region';
import type { ThreadShape } from '../core/thread_geometry';
import { cellKey, type CellLook, type MapScene, type MapStyle, type RouteGeometry, type SceneThread } from './scene';
import { TextureCache, type HexTexture, type SpriteBox } from './textures';
import { SPEC, TEX, type GlyphTable, type Glyph } from './vendor';

export const LOD_FULL = 14; // hex radius px: labels, stamps, textures
export const LOD_MED = 6; // and up: fills and borders

export interface PaintParams {
	style: MapStyle;
	blend: boolean;
	/** CSS px per scene px. */
	scale: number;
	/** Device px per CSS px. */
	dpr: number;
	/** The scene rect to cover: [x0, y0, x1, y1]. Whatever lies outside is
	 *  clipped by the caller; the painter only uses it to cull. */
	rect: [number, number, number, number];
	/** Cap the detail whatever the zoom (the overview is a gap filler). */
	maxDetail?: 'medium';
}

const UNIT = hexCorners(0, 0);
const DEG = Math.PI / 180;
const RIVER_BORDER = { color: '#5C3210', w: 8.0 };
const RIVER_WATER = { color: '#3A7DBF', w: 5.0 };
const RIVER_GLINT = { color: 'rgba(107,174,214,0.6)', w: 1.8 };
const GLYPH_HALO_WIDTH = 2.5; // scene px; glyphHaloWidth in glyphs.dart
const GLYPH_OUTLINE_WIDTH = 1.4; // glyphOutlineWidth
const LABEL_MAX_WIDTH = R * 1.8;
const REVEAL_BADGE = '#55C8D4';
const THREAD_CASING = 'rgba(16,16,24,0.72)';
/** One hex's GM-fog hatch, pre-clipped (Flutter's _fogHatch). */
const FOG_HATCH = regionHatchSegments([[0, 0]], 9, R, -R * 2);

/** A region's colour with its lightness lifted to at least 0.62, so the
 *  overlay reads on dark and light terrain alike (Flutter's regionInk). */
export function regionInk(hex: string, minLightness = 0.62): string {
	const [r, g, b] = SPEC.parseHex(hex).map((v) => v / 255) as [number, number, number];
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (l >= minLightness) return hex;
	const d = max - min;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
	}
	h *= 60;
	const c2 = (1 - Math.abs(2 * minLightness - 1)) * s;
	const x = c2 * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = minLightness - c2 / 2;
	const [r1, g1, b1] = h < 60 ? [c2, x, 0] : h < 120 ? [x, c2, 0] : h < 180 ? [0, c2, x] : h < 240 ? [0, x, c2] : h < 300 ? [x, 0, c2] : [c2, 0, x];
	const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
	return `#${to(r1)}${to(g1)}${to(b1)}`.toUpperCase();
}

function chevronStops(s: ThreadShape, labelled: boolean): number[] {
	const len = s.sample(16).reduce((sum, p, i, a) => (i ? sum + Math.hypot(p[0] - a[i - 1]![0], p[1] - a[i - 1]![1]) : 0), 0);
	const m = Math.max(1, Math.floor(len / (1.8 * R)));
	const stops: number[] = [];
	for (let i = 1; i <= m; i++) {
		const f = i / (m + 1);
		if (labelled && Math.abs(f - 0.5) < 0.14) continue;
		stops.push(s.t0 + (s.t1 - s.t0) * f);
	}
	if (!stops.length) stops.push(s.t0 + (s.t1 - s.t0) * 0.28);
	return stops;
}
const FEATURE_BADGE = '#E0A24A';
const LABEL_FONT = `600 ${SPEC.labelFontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;

function hexPath(c: CanvasRenderingContext2D, cx: number, cy: number, inset = 1): void {
	for (let i = 0; i < 6; i++) {
		const [x, y] = UNIT[i]!;
		if (i) c.lineTo(cx + x * inset, cy + y * inset);
		else c.moveTo(cx + x * inset, cy + y * inset);
	}
	c.closePath();
}

/** Catmull-Rom through the points as cubic Béziers (the river smoothing). */
function smoothPath(c: CanvasRenderingContext2D, pts: Point[]): void {
	c.beginPath();
	if (!pts.length) return;
	c.moveTo(pts[0]![0], pts[0]![1]);
	if (pts.length === 1) return;
	if (pts.length === 2) {
		c.lineTo(pts[1]![0], pts[1]![1]);
		return;
	}
	const ext = [pts[0]!, ...pts, pts[pts.length - 1]!];
	for (let i = 1; i < ext.length - 2; i++) {
		const p0 = ext[i - 1]!, p1 = ext[i]!, p2 = ext[i + 1]!, p3 = ext[i + 2]!;
		c.bezierCurveTo(
			p1[0] + (p2[0] - p0[0]) / 6,
			p1[1] + (p2[1] - p0[1]) / 6,
			p2[0] - (p3[0] - p1[0]) / 6,
			p2[1] - (p3[1] - p1[1]) / 6,
			p2[0],
			p2[1],
		);
	}
}

/** Where paintGlyph draws [g] at (0, [y]) with [size], halo (or [pad])
 *  included: a sprite's box. */
function glyphBox(table: GlyphTable, g: Glyph, size: number, y: number, pad = (GLYPH_HALO_WIDTH + GLYPH_OUTLINE_WIDTH) / 2 + 1): SpriteBox {
	const [s, tx, ty] = table.transform(g, size);
	return [tx + s * g.left - pad, y + ty + s * g.top - pad, tx + s * g.right + pad, y + ty + s * g.bottom + pad];
}

/** Where paintBiomeStamp draws [stamp] about (0, 0): a sprite's box. A
 *  procedural stamp stays within 1.5 sizes, plus its (screen-floored) line. */
function stampBox(stamp: Stamp, scale: number): SpriteBox {
	const size = R * SPEC.terrainStampScale, y = R * SPEC.stampCentreOffset;
	if (stamp.kind === 'glyph') return glyphBox(stamp.table, stamp.glyph, size, y);
	const e = 1.5 * size + 2 + 1 / scale;
	return [-e, y - e, e, y + e];
}

/** Segments per subpath when a course is cut to a rect. */
const COURSE_CHUNK = 8;

const missesRect = (b: [number, number, number, number], r: [number, number, number, number], pad: number) =>
	b[2] + pad < r[0] || b[0] - pad > r[2] || b[3] + pad < r[1] || b[1] - pad > r[3];

/** Begin a path holding the parts of smoothPath's course through [pts] that
 *  can reach [rect] grown by [pad]: runs of COURSE_CHUNK segments, each a
 *  subpath of its own (a Bézier stays within its control points). Stroked
 *  with ROUND caps and joins in ONE call, that is the whole course's stroke
 *  inside the rect: such a stroke is the course swept by a disk, a run's
 *  sweep is part of it, and one call fills the union once. A tile used to
 *  stroke every river and road crossing it end to end. Never for a dashed
 *  line: a cut would restart its dashes. */
function smoothCourse(c: CanvasRenderingContext2D, pts: Point[], rect: [number, number, number, number], pad: number): void {
	const n = pts.length;
	if (n < 3) {
		smoothPath(c, pts);
		return;
	}
	c.beginPath();
	const ext = [pts[0]!, ...pts, pts[n - 1]!];
	for (let s0 = 0; s0 < n - 1; s0 += COURSE_CHUNK) {
		const s1 = Math.min(s0 + COURSE_CHUNK, n - 1);
		const segs: number[] = [];
		const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
		const grow = (x: number, y: number) => {
			box[0] = Math.min(box[0], x);
			box[1] = Math.min(box[1], y);
			box[2] = Math.max(box[2], x);
			box[3] = Math.max(box[3], y);
		};
		grow(pts[s0]![0], pts[s0]![1]);
		for (let i = s0; i < s1; i++) {
			const p0 = ext[i]!, p1 = ext[i + 1]!, p2 = ext[i + 2]!, p3 = ext[i + 3]!;
			const ax = p1[0] + (p2[0] - p0[0]) / 6, ay = p1[1] + (p2[1] - p0[1]) / 6;
			const bx = p2[0] - (p3[0] - p1[0]) / 6, by = p2[1] - (p3[1] - p1[1]) / 6;
			segs.push(ax, ay, bx, by, p2[0], p2[1]);
			grow(ax, ay);
			grow(bx, by);
			grow(p2[0], p2[1]);
		}
		if (missesRect(box, rect, pad)) continue;
		c.moveTo(pts[s0]![0], pts[s0]![1]);
		for (let i = 0; i < segs.length; i += 6) c.bezierCurveTo(segs[i]!, segs[i + 1]!, segs[i + 2]!, segs[i + 3]!, segs[i + 4]!, segs[i + 5]!);
	}
}

/** The same for a polyline (a river's dry run). */
function polylineCourse(c: CanvasRenderingContext2D, pts: Point[], rect: [number, number, number, number], pad: number): void {
	c.beginPath();
	for (let s0 = 0; s0 < pts.length - 1; s0 += COURSE_CHUNK) {
		const s1 = Math.min(s0 + COURSE_CHUNK, pts.length - 1);
		const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
		for (let i = s0; i <= s1; i++) {
			box[0] = Math.min(box[0], pts[i]![0]);
			box[1] = Math.min(box[1], pts[i]![1]);
			box[2] = Math.max(box[2], pts[i]![0]);
			box[3] = Math.max(box[3], pts[i]![1]);
		}
		if (missesRect(box, rect, pad)) continue;
		c.moveTo(pts[s0]![0], pts[s0]![1]);
		for (let i = s0 + 1; i <= s1; i++) c.lineTo(pts[i]![0], pts[i]![1]);
	}
}

function polygon(c: CanvasRenderingContext2D, pts: Point[]): void {
	c.beginPath();
	pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.closePath();
}

const overlaps = (b: [number, number, number, number], r: [number, number, number, number]) =>
	b[2] >= r[0] && b[0] <= r[2] && b[3] >= r[1] && b[1] <= r[3];

interface Cell {
	q: number;
	r: number;
	cx: number;
	cy: number;
	look: CellLook;
}

/** A biome stamp, glyph or procedural, in the ink derived from the fill.
 *  Exported for the brush palette's previews (view/pick_preview.ts). */
export function paintBiomeStamp(c: CanvasRenderingContext2D, stamp: Stamp | null, cx: number, cy: number, fill: string, scale: number): void {
	if (!stamp) return;
	const y = cy + R * SPEC.stampCentreOffset;
	const size = R * SPEC.terrainStampScale;
	if (stamp.kind === 'glyph') {
		paintGlyph(c, stamp.table, stamp.glyph, cx, y, size, fill);
		return;
	}
	const ink = SPEC.inkFor(fill);
	c.save();
	c.translate(cx, y);
	c.strokeStyle = ink;
	c.fillStyle = ink;
	// At least one screen px, as player.js's Math.max(1, …).
	c.lineWidth = Math.max(1 / scale, size * SPEC.stampStrokeRatio);
	c.lineCap = 'round';
	c.lineJoin = 'round';
	stamp.draw(c, size);
	c.restore();
}

/** Halo in the hex's own fill, then the ink: a silhouette that separates
 *  from terrain of similar value without tinting it (_drawGlyph). */
export function paintGlyph(c: CanvasRenderingContext2D, table: GlyphTable, g: Glyph, x: number, y: number, size: number, fill: string): void {
	const [s, tx, ty] = table.transform(g, size);
	const ink = SPEC.inkFor(fill);
	const path = table.path(g);
	c.save();
	c.translate(x + tx, y + ty);
	c.scale(s, s);
	const inkWidth = g.outline ? GLYPH_OUTLINE_WIDTH : 0;
	c.strokeStyle = fill;
	c.lineWidth = (GLYPH_HALO_WIDTH + inkWidth) / s;
	c.lineJoin = 'round';
	c.stroke(path);
	if (g.outline) {
		c.strokeStyle = ink;
		c.lineWidth = inkWidth / s;
		c.stroke(path);
	} else {
		c.fillStyle = ink;
		c.fill(path);
	}
	c.restore();
}

export class MapPainter {
	private labelFits = new Map<string, string>();
	/** Blend strips by edge and fills (paintBlendStrips). */
	private strips = new Map<string, { gradient: CanvasGradient; path: Path2D }>();

	constructor(readonly textures: TextureCache) {}

	/** Drop what was derived from the scene's art (a style switch keeps it). */
	reset(): void {
		this.textures.clear();
	}

	paint(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams): void {
		const radiusPx = R * p.scale;
		if (radiusPx < LOD_MED) {
			this.paintCoarse(c, scene, p);
			this.paintRivers(c, scene, p);
			this.paintRoutes(c, scene, p, false);
			return;
		}
		const full = radiusPx >= LOD_FULL && p.maxDetail !== 'medium';
		const ill = p.style === 'illustrated';
		const cells = this.cellsIn(scene, p);

		// 1. Fills. One anti-aliased path per cell on purpose: the faint seams
		//    between separately anti-aliased hexes are part of the grid's look.
		for (const cell of cells) {
			c.beginPath();
			hexPath(c, cell.cx, cell.cy);
			c.fillStyle = cell.look.drawn;
			c.fill();
		}

		// 1a. Blend: gradients across biome borders, over the flat fills.
		if (p.blend) this.paintBlendStrips(c, scene, cells, p.style);

		// 1b. Illustrated ground marks (clipped to the hex). First, every
		//     raster this paint draws is made, before any is drawn: making
		//     one into an atlas page this paint had already drawn from cost
		//     a flush of the page each time.
		const textured: HexTexture[] = ill && full ? this.texturesOf(scene, cells, p) : [];
		if (full) {
			if (!ill) this.textures.beginPaint();
			for (const t of textured) this.textures.prepare(t);
			this.sprites(scene, cells, textured, p);
		}
		for (const t of textured) this.textures.blit(c, t, 'ground');

		// 1c. Coastlines and cell edges.
		this.paintCellEdges(c, scene, cells, p);

		// 1d. Stamps (under rivers and roads). The feature REPLACES the biome
		//     stamp; the biome still owns the fill. Each is a SPRITE: drawn once
		//     per look and zoom bucket, blitted from the atlas from then on
		//     (a halo stroke and a fill of a glyph path per hex, per paint, was
		//     most of a Clean render — Flutter's decision 23).
		if (full) for (const cell of cells) this.stamp(c, scene, cell, p);

		// 1e. GM fog: a hatch on every hex the GM has not written (no name).
		if (scene.overlays.gmFog) this.paintGmFog(c, scene, cells);

		// 1f. GM badges: what the player map exposes. An eye on revealed
		//     hexes (top right), a slashed ring on a feature kept from
		//     players (bottom right).
		if (full && scene.overlays.badges) this.paintBadges(c, scene, cells);

		// 2. Rivers, then roads over them.
		this.paintRivers(c, scene, p);
		this.paintRoutes(c, scene, p, full && ill);

		// 2c. Illustrated objects over rivers and roads, back to front, then
		//     features with their own foreground objects.
		if (textured.length) {
			textured.sort((a, b) => (a.cy !== b.cy ? a.cy - b.cy : a.cx - b.cx));
			for (const t of textured) this.textures.blit(c, t, 'behind');
			for (const t of textured) {
				if (t.slot === null) continue;
				const h = scene.hexAt(t.q, t.r);
				if (h?.feature) {
					const [fx, fy] = TEX.featureSlotCentre(t.slot);
					this.featureObject(c, h.feature, h.featureVariant, t.cx + fx * R, t.cy + fy * R, t.ground, p);
				}
				this.textures.blit(c, t, 'front');
			}
		}

		// 2d. Threads (GM-only), under the labels.
		this.paintThreads(c, scene, p, full);

		// 3. Labels, at full detail only (they are text).
		if (full) this.paintLabels(c, scene, p);

		// 4. Regions (GM-only), on top of everything.
		this.paintRegions(c, scene, p);
	}

	/** Hatch + haloed contour per region, in its ink (decision 7). */
	private paintRegions(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams): void {
		const o = scene.overlays;
		if (!o.regions || !scene.regions.length) return;
		const ordered = [...scene.regions].sort((a, b) => a.zOrder - b.zOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		c.lineCap = 'round';
		for (const g of ordered) {
			if (o.hiddenRegions.has(g.id) || !g.cells.length) continue;
			const shape = scene.regionShape(g);
			if (!overlaps(shape.bbox, p.rect)) continue;
			const ink = regionInk(g.color);
			const path = (segs: [number, number, number, number][]) => {
				const pp = new Path2D();
				for (const [x0, y0, x1, y1] of segs) {
					pp.moveTo(x0, y0);
					pp.lineTo(x1, y1);
				}
				return pp;
			};
			shape.paths ??= { hatch: path(shape.hatch), contour: path(shape.contour) };
			c.globalAlpha = 0.55;
			c.strokeStyle = ink;
			c.lineWidth = 2.2;
			c.stroke(shape.paths.hatch);
			c.globalAlpha = 1;
			const contour = shape.paths.contour;
			c.strokeStyle = 'rgba(0,0,0,0.55)';
			c.lineWidth = 7;
			c.stroke(contour);
			c.strokeStyle = ink;
			c.lineWidth = 4.5;
			c.stroke(contour);
		}
		c.lineCap = 'butt';
	}

	/** Threads as laid-out courses (decision 27). */
	private paintThreads(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams, full: boolean): void {
		const shapes = scene.threadShapes();
		if (!shapes.size) return;
		const byId = new Map(scene.threads.map((t) => [t.id, t]));
		// Sizes in scene units, with a screen floor: never a hairline zoomed out.
		const k = Math.max(1, 0.75 / p.scale);
		const curved = scene.overlays.threadStyle === 'arc';
		const drawn: { t: SceneThread; s: ThreadShape; pts: [number, number][] }[] = [];
		for (const [id, s] of shapes) {
			const t = byId.get(id);
			if (!t) continue;
			const pts = s.sample(curved ? 28 : 1);
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const [x, y] of pts) {
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
			}
			if (overlaps([x0 - R, y0 - R, x1 + R, y1 + R], p.rect)) drawn.push({ t, s, pts });
		}
		for (const casing of [true, false]) for (const d of drawn) this.paintThreadBody(c, d.t, d.s, d.pts, k, casing);
		if (!full) return;
		for (const d of drawn) if (d.t.label) this.paintThreadLabel(c, d.t, d.s.at(d.s.midT), k);
	}

	private paintThreadBody(c: CanvasRenderingContext2D, t: SceneThread, s: ThreadShape, pts: [number, number][], k: number, casing: boolean): void {
		const resolved = t.status === 'resolved', dormant = t.status === 'dormant';
		const color = casing ? THREAD_CASING : t.color;
		const grow = casing ? 3.2 * k : 0;
		c.globalAlpha = !casing && resolved ? 0.6 : 1;
		c.strokeStyle = color;
		c.fillStyle = color;
		c.lineCap = 'round';
		c.lineJoin = 'round';
		c.lineWidth = 3.2 * k + grow;
		c.setLineDash(dormant ? [10 * k, 7 * k] : resolved ? [0.1, 6 * k] : []);
		c.beginPath();
		pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
		c.stroke();
		c.setLineDash([]);
		const dot = (x: number, y: number) => {
			c.beginPath();
			c.arc(x, y, 3.6 * k + grow / 2, 0, Math.PI * 2);
			c.fill();
		};
		const [sx, sy] = s.start, [ex, ey] = s.end;
		dot(sx, sy);
		if (t.direction === 'one-way') {
			const [tx, ty] = s.tangentAt(s.t1);
			this.threadArrow(c, ex, ey, tx, ty, k, grow);
			for (const at of chevronStops(s, !!t.label)) {
				const [cx, cy] = s.at(at), [dx, dy] = s.tangentAt(at);
				const arm = 6.5 * k, nx = -dy, ny = dx;
				const tipX = cx + dx * arm * 0.5, tipY = cy + dy * arm * 0.5;
				const bx = tipX - dx * arm, by = tipY - dy * arm;
				c.lineWidth = 2.6 * k + grow;
				c.beginPath();
				c.moveTo(bx + nx * arm * 0.8, by + ny * arm * 0.8);
				c.lineTo(tipX, tipY);
				c.lineTo(bx - nx * arm * 0.8, by - ny * arm * 0.8);
				c.stroke();
			}
		} else {
			dot(ex, ey);
		}
		c.globalAlpha = 1;
	}

	private threadArrow(c: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, k: number, grow: number): void {
		const len = 15 * k, half = 8 * k, nx = -dy, ny = dx;
		const bx = x - dx * len, by = y - dy * len;
		c.beginPath();
		c.moveTo(x, y);
		c.lineTo(bx + nx * half, by + ny * half);
		c.lineTo(bx + dx * len * 0.3, by + dy * len * 0.3);
		c.lineTo(bx - nx * half, by - ny * half);
		c.closePath();
		if (grow > 0) {
			c.lineWidth = grow;
			c.stroke();
		}
		c.fill();
	}

	private paintThreadLabel(c: CanvasRenderingContext2D, t: SceneThread, at: [number, number], k: number): void {
		const text = t.label.length > 28 ? `${t.label.slice(0, 27)}…` : t.label;
		c.font = `600 ${10.5 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
		const w = c.measureText(text).width + 10 * k, h = 10.5 * k * 1.25 + 4 * k;
		c.beginPath();
		c.roundRect(at[0] - w / 2, at[1] - h / 2, w, h, 4 * k);
		c.fillStyle = 'rgba(24,24,38,0.9)';
		c.fill();
		c.lineWidth = 1.4 * k;
		c.strokeStyle = t.color;
		c.stroke();
		c.fillStyle = '#FFFFFF';
		c.textAlign = 'center';
		c.textBaseline = 'middle';
		c.fillText(text, at[0], at[1] + 0.5 * k);
	}

	/** The GM-fog hatch, one pre-clipped unit hatch per unwritten hex. */
	private paintGmFog(c: CanvasRenderingContext2D, scene: MapScene, cells: Cell[]): void {
		const path = new Path2D();
		for (const cell of cells) {
			if (scene.hexAt(cell.q, cell.r)?.name) continue;
			for (const [x0, y0, x1, y1] of FOG_HATCH) {
				path.moveTo(cell.cx + x0, cell.cy + y0);
				path.lineTo(cell.cx + x1, cell.cy + y1);
			}
		}
		c.strokeStyle = 'rgba(20,30,30,0.7)';
		c.lineWidth = 2;
		c.stroke(path);
	}

	private paintBadges(c: CanvasRenderingContext2D, scene: MapScene, cells: Cell[]): void {
		c.lineWidth = 1.5;
		for (const cell of cells) {
			if (scene.isRevealed(cell.q, cell.r)) {
				const x = cell.cx + R * 0.45, y = cell.cy - R * 0.45;
				c.strokeStyle = REVEAL_BADGE;
				c.fillStyle = REVEAL_BADGE;
				c.beginPath();
				c.arc(x, y, 4, 0, Math.PI * 2);
				c.stroke();
				c.beginPath();
				c.arc(x, y, 1.6, 0, Math.PI * 2);
				c.fill();
			}
			const h = scene.hexAt(cell.q, cell.r);
			if (h?.feature && h.featureHidden) {
				const x = cell.cx + R * 0.45, y = cell.cy + R * 0.45;
				c.strokeStyle = FEATURE_BADGE;
				c.beginPath();
				c.arc(x, y, 4, 0, Math.PI * 2);
				c.moveTo(x - 3, y + 3);
				c.lineTo(x + 3, y - 3);
				c.stroke();
			}
		}
	}

	/** Far out: the stored hexes as squares of their fill (Flutter's _paintCoarse). */
	private paintCoarse(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams): void {
		const [x0, y0, x1, y1] = p.rect;
		const s = R * 0.8;
		// The cells in the rect, not every hex of the map: a tile or an
		// overview band covers a small part of it.
		for (const [q, r] of cellsInRect(x0, y0, x1, y1, scene.grid)) {
			if (!scene.hexAt(q, r)) continue;
			const [cx, cy] = axialToPixel(q, r);
			c.fillStyle = scene.look(q, r, p.style).drawn;
			c.fillRect(cx - s / 2, cy - s / 2, s, s);
		}
	}

	/** Across every edge between two painted cells of different base colour,
	 *  a strip graded from one drawn fill to the other. */
	private paintBlendStrips(c: CanvasRenderingContext2D, scene: MapScene, cells: Cell[], style: MapStyle): void {
		const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
		const d = TEX.blendEdgeDepth;
		for (const cell of cells) {
			if (scene.group(cell.q, cell.r) === SPEC.groupNone) continue;
			for (let k = 0; k < 6; k++) {
				const [oq, or, ok] = SPEC.canonicalEdge(cell.q, cell.r, k);
				if (oq !== cell.q || or !== cell.r || ok !== k) continue;
				const [dq, dr] = SPEC.hexEdgeNeighbors[k]!;
				const nq = cell.q + dq, nr = cell.r + dr;
				if (scene.group(nq, nr) === SPEC.groupNone) continue;
				const other = scene.look(nq, nr, style);
				if (other.base === cell.look.base) continue;
				// A strip depends only on its edge and the two fills: made once,
				// kept across paints and tiles (a gradient is not tied to the
				// context that made it).
				const key = `${cell.q},${cell.r},${k}|${cell.look.drawn}|${other.drawn}`;
				let strip = this.strips.get(key);
				if (!strip) {
					const cA: Point = [cell.cx, cell.cy];
					const cB = axialToPixel(nq, nr);
					const p0: Point = [cA[0] + R * Math.cos(DEG * 60 * k), cA[1] + R * Math.sin(DEG * 60 * k)];
					const p1: Point = [cA[0] + R * Math.cos(DEG * 60 * ((k + 1) % 6)), cA[1] + R * Math.sin(DEG * 60 * ((k + 1) % 6))];
					const from = lerp(lerp(p0, cA, d), lerp(p1, cA, d), 0.5);
					const to = lerp(lerp(p0, cB, d), lerp(p1, cB, d), 0.5);
					const gradient = c.createLinearGradient(from[0], from[1], to[0], to[1]);
					gradient.addColorStop(0, cell.look.drawn);
					gradient.addColorStop(1, other.drawn);
					const path = new Path2D();
					[lerp(p0, cA, d), lerp(p1, cA, d), p1, lerp(p1, cB, d), lerp(p0, cB, d), p0].forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
					path.closePath();
					if (this.strips.size > 50_000) this.strips.clear();
					this.strips.set(key, (strip = { gradient, path }));
				}
				c.fillStyle = strip.gradient;
				c.fill(strip.path);
			}
		}
	}

	/** Every cell outline once (by its canonical owner): quiet inside a terrain
	 *  mass, heavier where the group changes; a coast halo inside water beside
	 *  land. Constant screen width, as on the GM canvas. */
	private paintCellEdges(c: CanvasRenderingContext2D, scene: MapScene, cells: Cell[], p: PaintParams): void {
		const quiet = new Path2D();
		const boundary = new Path2D();
		const coast = new Path2D();
		let anyBoundary = false, anyCoast = false;
		for (const cell of cells) {
			const mine = scene.group(cell.q, cell.r);
			if (mine === SPEC.groupWater) {
				for (let k = 0; k < 6; k++) {
					const [dq, dr] = SPEC.hexEdgeNeighbors[k]!;
					if (!SPEC.isCoast(mine, scene.group(cell.q + dq, cell.r + dr))) continue;
					for (let i = 0; i < 6; i++) {
						const [x, y] = UNIT[i]!;
						const px = cell.cx + x * SPEC.coastInset, py = cell.cy + y * SPEC.coastInset;
						if (i) coast.lineTo(px, py);
						else coast.moveTo(px, py);
					}
					coast.closePath();
					anyCoast = true;
					break;
				}
			}
			for (let k = 0; k < 6; k++) {
				const [oq, or, ok] = SPEC.canonicalEdge(cell.q, cell.r, k);
				if (oq !== cell.q || or !== cell.r || ok !== k) continue;
				const [dq, dr] = SPEC.hexEdgeNeighbors[k]!;
				const theirs = scene.group(cell.q + dq, cell.r + dr);
				const both = mine === SPEC.groupNone && theirs === SPEC.groupNone;
				const a = UNIT[k]!, b = UNIT[(k + 1) % 6]!;
				// Blend: every edge is a quiet line (a heavy stroke along a border
				// would redraw the cut the gradient removed).
				const heavy = !p.blend && SPEC.isBoundary(mine, theirs) && !both;
				const path = heavy ? boundary : quiet;
				if (heavy) anyBoundary = true;
				path.moveTo(cell.cx + a[0], cell.cy + a[1]);
				path.lineTo(cell.cx + b[0], cell.cy + b[1]);
			}
		}
		if (anyCoast) {
			const [r, g, b] = SPEC.parseHex(SPEC.coastColor);
			c.strokeStyle = `rgba(${r},${g},${b},${SPEC.coastAlpha})`;
			c.lineWidth = SPEC.coastWidth / p.scale;
			c.stroke(coast);
		}
		const [r, g, b] = SPEC.parseHex(SPEC.edgeColor);
		const ill = p.style === 'illustrated';
		c.lineCap = 'butt';
		c.strokeStyle = `rgba(${r},${g},${b},${ill ? TEX.illustratedEdgeQuietAlpha : SPEC.edgeQuietAlpha})`;
		c.lineWidth = (ill ? TEX.illustratedEdgeQuietWidth : SPEC.edgeQuietWidth) / p.scale;
		c.stroke(quiet);
		if (anyBoundary) {
			c.lineJoin = 'round';
			c.strokeStyle = `rgba(${r},${g},${b},${ill ? TEX.illustratedEdgeBoundaryAlpha : SPEC.edgeBoundaryAlpha})`;
			c.lineWidth = (ill ? TEX.illustratedEdgeBoundaryWidth : SPEC.edgeBoundaryWidth) / p.scale;
			c.stroke(boundary);
		}
	}

	/** The cells a paint visits, with their looks. */
	private cellsIn(scene: MapScene, p: PaintParams): Cell[] {
		const [x0, y0, x1, y1] = p.rect;
		const cells: Cell[] = [];
		for (const [q, r] of cellsInRect(x0, y0, x1, y1, scene.grid)) {
			const [cx, cy] = axialToPixel(q, r);
			cells.push({ q, r, cx, cy, look: scene.look(q, r, p.style) });
		}
		return cells;
	}

	/** The texture records of the textured [cells] (Illustrated, full detail). */
	private texturesOf(scene: MapScene, cells: Cell[], p: PaintParams): HexTexture[] {
		this.textures.beginPaint();
		const res = this.textures.resolution(R * p.scale, p.dpr);
		const obstacles = scene.obstacleSegments();
		const out: HexTexture[] = [];
		for (const cell of cells) {
			const tex = cell.look.texture;
			const h = tex && scene.hexAt(cell.q, cell.r);
			if (!tex || !h) continue;
			const mine = scene.group(cell.q, cell.r);
			const mask = p.blend
				? TEX.blendMaskFor(mine, (k) => {
						const [dq, dr] = SPEC.hexEdgeNeighbors[k]!;
						return scene.group(cell.q + dq, cell.r + dr);
					})
				: 0;
			out.push(
				TextureCache.hexTexture(
					cell.q,
					cell.r,
					cell.cx,
					cell.cy,
					h.terrain,
					h.terrainVariant,
					tex,
					cell.look.base,
					!!h.feature,
					res,
					obstacles.get(cellKey(cell.q, cell.r)) ?? [],
					mask,
				),
			);
		}
		return out;
	}

	/** A cell's stamp: its feature, else its biome's stamp, as a sprite. In
	 *  the Illustrated style a textured cell has none (its objects are its
	 *  stamp) and a feature is an object. No context: pre-warming. */
	private stamp(c: CanvasRenderingContext2D | null, scene: MapScene, cell: Cell, p: PaintParams): void {
		const h = scene.hexAt(cell.q, cell.r);
		if (!h) return;
		const k = p.scale * p.dpr;
		if (p.style === 'illustrated') {
			if (cell.look.texture) return; // drawn with its texture
			if (h.feature) this.featureObject(c, h.feature, h.featureVariant, cell.cx, cell.cy + R * SPEC.stampCentreOffset, cell.look.base, p);
			if (h.feature) return;
		}
		const fill = cell.look.base;
		if (h.feature) {
			const g = ART.featureGlyph(h.feature, h.featureVariant);
			if (!g) return;
			const size = R * SPEC.featureStampScale;
			this.textures.sprite(c, `f|${h.feature}|${h.featureVariant}|${fill}`, cell.cx, cell.cy + R * SPEC.stampCentreOffset, () => glyphBox(g.table, g.glyph, size, 0), k, (cc) =>
				paintGlyph(cc, g.table, g.glyph, 0, 0, size, fill),
			);
		} else if (cell.look.painted) {
			const stamp = ART.biomeStamp(h.terrain, h.terrainVariant);
			if (!stamp) return;
			this.textures.sprite(c, `b|${stamp.id}|${fill}`, cell.cx, cell.cy, () => stampBox(stamp, p.scale), k, (cc, kq) =>
				paintBiomeStamp(cc, stamp, 0, 0, fill, kq / p.dpr),
			);
		}
	}

	/** Make the textures and sprites a paint of [p] would need, drawing
	 *  nothing, within the frame's texture budget (pre-warming an area
	 *  before it scrolls into view). True when all of them are held. */
	warm(scene: MapScene, p: PaintParams): boolean {
		if (R * p.scale < LOD_FULL || p.maxDetail === 'medium') return true;
		const cells = this.cellsIn(scene, p);
		let textured: HexTexture[] = [];
		if (p.style === 'illustrated') {
			textured = this.texturesOf(scene, cells, p);
			for (const t of textured) if (!this.textures.ensure(t)) return false;
		} else this.textures.beginPaint();
		this.sprites(scene, cells, textured, p);
		return this.textures.budgetLeft > 0;
	}

	/** Make the sprites of [cells] (feature objects, stamps), drawing
	 *  nothing; out of budget, the rest wait for the draw. */
	private sprites(scene: MapScene, cells: Cell[], textured: HexTexture[], p: PaintParams): void {
		for (const t of textured) {
			const h = t.slot !== null ? scene.hexAt(t.q, t.r) : undefined;
			if (h?.feature) {
				const [fx, fy] = TEX.featureSlotCentre(t.slot!);
				this.featureObject(null, h.feature, h.featureVariant, t.cx + fx * R, t.cy + fy * R, t.ground, p);
			}
		}
		for (const cell of cells) this.stamp(null, scene, cell, p);
	}

	/** A feature object, as a sprite (see paintFeatureObject). */
	private featureObject(c: CanvasRenderingContext2D | null, feature: string, variant: number, x: number, y: number, ground: string, p: PaintParams): void {
		const art = ART.featureGlyph(feature as never, variant);
		if (!art) return;
		const box = (): SpriteBox => {
			const size = R * SPEC.featureStampScale;
			const depth = size * TEX.featureSolidDepth;
			const g = glyphBox(art.table, art.glyph, size, 0, TEX.glyphSolidOutlinePx + 1);
			// The walls are layers from -depth/2 to +depth/2; the shadow an
			// ellipse under the foot.
			return [Math.min(g[0], -R * 0.37), g[1] - depth / 2, Math.max(g[2], R * 0.37), Math.max(g[3] + depth / 2, R * 0.46)];
		};
		this.textures.sprite(c, `o|${feature}|${variant}|${ground}`, x, y, box, p.scale * p.dpr, (cc, kq) =>
			this.paintFeatureObject(cc, feature, variant, 0, 0, ground, kq / p.dpr),
		);
	}

	/** A feature as an object on the ground: a soft shadow, then the
	 *  silhouette as a small carved solid (paintFeatureShadow + drawFeatureSolid). */
	private paintFeatureObject(c: CanvasRenderingContext2D, feature: string, variant: number, x: number, y: number, ground: string, scale: number): void {
		const art = ART.featureGlyph(feature as never, variant);
		if (!art) return;
		c.save();
		c.translate(x, y + R * 0.34);
		c.scale(1, 0.2 / 0.72);
		const shadow = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.36);
		shadow.addColorStop(0, `rgba(0,0,0,${TEX.textureShadowAlpha})`);
		shadow.addColorStop(1, 'rgba(0,0,0,0)');
		c.fillStyle = shadow;
		c.beginPath();
		c.arc(0, 0, R * 0.36, 0, Math.PI * 2);
		c.fill();
		c.restore();

		const size = R * SPEC.featureStampScale;
		const g = art.glyph;
		const [s, tx, ty] = art.table.transform(g, size);
		const path = art.table.path(g);
		const tone = {
			body: TEX.featureBodyTone(ground, feature),
			side: TEX.featureSideTone(ground, feature),
			highlight: TEX.featureHighlightTone(ground, feature),
			rim: TEX.featureRimTone(ground, feature),
			outline: TEX.featureOutlineTone(ground),
		};
		const depth = size * TEX.featureSolidDepth; // scene px
		// Layers about every 0.75 screen px, so the walls read as solid.
		const steps = Math.max(2, Math.min(12, Math.ceil((depth * scale) / 0.75)));
		const stepY = (i: number) => -depth / 2 + (depth * i) / steps;
		const at = (dy: number, draw: () => void) => {
			c.save();
			c.translate(x + tx, y + ty + dy);
			c.scale(s, s);
			draw();
			c.restore();
		};
		c.lineJoin = 'round';
		for (let i = 0; i <= steps; i++) {
			at(stepY(i), () => {
				c.strokeStyle = tone.outline;
				c.lineWidth = (2 * TEX.glyphSolidOutlinePx) / s;
				c.stroke(path);
			});
		}
		for (let i = steps; i >= 1; i--) {
			at(stepY(i), () => {
				c.fillStyle = SPEC.lerpHex(tone.side, tone.outline, (0.35 * i) / steps);
				c.fill(path);
			});
		}
		at(stepY(0), () => {
			const grad = c.createLinearGradient(g.left, g.top, g.right, g.bottom);
			grad.addColorStop(0, SPEC.lerpHex(tone.body, tone.highlight, 0.35));
			grad.addColorStop(1, tone.body);
			c.fillStyle = grad;
			c.fill(path);
			const bev = TEX.featureBevelPx / s;
			c.save();
			c.clip(path);
			c.lineWidth = 2 * bev;
			c.translate(bev, bev);
			c.strokeStyle = tone.highlight;
			c.stroke(path);
			c.translate(-2 * bev, -2 * bev);
			c.strokeStyle = tone.rim;
			c.stroke(path);
			c.restore();
		});
	}

	/** Rivers, as _paintRivers: a course that never meets water is one smooth
	 *  stroke; one that does is cut at the shore into dry runs plus MOUTHS that
	 *  flare and fade into the water's own fill. */
	private paintRivers(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams): void {
		const rivers = scene.riverGeometry().filter((g) => overlaps(g.bbox, p.rect));
		if (!rivers.length) return;
		const wet = (x: number, y: number) => {
			const [q, r] = pixelToAxial(x, y);
			return scene.isWater(q, r);
		};
		const whole = rivers.filter((g) => !g.split);
		const split = rivers.filter((g) => g.split);
		const [x0, y0, x1, y1] = p.rect;
		// A hex wholly outside the rect adds nothing inside it to a clip or a
		// fill, so only the ones touching it are added (a split river's water
		// cells, once per tile, were most of a tile's path work).
		const reach = R + 1 / (p.scale * p.dpr); // and a device pixel of anti-aliasing
		const touches = (q: number, r: number) => {
			const [cx, cy] = axialToPixel(q, r);
			return cx > x0 - reach && cx < x1 + reach && cy > y0 - reach && cy < y1 + reach;
		};
		const addHexes = (cells: [number, number][], reversed: boolean) => {
			for (const [q, r] of cells) {
				if (!touches(q, r)) continue;
				const [cx, cy] = axialToPixel(q, r);
				const corners = UNIT.map(([x, y]) => [cx + x, cy + y] as Point);
				if (reversed) corners.reverse();
				corners.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				c.closePath();
			}
		};
		c.lineCap = 'round'; // and round joins: the strokes may be cut to the rect
		c.lineJoin = 'round';
		const aa = 1 / (p.scale * p.dpr); // a device pixel of anti-aliasing
		for (const layer of [RIVER_BORDER, RIVER_WATER, RIVER_GLINT]) {
			c.strokeStyle = layer.color;
			c.fillStyle = layer.color;
			for (const g of whole) {
				c.lineWidth = layer.w * g.river.width;
				smoothCourse(c, g.pts, p.rect, c.lineWidth / 2 + aa);
				c.stroke();
			}
			if (!split.length) continue;
			c.save();
			// Water cells a mouth opens into are cut out of the strokes.
			c.beginPath();
			c.rect(x0 - R, y0 - R, x1 - x0 + 2 * R, y1 - y0 + 2 * R);
			for (const g of split) addHexes(g.nearWater, true);
			c.clip('nonzero');
			for (const g of split) {
				const half = (layer.w * g.river.width) / 2;
				c.lineWidth = layer.w * g.river.width;
				for (const run of g.split!.runs) {
					polylineCourse(c, run.points, p.rect, half + aa);
					c.stroke();
				}
				if (layer === RIVER_GLINT) continue; // the fade swallows it
				g.split!.mouths.forEach((m, i) => {
					if (!g.mouths[i]!.land.some(([q, r]) => touches(q, r))) return; // clipped to those
					const flare = half * SPEC.riverMouthFlare;
					c.save();
					c.beginPath();
					addHexes(g.mouths[i]!.land, false);
					c.clip('nonzero');
					polygon(c, SPEC.mouthOutline(m, half, flare, 0, wet, 4 * flare));
					c.fill();
					c.restore();
				});
			}
			c.restore();
		}
		// The fade into the water's own fill, spilling past the shore so the
		// coastline opens where the river comes in.
		for (const g of split) {
			const half = (RIVER_WATER.w * g.river.width) / 2;
			g.split!.mouths.forEach((m, i) => {
				const info = g.mouths[i]!;
				if (![...info.land, info.dest].some(([q, r]) => touches(q, r))) return; // clipped to those
				const fill = scene.look(info.dest[0], info.dest[1], p.style).drawn;
				const shore = m.spine[m.spine.length - 1]!;
				const spill = R * SPEC.riverMouthSpill;
				const start = m.spine[0]!;
				const end: Point = [shore[0] + m.into[0] * spill, shore[1] + m.into[1] * spill];
				const total = Math.hypot(end[0] - start[0], end[1] - start[1]);
				const atShore = total === 0 ? 1 : Math.min(1, Math.max(0, Math.hypot(shore[0] - start[0], shore[1] - start[1]) / total));
				const [r, gg, b] = SPEC.parseHex(fill);
				const grad = c.createLinearGradient(start[0], start[1], end[0], end[1]);
				grad.addColorStop(0, `rgba(${r},${gg},${b},0)`);
				grad.addColorStop(atShore, `rgb(${r},${gg},${b})`);
				grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
				c.save();
				c.beginPath();
				addHexes([...info.land, info.dest], false);
				c.clip('nonzero');
				polygon(c, SPEC.mouthOutline(m, half, half * SPEC.riverMouthFlare, spill));
				c.fillStyle = grad;
				c.fill();
				c.restore();
			});
		}
	}

	/** Roads, as _paintRoutes: every casing, then every body, then every core,
	 *  so roads merge where they meet; Illustrated marks at full detail;
	 *  borders last. */
	private paintRoutes(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams, marks: boolean): void {
		const visible = scene.routeGeometry().filter((g) => overlaps(g.bbox, p.rect) && (g.style || scene.overlays.borders));
		if (!visible.length) return;
		const roads = visible.filter((g) => g.style);
		const colour = (g: RouteGeometry) => g.route.color || '#6B4A2F';
		const stroke = (g: RouteGeometry, color: string, alpha: number, width: number, dash: number[], round: boolean) => {
			c.globalAlpha = alpha;
			c.strokeStyle = color;
			c.lineWidth = width;
			c.lineCap = round ? 'round' : 'butt';
			c.lineJoin = 'round';
			c.setLineDash(dash);
			if (round && !dash.length) smoothCourse(c, g.pts, p.rect, width / 2 + 1 / (p.scale * p.dpr));
			else smoothPath(c, g.pts); // a cut would restart the dashes (or square the ends)
			c.stroke();
		};
		for (const g of roads) {
			const s = g.style!;
			stroke(g, SPEC.roadCasingColor(colour(g), s), s.casingAlpha, SPEC.roadCasingWidth(s, g.route.width), s.dash, true);
		}
		for (const g of roads) {
			const s = g.style!;
			stroke(g, colour(g), s.bodyAlpha, SPEC.roadBodyWidth(s, g.route.width), s.dash, true);
		}
		for (const g of roads) {
			const s = g.style!;
			if (s.coreFrac <= 0) continue;
			stroke(g, SPEC.roadCoreColor(colour(g), s), 1, SPEC.roadBodyWidth(s, g.route.width) * s.coreFrac, s.coreDash, s.coreDash.length === 0);
		}
		c.globalAlpha = 1;
		c.setLineDash([]);
		c.lineCap = 'butt';

		if (marks) {
			// Only the marks in the rect: a road crossing a tile used to draw
			// every pebble it has, once per tile.
			const [x0, y0, x1, y1] = p.rect;
			// A pebble's radius or a tick's half width, and a device pixel of
			// anti-aliasing (which is many scene px when zoomed out).
			const pad = 1 + 1 / (p.scale * p.dpr);
			const inRect = (x: number, y: number) => x > x0 - pad && x < x1 + pad && y > y0 - pad && y < y1 + pad;
			for (const g of roads) {
				if (g.style!.marks === 'none') continue;
				const m = scene.roadMarks(g);
				const ink = SPEC.roadMarkColor(colour(g));
				c.fillStyle = ink;
				c.globalAlpha = 0.55;
				for (let i = 0; i + 2 < m.pebbles.length; i += 3) {
					if (!inRect(m.pebbles[i]!, m.pebbles[i + 1]!)) continue;
					c.beginPath();
					c.arc(m.pebbles[i]!, m.pebbles[i + 1]!, (m.pebbles[i + 2]! < 0.8 ? 1.0 : 1.6) / 2, 0, Math.PI * 2);
					c.fill();
				}
				if (m.ticks.length) {
					c.strokeStyle = ink;
					c.globalAlpha = 0.4;
					c.lineWidth = 0.8;
					c.beginPath();
					for (let i = 0; i + 3 < m.ticks.length; i += 4) {
						const ax = m.ticks[i]!, ay = m.ticks[i + 1]!, bx = m.ticks[i + 2]!, by = m.ticks[i + 3]!;
						if (Math.max(ax, bx) < x0 - pad || Math.min(ax, bx) > x1 + pad || Math.max(ay, by) < y0 - pad || Math.min(ay, by) > y1 + pad) continue;
						c.moveTo(ax, ay);
						c.lineTo(bx, by);
					}
					c.stroke();
				}
				c.globalAlpha = 1;
			}
		}

		for (const g of visible) {
			if (g.style) continue;
			c.strokeStyle = colour(g);
			c.lineWidth = SPEC.borderStyle.base * g.route.width;
			c.setLineDash(SPEC.borderStyle.dash);
			c.beginPath();
			g.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
			c.stroke();
		}
		c.setLineDash([]);
	}

	/** Hex names above the centre: near-white ink over a dark halo, cut with an
	 *  ellipsis at 1.8 radii as the GM canvas lays them out. */
	private paintLabels(c: CanvasRenderingContext2D, scene: MapScene, p: PaintParams): void {
		const [x0, y0, x1, y1] = p.rect;
		c.font = LABEL_FONT;
		c.textAlign = 'center';
		c.textBaseline = 'middle';
		c.lineJoin = 'round';
		c.strokeStyle = SPEC.labelHalo;
		c.fillStyle = SPEC.labelInk;
		c.lineWidth = SPEC.labelHaloWidth;
		// Labels overhang their cell: take one more ring of cells each side.
		for (const [q, r] of cellsInRect(x0 - R, y0 - R, x1 + R, y1 + R, scene.grid)) {
			const name = scene.hexAt(q, r)?.name;
			if (!name) continue;
			const [cx, cy] = axialToPixel(q, r);
			const text = this.fitLabel(c, name);
			const y = cy - R * SPEC.labelOffset;
			c.strokeText(text, cx, y);
			c.fillText(text, cx, y);
		}
	}

	private fitLabel(c: CanvasRenderingContext2D, name: string): string {
		let fit = this.labelFits.get(name);
		if (fit !== undefined) return fit;
		fit = name;
		if (c.measureText(name).width > LABEL_MAX_WIDTH) {
			let n = name.length;
			while (n > 1 && c.measureText(name.slice(0, n) + '…').width > LABEL_MAX_WIDTH) n--;
			fit = name.slice(0, n).trimEnd() + '…';
		}
		if (this.labelFits.size > 512) this.labelFits.clear();
		this.labelFits.set(name, fit);
		return fit;
	}
}
