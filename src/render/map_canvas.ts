// A map on screen: the camera, the base layer (tiles, or a direct render) and
// a pointer-only overlay. No Obsidian import: the view (view/map_view.ts)
// hosts it, and the benchmark drives it.
//
// Frame rules (decisions 23 / 23b in the Flutter repo):
// - Camera only translated, layer unchanged: draw tiles. Missing visible tiles
//   render within a per-frame budget; until then the previous zoom's tiles or
//   the whole-map overview stand in. Idle frames prefetch a ring around the view.
// - Zooming: what is held is STRETCHED (no rendering at all); once the wheel
//   has been quiet for SETTLE_MS a tile set at the new zoom is built,
//   progressively, the stretched one standing in until it covers the view.
// - The scene changing (an edit): frames render DIRECTLY, culled and at the
//   zoom's level of detail, until it has been quiet for SETTLE_MS.
// - Pointer-only changes (hover) repaint the overlay, never the base layer.

import {
	HEX_RADIUS as R,
	MAX_ZOOM,
	cellInGrid,
	cellsPixelBounds,
	fitRect,
	gridPixelBounds,
	minScaleForGrid,
	pixelToAxial,
	type Rect,
} from '../core/geometry';
import { LOD_MED, MapPainter } from './painter';
import { CANVAS_BG, type MapScene, type MapStyle } from './scene';
import { TextureCache, type Surface, type SurfaceFactory } from './textures';
import { SPEC } from './vendor';
import { HOVER_GLOW, strokeCells, type OverlayFrame } from './overlay';
import { TILE, TileSet, sameKey, tilesCovering, type LayerKey } from './tiles';

export interface Camera {
	/** CSS px per scene px. */
	scale: number;
	/** Screen (CSS px) position of the scene origin. */
	ox: number;
	oy: number;
}

export type FrameMode = 'tiles' | 'stretch' | 'direct' | 'empty';

export interface FrameStats {
	mode: FrameMode;
	/** Tiles rendered this frame, prefetched ones included. */
	tilesRendered: number;
	/** Idle work done this frame, if any. */
	background: 'prefetch' | 'overview' | null;
	ms: number;
}

const SETTLE_MS = 180;
/** Tile rendering allowed per frame, ms (one tile always renders if needed). */
const TILE_BUDGET_MS = 8;
/** The overview's longest side, device px. */
const OVERVIEW_PX = 2048;
/** The overview is rendered in bands this tall, one per idle frame. */
const OVERVIEW_BAND = 256;
/** Never zoom out past the medium level of detail (Flutter's floor). */
export const MIN_LEGIBLE_SCALE = LOD_MED / R;

export class MapCanvas {
	readonly base: HTMLCanvasElement;
	readonly overlay: HTMLCanvasElement;
	camera: Camera = { scale: 1, ox: 0, oy: 0 };
	style: MapStyle = 'clean';
	blend = false;
	/** Off: every frame renders directly (for the benchmark's comparison). */
	useTiles = true;
	/** On: frames run only when frame() is called (the benchmark drives them). */
	manual = false;
	hover: [number, number] | null = null;
	/** Called after the camera moves (to remember it). */
	onCameraChange: (() => void) | null = null;

	private scene: MapScene | null = null;
	private readonly painter: MapPainter;
	private tiles: TileSet | null = null;
	/** The previous zoom's tiles, standing in while the new set fills. */
	private previous: TileSet | null = null;
	/** The whole map, small: what a zoom-out shows until tiles arrive. Built
	 *  in bands over idle frames ([band] of [bands] done). */
	private overview: { key: LayerKey; surface: Surface; k: number; bounds: Rect; band: number; bands: number } | null = null;
	private lastZoomAt = -Infinity;
	private lastEditAt = -Infinity;
	private lastEditRevision = -1;
	private framePending = 0;
	private settleTimer = 0;
	private width = 0; // CSS px
	private height = 0;
	private dpr = 1;
	last: FrameStats = { mode: 'empty', tilesRendered: 0, background: null, ms: 0 };

	constructor(
		private readonly host: HTMLElement,
		private readonly win: Window,
		private readonly makeSurface: SurfaceFactory,
	) {
		this.base = host.createEl('canvas', { cls: 'hexlore-map-base' });
		this.overlay = host.createEl('canvas', { cls: 'hexlore-map-overlay' });
		// The base is always painted edge to edge: an opaque context composites cheaper.
		this.base.getContext('2d', { alpha: false });
		this.painter = new MapPainter(new TextureCache(makeSurface, (h) => SPEC.parseHex(h)));
	}

