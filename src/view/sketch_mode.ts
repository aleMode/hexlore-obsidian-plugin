// The Sketch view (plan item 2.8, decision 19): free drawing over the hex
// lattice, in the same scene space and with the SAME camera as the map —
// it is a mode of the map view, so switching keeps your place for free.
//
// A canvas of its own over the map's: the map below, dimmed, is the hex
// ghost (the shared renderer, not a second one), then the faint lattice, the
// trace image, the document, and the stroke in progress. Raw pointer events
// with coalesced points; pen pressure is the pen's, never simulated; a pen
// that reports none gets a hint. The sketch has its OWN undo stack.

import { Notice, setIcon, setTooltip, type App } from 'obsidian';
import getStroke from 'perfect-freehand';
import { HEX_RADIUS as R, axialToPixel, cellsInRect, hexCorners, type GridWindow } from '../core/geometry';
import type { MapScale } from '../core/map_scale';
import { SketchFill, SketchLabel, SketchShape, SketchStroke, UnknownSketchItem, thinStroke, type ShapeKind, type SketchDocument, type SketchItem, type StrokePoint, type Swatch } from '../core/sketch';
import type { MapEditor } from '../edit/editor';
import type { MapCanvas } from '../render/map_canvas';
import { bucketFill, type BucketFillFailure } from '../sketch/bucket_fill';
import { traceBounds, type TraceImage } from './trace_image';

export type SketchTool = 'pan' | 'pen' | 'eraser' | 'bucket' | 'line' | 'rect' | 'ellipse' | 'label';

export const SKETCH_TOOLS: readonly { id: SketchTool; icon: string; key: string; label: string }[] = [
	{ id: 'pan', icon: 'hand', key: 'h', label: 'Pan' },
	{ id: 'pen', icon: 'pen-line', key: 'p', label: 'Pen' },
	{ id: 'eraser', icon: 'eraser', key: 'e', label: 'Eraser' },
	{ id: 'bucket', icon: 'paint-bucket', key: 'b', label: 'Bucket fill' },
	{ id: 'line', icon: 'minus', key: 'l', label: 'Line' },
	{ id: 'rect', icon: 'square', key: 'r', label: 'Rectangle' },
	{ id: 'ellipse', icon: 'circle', key: 'o', label: 'Ellipse' },
	{ id: 'label', icon: 'type', key: 't', label: 'Label' },
];

/** How the hex view shows the sketch: not at all, everything translucent,
 *  or labels only at full strength. */
export type SketchOverlay = 'none' | 'full' | 'labels';
export type SketchOverlayMode = Exclude<SketchOverlay, 'none'>;

export const SKETCH_MIN_WIDTH = 1;
export const SKETCH_MAX_WIDTH = 48;
/** Kept stroke points this far apart at least (scene px at zoom 1). */
const THIN_STEP = 1.5;
/** Below this on-screen hex radius the lattice would be a smear. */
const LATTICE_MIN_RADIUS_PX = 4;
/** The bucket closes gaps this wide, in SCREEN px. */
const BUCKET_GAP_SCREEN_PX = 4;
const BUCKET_MAX_RASTER = 900;
const PREFS_KEY = 'hexlore-sketch';

export interface SketchPrefs {
	tool: SketchTool;
	swatchId: string;
	width: number;
	filled: boolean;
	showGhost: boolean;
	showLattice: boolean;
	/** What the hex view draws of the sketch ('none' = hidden)… */
	overlay: SketchOverlay;
	/** …and what showing it again brings back. */
	overlayMode: SketchOverlayMode;
}

export interface SketchHost {
	app: App;
	stage: HTMLElement;
	canvas: MapCanvas;
	editor(): MapEditor | null;
	grid(): GridWindow | null;
	mapScale(): MapScale;
	spaceDown(): boolean;
	/** The trace image (loaded by the view), or null. */
	trace(): TraceImage | null;
	/** The trace image was moved or resized (once per gesture). */
	traceMoved(t: TraceImage): void;
	/** A label to place at a scene point, or one to edit. */
	askLabel(initial: string, done: (text: string | null) => void): void;
	/** The mode, the tool or a choice changed (the panel follows). */
	changed(): void;
}

/** Pressure → width the way Flutter's view does: a light touch 30 % of the
 *  nominal width, a full press the nominal width. perfect-freehand's width
 *  is size·(1 − t + 2·t·p): size = 0.65·width, t = 7/13 (decision 19). */
