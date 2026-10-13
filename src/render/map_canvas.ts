// A map on screen: the camera, the base layer (tiles, or a direct render) and
// a pointer-only overlay. No Obsidian import: the view (view/map_view.ts)
// hosts it, and the benchmark drives it.
//
// Frame rules (decisions 23 / 23b in the Flutter repo):
// - Camera only translated, layer unchanged: draw tiles. Missing visible tiles
//   render a few per frame; until then the previous zoom's tiles or the
//   whole-map overview stand in. Idle frames prefetch a ring around the view.
// - Zooming: what is held is STRETCHED (no rendering at all); once the wheel
//   has been quiet for SETTLE_MS a tile set at the new zoom is built,
//   progressively, the stretched one standing in until it covers the view.
// - An edit (hexes, lines, regions, fog): the tiles its damage touches are
//   dropped, and the visible ones render again in the same frame, however
//   many (a long river can touch the whole view); the overview redoes its
//   touched bands while idle. A change with no damage (threads, overlays: a
//   new scene EPOCH) renders DIRECTLY until it has been quiet for SETTLE_MS.
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
import { TILE, TilePool, TileSet, releaseSurface, sameKey, tilesCovering, type LayerKey } from './tiles';

export interface Camera {
	/** CSS px per scene px. */
	scale: number;
	/** Screen (CSS px) position of the scene origin. */
	ox: number;
	oy: number;
}

export type FrameMode = 'tiles' | 'stretch' | 'direct' | 'empty';

/** One piece of idle work: a visible tile painted with stand-in textures
 *  done again, a tile of the ring around the view, the textures of the ring
 *  past that, a band of the overview. */
export type IdleWork = 'soft' | 'textures' | 'prefetch' | 'warm' | 'overview';

interface IdleWindow {
	requestIdleCallback?(cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, opts?: { timeout: number }): number;
	cancelIdleCallback?(id: number): void;
}

export interface FrameStats {
	mode: FrameMode;
	/** Tiles rendered this frame, prefetched ones included. */
	tilesRendered: number;
	/** Idle work done this frame, if any. */
	background: IdleWork | null;
	ms: number;
}

const SETTLE_MS = 180;
/** Tiles scrolling or zooming in that one frame may render: most of a tile's
 *  cost is raster work after the frame, which no clock in here can see. */
const TILES_PER_FRAME = 3;
/** And within this much of the frame's own time, ms (one always renders):
 *  an Illustrated tile can take most of it. */
const TILE_BUDGET_MS = 8;
/** New Illustrated textures one frame (or one piece of idle work) may make;
 *  past that, rasters at another resolution stand in (decision 23b). */