	setScene(scene: MapScene | null): void {
		this.scene = scene;
		this.tiles = null;
		this.previous = null;
		this.overview = null;
		this.lastEditRevision = scene?.revision ?? -1;
		this.lastEditAt = -Infinity; // a new scene is not an edit
		// The texture cache is keyed by content, not by scene: kept.
		this.requestFrame();
	}

	getScene(): MapScene | null {
		return this.scene;
	}

	setStyle(style: MapStyle, blend: boolean): void {
		if (style === this.style && blend === this.blend) return;
		this.style = style;
		this.blend = blend;
		this.requestFrame();
	}

	/** Size the canvases to the host; keeps the scene point at the centre. */
	resize(): void {
		const w = this.host.clientWidth, h = this.host.clientHeight;
		const dpr = this.win.devicePixelRatio || 1;
		if (w === this.width && h === this.height && dpr === this.dpr) return;
		if (this.width && this.height) {
			this.camera.ox += (w - this.width) / 2;
			this.camera.oy += (h - this.height) / 2;
		}
		this.width = w;
		this.height = h;
		this.dpr = dpr;
		for (const c of [this.base, this.overlay]) {
			c.width = Math.max(1, Math.round(w * dpr));
			c.height = Math.max(1, Math.round(h * dpr));
		}
		this.requestFrame();
		this.paintOverlay();
	}

	get size(): [number, number] {
		return [this.width, this.height];
	}

	// ----- camera ------------------------------------------------------------

	/** The zoom-out floor: the whole grid fits, but never below medium LOD. */
	minScale(): number {
		if (!this.scene) return MIN_LEGIBLE_SCALE;
		return Math.max(minScaleForGrid(this.scene.grid, this.width, this.height), MIN_LEGIBLE_SCALE);
	}

	/** Frame the painted hexes (the grid when there are none), never below
	 *  the medium level of detail. */
	fit(): void {
		if (!this.scene || !this.width) return;
		const bounds = cellsPixelBounds(this.scene.cells()) ?? gridPixelBounds(this.scene.grid);
		const [scale, ox, oy] = fitRect(bounds, this.width, this.height, { minFit: MIN_LEGIBLE_SCALE });
		this.camera = { scale, ox, oy };
		this.cameraMoved(true);
	}

	panBy(dx: number, dy: number): void {
		this.camera.ox += dx;
		this.camera.oy += dy;
		this.cameraMoved(false);
	}

	/** Zoom by [factor] about screen point (sx, sy), within the limits. */
	zoomAt(sx: number, sy: number, factor: number): void {
		const s0 = this.camera.scale;
		const s1 = Math.min(MAX_ZOOM, Math.max(this.minScale(), s0 * factor));
		if (s1 === s0) return;
		this.camera.ox = sx - (sx - this.camera.ox) * (s1 / s0);
		this.camera.oy = sy - (sy - this.camera.oy) * (s1 / s0);
		this.camera.scale = s1;
		this.lastZoomAt = this.win.performance.now();
		this.cameraMoved(true);
	}

	/** Centre on a scene point at the current zoom. */
	centreOn(x: number, y: number): void {
		this.camera.ox = this.width / 2 - x * this.camera.scale;
		this.camera.oy = this.height / 2 - y * this.camera.scale;
		this.cameraMoved(false);
	}

	/** The scene point at the centre of the view. */
	centre(): [number, number] {
		return [(this.width / 2 - this.camera.ox) / this.camera.scale, (this.height / 2 - this.camera.oy) / this.camera.scale];
	}

	private cameraMoved(zoomed: boolean): void {
		this.requestFrame();
		this.paintOverlay();
		if (zoomed) this.scheduleSettle();
		this.onCameraChange?.();
	}

	/** The in-grid cell under a screen point, or null. */
	cellAt(sx: number, sy: number): [number, number] | null {
		if (!this.scene) return null;
		const [q, r] = pixelToAxial((sx - this.camera.ox) / this.camera.scale, (sy - this.camera.oy) / this.camera.scale);
		return cellInGrid(q, r, this.scene.grid) ? [q, r] : null;
	}

	setHover(cell: [number, number] | null): void {
		const same = cell === this.hover || (cell && this.hover && cell[0] === this.hover[0] && cell[1] === this.hover[1]);
		if (same) return;
		this.hover = cell;
		this.paintOverlay();
	}

	// ----- frames ------------------------------------------------------------