export function strokeOutline(points: StrokePoint[], width: number, complete = true): number[][] {
	return getStroke(points, { size: width * 0.65, thinning: 7 / 13, smoothing: 0.5, streamline: 0.3, simulatePressure: false, last: complete });
}

const widthAt = (width: number, p: number) => width * (0.3 + 0.7 * Math.min(1, Math.max(0, p)));

export class SketchMode {
	active = false;
	prefs: SketchPrefs;
	private readonly cnv: HTMLCanvasElement;
	private readonly c: CanvasRenderingContext2D;
	readonly strip: HTMLElement;
	private toolButtons = new Map<SketchTool, HTMLElement>();
	private swatchRow!: HTMLElement;
	private widthValue!: HTMLElement;
	private hint: HTMLElement;
	private frame = 0;
	private paths = new WeakMap<SketchItem, Path2D>();

	// In-progress input, in SCENE space.
	private pointer: number | null = null;
	private stroke: StrokePoint[] | null = null;
	private shape: { a: [number, number]; b: [number, number] } | null = null;
	private press: { x: number; y: number } | null = null;
	private panning: { x: number; y: number } | null = null;
	private erasing = false;
	private traceDrag: { mode: 'move' | 'resize'; start: [number, number]; base: TraceImage; live: TraceImage } | null = null;
	private strokePressures = new Set<number>();
	private hinted = false;

	constructor(private readonly host: SketchHost) {
		const stored = (host.app.loadLocalStorage(PREFS_KEY) ?? {}) as Partial<SketchPrefs>;
		this.prefs = {
			tool: SKETCH_TOOLS.some((t) => t.id === stored.tool) ? stored.tool! : 'pen',
			swatchId: typeof stored.swatchId === 'string' ? stored.swatchId : 'ink',
			width: typeof stored.width === 'number' ? Math.min(SKETCH_MAX_WIDTH, Math.max(SKETCH_MIN_WIDTH, stored.width)) : 6,
			filled: stored.filled === true,
			showGhost: stored.showGhost !== false,
			showLattice: stored.showLattice !== false,
			overlay: stored.overlay === 'full' || stored.overlay === 'labels' ? stored.overlay : 'none',
			overlayMode: stored.overlayMode === 'labels' || (!stored.overlayMode && stored.overlay === 'labels') ? 'labels' : 'full',
		};
		this.cnv = host.stage.createEl('canvas', { cls: 'hexlore-sketch-canvas' });
		// Low-latency ink where the platform offers it.
		this.c = (this.cnv.getContext('2d', { desynchronized: true }) ?? this.cnv.getContext('2d'))!;
		this.strip = host.stage.createDiv({ cls: 'hexlore-toolbar hexlore-sketch-toolbar' });
		for (const type of ['pointerdown', 'pointerup', 'contextmenu', 'wheel'] as const) this.strip.addEventListener(type, (e) => e.stopPropagation());
		this.hint = host.stage.createDiv({ cls: 'hexlore-sketch-hint' });
		this.hint.hide();
		this.buildStrip();
		this.applyVisibility();
	}

	private savePrefs(): void {
		this.host.app.saveLocalStorage(PREFS_KEY, this.prefs);
	}

	setPrefs(change: Partial<SketchPrefs>): void {
		this.prefs = { ...this.prefs, ...change };
		this.prefs.width = Math.min(SKETCH_MAX_WIDTH, Math.max(SKETCH_MIN_WIDTH, this.prefs.width));
		this.savePrefs();
		this.cancel();
		this.refreshStrip();
		this.applyVisibility();
		this.schedule();
		this.host.changed();
	}

	/** Show or hide the sketch over the hex view; the mode is kept while hidden. */
	showOverlay(shown: boolean, mode = this.prefs.overlayMode): void {
		this.setPrefs({ overlayMode: mode, overlay: shown ? mode : 'none' });
	}

	setActive(on: boolean): void {
		this.active = on;
		this.cancel();
		this.refreshStrip();
		this.applyVisibility();
		this.schedule();
		this.host.changed();
	}