const TEXTURES_PER_FRAME = 8;
/** How long the camera must have been still before textures are pre-warmed. */
const WARM_QUIET_MS = 500;
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
	private readonly pool: TilePool;
	private tiles: TileSet | null = null;
	/** The previous zoom's tiles, standing in while the new set fills. */
	private previous: TileSet | null = null;
	/** The whole map, small: what a zoom-out shows until tiles arrive. Built
	 *  in bands over idle frames ([band] of [bands] done); an edit marks the
	 *  bands it touched [dirty], redone after. */
	private overview: {
		key: LayerKey;
		revision: number;
		surface: Surface;
		k: number;
		bounds: Rect;
		band: number;
		bands: number;
		dirty: Set<number>;
	} | null = null;
	private lastZoomAt = -Infinity;
	/** When the camera last moved (pre-warming waits for it to be still). */
	private lastCameraAt = -Infinity;
	/** When the scene last changed with no recorded damage (a new epoch). */
	private lastEditAt = -Infinity;
	/** The epoch the held images show; null until the first frame of a scene
	 *  (whatever it went through before that — overlays applied right after
	 *  it was set — is not an edit). */
	private lastEpoch: number | null = null;
	private framePending = 0;
	private overlayPending = 0;
	private idlePending = 0;
	/** The tiles of the outer ring whose textures are made, for [warmedSet]. */
	private warmed = new Set<string>();
	private warmedSet: TileSet | null = null;
	private settleTimer = 0;
	private width = 0; // CSS px
	private height = 0;
	private dpr = 1;
	last: FrameStats = { mode: 'empty', tilesRendered: 0, background: null, ms: 0 };

	/** Cleared, not filled with the background, from the base to the tiles
	 *  and the overview: a map laid over another ("Show maps together"). The
	 *  map view stays opaque, which composites cheaper. */
	readonly transparent: boolean;

	constructor(
		private readonly host: HTMLElement,
		private readonly win: Window,
		private readonly makeSurface: SurfaceFactory,
		opts: { transparent?: boolean } = {},
	) {
		this.transparent = opts.transparent === true;
		this.base = host.createEl('canvas', { cls: 'hexlore-map-base' });
		this.overlay = host.createEl('canvas', { cls: 'hexlore-map-overlay' });
		// The base is always painted edge to edge: an opaque context composites cheaper.
		this.base.getContext('2d', { alpha: this.transparent });
		this.painter = new MapPainter(new TextureCache(makeSurface, (h) => SPEC.parseHex(h)));
		this.pool = new TilePool(makeSurface);
		this.watchPixelRatio();
	}

	setScene(scene: MapScene | null): void {
		this.scene = scene;
		this.setPrevious(null);
		this.tiles?.clear();
		this.tiles = null;
		this.dropOverview();
		this.lastEpoch = null;
		this.lastEditAt = -Infinity; // a new scene is not an edit
		// The texture cache is keyed by content, not by scene: kept.
		this.requestFrame();
	}

	getScene(): MapScene | null {
		return this.scene;
	}

	/** Illustrated textures and sprites made so far (for the benchmark). */
	get texturesMade(): number {
		return this.painter.textures.made;
	}

	/** Forget every texture and sprite, as a fresh open (for the benchmark:
	 *  the cache outlives scenes, so a run would depend on what was open). */
	dropRasters(): void {
		this.painter.reset();
	}


	setStyle(style: MapStyle, blend: boolean): void {
		if (style === this.style && blend === this.blend) return;
		this.style = style;
		this.blend = blend;
		this.requestFrame();
	}

	/** Follow the device pixel ratio (the window moved to another screen, a
	 *  browser zoom): no resize event comes with it, and the canvases would
	 *  stay at the old resolution until the next one. */
	private watchPixelRatio(): void {
		const mq = this.win.matchMedia?.(`(resolution: ${this.win.devicePixelRatio || 1}dppx)`);
		if (!mq?.addEventListener) return;
		const changed = () => {
			mq.removeEventListener('change', changed);
			if (this.disposed) return;
			this.resize();
			this.watchPixelRatio();
		};
		mq.addEventListener('change', changed);
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

	/** Set the camera outright, past the zoom limits (a view driving several
	 *  maps from one camera of its own: "Show maps together"). */
	setCamera(c: Camera): void {
		const zoomed = c.scale !== this.camera.scale;
		if (!zoomed && c.ox === this.camera.ox && c.oy === this.camera.oy) return;
		this.camera = { ...c };
		if (zoomed) this.lastZoomAt = this.win.performance.now();
		this.cameraMoved(zoomed);
	}

	/** The scene point at the centre of the view. */
	centre(): [number, number] {
		return [(this.width / 2 - this.camera.ox) / this.camera.scale, (this.height / 2 - this.camera.oy) / this.camera.scale];
	}

	private cameraMoved(zoomed: boolean): void {
		this.lastCameraAt = this.win.performance.now();
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

	requestFrame(): void {
		// Disposed: a late edit (an index read finishing after the view
		// closed) must not render tiles nothing will release.
		if (this.framePending || this.manual || this.disposed) return;
		this.framePending = this.win.requestAnimationFrame(() => {
			this.framePending = 0;
			this.frame();
		});
	}

	private scheduleSettle(): void {
		this.win.clearTimeout(this.settleTimer);
		this.settleTimer = this.win.setTimeout(() => this.requestFrame(), SETTLE_MS + 10);
	}

	private disposed = false;

	dispose(): void {
		this.disposed = true;
		if (this.framePending) this.win.cancelAnimationFrame(this.framePending);
		if (this.overlayPending) this.win.cancelAnimationFrame(this.overlayPending);
		if (this.idlePending) (this.win as IdleWindow).cancelIdleCallback?.(this.idlePending);
		this.win.clearTimeout(this.settleTimer);
		this.setPrevious(null);
		this.tiles?.clear();
		this.tiles = null;
		this.dropOverview();
		this.painter.reset();
	}

	/** Render one frame now and report what it did. */
	frame(): FrameStats {
		const t0 = this.win.performance.now();
		const c = this.base.getContext('2d')!;
		const W = this.base.width, H = this.base.height;
		c.setTransform(1, 0, 0, 1, 0, 0);
		if (this.transparent) c.clearRect(0, 0, W, H);
		else {
			c.fillStyle = CANVAS_BG;
			c.fillRect(0, 0, W, H);
		}
		const scene = this.scene;
		if (!scene || !this.width) return (this.last = { mode: 'empty', tilesRendered: 0, background: null, ms: 0 });
		this.painter.textures.beginFrame(TEXTURES_PER_FRAME);

		const dpr = this.dpr;
		const cam = this.camera;
		// Snap the offset to device pixels, so tiles land 1:1 and a tiled
		// frame matches a direct one.
		const oxD = Math.round(cam.ox * dpr), oyD = Math.round(cam.oy * dpr);
		const key: LayerKey = { epoch: scene.epoch, style: this.style, blend: this.blend, dpr };
		const now = t0;
		if (this.lastEpoch === null) this.lastEpoch = scene.epoch;
		else if (scene.epoch !== this.lastEpoch) {
			this.lastEpoch = scene.epoch;
			this.lastEditAt = now;
			this.scheduleSettle();
		}
		const editing = now - this.lastEditAt < SETTLE_MS;
		const zooming = now - this.lastZoomAt < SETTLE_MS;

		if (!this.useTiles || editing) {
			this.paintDirect(c, scene, key, oxD, oyD);
			return (this.last = { mode: 'direct', tilesRendered: 0, background: null, ms: this.win.performance.now() - t0 });
		}

		// What is held catches up with the edits since: only what their
		// damage touched goes. Visible tiles dropped here render this frame.
		const edited = new Set<string>();
		if (this.tiles && sameKey(this.tiles.key, key)) {
			const dropped = this.tiles.catchUp();
			if (dropped === false) {
				this.tiles.clear();
				this.tiles = null;
			}
			else for (const [i, j] of dropped) edited.add(`${i},${j}`);
		}
		if (this.previous && (!sameKey(this.previous.key, key) || this.previous.catchUp() === false)) this.setPrevious(null);
		this.overviewCatchUp(scene, key);

		// A set at this zoom with this key, or start one.
		let set = this.tiles;
		if (!set || !sameKey(set.key, key) || (set.scale !== cam.scale && !zooming)) {
			const fresh = !set || !sameKey(set.key, key);
			if (!fresh) this.setPrevious(set); // a settled zoom: the old zoom stands in
			else {
				this.setPrevious(null); // new content: stale tiles must not show
				set?.clear();
			}
			set = this.tiles = new TileSet(key, cam.scale, scene, this.painter, this.makeSurface, undefined, this.pool, this.transparent);
			edited.clear(); // those were the old set's tiles; this one draws the scene as it is
			if (fresh && this.overview && !sameKey(this.overview.key, key)) this.dropOverview();
			if (fresh && !this.previous) {
				// New content (or the first frame): one synchronous pass over the
				// view, so nothing stale or blank is ever shown.
				set.renderMany(tilesCovering(W, H, oxD, oyD, 1));
			}
		}

		const f = cam.scale / set.scale;
		let rendered = 0;
		let missing = 0;
		if (f === 1) {
			// Render missing visible tiles: every one an edit dropped, painted
			// in blocks (the edit shows at once, never a stale tile); then the
			// rest, centre first, one at a time within the budget. Those are
			// not blocked: a block of scattered tiles paints the gaps too.
			const now: [number, number][] = [], rest: [number, number][] = [];
			for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1)) {
				if (set.has(i, j)) continue;
				(edited.has(`${i},${j}`) ? now : rest).push([i, j]);
			}
			rendered += set.renderMany(now);
			const start = this.win.performance.now();
			let budgeted = 0;
			for (const [i, j] of rest) {
				if (budgeted >= TILES_PER_FRAME || (budgeted && this.win.performance.now() - start > TILE_BUDGET_MS)) {
					missing++;
					continue;
				}
				set.render(i, j);
				budgeted++;
			}
			rendered += budgeted;
		} else {
			for (const [i, j] of tilesCovering(W, H, oxD, oyD, f)) if (!set.has(i, j)) missing++;
		}

		if (missing) {
			this.drawOverview(c, key, oxD, oyD);
			if (this.previous) this.drawSet(c, this.previous, oxD, oyD, cam.scale / this.previous.scale, W, H);
		} else {
			this.setPrevious(null); // the new zoom covers the view
		}
		this.drawSet(c, set, oxD, oyD, f, W, H);

		const mode: FrameMode = f === 1 ? 'tiles' : 'stretch';
		let background: FrameStats['background'] = null;
		if (missing || zooming || rendered) {
			this.requestFrame();
		} else if (f === 1) {
			// Idle: one piece of work per frame, in requestIdleCallback after
			// the frame when there is one (in the frame without it, and for
			// the benchmark).
			if (!this.manual && (this.win as IdleWindow).requestIdleCallback) this.scheduleIdle();
			else {
				background = this.idleStep();
				if (background === 'soft' || background === 'prefetch') rendered++;
				if (background) this.requestFrame();
			}
		}
		return (this.last = { mode, tilesRendered: rendered, background, ms: this.win.performance.now() - t0 });
	}

	/** The set standing in for the last zoom; the one it replaces is done. */
	private setPrevious(set: TileSet | null): void {
		if (this.previous && this.previous !== set) this.previous.clear();
		this.previous = set;
	}

	private dropOverview(): void {
		if (this.overview) releaseSurface(this.overview.surface);
		this.overview = null;
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

	private scheduleIdle(): void {
		const w = this.win as IdleWindow;
		if (this.idlePending || !w.requestIdleCallback) return;
		this.idlePending = w.requestIdleCallback(
			(d) => {
				this.idlePending = 0;
				// ONE piece: its cost is mostly raster work after it, which
				// timeRemaining cannot see; a loop to the deadline queued a
				// tile's textures, or several tiles, for the next frame.
				if (d.timeRemaining() > 4 || d.didTimeout) {
					const work = this.idleStep();
					if (!work) return; // done, or no longer idle (a frame will ask again)
					if (work === 'soft') this.requestFrame(); // a visible tile changed
				}
				this.scheduleIdle();
			},
			{ timeout: 1000 },
		);
	}

	/** One piece of idle work, if the view is idle (the tiles at this zoom,
	 *  up to date, nothing moving): a visible soft tile, then the ring around
	 *  the view, then the textures of the ring past it, then the overview. */
	private idleStep(): IdleWork | null {
		const scene = this.scene, set = this.tiles;
		if (!scene || !set || !this.width || set.scale !== this.camera.scale || set.revision !== scene.revision) return null;
		const now = this.win.performance.now();
		if (now - this.lastZoomAt < SETTLE_MS || now - this.lastEditAt < SETTLE_MS) return null;
		const key: LayerKey = { epoch: scene.epoch, style: this.style, blend: this.blend, dpr: this.dpr };
		if (!sameKey(set.key, key)) return null;
		const W = this.base.width, H = this.base.height;
		const oxD = Math.round(this.camera.ox * this.dpr), oyD = Math.round(this.camera.oy * this.dpr);
		this.painter.textures.beginFrame(TEXTURES_PER_FRAME);
		const visible = tilesCovering(W, H, oxD, oyD, 1);
		const soft = visible.find(([i, j]) => set.isSoft(i, j));
		if (soft) {
			set.render(...soft);
			return 'soft';
		}
		const ring = this.prefetch(scene, set, oxD, oyD, W, H);
		if (ring) return ring;
		// Pre-warming is for a STILL map. During a pan each step's textures
		// were GPU work landing between frames (the benchmark: pan intervals
		// 33 → 166 ms with it), for a ring the pan was about to move past.
		if (now - this.lastCameraAt >= WARM_QUIET_MS && this.warmStep(scene, set, oxD, oyD, W, H)) return 'warm';
		if (this.overviewStep(scene, key)) return 'overview';
		return null;
	}

	/** Make the textures of one tile of the ring past the prefetched one
	 *  (drawing nothing): a pan beyond the ring finds them made. False when
	 *  every one is done. */
	private warmStep(scene: MapScene, set: TileSet, oxD: number, oyD: number, W: number, H: number): boolean {
		if (this.warmedSet !== set) {
			this.warmed = new Set();
			this.warmedSet = set;
		}
		const inner = new Set(tilesCovering(W, H, oxD, oyD, 1, 1).map(([i, j]) => `${i},${j}`));
		for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1, 2)) {
			const id = `${i},${j}`;
			if (inner.has(id) || this.warmed.has(id) || set.has(i, j)) continue;
			const done = this.painter.warm(scene, { style: this.style, blend: this.blend, scale: set.scale, dpr: this.dpr, rect: set.sceneRect(i, j) });
			if (done) this.warmed.add(id);
			return true;
		}
		return false;
	}

	/** One step on the ring around the view: the next tile's textures, a
	 *  frame's worth at a time ('textures'), then the tile ('prefetch'); null
	 *  when the ring is done. Making them all with the tile put a cold
	 *  tile's few dozen new textures, GPU work, between two frames of a pan
	 *  (the benchmark: the first Illustrated pan at zoom 1, 8% dropped). */
	private prefetch(scene: MapScene, set: TileSet, oxD: number, oyD: number, W: number, H: number): IdleWork | null {
		for (const [i, j] of tilesCovering(W, H, oxD, oyD, 1, 1)) {
			if (set.has(i, j)) continue;
			const p = { style: this.style, blend: this.blend, scale: set.scale, dpr: this.dpr, rect: set.sceneRect(i, j) };
			// Out of budget with some still to make: the tile waits. (A full
			// cache stops warming with budget left: render, as before.)
			if (!this.painter.warm(scene, p) && this.painter.textures.budgetLeft <= 0) return 'textures';
			set.render(i, j);
			return 'prefetch';
		}
		return null;
	}

	/** Mark the overview bands the edits since it was drawn touched (bands
	 *  not drawn yet will show them anyway). */
	private overviewCatchUp(scene: MapScene, key: LayerKey): void {
		const o = this.overview;
		if (!o || !sameKey(o.key, key) || o.revision === scene.revision) return;
		const damage = scene.damageSince(o.revision);
		if (!damage) {
			this.dropOverview();
			return;
		}
		o.revision = scene.revision;
		const by = o.bounds[1];
		for (const [, y0, , y1] of damage) {
			const b0 = Math.max(0, Math.floor(((y0 - by) * o.k) / OVERVIEW_BAND));
			const b1 = Math.min(o.band - 1, Math.floor(((y1 - by) * o.k) / OVERVIEW_BAND));
			for (let b = b0; b <= b1; b++) o.dirty.add(b);
		}
	}

	/** Render the next band of the overview, or a band an edit touched;
	 *  false when it is complete and current. */
	private overviewStep(scene: MapScene, key: LayerKey): boolean {
		let o = this.overview;
		if (!o || !sameKey(o.key, key)) {
			this.dropOverview();
			const bounds = gridPixelBounds(scene.grid);
			const [, , bw, bh] = bounds;
			if (bw <= 0 || bh <= 0) return false;
			const k = Math.min(OVERVIEW_PX / bw, OVERVIEW_PX / bh); // device px per scene px
			const surface = this.makeSurface(Math.ceil(bw * k), Math.ceil(bh * k));
			o = this.overview = {
				key,
				revision: scene.revision,
				surface,
				k,
				bounds,
				band: 0,
				bands: Math.ceil(surface.height / OVERVIEW_BAND),
				dirty: new Set(),
			};
		}
		let band: number;
		if (o.band < o.bands) band = o.band++;
		else if (o.dirty.size) {
			band = o.dirty.values().next().value as number;
			o.dirty.delete(band);
		} else return false;
		const c = o.surface.getContext('2d') as CanvasRenderingContext2D;
		const y0 = band * OVERVIEW_BAND, y1 = Math.min(o.surface.height, y0 + OVERVIEW_BAND);
		const [bx, by, bw] = o.bounds;
		c.save();
		c.beginPath();
		c.rect(0, y0, o.surface.width, y1 - y0);
		c.clip();
		// A band drawn again starts from nothing.
		if (this.transparent) c.clearRect(0, y0, o.surface.width, y1 - y0);
		else {
			c.fillStyle = CANVAS_BG;
			c.fillRect(0, y0, o.surface.width, y1 - y0);
		}
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

	/** Repaint the overlay, once, before the next frame: input comes faster
	 *  than frames (a wheel burst, a pen), and every repaint clears and
	 *  redraws the whole overlay. */
	paintOverlay(): void {
		if (this.disposed) return;
		if (this.manual) {
			this.paintOverlayNow();
			return;
		}
		if (this.overlayPending) return;
		this.overlayPending = this.win.requestAnimationFrame(() => {
			this.overlayPending = 0;
			this.paintOverlayNow();
		});
	}

	paintOverlayNow(): void {
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
