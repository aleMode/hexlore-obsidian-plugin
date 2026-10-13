// "Show maps together" (GM only, read-only): the maps the GM picks, each at
// its own scale, laid over one another in real distance (`atlas_layout.ts`).
// Each map is drawn by a MapCanvas of its own (tiles, LOD and idle work as
// in the map view), clipped to its grid, its opacity following how large its
// hexes are on screen: a map comes in as you zoom to its level and fades to
// a ghost past it. The coarsest map is at the bottom.
//
// Locked by default: drag pans, wheel / pinch zoom, a double-click opens the
// map under the pointer. Unlocked, a drag moves the map under the pointer
// and a corner handle resizes it about its centre (the fit factor). "Place"
// in the list puts a map's centre where the next click lands. Placements
// are in data.json (`AtlasLayout`), the camera per device. Nothing here
// writes a map.

import { ItemView, Modal, Notice, Setting, TFile, setIcon, setTooltip, type App, type WorkspaceLeaf } from 'obsidian';
import { MapScale } from '../core/map_scale';
import { MapCanvas } from '../render/map_canvas';
import { DEFAULT_OVERLAYS, MapScene } from '../render/scene';
import { sceneDataFromModel } from '../render/scene_from_model';
import { decodeMeta, LAYER_FILES } from '../storage/map_codec';
import type { MapStore } from '../storage/map_store';
import type { StoreRegistry } from '../storage/store_registry';
import {
	atlasOpacity,
	clampFit,
	frameRects,
	hexPx,
	mapCamera,
	scaleMismatch,
	stackOrder,
	toScreen,
	toWorld,
	worldRect,
	zoomLimits,
	type AtlasCamera,
	type AtlasLayout,
	type AtlasMap,
} from './atlas_layout';
import { DISPLAY_KEY, dataFolderOf, isMapIndex, makeSurface } from './map_view';
import { WheelClassifier } from './wheel_intent';

export const ATLAS_VIEW = 'hexlore-atlas';

const CAMERA_KEY = 'hexlore-atlas-camera';
/** Screen px around a corner that grab its resize handle. */
const HANDLE_PX = 9;
const DRAG_SLOP = 4;

/** What the view needs from the plugin. */
export interface AtlasHost {
	layout(): AtlasLayout;
	/** Save a changed layout (data.json); every atlas view follows. */
	setLayout(layout: AtlasLayout): void;
	stores: StoreRegistry;
	/** The map picker. */
	pick(): void;
}

interface Layer {
	path: string;
	file: TFile;
	dir: string;
	store: MapStore;
	off: () => void;
	host: HTMLElement;
	canvas: MapCanvas;
	map: AtlasMap;
	opacity: number;
}

type Gesture =
	| { kind: 'pan'; x: number; y: number; moved: boolean }
	| { kind: 'move'; layer: Layer; x: number; y: number; px: number; py: number; moved: boolean }
	| { kind: 'resize'; layer: Layer; cx: number; cy: number; d0: number; fit0: number };

const nameOf = (f: TFile) => f.basename.replace(/\.hexmap$/, '');