	/** Show / dim / hide the layers for the mode and the choices. */
	private applyVisibility(): void {
		const sketchShown = this.active || this.prefs.overlay !== 'none';
		this.cnv.toggle(sketchShown);
		this.cnv.toggleClass('is-overlay', !this.active);
		this.cnv.toggleClass('is-labels-only', !this.active && this.prefs.overlay === 'labels');
		this.strip.toggle(this.active);
		this.host.stage.toggleClass('is-sketching', this.active);
		this.host.stage.toggleClass('hide-ghost', this.active && !this.prefs.showGhost);
		this.host.stage.style.cursor = this.active ? (this.prefs.tool === 'pan' ? 'grab' : this.prefs.tool === 'label' ? 'text' : this.prefs.tool === 'bucket' ? 'cell' : 'crosshair') : '';
		if (!this.active) this.hint.hide();
	}

	// ----- the tool strip -------------------------------------------------------------

	private buildStrip(): void {
		const tools = this.strip.createDiv({ cls: 'hexlore-toolbar-group' });
		for (const t of SKETCH_TOOLS) {
			const b = tools.createDiv({ cls: 'clickable-icon hexlore-tool' });
			setIcon(b, t.icon);
			setTooltip(b, `${t.label} (${t.key.toUpperCase()})`, { placement: 'right' });
			b.addEventListener('click', () => this.setPrefs({ tool: t.id }));
			this.toolButtons.set(t.id, b);
		}
		const width = this.strip.createDiv({ cls: 'hexlore-toolbar-group hexlore-brush' });
		const minus = width.createDiv({ cls: 'clickable-icon' });
		setIcon(minus, 'minus');
		setTooltip(minus, 'Thinner ([)', { placement: 'right' });
		minus.addEventListener('click', () => this.setPrefs({ width: this.prefs.width - (this.prefs.width > 8 ? 2 : 1) }));
		this.widthValue = width.createDiv({ cls: 'hexlore-brush-value' });
		const plus = width.createDiv({ cls: 'clickable-icon' });
		setIcon(plus, 'plus');
		setTooltip(plus, 'Thicker (])', { placement: 'right' });
		plus.addEventListener('click', () => this.setPrefs({ width: this.prefs.width + (this.prefs.width >= 8 ? 2 : 1) }));
		this.swatchRow = this.strip.createDiv({ cls: 'hexlore-toolbar-group hexlore-sketch-swatches' });
		const history = this.strip.createDiv({ cls: 'hexlore-toolbar-group' });
		const undo = history.createDiv({ cls: 'clickable-icon' });
		setIcon(undo, 'undo-2');
		setTooltip(undo, 'Undo in the sketch (Ctrl+Z)', { placement: 'right' });
		undo.addEventListener('click', () => this.undo());
		const redo = history.createDiv({ cls: 'clickable-icon' });
		setIcon(redo, 'redo-2');
		setTooltip(redo, 'Redo in the sketch (Ctrl+Shift+Z)', { placement: 'right' });
		redo.addEventListener('click', () => this.redo());
		this.refreshStrip();
	}

	refreshStrip(): void {
		for (const [id, b] of this.toolButtons) b.toggleClass('is-active', id === this.prefs.tool);
		this.widthValue.setText(String(Math.round(this.prefs.width)));
		this.swatchRow.empty();
		const doc = this.host.editor()?.sketch;
		if (!doc) return;
		const groups: [string, Swatch[]][] = [
			['Biomes', doc.swatches.filter((s) => s.kind === 'biome')],
			['Lines', doc.swatches.filter((s) => s.kind === 'river' || s.kind === 'road' || s.kind === 'trail')],
			['Ink', doc.swatches.filter((s) => s.kind === 'none')],
		];
		for (const [name, list] of groups) {
			if (!list.length) continue;
			const g = this.swatchRow.createDiv({ cls: 'hexlore-sketch-swatch-group' });
			setTooltip(g, name, { placement: 'right' });
			for (const s of list) {
				const chip = g.createDiv({ cls: 'hexlore-swatch is-small' });
				chip.style.setProperty('--chip', s.color);
				chip.toggleClass('is-active', s.id === this.prefs.swatchId);
				setTooltip(chip, `${s.name}${s.kind === 'biome' ? ' (becomes this biome on Hexify)' : s.kind === 'none' ? ' (ink: notes only)' : ' (becomes a line on Hexify)'}`, { placement: 'right' });
				chip.addEventListener('click', () => this.setPrefs({ swatchId: s.id }));
			}
		}
	}

	// ----- history ------------------------------------------------------------------------

	undo(): void {
		const label = this.host.editor()?.sketchUndoLast();
		if (label) new Notice(`Undid: ${label}`, 1500);
	}