	/** Mark the scene as just edited: frames render directly until it settles. */
	sceneEdited(): void {
		this.lastEditAt = this.win.performance.now();
		this.scheduleSettle();
		this.requestFrame();
	}

	requestFrame(): void {
		if (this.framePending || this.manual) return;
		this.framePending = this.win.requestAnimationFrame(() => {
			this.framePending = 0;
			this.frame();
		});
	}

	private scheduleSettle(): void {
		this.win.clearTimeout(this.settleTimer);
		this.settleTimer = this.win.setTimeout(() => this.requestFrame(), SETTLE_MS + 10);
	}

	dispose(): void {
		if (this.framePending) this.win.cancelAnimationFrame(this.framePending);
		this.win.clearTimeout(this.settleTimer);
		this.tiles = this.previous = null;
		this.overview = null;
		this.painter.reset();
	}

	/** Render one frame now and report what it did. */
	frame(): FrameStats {
		const t0 = this.win.performance.now();
		const c = this.base.getContext('2d')!;
		const W = this.base.width, H = this.base.height;
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.fillStyle = CANVAS_BG;
		c.fillRect(0, 0, W, H);
		const scene = this.scene;
		if (!scene || !this.width) return (this.last = { mode: 'empty', tilesRendered: 0, background: null, ms: 0 });

		const dpr = this.dpr;
		const cam = this.camera;
		// Snap the offset to device pixels, so tiles land 1:1 and a tiled
		// frame matches a direct one.
		const oxD = Math.round(cam.ox * dpr), oyD = Math.round(cam.oy * dpr);
		const key: LayerKey = { revision: scene.revision, style: this.style, blend: this.blend, dpr };
		const now = t0;
		if (scene.revision !== this.lastEditRevision) {
			this.lastEditRevision = scene.revision;
			this.lastEditAt = now;
			this.scheduleSettle();
		}
		const editing = now - this.lastEditAt < SETTLE_MS;
		const zooming = now - this.lastZoomAt < SETTLE_MS;

		if (!this.useTiles || editing) {
			this.paintDirect(c, scene, key, oxD, oyD);
			return (this.last = { mode: 'direct', tilesRendered: 0, background: null, ms: this.win.performance.now() - t0 });
		}

		// A set at this zoom with this key, or start one.
		let set = this.tiles;
		if (!set || !sameKey(set.key, key) || (set.scale !== cam.scale && !zooming)) {
			if (set && sameKey(set.key, key)) this.previous = set; // a settled zoom: the old zoom stands in
			else this.previous = null; // new content: stale tiles must not show
			const fresh = !set || !sameKey(set.key, key);
			set = this.tiles = new TileSet(key, cam.scale, scene, this.painter, this.makeSurface);
			if (fresh && this.overview && !sameKey(this.overview.key, key)) this.overview = null;
			if (fresh && !this.previous) {
				// New content (or the first frame): one synchronous pass over the
				// view, so nothing stale or blank is ever shown.
				for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1)) set.render(i, j);
			}
		}

		const f = cam.scale / set.scale;
		let rendered = 0;
		let missing = 0;
		if (f === 1) {
			// Render missing visible tiles within the budget, centre first.
			const start = this.win.performance.now();
			for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1)) {
				if (set.has(i, j)) continue;
				if (rendered && this.win.performance.now() - start > TILE_BUDGET_MS) {
					missing++;
					continue;
				}
				set.render(i, j);
				rendered++;
			}
		} else {
			for (const [i, j] of tilesCovering(W, H, oxD, oyD, f)) if (!set.has(i, j)) missing++;
		}

		if (missing) {
			this.drawOverview(c, key, oxD, oyD);
			if (this.previous) this.drawSet(c, this.previous, oxD, oyD, cam.scale / this.previous.scale, W, H);
		} else {
			this.previous = null; // the new zoom covers the view
		}
		this.drawSet(c, set, oxD, oyD, f, W, H);

		const mode: FrameMode = f === 1 ? 'tiles' : 'stretch';
		let background: FrameStats['background'] = null;
		if (missing || zooming || rendered) {
			this.requestFrame();
		} else if (f === 1) {
			// Idle: one piece of background work per frame — the ring around
			// the view first (the next pan finds it ready), then the overview.
			if (this.prefetch(set, oxD, oyD, W, H)) {
				background = 'prefetch';
				rendered++;
			} else if (this.overviewStep(scene, key)) {
				background = 'overview';
			}
			if (background) this.requestFrame();
		}
		return (this.last = { mode, tilesRendered: rendered, background, ms: this.win.performance.now() - t0 });
	}

	private paintDirect(c: CanvasRenderingContext2D, scene: MapScene, key: LayerKey, oxD: number, oyD: number): void {
		const k = this.camera.scale * this.dpr;
		c.setTransform(k, 0, 0, k, oxD, oyD);
		this.painter.paint(c, scene, {
			style: key.style,
			blend: key.blend,
			scale: this.camera.scale,
			dpr: this.dpr,
			rect: [-oxD / k, -oyD / k, (this.base.width - oxD) / k, (this.base.height - oyD) / k],
		});
		c.setTransform(1, 0, 0, 1, 0, 0);
	}

	private drawSet(c: CanvasRenderingContext2D, set: TileSet, oxD: number, oyD: number, f: number, W: number, H: number): void {
		const span = TILE * f;
		for (const [i, j] of tilesCovering(W, H, oxD, oyD, f)) {
			const t = set.get(i, j);
			if (!t) continue;
			if (f === 1) c.drawImage(t as CanvasImageSource, i * TILE + oxD, j * TILE + oyD);
			// Stretched: overlap by a pixel so the seams don't show.
			else c.drawImage(t as CanvasImageSource, i * span + oxD, j * span + oyD, span + 1, span + 1);
		}
	}

	/** Render one tile of the ring around the view; true while more remain. */
	private prefetch(set: TileSet, oxD: number, oyD: number, W: number, H: number): boolean {
		for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1, 1)) {
			if (set.has(i, j)) continue;
			set.render(i, j);
			return true;
		}
		return false;
	}

	/** Render the next band of the overview; false when it is complete. */
	private overviewStep(scene: MapScene, key: LayerKey): boolean {
		let o = this.overview;
		if (!o || !sameKey(o.key, key)) {
			const bounds = gridPixelBounds(scene.grid);
			const [, , bw, bh] = bounds;
			if (bw <= 0 || bh <= 0) return false;
			const k = Math.min(OVERVIEW_PX / bw, OVERVIEW_PX / bh); // device px per scene px
			const surface = this.makeSurface(Math.ceil(bw * k), Math.ceil(bh * k));
			const c = surface.getContext('2d') as CanvasRenderingContext2D;
			c.fillStyle = CANVAS_BG;
			c.fillRect(0, 0, surface.width, surface.height);
			o = this.overview = { key, surface, k, bounds, band: 0, bands: Math.ceil(surface.height / OVERVIEW_BAND) };
		}
		if (o.band >= o.bands) return false;
		const c = o.surface.getContext('2d') as CanvasRenderingContext2D;
		const y0 = o.band * OVERVIEW_BAND, y1 = Math.min(o.surface.height, y0 + OVERVIEW_BAND);
		const [bx, by, bw] = o.bounds;
		c.save();
		c.beginPath();
		c.rect(0, y0, o.surface.width, y1 - y0);
		c.clip();
		c.setTransform(o.k, 0, 0, o.k, -bx * o.k, -by * o.k);
		this.painter.paint(c, scene, {
			style: key.style,
			blend: key.blend,
			scale: o.k / key.dpr,
			dpr: key.dpr,
			rect: [bx, by + y0 / o.k, bx + bw, by + y1 / o.k],
			maxDetail: 'medium',
		});
		c.restore();
		o.band++;
		return true;
	}

	private drawOverview(c: CanvasRenderingContext2D, key: LayerKey, oxD: number, oyD: number): void {
		const o = this.overview;
		if (!o || !sameKey(o.key, key)) return;
		const k = this.camera.scale * this.dpr;
		const [x, y, w, h] = o.bounds;
		c.drawImage(o.surface as CanvasImageSource, x * k + oxD, y * k + oyD, w * k, h * k);
	}

	// ----- overlay -----------------------------------------------------------

	/** Draws the overlay (tools, selection, ruler…); the canvas just clears
	 *  it and calls this whenever the camera or the overlay state changes. */
	overlayPainter: ((f: OverlayFrame) => void) | null = null;

	paintOverlay(): void {
		const c = this.overlay.getContext('2d')!;
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, this.overlay.width, this.overlay.height);
		if (!this.width) return;
		const f: OverlayFrame = { c, camera: this.camera, dpr: this.dpr, width: this.width, height: this.height };
		if (this.overlayPainter) {
			c.save();
			this.overlayPainter(f);
			c.restore();
		} else if (this.hover) {
			strokeCells(f, [this.hover], HOVER_GLOW, 2.5);
		}
	}
}