export class AtlasView extends ItemView {
	private stage!: HTMLElement;
	private overlay!: HTMLCanvasElement;
	private list!: HTMLElement;
	private lockBtn!: HTMLElement;
	private layers = new Map<string, Layer>();
	private order: Layer[] = [];
	private cam: AtlasCamera | null = null;
	private locked = true;
	private placing: string | null = null;
	private gesture: Gesture | null = null;
	private hoverLayer: Layer | null = null;
	private readonly wheel = new WheelClassifier();
	private applyPending = 0;
	private camTimer = 0;
	private syncing: Promise<void> = Promise.resolve();
	private closed = false;
	/** The stage size the canvases were last sized to: [w, h, dpr]. */
	private sized: [number, number, number] = [0, 0, 0];
	private observer: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly host: AtlasHost) {
		super(leaf);
	}

	getViewType(): string {
		return ATLAS_VIEW;
	}

	getDisplayText(): string {
		return 'Maps together';
	}

	getIcon(): string {
		return 'layers';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('hexlore-atlas-view');
		const bar = root.createDiv({ cls: 'hexlore-atlas-bar' });
		const button = (icon: string, text: string, tip: string, fn: () => void) => {
			const b = bar.createEl('button', { cls: 'hexlore-atlas-button' });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text });
			setTooltip(b, tip);
			b.addEventListener('click', fn);
			return b;
		};
		button('list-checks', 'Maps…', 'Choose the maps shown', () => this.host.pick());
		button('maximize', 'Fit all', 'Frame every map shown', () => this.fitAll());
		this.lockBtn = button('lock', 'Locked', '', () => this.setLocked(!this.locked));
		this.stage = root.createDiv({ cls: 'hexlore-atlas-stage' });
		this.overlay = this.stage.createEl('canvas', { cls: 'hexlore-atlas-overlay' });
		this.list = root.createDiv({ cls: 'hexlore-atlas-list' });
		this.setLocked(true);
		this.listen();
		// Obsidian's onResize does not cover every size change (a view laid
		// out after it opened): the canvases are checked at every paint, and
		// a change of size asks for one.
		this.observer = new ResizeObserver(() => this.scheduleApply());
		this.observer.observe(this.stage);
		await this.sync();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.observer?.disconnect();
		this.saveCamera();
		if (this.applyPending) this.stage.win.cancelAnimationFrame(this.applyPending);
		await this.syncing;
		for (const l of [...this.layers.values()]) await this.drop(l);
	}

	onResize(): void {
		this.syncSize();
		this.scheduleApply();
	}

	/** Size the outline canvas and the maps' canvases to the stage, when it
	 *  changed. A canvas left at an old size is stretched by the browser
	 *  (blurred, oversized outlines and labels). */
	private syncSize(): void {
		const w = this.stage.clientWidth, h = this.stage.clientHeight;
		const dpr = this.stage.win.devicePixelRatio || 1;
		const [w0, h0, dpr0] = this.sized;
		if (w === w0 && h === h0 && dpr === dpr0) return;
		this.sized = [w, h, dpr];
		const old = w0 && h0 && this.cam ? toWorld(this.cam, w0 / 2, h0 / 2) : null;
		// A hidden map's layer measures 0: it is sized when shown (apply).
		for (const l of this.layers.values()) if (!l.host.hasClass('is-hidden')) l.canvas.resize();
		this.overlay.width = Math.max(1, Math.round(w * dpr));
		this.overlay.height = Math.max(1, Math.round(h * dpr));
		// Keep the same world point at the centre.
		if (old && this.cam) this.cam = { ...this.cam, ox: w / 2 - old[0] * this.cam.scale, oy: h / 2 - old[1] * this.cam.scale };
		if (!this.cam) this.restoreCamera();
	}

	// ----- the maps shown -----------------------------------------------------------

	/** Load the maps the layout shows, drop the others. */
	sync(): Promise<void> {
		this.syncing = this.syncing.then(() => this.syncNow()).catch((e: unknown) => console.error('HexLore: maps together', e));
		return this.syncing;
	}

	private async syncNow(): Promise<void> {
		if (this.closed) return;
		const layout = this.host.layout();
		const want = new Set(layout.shown);
		for (const l of [...this.layers.values()]) if (!want.has(l.path)) await this.drop(l);
		let placed = false;
		for (const path of layout.shown) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile) || !isMapIndex(this.app, f)) continue;
			const l = this.layers.get(path);
			if (l) {
				l.map.place = layout.maps[path] ?? l.map.place;
				continue;
			}
			if (!layout.maps[path]) {
				// Never placed: at the centre of the view, to scale.
				const [x, y] = this.cam ? toWorld(this.cam, this.stage.clientWidth / 2, this.stage.clientHeight / 2) : [0, 0];
				layout.maps[path] = { x, y, fit: 1 };
				placed = true;
			}
			await this.loadLayer(f, layout.maps[path]);
			if (this.closed) return;
		}
		if (placed) this.host.setLayout(layout);
		this.restack();
		if (!this.cam) this.restoreCamera();
		this.renderList();
		this.scheduleApply();
	}

	private async loadLayer(file: TFile, place: AtlasLayout['maps'][string]): Promise<void> {
		const dir = dataFolderOf(this.app, file);
		let store: MapStore;
		try {
			store = await this.host.stores.acquire(dir, nameOf(file));
		} catch (e) {
			new Notice(`Could not read ${nameOf(file)}: ${(e as Error).message}`);
			return;
		}
		const host = this.stage.createDiv({ cls: 'hexlore-atlas-layer' });
		// Transparent, painted hexes only: the map below shows through.
		const canvas = new MapCanvas(host, this.stage.win, makeSurface, { transparent: true });
		const display = this.app.loadLocalStorage(DISPLAY_KEY) as { style?: string; blend?: boolean } | null;
		canvas.setStyle(display?.style === 'illustrated' ? 'illustrated' : 'clean', display?.blend === true);
		const layer: Layer = {
			path: file.path,
			file,
			dir,
			store,
			off: () => {},
			host,
			canvas,
			map: { grid: store.model.meta.grid, scale: store.model.meta.scale, place },
			opacity: 0,
		};
		this.setScene(layer);
		// Edits made in a map view reach here when they are saved; external
		// changes when they are reloaded.
		layer.off = store.on((e) => {
			if (e.kind === 'problem' || this.closed) return;
			this.setScene(layer);
			this.restack();
			this.renderList();
			this.scheduleApply();
		});
		this.layers.set(file.path, layer);
		canvas.resize();
	}

	private setScene(l: Layer): void {
		const m = l.store.model;
		l.map.grid = m.meta.grid;
		l.map.scale = m.meta.scale;
		const scene = new MapScene(sceneDataFromModel(m));
		scene.paintedOnly = true;
		// The map itself: no threads or badges (notes and their links are not
		// shown here).
		scene.setOverlays({ ...DEFAULT_OVERLAYS, threads: false, badges: false });
		l.canvas.setScene(scene);
	}

	private async drop(l: Layer): Promise<void> {
		this.layers.delete(l.path);
		this.order = this.order.filter((o) => o !== l);
		l.off();
		l.canvas.dispose();
		l.host.remove();
		await this.host.stores.release(l.dir);
	}

	/** Coarsest map at the bottom; the overlay canvas above them all. */
	private restack(): void {
		const next = stackOrder([...this.layers.values()]);
		if (next.length !== this.order.length || next.some((l, i) => l !== this.order[i])) {
			for (const l of next) this.stage.appendChild(l.host);
			this.stage.appendChild(this.overlay);
		}
		this.order = next;
	}

	// ----- the side list ----------------------------------------------------------------

	private renderList(): void {
		const el = this.list;
		el.empty();
		if (!this.order.length) {
			el.createDiv({ cls: 'hexlore-atlas-empty', text: 'No map shown. Choose the maps with "Maps…".' });
			return;
		}
		for (const l of [...this.order].reverse()) {
			const row = el.createDiv({ cls: 'hexlore-atlas-row' });
			row.toggleClass('is-placing', this.placing === l.path);
			const head = row.createDiv({ cls: 'hexlore-atlas-row-head' });
			head.createSpan({ cls: 'hexlore-atlas-name', text: nameOf(l.file) });
			head.createSpan({ cls: 'hexlore-atlas-scale', text: l.map.scale.describe() });
			const mismatch = scaleMismatch(l.map);
			if (mismatch) row.createDiv({ cls: 'hexlore-atlas-mismatch', text: mismatch });
			const actions = row.createDiv({ cls: 'hexlore-atlas-actions' });
			const action = (text: string, tip: string, fn: () => void) => {
				const b = actions.createEl('button', { text });
				setTooltip(b, tip);
				b.addEventListener('click', fn);
			};
			action(this.placing === l.path ? 'Cancel' : 'Place', 'Click the map where its centre goes', () => {
				this.placing = this.placing === l.path ? null : l.path;
				this.stage.toggleClass('is-placing', !!this.placing);
				this.renderList();
			});
			action('Centre', 'Centre the view on this map, at its own zoom', () => this.centreOn(l));
			if (mismatch) action('To scale', 'Draw it at the size its own scale gives it', () => this.updatePlace(l, { fit: 1 }));
			action('Open', 'Open this map', () => void this.app.workspace.getLeaf('tab').openFile(l.file));
		}
	}

	private setLocked(on: boolean): void {
		this.locked = on;
		this.lockBtn.empty();
		setIcon(this.lockBtn.createSpan(), on ? 'lock' : 'lock-open');
		this.lockBtn.createSpan({ text: on ? 'Locked' : 'Arranging' });
		setTooltip(this.lockBtn, on ? 'Unlock to move and resize the maps' : 'Lock the maps in place');
		this.lockBtn.toggleClass('is-active', !on);
		this.scheduleApply();
	}

	private updatePlace(l: Layer, change: Partial<AtlasLayout['maps'][string]>, save = true): void {
		l.map.place = { ...l.map.place, ...change };
		if (save) this.savePlace(l);
		this.restack();
		this.renderList();
		this.scheduleApply();
	}

	private savePlace(l: Layer): void {
		const layout = this.host.layout();
		layout.maps[l.path] = { ...l.map.place };
		this.host.setLayout(layout);
	}

	// ----- camera ---------------------------------------------------------------------------

	private size(): [number, number] {
		return [this.stage.clientWidth, this.stage.clientHeight];
	}

	private restoreCamera(): void {
		const [w, h] = this.size();
		if (!w || !this.order.length) return;
		const saved = this.app.loadLocalStorage(CAMERA_KEY) as { scale?: number; x?: number; y?: number } | null;
		if (saved && typeof saved.scale === 'number' && saved.scale > 0 && typeof saved.x === 'number' && typeof saved.y === 'number') {
			this.cam = { scale: saved.scale, ox: w / 2 - saved.x * saved.scale, oy: h / 2 - saved.y * saved.scale };
			this.clampZoom(w / 2, h / 2);
		} else this.fitAll();
	}

	private fitAll(): void {
		const [w, h] = this.size();
		const cam = frameRects(this.order.map((l) => worldRect(l.map)), w, h);
		if (!cam) return;
		this.cam = cam;
		this.clampZoom(w / 2, h / 2);
		this.cameraMoved();
	}

	/** At the zoom where [l] is fully drawn, centred. */
	private centreOn(l: Layer): void {
		const [w, h] = this.size();
		const scale = 40 / hexPx(l.map, { scale: 1, ox: 0, oy: 0 });
		this.cam = { scale, ox: w / 2 - l.map.place.x * scale, oy: h / 2 - l.map.place.y * scale };
		this.cameraMoved();
	}

	private clampZoom(sx: number, sy: number): void {
		if (!this.cam) return;
		const [min, max] = zoomLimits(this.order.map((l) => l.map));
		const s = Math.min(max, Math.max(min, this.cam.scale));
		if (s === this.cam.scale) return;
		this.cam = { scale: s, ox: sx - (sx - this.cam.ox) * (s / this.cam.scale), oy: sy - (sy - this.cam.oy) * (s / this.cam.scale) };
	}

	private zoomAt(sx: number, sy: number, factor: number): void {
		if (!this.cam) return;
		const s = this.cam.scale * factor;
		this.cam = { scale: s, ox: sx - (sx - this.cam.ox) * factor, oy: sy - (sy - this.cam.oy) * factor };
		this.clampZoom(sx, sy);
		this.cameraMoved();
	}

	private panBy(dx: number, dy: number): void {
		if (!this.cam) return;
		this.cam = { ...this.cam, ox: this.cam.ox + dx, oy: this.cam.oy + dy };
		this.cameraMoved();
	}

	private cameraMoved(): void {
		this.scheduleApply();
		this.stage.win.clearTimeout(this.camTimer);
		this.camTimer = this.stage.win.setTimeout(() => this.saveCamera(), 400);
	}

	private saveCamera(): void {
		this.stage.win.clearTimeout(this.camTimer);
		const [w, h] = this.size();
		if (!this.cam || !w) return;
		const [x, y] = toWorld(this.cam, w / 2, h / 2);
		this.app.saveLocalStorage(CAMERA_KEY, { scale: this.cam.scale, x, y });
	}

	// ----- drawing --------------------------------------------------------------------------

	private scheduleApply(): void {
		if (this.applyPending || this.closed) return;
		this.applyPending = this.stage.win.requestAnimationFrame(() => {
			this.applyPending = 0;
			this.apply();
		});
	}

	/** Each map's camera, opacity and clip from the world camera; then the
	 *  outlines. A map not drawn (too small, too large, off screen) is hidden
	 *  and its canvas left alone. */
	private apply(): void {
		this.syncSize();
		const [w, h] = this.size();
		const cam = this.cam;
		for (const l of this.order) {
			const [x0, y0, x1, y1] = cam ? this.screenRect(l, cam) : [0, 0, 0, 0];
			const onScreen = x1 > 0 && y1 > 0 && x0 < w && y0 < h;
			l.opacity = cam && onScreen ? atlasOpacity(hexPx(l.map, cam)) : 0;
			l.host.toggleClass('is-hidden', l.opacity <= 0.01);
			if (l.opacity <= 0.01 || !cam) continue;
			// Shown again after a change of size (or of pixel ratio) while it
			// was hidden: its canvas was never told. Free when nothing changed.
			l.canvas.resize();
			l.host.style.setProperty('--atlas-opacity', String(l.opacity));
			const inset = [y0, w - x1, h - y1, x0].map((v) => `${Math.max(0, v).toFixed(1)}px`).join(' ');
			l.host.style.setProperty('--atlas-clip', `inset(${inset})`);
			l.canvas.setCamera(mapCamera(l.map, cam));
		}
		this.paintOverlay();
	}

	private paintOverlay(): void {
		const c = this.overlay.getContext('2d');
		if (!c) return;
		const dpr = this.stage.win.devicePixelRatio || 1;
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, this.overlay.width, this.overlay.height);
		const cam = this.cam;
		if (!cam) return;
		c.setTransform(dpr, 0, 0, dpr, 0, 0);
		c.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
		c.textBaseline = 'bottom';
		for (const l of this.order) {
			const [x0, y0, x1, y1] = this.screenRect(l, cam);
			const active = l === this.hoverLayer || (this.gesture && 'layer' in this.gesture && this.gesture.layer === l);
			c.strokeStyle = active ? '#E8B84A' : 'rgba(232,232,240,0.7)';
			c.lineWidth = active ? 2 : 1;
			c.setLineDash(l.opacity > 0.01 ? [] : [5, 4]);
			c.strokeRect(x0, y0, x1 - x0, y1 - y0);
			c.setLineDash([]);
			const label = `${nameOf(l.file)} · ${l.map.scale.formatDistance(l.map.scale.hexDistance)}`;
			const tw = c.measureText(label).width;
			c.fillStyle = 'rgba(26,26,46,0.75)';
			c.fillRect(x0, y0 - 18, tw + 10, 18);
			c.fillStyle = '#E8E8F0';
			c.fillText(label, x0 + 5, y0 - 3);
			if (!this.locked) {
				c.fillStyle = active ? '#E8B84A' : '#E8E8F0';
				for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) c.fillRect(x! - 4, y! - 4, 8, 8);
			}
		}
	}

	private screenRect(l: Layer, cam: AtlasCamera): [number, number, number, number] {
		const r = worldRect(l.map);
		const [x0, y0] = toScreen(cam, r[0], r[1]);
		const [x1, y1] = toScreen(cam, r[0] + r[2], r[1] + r[3]);
		return [x0, y0, x1, y1];
	}

	// ----- input -----------------------------------------------------------------------------

	private local(e: MouseEvent): [number, number] {
		const b = this.stage.getBoundingClientRect();
		return [e.clientX - b.left, e.clientY - b.top];
	}

	/** The topmost map under a screen point. */
	private layerAt(sx: number, sy: number): Layer | null {
		if (!this.cam) return null;
		for (const l of [...this.order].reverse()) {
			const [x0, y0, x1, y1] = this.screenRect(l, this.cam);
			if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return l;
		}
		return null;
	}

	/** The topmost map with a corner handle under a screen point. */
	private handleAt(sx: number, sy: number): Layer | null {
		if (!this.cam || this.locked) return null;
		for (const l of [...this.order].reverse()) {
			const [x0, y0, x1, y1] = this.screenRect(l, this.cam);
			for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) if (Math.abs(sx - x!) <= HANDLE_PX && Math.abs(sy - y!) <= HANDLE_PX) return l;
		}
		return null;
	}

	private listen(): void {
		const el = this.stage;
		this.registerDomEvent(el, 'pointerdown', (e) => {
			if (!this.cam) return;
			const [sx, sy] = this.local(e);
			if (e.button === 0 && this.placing) {
				const l = this.layers.get(this.placing);
				this.placing = null;
				el.removeClass('is-placing');
				if (l) {
					const [x, y] = toWorld(this.cam, sx, sy);
					this.updatePlace(l, { x, y });
				} else this.renderList();
				return;
			}
			if (e.button !== 0 && e.button !== 1) return;
			el.setPointerCapture(e.pointerId);
			const handle = e.button === 0 ? this.handleAt(sx, sy) : null;
			const over = e.button === 0 && !this.locked ? this.layerAt(sx, sy) : null;
			if (handle) {
				const [cx, cy] = toScreen(this.cam, handle.map.place.x, handle.map.place.y);
				this.gesture = { kind: 'resize', layer: handle, cx, cy, d0: Math.max(1, Math.hypot(sx - cx, sy - cy)), fit0: handle.map.place.fit };
			} else if (over) {
				this.gesture = { kind: 'move', layer: over, x: sx, y: sy, px: over.map.place.x, py: over.map.place.y, moved: false };
			} else {
				this.gesture = { kind: 'pan', x: sx, y: sy, moved: false };
				el.addClass('is-panning');
			}
		});
		this.registerDomEvent(el, 'pointermove', (e) => {
			const [sx, sy] = this.local(e);
			const g = this.gesture;
			if (!g || !this.cam) {
				const hover = this.locked ? null : (this.handleAt(sx, sy) ?? this.layerAt(sx, sy));
				el.toggleClass('is-resize', !!this.handleAt(sx, sy));
				if (hover !== this.hoverLayer) {
					this.hoverLayer = hover;
					this.paintOverlay();
				}
				return;
			}
			if (g.kind === 'pan') {
				if (!g.moved && Math.hypot(sx - g.x, sy - g.y) < DRAG_SLOP) return;
				g.moved = true;
				this.panBy(sx - g.x, sy - g.y);
				g.x = sx;
				g.y = sy;
			} else if (g.kind === 'move') {
				if (!g.moved && Math.hypot(sx - g.x, sy - g.y) < DRAG_SLOP) return;
				g.moved = true;
				this.updatePlace(g.layer, { x: g.px + (sx - g.x) / this.cam.scale, y: g.py + (sy - g.y) / this.cam.scale }, false);
			} else {
				const fit = clampFit((g.fit0 * Math.hypot(sx - g.cx, sy - g.cy)) / g.d0);
				this.updatePlace(g.layer, { fit }, false);
			}
		});
		const end = () => {
			const g = this.gesture;
			if (!g) return;
			this.gesture = null;
			el.removeClass('is-panning');
			if (g.kind === 'resize' || (g.kind === 'move' && g.moved)) this.savePlace(g.layer);
			this.paintOverlay();
		};
		this.registerDomEvent(el, 'pointerup', end);
		this.registerDomEvent(el, 'pointercancel', end);
		this.registerDomEvent(el, 'dblclick', (e) => {
			const l = this.layerAt(...this.local(e));
			if (l) void this.app.workspace.getLeaf('tab').openFile(l.file);
		});
		this.registerDomEvent(
			el,
			'wheel',
			(e) => {
				e.preventDefault();
				if (this.wheel.classify(e) === 'pan') {
					this.panBy(-e.deltaX, -e.deltaY);
					return;
				}
				const [sx, sy] = this.local(e);
				const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
				this.zoomAt(sx, sy, Math.pow(1.15, (-dy / 100) * (e.ctrlKey ? 3 : 1)));
			},
			{ passive: false },
		);
	}
}