	redo(): void {
		const label = this.host.editor()?.sketchRedoLast();
		if (label) new Notice(`Redid: ${label}`, 1500);
	}

	// ----- coordinates ----------------------------------------------------------------------

	private local(e: MouseEvent): [number, number] {
		const r = this.host.stage.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	private toScene([sx, sy]: [number, number]): [number, number] {
		const cam = this.host.canvas.camera;
		return [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];
	}

	/** The pen's pressure; 1 for a mouse. A pen that reports nothing (0, or
	 *  a constant 0.5) draws at full width, and the GM hears why once. */
	private pressureOf(e: PointerEvent): number {
		if (e.pointerType !== 'pen') return 1;
		const p = e.pressure;
		this.strokePressures.add(p);
		const varied = this.strokePressures.size > 1;
		if (!varied && !this.hinted && (this.stroke?.length ?? 0) > 12 && (p === 0 || p === 0.5)) {
			this.hinted = true;
			this.hint.setText('No pen pressure detected: strokes are drawn at full width. On Windows, turn on the ink setting in the tablet driver.');
			this.hint.show();
			window.setTimeout(() => this.hint.hide(), 9000);
		}
		if (varied) return Math.min(1, Math.max(0, p));
		return p === 0 || p === 0.5 ? 1 : p;
	}

	private point(e: PointerEvent): StrokePoint {
		const [x, y] = this.toScene(this.local(e));
		return [x, y, this.pressureOf(e)];
	}

	// ----- input (called by the map view while active) -------------------------------------

	private cancel(): void {
		this.stroke = null;
		this.shape = null;
		this.press = null;
		this.panning = null;
		this.erasing = false;
		this.traceDrag = null;
		this.pointer = null;
	}

	/** A pinch took over: drop what is in progress, commit nothing. */
	abortInput(): void {
		this.cancel();
		this.host.stage.removeClass('is-panning');
		this.schedule();
	}

	/** Pen eraser end: button 5 / buttons bit 32. */
	private static isEraser(e: PointerEvent): boolean {
		return e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
	}

	pointerDown(e: PointerEvent): void {
		const editor = this.host.editor();
		const st = this.host.stage;
		st.setPointerCapture(e.pointerId);
		this.pointer = e.pointerId;
		const local = this.local(e);
		if (e.button === 1 || this.host.spaceDown() || (this.prefs.tool === 'pan' && !this.traceHandleAt(local))) {
			this.panning = { x: e.clientX, y: e.clientY };
			st.addClass('is-panning');
			return;
		}
		if (this.prefs.tool === 'pan') {
			const t = this.host.trace()!;
			this.traceDrag = { mode: this.traceHandleAt(local)!, start: this.toScene(local), base: t, live: t };
			return;
		}
		if (!editor || editor.readOnly) return;
		// Right button, or the pen's eraser end, erases whatever the tool.
		if (e.button === 2 || SketchMode.isEraser(e)) {
			this.erasing = true;
			this.eraseAt(local);
			return;
		}
		if (e.button !== 0) return;
		switch (this.prefs.tool) {
			case 'pen':
				this.strokePressures.clear();
				this.stroke = [this.point(e)];
				break;
			case 'eraser':
				this.erasing = true;
				this.eraseAt(local);
				break;
			case 'bucket':
				this.bucketAt(local);
				break;
			case 'line':
			case 'rect':
			case 'ellipse': {
				const s = this.toScene(local);
				this.shape = { a: s, b: s };
				break;
			}
			case 'label':
				this.press = { x: local[0], y: local[1] };
				break;
		}
		this.schedule();
	}

	pointerMove(e: PointerEvent): void {
		if (this.pointer !== e.pointerId) return;
		const local = this.local(e);
		if (this.panning) {
			this.host.canvas.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
			this.panning = { x: e.clientX, y: e.clientY };
			return;
		}
		if (this.traceDrag) {
			this.updateTraceDrag(this.toScene(local));
			return;
		}
		if (this.erasing) {
			this.eraseAt(local);
			return;
		}
		if (this.stroke) {
			// Every point the device saw, not one per frame: a fast curve stays round.
			const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
			for (const ev of events.length ? events : [e]) this.stroke.push(this.point(ev));
			this.schedule();
			return;
		}
		if (this.shape) {
			this.shape.b = this.toScene(local);
			this.schedule();
			return;
		}
		if (this.press && Math.hypot(local[0] - this.press.x, local[1] - this.press.y) > 5) {
			// Label tool: a drag pans instead of placing.
			this.press = null;
			this.panning = { x: e.clientX, y: e.clientY };
		}
	}

	pointerUp(e: PointerEvent): void {
		if (this.pointer !== e.pointerId) return;
		this.pointer = null;
		this.host.stage.removeClass('is-panning');
		const editor = this.host.editor();
		const up = e.type === 'pointerup';
		if (this.panning) {
			this.panning = null;
			return;
		}
		if (this.traceDrag) {
			const live = this.traceDrag.live;
			this.traceDrag = null;
			this.host.traceMoved(live);
			return;
		}
		if (this.erasing) {
			this.erasing = false;
			return;
		}
		const scale = this.host.canvas.camera.scale;
		if (this.stroke) {
			const raw = this.stroke;
			this.stroke = null;
			if (up && editor) {
				const points = thinStroke(raw, THIN_STEP / scale);
				if (points.length === 1) points.push(points[0]!); // a dot
				if (points.length) editor.addSketchItem(new SketchStroke(editor.sketch.newId(), this.prefs.swatchId, this.prefs.width, points));
			}
			this.schedule();
			return;
		}
		if (this.shape) {
			const { a, b } = this.shape;
			this.shape = null;
			// A shape smaller than a couple of screen px was a slip.
			if (up && editor && Math.hypot(b[0] - a[0], b[1] - a[1]) * scale >= 2) {
				const kind: ShapeKind = this.prefs.tool === 'rect' ? 'rect' : this.prefs.tool === 'ellipse' ? 'ellipse' : 'line';
				editor.addSketchItem(new SketchShape(editor.sketch.newId(), kind, this.prefs.swatchId, this.prefs.width, a[0], a[1], b[0], b[1], this.prefs.filled && kind !== 'line'));
			}
			this.schedule();
			return;
		}
		const press = this.press;
		this.press = null;
		if (up && press && editor && this.prefs.tool === 'label') {
			const s = this.toScene([press.x, press.y]);
			const tol = Math.max(6 / scale, 2);
			const hit = editor.sketch.hitTest(s[0], s[1], tol);
			if (hit instanceof SketchLabel) {
				this.host.askLabel(hit.text, (text) => {
					if (text === null) return;
					if (!text.trim()) editor.removeSketchItem(hit.id);
					else editor.replaceSketchItem(hit.id, new SketchLabel(hit.id, text.trim(), hit.x, hit.y, hit.size, hit.color));
				});
			} else {
				this.host.askLabel('', (text) => {
					if (!text?.trim()) return;
					const color = editor.sketch.colorOf(this.prefs.swatchId);
					editor.addSketchItem(new SketchLabel(editor.sketch.newId(), text.trim(), s[0], s[1], Math.max(10, this.prefs.width * 3), color));
				});
			}
		}
	}

	private eraseAt(local: [number, number]): void {
		const editor = this.host.editor();
		if (!editor) return;
		const [x, y] = this.toScene(local);
		const tol = Math.max(8 / this.host.canvas.camera.scale, 2);
		const hit = editor.sketch.hitTest(x, y, tol);
		if (hit) editor.removeSketchItem(hit.id);
	}

	/** Fill around a click: the raster covers the viewport padded by a quarter
	 *  each side, at most 900 px on the long side, never finer than a screen
	 *  px (what counts as a small gap is a screen-space judgement). */
	private bucketAt(local: [number, number]): void {
		const editor = this.host.editor();
		if (!editor) return;
		const [w, h] = this.host.canvas.size;
		const scale = this.host.canvas.camera.scale;
		const tl = this.toScene([-w / 4, -h / 4]), br = this.toScene([w * 1.25, h * 1.25]);
		const step = Math.max(Math.max(br[0] - tl[0], br[1] - tl[1]) / BUCKET_MAX_RASTER, 1 / scale);
		const [x, y] = this.toScene(local);
		const res = bucketFill(editor.sketch, x, y, {
			left: tl[0],
			top: tl[1],
			right: br[0],
			bottom: br[1],
			step,
			gapPx: Math.min(6, Math.max(0, Math.round(BUCKET_GAP_SCREEN_PX / (step * scale)))),
		});
		if (!res.polygon) {
			new Notice(BUCKET_FAILURES[res.failure], 3500);
			return;
		}
		editor.addSketchFill(new SketchFill(editor.sketch.newId(), this.prefs.swatchId, res.polygon));
	}

	// ----- the trace image (Pan tool only, unlocked) -------------------------------------------

	private traceHandleAt(local: [number, number]): 'move' | 'resize' | null {
		const t = this.host.trace();
		if (!t || !t.visible || t.locked || this.prefs.tool !== 'pan') return null;
		const [x, y] = this.toScene(local);
		const [l, tp, r, b] = traceBounds(t);
		if (Math.hypot(x - r, y - b) <= 10 / this.host.canvas.camera.scale) return 'resize';
		return x >= l && x <= r && y >= tp && y <= b ? 'move' : null;
	}

	private updateTraceDrag([x, y]: [number, number]): void {
		const d = this.traceDrag!;
		const base = d.base;
		if (d.mode === 'move') {
			d.live = { ...base, centerX: base.centerX + x - d.start[0], centerY: base.centerY + y - d.start[1] };
		} else {
			// Uniform scale from the fixed top-left corner; the aspect never changes.
			const [l, t] = traceBounds(base);
			const k = Math.max(Math.max(20, x - l) / base.width, Math.max(20, y - t) / base.height);
			const w = base.width * k, h = base.height * k;
			d.live = { ...base, centerX: l + w / 2, centerY: t + h / 2, width: w, height: h };
		}
		this.schedule();
	}

	// ----- painting ----------------------------------------------------------------------------

	schedule(): void {
		if (this.frame) return;
		this.frame = this.host.stage.win.requestAnimationFrame(() => {
			this.frame = 0;
			this.paint();
		});
	}

	resize(): void {
		this.schedule();
	}

	private paint(): void {
		const [w, h] = this.host.canvas.size;
		const dpr = this.host.stage.win.devicePixelRatio || 1;
		if (this.cnv.width !== Math.round(w * dpr) || this.cnv.height !== Math.round(h * dpr)) {
			this.cnv.width = Math.round(w * dpr);
			this.cnv.height = Math.round(h * dpr);
		}
		const c = this.c;
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, this.cnv.width, this.cnv.height);
		if (!this.active && this.prefs.overlay === 'none') return;
		const editor = this.host.editor();
		const cam = this.host.canvas.camera;
		const k = cam.scale * dpr;
		c.setTransform(k, 0, 0, k, cam.ox * dpr, cam.oy * dpr);
		const view: [number, number, number, number] = [-cam.ox / cam.scale, -cam.oy / cam.scale, (w - cam.ox) / cam.scale, (h - cam.oy) / cam.scale];
		if (this.active) {
			this.paintTrace(c);
			this.paintLattice(c, view);
		}
		const doc = editor?.model.sketch;
		if (doc) {
			const labelsOnly = !this.active && this.prefs.overlay === 'labels';
			for (const item of doc.items) if (!labelsOnly || item instanceof SketchLabel) this.paintItem(c, item, doc);
		}
		if (this.active && doc) this.paintInProgress(c, doc);
	}

	private paintTrace(c: CanvasRenderingContext2D): void {
		const live = this.traceDrag?.live;
		const t = live ?? this.host.trace();
		if (!t || !t.visible || !t.image) return;
		const [l, tp, r, b] = traceBounds(t);
		c.globalAlpha = t.opacity;
		c.drawImage(t.image, l, tp, r - l, b - tp);
		c.globalAlpha = 1;
		if (this.prefs.tool === 'pan' && !t.locked) {
			const s = 1 / this.host.canvas.camera.scale;
			c.strokeStyle = 'rgba(122,85,212,0.8)';
			c.lineWidth = 1.5 * s;
			c.strokeRect(l, tp, r - l, b - tp);
			c.beginPath();
			c.arc(r, b, 6 * s, 0, Math.PI * 2);
			c.fillStyle = '#7A55D4';
			c.fill();
			c.strokeStyle = '#FFFFFF';
			c.stroke();
		}
	}

	private paintLattice(c: CanvasRenderingContext2D, [x0, y0, x1, y1]: [number, number, number, number]): void {
		const grid = this.host.grid();
		const scale = this.host.canvas.camera.scale;
		if (!grid || !this.prefs.showLattice || R * scale < LATTICE_MIN_RADIUS_PX) return;
		c.beginPath();
		for (const [q, r] of cellsInRect(x0, y0, x1, y1, grid)) {
			const [cx, cy] = axialToPixel(q, r);
			hexCorners(cx, cy).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
			c.closePath();
		}
		c.strokeStyle = 'rgba(255,255,255,0.2)';
		c.lineWidth = 1 / scale;
		c.stroke();
	}