// ----- the map picker --------------------------------------------------------------------

/** Every map of the vault, each with its scale: tick the ones shown. */
export class AtlasPickerModal extends Modal {
	constructor(
		app: App,
		private readonly layout: () => AtlasLayout,
		private readonly setLayout: (l: AtlasLayout) => void,
		private readonly done: () => void,
	) {
		super(app);
		this.setTitle('Show maps together');
	}

	onOpen(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.createEl('p', {
			cls: 'setting-item-description',
			text: 'The maps are laid over one another at their own scales, for you only: players never see this, and no map is changed. Each map keeps where you put it.',
		});
		const maps = this.app.vault
			.getMarkdownFiles()
			.filter((f) => isMapIndex(this.app, f))
			.sort((a, b) => a.path.localeCompare(b.path));
		if (!maps.length) el.createEl('p', { text: 'This vault has no map yet.' });
		for (const f of maps) {
			const row = new Setting(el).setName(nameOf(f)).setDesc(f.parent && !f.parent.isRoot() ? f.parent.path : '');
			// Braces: a Setting has then(), so a promise resolved with one
			// (an arrow returning `row.setDesc(…)`) loops forever.
			void scaleOf(this.app, f).then((s) => {
				if (s) row.setDesc(`${s.describe()}${f.parent && !f.parent.isRoot() ? ` · ${f.parent.path}` : ''}`);
			});
			row.addToggle((t) =>
				t.setValue(this.layout().shown.includes(f.path)).onChange((on) => {
					const l = this.layout();
					l.shown = on ? [...l.shown.filter((p) => p !== f.path), f.path] : l.shown.filter((p) => p !== f.path);
					this.setLayout(l);
				}),
			);
		}
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Show')
				.setCta()
				.onClick(() => {
					this.close();
					this.done();
				}),
		);
	}
}

/** A map's scale, read from its `campaign.json` (null when unreadable). */
async function scaleOf(app: App, index: TFile): Promise<MapScale | null> {
	const f = app.vault.getAbstractFileByPath(`${dataFolderOf(app, index)}/${LAYER_FILES.meta}`);
	if (!(f instanceof TFile)) return null;
	try {
		return decodeMeta(await app.vault.cachedRead(f), nameOf(index)).scale;
	} catch {
		return null;
	}
}