	private pathOf(item: SketchItem): Path2D | null {
		const known = this.paths.get(item);
		if (known) return known;
		let p: Path2D | null = null;
		if (item instanceof SketchStroke) {
			p = new Path2D();
			if (item.points.length === 1) {
				const [x, y, pr] = item.points[0]!;
				p.arc(x, y, widthAt(item.width, pr) / 2, 0, Math.PI * 2);
			} else {
				const outline = strokeOutline(item.points, item.width);
				outline.forEach(([x, y], i) => (i ? p!.lineTo(x!, y!) : p!.moveTo(x!, y!)));
				p.closePath();
			}
		} else if (item instanceof SketchFill && item.polygon.length >= 3) {
			p = new Path2D();
			item.polygon.forEach(([x, y], i) => (i ? p!.lineTo(x, y) : p!.moveTo(x, y)));
			p.closePath();
		}
		if (p) this.paths.set(item, p);
		return p;
	}

	private paintItem(c: CanvasRenderingContext2D, item: SketchItem, doc: SketchDocument): void {
		if (item instanceof UnknownSketchItem) return; // a newer app's item: kept, not drawn
		if (item instanceof SketchLabel) {
			paintLabel(c, item);
			return;
		}
		const color = doc.colorOf((item as SketchStroke | SketchShape | SketchFill).swatchId);
		if (item instanceof SketchShape) {
			paintShape(c, item.kind, item.x1, item.y1, item.x2, item.y2, color, item.width, item.filled);
			return;
		}
		const p = this.pathOf(item);
		if (!p) return;
		c.fillStyle = color;
		c.fill(p);
	}

	private paintInProgress(c: CanvasRenderingContext2D, doc: SketchDocument): void {
		const color = doc.colorOf(this.prefs.swatchId);
		if (this.stroke?.length) {
			c.fillStyle = color;
			if (this.stroke.length === 1) {
				const [x, y, pr] = this.stroke[0]!;
				c.beginPath();
				c.arc(x, y, widthAt(this.prefs.width, pr) / 2, 0, Math.PI * 2);
				c.fill();
			} else {
				const outline = strokeOutline(this.stroke, this.prefs.width, false);
				c.beginPath();
				outline.forEach(([x, y], i) => (i ? c.lineTo(x!, y!) : c.moveTo(x!, y!)));
				c.closePath();
				c.fill();
			}
		}
		if (this.shape) {
			const kind: ShapeKind = this.prefs.tool === 'rect' ? 'rect' : this.prefs.tool === 'ellipse' ? 'ellipse' : 'line';
			const { a, b } = this.shape;
			paintShape(c, kind, a[0], a[1], b[0], b[1], color, this.prefs.width, this.prefs.filled && kind !== 'line');
		}
	}

	dispose(): void {
		if (this.frame) this.host.stage.win.cancelAnimationFrame(this.frame);
	}
}

const BUCKET_FAILURES: Record<BucketFillFailure, string> = {
	notEnclosed: 'Nothing enclosed there: the bucket fills an area closed by lines (small gaps are bridged).',
	onInk: 'That is a line: click inside an enclosed area.',
	tooSmall: 'That area is too small to fill.',
};

export function paintShape(c: CanvasRenderingContext2D, kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, color: string, width: number, filled: boolean): void {
	c.beginPath();
	if (kind === 'line') {
		c.moveTo(x1, y1);
		c.lineTo(x2, y2);
	} else if (kind === 'rect') {
		c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
	} else {
		c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
	}
	if (filled) {
		c.fillStyle = color;
		c.fill();
	} else {
		c.strokeStyle = color;
		c.lineWidth = width;
		c.lineCap = 'round';
		c.lineJoin = 'round';
		c.stroke();
	}
}

/** y is the text's baseline (SketchLabel.bounds reaches one em above it). */
export function paintLabel(c: CanvasRenderingContext2D, l: SketchLabel): void {
	c.font = `600 ${l.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
	c.textAlign = 'left';
	c.textBaseline = 'alphabetic';
	c.shadowColor = 'rgba(0,0,0,0.8)';
	c.shadowBlur = 3;
	c.fillStyle = l.color;
	c.fillText(l.text, l.x, l.y);
	c.shadowBlur = 0;
	c.shadowColor = 'transparent';
}
