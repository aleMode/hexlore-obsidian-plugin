// The map view of a `.hexmap.md` index (items 2.2–2.3; editing is 2.4).
//
// The map comes from the data folder's shared MapStore (one per folder, so
// two views of a map agree) and the hex → note links from the index. Files
// changed outside (a git pull, a sync, the Flutter app) reload on their own.
// Camera and display choices are per device (§1.2): they live in the vault's
// local storage, never in a synced file.

import { ItemView, Menu, Modal, Notice, Platform, Scope, Setting, TFile, type ButtonComponent, apiVersion, normalizePath, type App, type Events, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { nearestAnchor } from '../core/anchors';
import { axialToPixel, cellsInRect, hexDistance, nodePixel, pixelToAxial } from '../core/geometry';
import { fitPaste, topLeftCell } from '../core/hex_clipboard';
import { nearestLineSegment } from '../core/line_edit';
import { sameAnchor, type Anchor } from '../core/river';
import { THREAD_DIRECTIONS, THREAD_STATUSES, THREAD_TYPES, threadColorFor, type ThreadDirection, type ThreadStatus, type ThreadType } from '../core/thread';
import type { ThreadStyle } from '../core/thread_geometry';
import { hexIdFor } from '../core/hex_data';
import type { PaintPick } from '../core/hex_paint';
import { hexLine } from '../core/line_of_sight';
import { MapScale } from '../core/map_scale';
import type { Cell, EditorEvent, LineKind, MapEditor, ThreadSpec } from '../edit/editor';
import { editorFor } from '../edit/editors';
import { HOVER_GLOW, SELECT_GLOW, brushCells, drawVotes, highlightCells, drawAnchorField, drawGhost, drawBand, drawBrush, drawHandle, drawLine, drawRuler, drawScaleBar, nearestIndex, strokeCells, type OverlayFrame } from '../render/overlay';
import { regionInk } from '../render/painter';
import { sceneHexOf, sceneRegionOf, sceneRiversOf, sceneRoutesOf, sceneThreadOf } from '../render/scene_from_model';
import { MAX_BRUSH, ROUTE_KINDS, Toolbar, TOOLS, pickFromStored, pickToStored, type StoredPick, type ToolId } from './toolbar';
import { reportMarkdown, runBench } from '../dev/bench';
import { syntheticMap } from '../dev/synthetic';
import { ART } from '../render/art';
import { MapCanvas } from '../render/map_canvas';
import { DEFAULT_OVERLAYS, MapScene, type MapData, type MapStyle } from '../render/scene';
import { sceneDataFromModel } from '../render/scene_from_model';
import type { Surface } from '../render/textures';
import { REGIONS, parseHexList, parseLinks, type IndexProblem } from '../storage/hexmap_index';
import { updateHexLinks } from '../storage/index_file';
import { LAYER_FILES as LAYER_PATHS } from '../storage/map_codec';
import type { MapStore, StoreEvent } from '../storage/map_store';
import type { StoreRegistry } from '../storage/store_registry';
import { hexesByNote, hexesOfNote } from './vault_notes';
import { PLAYERS_EVENT } from '../server/control';
import { ImageExportModal } from './image_export_modal';
import { playersSceneData } from '../render/players_scene';
import { filterCampaignForPlayer } from '../core/player_filter';
import { toPlain, type JsonObject } from '../core/json';

export const MAP_VIEW = 'hexlore-map';

export interface MapViewState {
	file?: string;
	/** The benchmark's synthetic 100×100 map, instead of a file. */
	synthetic?: boolean;
}

/** Per DEVICE, every map (decision 28). */
export interface Display {
	style: MapStyle;
	blend: boolean;
	threadStyle: ThreadStyle;
	/** Hatch the hexes not written yet. */
	gmFog: boolean;
	badges: boolean;
}

/** Per MAP, on this device: what is shown (decision 27). */
export interface OverlayState {
	threads: boolean;
	hiddenThreadColors: string[];
	regions: boolean;
	hiddenRegions: string[];
	borders: boolean;
}

/** What the map panel reads. */
export interface MapPanelState {
	file: TFile | null;
	editor: MapEditor | null;
	selection: Cell[];
	links: Map<string, string[]>;
	regionLinks: Map<string, string[]>;
	scale: MapScale;
	tool: ToolId;
	selectedLine: { kind: LineKind; id: string } | null;
	heldPoint: number | null;
	selectedThread: string | null;
	activeRegion: string | null;
	regionErase: boolean;
	overlays: OverlayState;
	display: Display;
}

const overlaysKey = (path: string) => `hexlore-overlays:${path}`;

const DISPLAY_KEY = 'hexlore-display';
const EDITOR_KEY = 'hexlore-editor';
const DRAG_SLOP = 5; // px before a press becomes a drag
const FOG_HIDE = '#E05555';

/** The Page preview source the map's hover previews come from. */
export const HOVER_SOURCE = 'hexlore-map';

/** Broadcast when what the HexLore panel shows may have changed. */
export const MAP_STATE_EVENT = 'hexlore:map-state';

type Gesture =
	| { kind: 'pan'; id: number; x: number; y: number }
	| { kind: 'select'; id: number; x: number; y: number; moved: boolean; additive: boolean; base: Set<string> }
	| { kind: 'paint'; id: number; last: Cell | null }
	| { kind: 'fog'; id: number; last: Cell | null; reveal: boolean }
	| { kind: 'ruler'; id: number }
	| { kind: 'region'; id: number; last: Cell | null; add: boolean }
	/** River / route / thread tool: a click places on release. */
	| { kind: 'place'; id: number; x: number; y: number; moved: boolean }
	/** Dragging a handle of the selected line, from its points at pointer-down. */
	| { kind: 'line'; id: number; line: { kind: LineKind; id: string }; index: number; from: Anchor[]; x: number; y: number; moved: boolean; last: Anchor | null }
	/** Dragging the selection: a grid-snapped ghost, red where blocked. */
	| { kind: 'move'; id: number; start: Cell; x: number; y: number; moved: boolean; delta: Cell; valid: boolean; additive: boolean; base: Set<string> };

const cellKeyOf = ([q, r]: Cell) => `${q},${r}`;
const cellOfId = (id: string): Cell | null => {
	const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
	return m ? [Number(m[1]), Number(m[2])] : null;
};
const idsToCells = (ids: Iterable<string>): Cell[] => [...ids].map(cellOfId).filter((c): c is Cell => !!c);
/** The highlight of a note's hexes (gold, apart from selection purple). */
const NOTE_GLOW = '#E8B84A';
const cellOfKey = (k: string) => k.split(',').map(Number) as Cell;
const cameraKey = (path: string) => `hexlore-camera:${path}`;

/** The data folder of a `.hexmap.md` index: its `data:` frontmatter, beside it. */
export function dataFolderOf(app: App, file: TFile): string {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const data = typeof fm?.data === 'string' && fm.data ? fm.data : file.basename.replace(/\.hexmap$/, '') + '.hexlore';
	const parent = file.parent && !file.parent.isRoot() ? file.parent.path + '/' : '';
	return normalizePath(parent + data);
}

/** True for a note the map view should open: `hexlore-plugin: map`. */
export function isMapIndex(app: App, file: TFile | null): file is TFile {
	if (!file || file.extension !== 'md') return false;
	return app.metadataCache.getFileCache(file)?.frontmatter?.['hexlore-plugin'] === 'map' || file.path.endsWith('.hexmap.md');
}

function makeSurface(w: number, h: number): Surface {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
	const c = createEl('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export class MapView extends ItemView {
	private state: MapViewState = {};
	private file: TFile | null = null;
	private dataDir = '';
	private data: MapData | null = null;
	private store: MapStore | null = null;
	private storeDir: string | null = null;
	private unsubscribe: (() => void) | null = null;
	/** Hex id → notes, from the index. */
	private links = new Map<string, string[]>();
	private indexProblems: IndexProblem[] = [];
	private storeProblems: string[] = [];
	private canvas!: MapCanvas;
	private stage!: HTMLElement;
	private tooltip!: HTMLElement;
	private notice!: HTMLElement;
	private saveTimer = 0;
	private loading: Promise<void> | null = null;
	private benching = false;

	// ----- editing --------------------------------------------------------------
	private editor: MapEditor | null = null;
	private unsubscribeEditor: (() => void) | null = null;
	private toolbar!: Toolbar;
	private tool: ToolId = 'select';
	private pick!: PaintPick;
	private brush = 0;
	/** Selected cells, "q,r". */
	private selection = new Set<string>();
	private hover: Cell | null = null;
	private gesture: Gesture | null = null;
	private band: [number, number, number, number] | null = null;
	private ruler: [[number, number], [number, number]] | null = null;
	private spaceDown = false;
	private broadcastPending = 0;
	private hoverScene: [number, number] | null = null;
	private selectedLine: { kind: LineKind; id: string } | null = null;
	/** The selected line's point the GM is working on (Del deletes it). */
	private heldPoint: number | null = null;
	private selectedThread: string | null = null;
	private activeRegion: string | null = null;
	/** The region panel's Remove mode: a drag removes (Ctrl inverts). */
	private regionErase = false;
	private riverDraft: Anchor[] = [];
	private routeDraft: Anchor[] = [];
	private routeKind = 'road';
	private routeColor = '#6B4A2F';
	private threadSource: Cell | null = null;
	private lastThreadColor = '';
	private lastClick: { at: number; x: number; y: number; line: string | null; cell?: string | null } | null = null;
	private previewed: string | null = null;
	private overlays: OverlayState = { threads: true, hiddenThreadColors: [], regions: true, hiddenRegions: [], borders: true };
	/** Region id → its note, from the index. */
	private regionLinks = new Map<string, string[]>();
	/** The hexes the note being read stands for (an NPC: its place's hexes),
	 *  and the ones a hovered note in the sections list stands for. */
	private noteHighlight: { name: string; ids: Set<string> } | null = null;
	private hoverHighlight: Set<string> | null = null;
	/** Closed: the panel must stop showing this view. */
	closed = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly openAsMarkdown: (file: TFile, leaf: WorkspaceLeaf) => void,
		private readonly registry: StoreRegistry,
		/** The map panel: make sure it exists; show or hide it. */
		private readonly panel: {
			ensure: () => Promise<void>;
			toggle: () => Promise<void>;
			sections: () => Promise<void>;
			/** Live player votes on this map: hex id → count. */
			votes: (file: TFile | null) => Map<string, number>;
			/** "Export to the HexLore app…" (item 2.7). */
			exportFlutter: (file: TFile) => void;
		},
	) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return MAP_VIEW;
	}

	getDisplayText(): string {
		if (this.state.synthetic) return 'Synthetic 100×100';
		return this.file?.basename.replace(/\.hexmap$/, '') ?? 'HexLore map';
	}

	getIcon(): string {
		return 'hexagon';
	}

	getState(): Record<string, unknown> {
		return { ...this.state };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = (state ?? {}) as MapViewState;
		const changed = next.file !== this.state.file || next.synthetic !== this.state.synthetic;
		this.state = next;
		if (changed && this.canvas) await this.loadMap();
		await super.setState(state, result);
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('hexlore-map-view');
		this.stage = root.createDiv({ cls: 'hexlore-map-stage' });
		this.canvas = new MapCanvas(this.stage, this.stage.win, makeSurface);
		this.tooltip = this.stage.createDiv({ cls: 'hexlore-map-tooltip' });
		this.tooltip.hide();
		this.notice = root.createDiv({ cls: 'hexlore-map-notice' });
		this.notice.hide();

		const display = this.loadDisplay();
		this.canvas.setStyle(display.style, display.blend);
		this.canvas.onCameraChange = () => this.saveCameraSoon();
		this.canvas.overlayPainter = (f) => this.paintOverlay(f);
		this.stage.tabIndex = 0; // takes keyboard focus, so the view's keys work

		const prefs = (this.app.loadLocalStorage(EDITOR_KEY) ?? {}) as {
			tool?: ToolId;
			brush?: number;
			pick?: StoredPick;
			routeKind?: string;
			routeColor?: string;
			threadColor?: string;
		};
		this.tool = TOOLS.some((t) => t.id === prefs.tool && !t.later) ? prefs.tool! : 'select';
		this.brush = Math.min(MAX_BRUSH, Math.max(0, prefs.brush ?? 0));
		this.pick = pickFromStored(prefs.pick);
		this.routeKind = ROUTE_KINDS.some((r) => r.kind === prefs.routeKind) ? prefs.routeKind! : 'road';
		this.routeColor = typeof prefs.routeColor === 'string' && /^#[0-9A-F]{6}$/i.test(prefs.routeColor) ? prefs.routeColor : '#6B4A2F';
		this.lastThreadColor = typeof prefs.threadColor === 'string' ? prefs.threadColor : '';
		this.toolbar = new Toolbar(this.stage, {
			tool: () => this.tool,
			setTool: (t) => this.setTool(t),
			pick: () => this.pick,
			setPick: (p) => {
				this.pick = p;
				this.savePrefs();
				this.toolbar.refresh(...this.historyLabels());
			},
			brush: () => this.brush,
			setBrush: (n) => this.setBrush(n),
			undo: () => this.undoLast(),
			redo: () => this.redoLast(),
			canUndo: () => !!this.editor?.undo.canUndo,
			canRedo: () => !!this.editor?.undo.canRedo,
			readOnly: () => !this.editor || this.editor.readOnly,
			routeKind: () => this.routeKind,
			setRouteKind: (k) => {
				this.routeKind = k;
				this.savePrefs();
				this.toolbar.refresh(...this.historyLabels());
			},
			routeColor: () => this.routeColor,
			setRouteColor: (c) => {
				this.routeColor = c;
				this.savePrefs();
				this.canvas.paintOverlay();
			},
		});
		this.wireKeys();

		this.addAction('file-text', 'Open as Markdown', () => {
			if (this.file) this.openAsMarkdown(this.file, this.leaf);
		});
		this.addAction('maximize', 'Fit the map', () => this.canvas.fit());
		this.addAction('panel-right', 'Show or hide the map panel (the selected hex, its notes, player visibility)', () => void this.panel.toggle());
		this.addAction('library', 'Show or hide the sections (the campaign’s notes, by folder)', () => void this.panel.sections());
		this.addAction('palette', 'Map style', (evt) => this.styleMenu(evt));

		this.wireInput();
		this.registerEvent(
			this.app.vault.on('rename', (f, old) => {
				if (old === this.state.file) {
					this.state = { file: f.path };
					this.file = f instanceof TFile ? f : null;
					this.refreshHeader();
					this.app.workspace.requestSaveLayout();
				}
			}),
		);
		// Player votes come and go: redraw their badges.
		this.registerEvent((this.app.workspace as Events).on(PLAYERS_EVENT, () => this.canvas.paintOverlay()));
		// The note being read: highlight the hexes it stands for.
		this.registerEvent(this.app.workspace.on('file-open', (f) => this.followNote(f)));
		this.registerEvent(
			this.app.metadataCache.on('changed', (f) => {
				if (f === this.app.workspace.getActiveFile() && f !== this.file) this.followNote(f);
				if (f !== this.file) return;
				// The index's `data:` may point somewhere else now; else its links changed.
				if (dataFolderOf(this.app, f) !== this.dataDir) void this.loadMap();
				else void this.readIndex().then(() => this.rebuildScene());
			}),
		);
		if (this.state.file || this.state.synthetic) await this.loadMap();
		// Also when Obsidian reopens a map from the last session.
		this.app.workspace.onLayoutReady(() => void this.panel.ensure());
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.editor?.endStroke();
		this.flushCamera();
		this.canvas.dispose();
		await this.releaseStore();
		this.broadcast();
	}

	onResize(): void {
		if (this.benching) return;
		const first = !this.canvas.size[0];
		this.canvas.resize();
		if (first && this.data) this.restoreCamera();
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const ro = !this.editor || this.editor.readOnly;
		menu.addItem((i) => i.setTitle('Resize grid…').setIcon('scaling').setDisabled(ro).onClick(() => this.resizeDialog()));
		menu.addItem((i) => i.setTitle('Explode map…').setIcon('expand').setDisabled(ro).onClick(() => this.explodeDialog()));
		menu.addItem((i) =>
			i
				.setTitle('Export image…')
				.setIcon('image-down')
				.setDisabled(!this.store)
				.onClick(() => this.exportImage()),
		);
		menu.addItem((i) =>
			i
				.setTitle('Export as a campaign folder…')
				.setIcon('folder-output')
				.setDisabled(!this.file || !Platform.isDesktopApp)
				.onClick(() => this.file && void this.panel.exportFlutter(this.file)),
		);
		menu.addItem((i) => i.setTitle('Art credits').setIcon('info').onClick(() => new CreditsModal(this.app).open()));
		menu.addItem((i) =>
			i
				.setTitle('Benchmark the renderer')
				.setIcon('gauge')
				.onClick(() => void this.bench()),
		);
	}

	// ----- loading ------------------------------------------------------------

	private async loadMap(): Promise<void> {
		if (this.loading) await this.loading;
		this.loading = this.loadMapNow().finally(() => (this.loading = null));
		await this.loading;
	}

	private async loadMapNow(): Promise<void> {
		const first = !this.data;
		try {
			if (this.state.synthetic) {
				await this.releaseStore();
				this.file = null;
				this.dataDir = '';
				this.links = new Map();
				this.data = syntheticMap(100, 100);
			} else {
				const f = this.state.file ? this.app.vault.getAbstractFileByPath(this.state.file) : null;
				if (!(f instanceof TFile)) throw new Error(`${this.state.file ?? 'no file'} was not found`);
				this.file = f;
				this.dataDir = dataFolderOf(this.app, f);
				if (this.storeDir !== this.dataDir) {
					await this.releaseStore();
					this.storeDir = this.dataDir;
					this.store = await this.registry.acquire(this.dataDir, f.basename.replace(/\.hexmap$/, ''));
					this.unsubscribe = this.store.on((e) => this.onStoreEvent(e));
					this.storeProblems = [...this.store.broken.values()];
					this.editor = editorFor(this.store);
					this.unsubscribeEditor = this.editor.on((e) => this.onEditorEvent(e));
					const index = f;
					// Moving hexes moves their notes: written as changes, applied to
					// the index as it is at that moment.
					this.editor.linkWriter = (changes) =>
						updateHexLinks(this.app, index, (hexes) => {
							for (const [id, list] of changes) {
								if (list && list.length) hexes.set(id, list);
								else hexes.delete(id);
							}
							return hexes;
						});
				}
				await this.readIndex();
				this.data = sceneDataFromModel(this.store!.model, new Set(this.links.keys()));
			}
		} catch (e) {
			this.data = null;
			this.canvas.setScene(null);
			this.showNotice(`Could not read this map: ${(e as Error).message}`);
			return;
		}
		this.loadOverlays();
		this.canvas.setScene(new MapScene(this.data));
		this.applyOverlays();
		this.updateNotice();
		this.refreshHeader();
		this.canvas.resize();
		if (first) this.restoreCamera();
		if (!this.editor && this.tool !== 'select' && this.tool !== 'ruler') this.tool = 'select';
		this.toolbar.refresh(...this.historyLabels());
		this.broadcast();
	}

	private async releaseStore(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.unsubscribeEditor?.();
		this.unsubscribeEditor = null;
		this.editor = null;
		const dir = this.storeDir;
		this.store = null;
		this.storeDir = null;
		this.storeProblems = [];
		if (dir) await this.registry.release(dir);
	}

	/** The hex → notes list from the index note. */
	private async readIndex(): Promise<void> {
		if (!this.file) return;
		const text = await this.app.vault.cachedRead(this.file);
		const parsed = parseHexList(text);
		const regions = parseLinks(text, REGIONS);
		if (this.editor) {
			this.editor.linksFromIndex(parsed.hexes);
			this.links = new Map(this.editor.links);
		} else this.links = parsed.hexes;
		this.regionLinks = regions.links;
		this.indexProblems = [...parsed.problems, ...regions.problems];
		this.updateNotice();
	}

	/** Rebuild the scene from the model, keeping the camera. */
	private rebuildScene(): void {
		if (!this.store) return;
		this.data = sceneDataFromModel(this.store.model, new Set(this.links.keys()));
		this.canvas.setScene(new MapScene(this.data));
		this.applyOverlays();
		this.broadcast();
	}

	private onStoreEvent(e: StoreEvent): void {
		if (e.kind === 'reloaded') {
			if (e.discarded.length) {
				const files = e.discarded.map((k) => ('chunk' in k ? `paint/${k.chunk}` : k.layer)).join(', ');
				new Notice(`HexLore: ${files} changed on disk; your last unsaved change there was replaced by that version.`);
			}
			// Undoing an edit to a file that changed under us would write over it.
			const paths = e.files.map((k) => ('chunk' in k ? `paint/${k.chunk}` : LAYER_PATHS[k.layer]));
			const dropped = this.editor?.reloaded(paths) ?? 0;
			if (dropped) new Notice(`HexLore: ${dropped} undo step${dropped === 1 ? '' : 's'} removed — the files they changed were changed elsewhere.`);
			this.rebuildScene();
			this.updateNotice();
			this.broadcast();
		} else if (e.kind === 'problem') {
			this.storeProblems.push(e.message);
			this.updateNotice();
		} else {
			this.broadcast(); // "Saving…" → "All changes saved"
		}
	}

	/** One notice for everything the GM should know about this map. */
	private updateNotice(): void {
		const lines: string[] = [];
		if (this.store?.readOnlyReason) lines.push(`Read-only: ${this.store.readOnlyReason}.`);
		for (const p of new Set(this.storeProblems)) lines.push(p);
		if (this.indexProblems.length) {
			const first = this.indexProblems[0]!;
			lines.push(
				`${this.indexProblems.length} line${this.indexProblems.length === 1 ? '' : 's'} of the index could not be read and ${this.indexProblems.length === 1 ? 'was' : 'were'} kept as written (line ${first.line}: ${first.reason}).`,
			);
		}
		this.showNotice(lines.length ? lines.join('\n') : null);
	}

	/** The tab title follows a rename (not in the public API, so optional). */
	private refreshHeader(): void {
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
	}

	private showNotice(text: string | null): void {
		if (text) {
			this.notice.setText(text);
			this.notice.show();
		} else {
			this.notice.hide();
		}
	}

	// ----- camera and display (per device) ------------------------------------

	private cameraId(): string {
		return this.state.synthetic ? 'synthetic' : (this.state.file ?? '');
	}

	private restoreCamera(): void {
		if (!this.canvas.size[0]) return;
		const saved = this.app.loadLocalStorage(cameraKey(this.cameraId())) as { scale?: number; x?: number; y?: number } | null;
		if (saved && typeof saved.scale === 'number' && typeof saved.x === 'number' && typeof saved.y === 'number') {
			this.canvas.camera.scale = Math.max(this.canvas.minScale(), saved.scale);
			this.canvas.centreOn(saved.x, saved.y);
		} else {
			this.canvas.fit();
		}
	}

	private saveCameraSoon(): void {
		if (this.benching) return;
		this.stage.win.clearTimeout(this.saveTimer);
		this.saveTimer = this.stage.win.setTimeout(() => this.flushCamera(), 400);
	}

	private flushCamera(): void {
		this.stage.win.clearTimeout(this.saveTimer);
		if (!this.data || !this.canvas.size[0] || this.benching) return;
		const [x, y] = this.canvas.centre();
		this.app.saveLocalStorage(cameraKey(this.cameraId()), { scale: this.canvas.camera.scale, x, y });
	}

	private loadDisplay(): Display {
		const d = this.app.loadLocalStorage(DISPLAY_KEY) as Partial<Display> | null;
		return {
			style: d?.style === 'illustrated' ? 'illustrated' : 'clean',
			blend: d?.blend === true,
			threadStyle: d?.threadStyle === 'ribbon' ? 'ribbon' : 'arc',
			gmFog: d?.gmFog === true,
			badges: d?.badges !== false,
		};
	}

	/** Change display choices; every open map follows (per device). */
	setDisplay(change: Partial<Display>): void {
		const d = { ...this.loadDisplay(), ...change };
		this.app.saveLocalStorage(DISPLAY_KEY, d);
		for (const leaf of this.app.workspace.getLeavesOfType(MAP_VIEW)) {
			if (!(leaf.view instanceof MapView)) continue;
			leaf.view.canvas.setStyle(d.style, d.blend);
			leaf.view.applyOverlays();
			leaf.view.broadcast();
		}
	}

	private styleMenu(evt: MouseEvent): void {
		const d = { style: this.canvas.style, blend: this.canvas.blend };
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Clean').setChecked(d.style === 'clean').onClick(() => this.setDisplay({ style: 'clean' })));
		menu.addItem((i) => i.setTitle('Illustrated').setChecked(d.style === 'illustrated').onClick(() => this.setDisplay({ style: 'illustrated' })));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Blend biome borders').setChecked(d.blend).onClick(() => this.setDisplay({ blend: !d.blend })));
		menu.addItem((i) => i.setTitle('More in the map panel…').setIcon('panel-right').onClick(() => void this.panel.toggle()));
		menu.showAtMouseEvent(evt);
	}

	// ----- editing: state ---------------------------------------------------------

	/** What the map panel shows (read by the inspector view). */
	mapState(): MapPanelState {
		return {
			file: this.file,
			editor: this.editor,
			selection: [...this.selection].map(cellOfKey),
			links: this.links,
			regionLinks: this.regionLinks,
			scale: this.editor?.model.meta.scale ?? MapScale.defaults,
			tool: this.tool,
			selectedLine: this.selectedLine,
			heldPoint: this.heldPoint,
			selectedThread: this.selectedThread,
			activeRegion: this.activeRegion,
			regionErase: this.regionErase,
			overlays: this.overlays,
			display: this.loadDisplay(),
		};
	}

	/** Tell the map panel to refresh — at most once a frame (a stroke
	 *  changes cells on every pointer move). A close is told at once. */
	broadcast(): void {
		if (this.closed) {
			this.app.workspace.trigger(MAP_STATE_EVENT, this);
			return;
		}
		if (this.broadcastPending) return;
		this.broadcastPending = this.stage.win.requestAnimationFrame(() => {
			this.broadcastPending = 0;
			this.app.workspace.trigger(MAP_STATE_EVENT, this);
		});
	}

	private historyLabels(): [string | null, string | null] {
		return [this.editor?.undo.nextUndoLabel ?? null, this.editor?.undo.nextRedoLabel ?? null];
	}

	private savePrefs(): void {
		this.app.saveLocalStorage(EDITOR_KEY, {
			tool: this.tool,
			brush: this.brush,
			pick: pickToStored(this.pick),
			routeKind: this.routeKind,
			routeColor: this.routeColor,
			threadColor: this.lastThreadColor,
		});
	}

	setTool(t: ToolId): void {
		const editing = t !== 'select' && t !== 'ruler';
		if (editing && (!this.editor || this.editor.readOnly)) {
			new Notice(this.editor ? `This map is read-only: ${this.editor.store.readOnlyReason}.` : 'This map cannot be edited.');
			return;
		}
		this.editor?.endStroke();
		this.editor?.endRegionStroke();
		this.gesture = null;
		this.band = null;
		this.ruler = null; // the last measurement clears on a tool change
		this.riverDraft = [];
		this.routeDraft = [];
		this.threadSource = null;
		this.tool = t;
		if (t === 'region') this.ensureActiveRegion();
		this.toolbar.closePalette();
		this.savePrefs();
		this.toolbar.refresh(...this.historyLabels());
		this.hideTooltip();
		this.canvas.paintOverlay();
		this.broadcast();
	}

	private setBrush(n: number): void {
		this.brush = Math.min(MAX_BRUSH, Math.max(0, n));
		this.savePrefs();
		this.toolbar.refresh(...this.historyLabels());
		this.canvas.paintOverlay();
	}

	private undoLast(): void {
		const label = this.editor?.undoLast();
		if (label) new Notice(`Undid ${label}`, 1500);
		this.dropStaleSelection();
	}

	private redoLast(): void {
		const label = this.editor?.redoLast();
		if (label) new Notice(`Redid ${label}`, 1500);
		this.dropStaleSelection();
	}

	/** A selected line or thread an undo removed is no longer selected. */
	private dropStaleSelection(): void {
		const m = this.editor?.model;
		if (!m) return;
		if (this.selectedLine && !(this.selectedLine.kind === 'river' ? m.rivers : m.routes).has(this.selectedLine.id)) this.selectLine(null);
		if (this.selectedThread && !m.threads.has(this.selectedThread)) this.selectThread(null);
		if (this.activeRegion && !m.regions.has(this.activeRegion)) this.activeRegion = null;
	}

	/** Keep the scene in step with an edit. */
	private onEditorEvent(e: EditorEvent): void {
		const scene = this.canvas.getScene();
		const model = this.editor?.model;
		if (e.kind === 'history') {
			this.toolbar.refresh(...this.historyLabels());
			this.broadcast();
			return;
		}
		if (!scene || !model) return;
		const linked = new Set(this.links.keys());
		switch (e.kind) {
			case 'hexes':
				for (const [q, r] of e.cells) {
					const h = model.getHex(q, r);
					if (h) scene.setHex(sceneHexOf(h, linked));
					else scene.removeHex(q, r);
				}
				break;
			case 'revealed':
				scene.setRevealed(e.cells, (q, r) => model.revealed.has(hexIdFor(q, r)));
				break;
			case 'lines':
				scene.setLines(sceneRiversOf(model), sceneRoutesOf(model));
				break;
			case 'regions':
				scene.setRegions([...model.regions.values()].map(sceneRegionOf));
				break;
			case 'threads':
				scene.setThreads([...model.threads.values()].map(sceneThreadOf));
				break;
			case 'links':
				this.links = new Map([...this.editor!.links].map(([id, l]) => [id, [...l]]));
				this.rebuildScene();
				return;
			case 'all': {
				// A remap or a resize: everything may have moved.
				this.rebuildScene();
				this.dropStaleSelection();
				return;
			}
		}
		this.canvas.sceneEdited();
		this.canvas.paintOverlay();
		this.broadcast();
	}

	private setSelection(cells: Iterable<string>): void {
		this.selection = new Set(cells);
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** Select a river or a route (its points become handles), or none. */
	selectLine(line: { kind: LineKind; id: string } | null, held: number | null = null): void {
		this.selectedLine = line;
		this.heldPoint = line ? held : null;
		if (line) {
			this.selectedThread = null;
			this.selection.clear();
		}
		this.canvas.paintOverlay();
		this.broadcast();
	}

	selectThread(id: string | null): void {
		this.selectedThread = id;
		if (id) {
			this.selectedLine = null;
			this.heldPoint = null;
			this.selection.clear();
		}
		this.canvas.paintOverlay();
		this.broadcast();
	}

	// ----- overlays (decision 27) -----------------------------------------------------

	/** Show or hide; what the GM is working on is shown again (decision 27). */
	setOverlays(change: Partial<OverlayState>): void {
		this.overlays = { ...this.overlays, ...change };
		this.app.saveLocalStorage(overlaysKey(this.cameraId()), this.overlays);
		this.applyOverlays();
		this.broadcast();
	}

	private loadOverlays(): void {
		const o = this.app.loadLocalStorage(overlaysKey(this.cameraId())) as Partial<OverlayState> | null;
		this.overlays = {
			threads: o?.threads !== false,
			hiddenThreadColors: Array.isArray(o?.hiddenThreadColors) ? o.hiddenThreadColors.filter((x) => typeof x === 'string') : [],
			regions: o?.regions !== false,
			hiddenRegions: Array.isArray(o?.hiddenRegions) ? o.hiddenRegions.filter((x) => typeof x === 'string') : [],
			borders: o?.borders !== false,
		};
	}

	/** Push the overlay switches and display choices into the scene. */
	applyOverlays(): void {
		const scene = this.canvas.getScene();
		if (!scene) return;
		const d = this.loadDisplay();
		const o = this.overlays;
		scene.setOverlays({
			threads: o.threads,
			hiddenThreadColors: new Set(o.hiddenThreadColors),
			threadStyle: d.threadStyle,
			regions: o.regions,
			hiddenRegions: new Set(o.hiddenRegions),
			borders: o.borders,
			gmFog: d.gmFog,
			badges: d.badges,
		});
		this.canvas.requestFrame();
		this.canvas.paintOverlay();
	}

	private showThreadColor(key: string): void {
		if (!this.overlays.threads || this.overlays.hiddenThreadColors.includes(key)) {
			this.setOverlays({ threads: true, hiddenThreadColors: this.overlays.hiddenThreadColors.filter((k) => k !== key) });
		}
	}

	/** The active region (the region tool paints it): shown, never hidden. */
	setActiveRegion(id: string | null): void {
		this.activeRegion = id;
		if (id && (!this.overlays.regions || this.overlays.hiddenRegions.includes(id))) {
			this.setOverlays({ regions: true, hiddenRegions: this.overlays.hiddenRegions.filter((r) => r !== id) });
		}
		this.canvas.paintOverlay();
		this.broadcast();
	}

	setRegionErase(on: boolean): void {
		this.regionErase = on;
		this.broadcast();
	}

	private ensureActiveRegion(): void {
		const regions = this.editor?.model.regions;
		if (!regions) return;
		if (!this.activeRegion || !regions.has(this.activeRegion)) this.setActiveRegion(regions.keys().next().value ?? null);
	}

	// ----- editing: overlay ---------------------------------------------------------

	private anchorPx(a: Anchor): [number, number] {
		return nodePixel(a.kind, a.q, a.r, a.k);
	}

	private linePoints(kind: LineKind, id: string): [number, number][] {
		const m = this.editor?.model;
		const line = kind === 'river' ? m?.rivers.get(id) : m?.routes.get(id);
		return line ? line.nodes.map((n) => this.anchorPx(n)) : [];
	}

	private paintOverlay(f: OverlayFrame): void {
		const scene = this.canvas.getScene();
		const grid = scene?.grid;
		if (grid && scene) {
			const k = 1 / f.camera.scale; // scene units per screen px
			if (this.noteHighlight) highlightCells(f, idsToCells(this.noteHighlight.ids), NOTE_GLOW, 0.16, 2.5);
			if (this.hoverHighlight) highlightCells(f, idsToCells(this.hoverHighlight), NOTE_GLOW, 0.32, 3.5);
			if (this.selection.size) strokeCells(f, [...this.selection].map(cellOfKey), SELECT_GLOW, 3);
			// The anchor field, while points are being placed or dragged.
			const placing = this.tool === 'river' || this.tool === 'route' || this.gesture?.kind === 'line';
			if (placing) drawAnchorField(f, grid, this.tool === 'route' ? this.routeColor : '#3A7DBF');
			// The selected line: a glow along it and its points as handles.
			if (this.selectedLine) {
				const pts = this.linePoints(this.selectedLine.kind, this.selectedLine.id);
				const near = this.hoverScene ? nearestIndex(pts, this.hoverScene) : -1;
				drawLine(f, pts, 'rgba(176,140,240,0.55)', 9);
				pts.forEach((p, i) => {
					const held = i === this.heldPoint;
					drawHandle(f, p, held ? 7 : i === near ? 6 : 4, held ? '#3A7DBF' : i === near ? SELECT_GLOW : '#FFFFFF', held ? '#FFFFFF' : '#5C3210', held ? 2 : 1.2);
				});
			}
			if (this.selectedThread) {
				const s = scene.threadShapes().get(this.selectedThread);
				if (s) drawLine(f, s.sample(28), 'rgba(176,140,240,0.6)', 11 * Math.max(1, 0.75 * k));
			}
			// A line being drawn, with the segment the next click would add.
			const draft = this.tool === 'river' ? this.riverDraft : this.tool === 'route' ? this.routeDraft : [];
			if (draft.length || (placing && this.hoverScene)) {
				const pts = draft.map((n) => this.anchorPx(n));
				const next = this.hoverScene && (this.tool === 'river' || this.tool === 'route') ? this.anchorPx(nearestAnchor(...this.hoverScene)) : null;
				const ink = this.tool === 'route' ? this.routeColor : '#3A7DBF';
				if (pts.length) drawLine(f, pts, ink, 4);
				if (next && pts.length) drawLine(f, [pts[pts.length - 1]!, next], ink, 2, [6, 5]);
				for (const p of pts) drawHandle(f, p, 4, '#FFFFFF', ink, 1.5);
				if (next) drawHandle(f, next, 5, ink, '#FFFFFF', 1.5);
			}
			// A thread being started: its source, and a line to the cursor.
			if (this.threadSource) {
				strokeCells(f, [this.threadSource], '#E0C050', 3);
				if (this.hover) drawLine(f, [axialToPixel(...this.threadSource), axialToPixel(...this.hover)], '#E0C050', 2.5, [8, 6]);
			}
			const hover = this.hover;
			if (hover && this.gesture?.kind !== 'pan' && this.gesture?.kind !== 'line') {
				if (this.tool === 'paint' || this.tool === 'fog') {
					const hiding = this.tool === 'fog' && (this.gesture?.kind === 'fog' ? !this.gesture.reveal : false);
					drawBrush(f, hover, this.brush, grid, hiding ? FOG_HIDE : HOVER_GLOW);
				} else if (this.tool === 'region') {
					const g = this.activeRegion ? this.editor?.model.regions.get(this.activeRegion) : undefined;
					drawBrush(f, hover, 0, grid, g ? regionInk(g.color) : HOVER_GLOW);
				} else if (this.tool !== 'river' && this.tool !== 'route' && !this.selection.has(cellKeyOf(hover))) {
					strokeCells(f, [hover], HOVER_GLOW, 2.5);
				}
			}
			drawVotes(f, this.panel.votes(this.file));
			const g = this.gesture;
			if (g?.kind === 'move' && g.moved) {
				const ghost = [...this.selection].map(cellOfKey).map(([q, r]): Cell => [q + g.delta[0], r + g.delta[1]]);
				drawGhost(f, ghost, g.valid ? SELECT_GLOW : '#E05555');
			}
			if (this.band) drawBand(f, ...this.band);
			if (this.ruler) drawRuler(f, this.ruler[0], this.ruler[1], grid, this.editor?.model.meta.scale ?? MapScale.defaults);
		}
		drawScaleBar(f, this.editor?.model.meta.scale ?? MapScale.defaults);
	}

	// ----- editing: input -------------------------------------------------------------

	private local(e: MouseEvent): [number, number] {
		const r = this.stage.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	}

	private scenePoint(e: MouseEvent): [number, number] {
		const [sx, sy] = this.local(e);
		const cam = this.canvas.camera;
		return [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];
	}

	/** Paint (or fog, or region) every cell between the last cell and [cell],
	 *  so a fast stroke leaves no gaps. */
	private strokeTo(cell: Cell, last: Cell | null, apply: (cells: Cell[]) => void, radius = this.brush): void {
		const grid = this.canvas.getScene()!.grid;
		const path = last && hexDistance(last[0], last[1], cell[0], cell[1]) > 1 ? hexLine(last[0], last[1], cell[0], cell[1]).slice(1) : [cell];
		const cells = new Map<string, Cell>();
		for (const c of path) for (const b of brushCells(c, radius, grid)) cells.set(cellKeyOf(b), b);
		if (cells.size) apply([...cells.values()]);
	}

	/** How near (scene units) a press must be to a line or a handle. */
	private hitRadius(): number {
		return Math.max(8 / this.canvas.camera.scale, 6);
	}

	/** The selected line's handle under a scene point. */
	private handleAt(p: [number, number]): number | null {
		if (!this.selectedLine) return null;
		const pts = this.linePoints(this.selectedLine.kind, this.selectedLine.id);
		const i = nearestIndex(pts, p);
		return i >= 0 && Math.hypot(pts[i]![0] - p[0], pts[i]![1] - p[1]) <= this.hitRadius() ? i : null;
	}

	/** The river, route or thread under a scene point (in that order). */
	private lineAt(p: [number, number]): { kind: LineKind; id: string; segment: number } | { kind: 'thread'; id: string } | null {
		const m = this.editor?.model;
		const scene = this.canvas.getScene();
		if (!m || !scene) return null;
		const r = this.hitRadius();
		let best: { kind: LineKind; id: string; segment: number } | null = null;
		let bestD = r;
		const test = (kind: LineKind, id: string, pts: [number, number][]) => {
			const hit = nearestLineSegment(pts, p[0], p[1]);
			if (hit && hit[1] <= bestD) {
				bestD = hit[1];
				best = { kind, id, segment: hit[0] };
			}
		};
		// The selected line wins where another crosses it.
		if (this.selectedLine) {
			const pts = this.linePoints(this.selectedLine.kind, this.selectedLine.id);
			const hit = nearestLineSegment(pts, p[0], p[1]);
			if (hit && hit[1] <= r) return { ...this.selectedLine, segment: hit[0] };
		}
		for (const river of m.rivers.values()) test('river', river.id, river.nodes.map((n) => this.anchorPx(n)));
		if (best) return best;
		for (const route of m.routes.values()) {
			if (route.kind === 'border' && !this.overlays.borders) continue;
			test('route', route.id, route.nodes.map((n) => this.anchorPx(n)));
		}
		if (best) return best;
		for (const [id, s] of scene.threadShapes()) {
			const hit = nearestLineSegment(s.sample(24), p[0], p[1]);
			if (hit && hit[1] <= r) return { kind: 'thread', id };
		}
		return null;
	}

	private wireInput(): void {
		const el = this.stage;
		// Raw pointer events, never gesture recognisers: trackpad drags must
		// not be lost (the Flutter canvas learned this the hard way).
		this.registerDomEvent(el, 'pointerdown', (e) => {
			el.focus({ preventScroll: true });
			this.toolbar.closePalette();
			if (e.button === 2) return; // the context menu
			if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
				this.gesture = { kind: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY };
				el.setPointerCapture(e.pointerId);
				el.addClass('is-panning');
				this.hideTooltip();
				return;
			}
			if (e.button !== 0) return;
			el.setPointerCapture(e.pointerId);
			this.hideTooltip();
			const [sx, sy] = this.local(e);
			const cell = this.canvas.cellAt(sx, sy);
			const p = this.scenePoint(e);
			const editor = this.editor;
			switch (this.tool) {
				case 'paint':
					this.gesture = { kind: 'paint', id: e.pointerId, last: cell };
					if (cell && editor) this.strokeTo(cell, null, (cells) => editor.paint(cells, this.pick));
					break;
				case 'fog': {
					const reveal = !(e.ctrlKey || e.metaKey);
					this.gesture = { kind: 'fog', id: e.pointerId, last: cell, reveal };
					if (cell && editor) this.strokeTo(cell, null, (cells) => editor.setRevealed(cells, reveal));
					break;
				}
				case 'region': {
					if (!editor || !this.activeRegion) {
						new Notice('Create or pick a region first: the map panel lists them.');
						void this.panel.toggle();
						break;
					}
					const add = !(e.ctrlKey || e.metaKey) !== this.regionErase;
					this.gesture = { kind: 'region', id: e.pointerId, last: cell, add };
					const rid = this.activeRegion;
					if (cell) this.strokeTo(cell, null, (cells) => editor.paintRegion(rid, cells, add), 0);
					break;
				}
				case 'ruler':
					this.ruler = [p, p];
					this.gesture = { kind: 'ruler', id: e.pointerId };
					break;
				case 'river':
				case 'route':
				case 'thread':
					// Placed on release, so a press that turns into a pan is not a point.
					this.gesture = { kind: 'place', id: e.pointerId, x: sx, y: sy, moved: false };
					break;
				default: {
					// A handle of the selected line beats every other meaning a
					// press can have (decision 8c).
					const held = this.handleAt(p);
					if (held !== null && this.selectedLine && editor) {
						const line = this.selectedLine;
						const from = (line.kind === 'river' ? editor.model.rivers : editor.model.routes).get(line.id)!.nodes.map((n) => ({ ...n }));
						this.gesture = { kind: 'line', id: e.pointerId, line, index: held, from, x: sx, y: sy, moved: false, last: null };
						break;
					}
					const additive = e.ctrlKey || e.metaKey || e.shiftKey;
					// A drag starting on a selected hex moves the selection.
					if (cell && this.selection.has(cellKeyOf(cell)) && editor && !editor.readOnly && !additive) {
						this.gesture = { kind: 'move', id: e.pointerId, start: cell, x: sx, y: sy, moved: false, delta: [0, 0], valid: false, additive, base: new Set(this.selection) };
						break;
					}
					this.gesture = {
						kind: 'select',
						id: e.pointerId,
						x: sx,
						y: sy,
						moved: false,
						additive,
						base: new Set(this.selection),
					};
				}
			}
			this.canvas.paintOverlay();
		});

		const end = (e: PointerEvent) => {
			const g = this.gesture;
			if (!g || g.id !== e.pointerId) return;
			this.gesture = null;
			el.removeClass('is-panning');
			const up = e.type === 'pointerup';
			switch (g.kind) {
				case 'paint':
					this.editor?.endStroke();
					break;
				case 'region':
					this.editor?.endRegionStroke();
					break;
				case 'line':
					if (g.moved) {
						this.editor?.pushLineNodesChange(g.line.kind, g.line.id, g.from);
					} else if (up) {
						this.heldPoint = g.index; // "work on this point": Del deletes it
						this.broadcast();
					}
					break;
				case 'place':
					if (up && !g.moved) this.place(e);
					break;
				case 'select':
					if (up && !g.moved) this.click(e, g.additive, g.base);
					break;
				case 'move':
					if (!g.moved) {
						if (up) this.click(e, g.additive, g.base); // a press that never dragged: a click
					} else if (up && g.valid && (g.delta[0] || g.delta[1])) {
						const cells = [...this.selection].map(cellOfKey);
						if (this.editor?.moveSelection(cells, g.delta[0], g.delta[1])) {
							this.setSelection(cells.map(([q, r]) => cellKeyOf([q + g.delta[0], r + g.delta[1]])));
						}
					}
					break;
			}
			this.band = null;
			this.canvas.paintOverlay();
		};
		this.registerDomEvent(el, 'pointerup', end);
		this.registerDomEvent(el, 'pointercancel', end);

		this.registerDomEvent(el, 'pointermove', (e) => {
			const [sx, sy] = this.local(e);
			const cell = this.canvas.cellAt(sx, sy);
			this.hoverScene = this.scenePoint(e);
			const g = this.gesture;
			if (g && g.id === e.pointerId) {
				switch (g.kind) {
					case 'pan':
						this.canvas.panBy(e.clientX - g.x, e.clientY - g.y);
						g.x = e.clientX;
						g.y = e.clientY;
						return;
					case 'paint':
					case 'fog':
					case 'region':
						this.hover = cell;
						if (cell && this.editor && (!g.last || cellKeyOf(cell) !== cellKeyOf(g.last))) {
							const editor = this.editor;
							if (g.kind === 'paint') this.strokeTo(cell, g.last, (cells) => editor.paint(cells, this.pick));
							else if (g.kind === 'fog') this.strokeTo(cell, g.last, (cells) => editor.setRevealed(cells, g.reveal));
							else if (this.activeRegion) {
								const rid = this.activeRegion;
								this.strokeTo(cell, g.last, (cells) => editor.paintRegion(rid, cells, g.add), 0);
							}
							g.last = cell;
						}
						this.canvas.paintOverlay();
						return;
					case 'ruler':
						if (this.ruler) this.ruler = [this.ruler[0], this.scenePoint(e)];
						this.canvas.paintOverlay();
						return;
					case 'place':
						if (Math.hypot(sx - g.x, sy - g.y) > DRAG_SLOP) g.moved = true;
						return;
					case 'line': {
						if (!g.moved && Math.hypot(sx - g.x, sy - g.y) <= DRAG_SLOP) return;
						g.moved = true;
						// Snap to the nearest anchor; re-laid from the points at
						// pointer-down, so passing over a neighbour leaves no trace.
						const target = nearestAnchor(...this.scenePoint(e));
						if (g.last && sameAnchor(g.last, target)) return;
						g.last = target;
						const index = this.editor?.moveLinePointLive(g.line.kind, g.line.id, g.from, g.index, target);
						if (index !== null && index !== undefined) this.heldPoint = index;
						this.canvas.paintOverlay();
						return;
					}
					case 'move': {
						if (!g.moved && Math.hypot(sx - g.x, sy - g.y) <= DRAG_SLOP) return;
						g.moved = true;
						// Raw pixel → cell, so the ghost follows past the grid's edge (red there).
						const [hq, hr] = pixelToAxial(...this.scenePoint(e));
						const d: Cell = [hq - g.start[0], hr - g.start[1]];
						if (d[0] !== g.delta[0] || d[1] !== g.delta[1]) {
							g.delta = d;
							g.valid = !!this.editor?.canMoveSelection([...this.selection].map(cellOfKey), d[0], d[1]);
							this.canvas.paintOverlay();
						}
						return;
					}
					case 'select': {
						if (!g.moved && Math.hypot(sx - g.x, sy - g.y) <= DRAG_SLOP) return;
						g.moved = true;
						// The rubber band: live, REPLACING the selection (or adding to it).
						this.band = [g.x, g.y, sx, sy];
						const picked = this.cellsInBand(g.x, g.y, sx, sy);
						this.selectLine(null);
						this.setSelection(g.additive ? new Set([...g.base, ...picked]) : picked);
						return;
					}
				}
			}
			if (!cell || !this.hover || cellKeyOf(cell) !== cellKeyOf(this.hover) || this.tool === 'river' || this.tool === 'route' || this.selectedLine) {
				this.hover = cell;
				this.canvas.paintOverlay();
			}
			if (this.tool === 'select') {
				this.showTooltip(cell, sx, sy);
				this.previewNote(cell, e);
			}
		});
		this.registerDomEvent(el, 'pointerleave', () => {
			this.hover = null;
			this.hoverScene = null;
			this.canvas.paintOverlay();
			this.hideTooltip();
		});
		// Drag a note from the file explorer onto a hex: it is linked there.
		this.registerDomEvent(el, 'dragover', (e) => {
			const [sx, sy] = this.local(e);
			const cell = this.canvas.cellAt(sx, sy);
			if (!cell || !this.editor || this.editor.readOnly) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
			if (!this.hover || cellKeyOf(cell) !== cellKeyOf(this.hover)) {
				this.hover = cell;
				this.canvas.paintOverlay();
			}
		});
		this.registerDomEvent(el, 'drop', (e) => {
			const [sx, sy] = this.local(e);
			const cell = this.canvas.cellAt(sx, sy);
			const editor = this.editor;
			if (!cell || !editor || editor.readOnly || !this.file) return;
			const file = this.droppedFile(e);
			if (!file) return;
			e.preventDefault();
			const id = hexIdFor(...cell);
			const link = this.app.metadataCache.fileToLinktext(file, this.file.path, true);
			const notes = editor.hexNotes(id);
			if (notes.includes(link)) {
				new Notice(`“${file.basename}” is already linked to this hex.`);
				return;
			}
			editor.setHexNotes(id, [...notes, link], `Link “${file.basename}”`);
			this.setSelection([cellKeyOf(cell)]);
			new Notice(`Linked “${file.basename}” to this hex.`, 2500);
		});

		this.registerDomEvent(el, 'contextmenu', (e) => {
			e.preventDefault();
			const [sx, sy] = this.local(e);
			if (this.tool === 'select') {
				const hit = this.lineAt(this.scenePoint(e));
				if (hit?.kind === 'thread') {
					this.selectThread(hit.id);
					this.threadMenu(hit.id, e);
					return;
				}
				if (hit) {
					const pts = this.linePoints(hit.kind, hit.id);
					this.selectLine(hit);
					this.lineMenu(hit, nearestIndex(pts, this.scenePoint(e)), e);
					return;
				}
			}
			const cell = this.canvas.cellAt(sx, sy);
			if (cell) this.cellMenu(cell, e);
		});
		this.registerDomEvent(
			el,
			'wheel',
			(e) => {
				e.preventDefault();
				const [sx, sy] = this.local(e);
				this.hideTooltip();
				// A mouse wheel moves in whole notches (±100 px, or lines); a
				// trackpad scrolls in small, often sideways, steps: it pans.
				// Ctrl+wheel is a pinch: it zooms, smoothly.
				const notch = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
				if (!e.ctrlKey && !notch) {
					this.canvas.panBy(-e.deltaX, -e.deltaY);
					return;
				}
				const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
				this.canvas.zoomAt(sx, sy, Math.pow(1.15, (-dy / 100) * (e.ctrlKey ? 3 : 1)));
			},
			{ passive: false },
		);
		// Space held: drag pans with any tool.
		const win = this.stage.win;
		this.registerDomEvent(win, 'keydown', (e) => {
			if (e.key === ' ' && this.stage.doc.activeElement === this.stage) {
				this.spaceDown = true;
				e.preventDefault();
			}
		});
		this.registerDomEvent(win, 'keyup', (e) => {
			if (e.key === ' ') this.spaceDown = false;
		});
		this.registerDomEvent(win, 'blur', () => (this.spaceDown = false));
	}

	/** A plain click with the select tool: the selected line's body (a second
	 *  click inserts a point), any line, a thread, else a hex. */
	private click(e: PointerEvent, additive: boolean, base: Set<string>): void {
		const p = this.scenePoint(e);
		const [sx, sy] = this.local(e);
		const editor = this.editor;
		const hit = editor ? this.lineAt(p) : null;
		const now = e.timeStamp;
		const last = this.lastClick;
		this.lastClick = { at: now, x: sx, y: sy, line: hit && hit.kind !== 'thread' ? `${hit.kind}:${hit.id}` : null };
		if (hit && hit.kind !== 'thread' && editor) {
			const wasSelected = this.selectedLine?.kind === hit.kind && this.selectedLine.id === hit.id;
			// A double-click on the SELECTED line's body adds a point there.
			if (wasSelected && last && last.line === `${hit.kind}:${hit.id}` && now - last.at < 400 && Math.hypot(sx - last.x, sy - last.y) < 12) {
				const index = editor.insertLinePoint(hit.kind, hit.id, hit.segment, nearestAnchor(...p));
				this.selectLine(hit, index);
				this.lastClick = null;
				return;
			}
			this.selectLine({ kind: hit.kind, id: hit.id });
			return;
		}
		if (hit?.kind === 'thread') {
			this.selectThread(hit.id);
			return;
		}
		this.selectLine(null);
		this.selectThread(null);
		const cell = this.canvas.cellAt(sx, sy);
		// A double-click on a hex opens its principal note, beside the map.
		if (cell && !additive && last && last.cell === cellKeyOf(cell) && now - last.at < 400) {
			this.openPrincipalNote(cell);
			this.lastClick = null;
		}
		if (this.lastClick) this.lastClick.cell = cell ? cellKeyOf(cell) : null;
		if (!cell) this.setSelection(additive ? base : []);
		else if (additive) {
			const next = new Set(base);
			if (!next.delete(cellKeyOf(cell))) next.add(cellKeyOf(cell));
			this.setSelection(next);
		} else this.setSelection([cellKeyOf(cell)]);
	}

	// ----- notes on the map (item 2.5) -----------------------------------------------

	/** Note path → the hexes listing it. */
	hexesByNote(): Map<string, Set<string>> {
		return this.file ? hexesByNote(this.app, this.file, this.links) : new Map<string, Set<string>>();
	}

	/** The hexes [file] stands for on this map. */
	hexesOf(file: TFile): Set<string> {
		return hexesOfNote(this.app, file, this.hexesByNote());
	}

	/** A note was opened: highlight its hexes (a note that is on no hex of
	 *  this map leaves the last highlight, so clicking back to the map keeps
	 *  what was being read). */
	private followNote(file: TFile | null): void {
		if (!file || file === this.file || file.extension !== 'md') return;
		const index: boolean = isMapIndex(this.app, file);
		if (index) return;
		const ids = this.hexesOf(file);
		const next = ids.size ? { name: file.basename, ids } : null;
		if (!next && !this.noteHighlight) return;
		this.noteHighlight = next;
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** The hexes highlighted for the note being read, if any. */
	get highlightedNote(): { name: string; ids: Set<string> } | null {
		return this.noteHighlight;
	}

	clearNoteHighlight(): void {
		this.noteHighlight = null;
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** Hovering a note elsewhere (the sections list): its hexes, or null. */
	setHoverHighlight(ids: Set<string> | null): void {
		this.hoverHighlight = ids && ids.size ? ids : null;
		this.canvas.paintOverlay();
	}

	/** Bring [ids] into view and highlight them as [name]'s. */
	showHexes(ids: Set<string>, name: string): void {
		const cells = [...ids].map(cellOfId).filter((c): c is Cell => !!c);
		if (!cells.length) return;
		let x = 0, y = 0;
		for (const [q, r] of cells) {
			const [px, py] = axialToPixel(q, r);
			x += px;
			y += py;
		}
		this.canvas.centreOn(x / cells.length, y / cells.length);
		this.noteHighlight = { name, ids };
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** "Export image…" (item 2.10): PNG or PDF, Players or GM. */
	exportImage(): void {
		const store = this.store;
		if (!store || !this.file || !this.data) return;
		const m = store.model;
		const [w, h] = this.canvas.size;
		const cam = this.canvas.camera;
		const scene = this.canvas.getScene();
		new ImageExportModal({
			app: this.app,
			index: this.file,
			// The Players version comes from the filter's payload, never the model.
			source: (version) =>
				version === 'players'
					? { data: playersSceneData(toPlain(filterCampaignForPlayer(m)) as JsonObject, m.meta.format), overlays: DEFAULT_OVERLAYS, mapScale: m.meta.scale, name: m.meta.name }
					: { data: sceneDataFromModel(m, new Set(this.links.keys())), overlays: scene?.overlays ?? DEFAULT_OVERLAYS, mapScale: m.meta.scale, name: m.meta.name },
			view: [-cam.ox / cam.scale, -cam.oy / cam.scale, w / cam.scale, h / cam.scale],
			style: this.canvas.style,
			blend: this.canvas.blend,
			revealed: m.revealed.size,
			makeSurface,
		}).open();
	}

	/** Open a hex's principal note in a pane beside the map. */
	openPrincipalNote(cell: Cell): void {
		const link = this.editor?.hexNotes(hexIdFor(...cell))[0] ?? this.links.get(hexIdFor(...cell))?.[0];
		if (!link || !this.file) {
			new Notice('No notes linked to this hex yet: the map panel can create or link one.');
			return;
		}
		void this.app.workspace.openLinkText(link.split('|')[0]!, this.file.path, 'split');
	}

	/** Page preview of the hovered hex's principal note (with Ctrl, by
	 *  default: Obsidian's Page preview settings decide). */
	private previewNote(cell: Cell | null, e: MouseEvent): void {
		const link = cell ? this.links.get(hexIdFor(...cell))?.[0] : undefined;
		const key = link && cell ? `${cellKeyOf(cell)}:${link}` : null;
		if (key === this.previewed) return;
		this.previewed = key;
		if (!link || !this.file) return;
		this.app.workspace.trigger('hover-link', {
			event: e,
			source: HOVER_SOURCE,
			hoverParent: this,
			targetEl: this.stage,
			linktext: link.split('|')[0]!,
			sourcePath: this.file.path,
		});
	}

	/** The note dropped on the map: Obsidian's own drag (the file explorer),
	 *  else the dropped text — an obsidian:// link, a [[link]] or a path. */
	private droppedFile(e: DragEvent): TFile | null {
		const drag = (this.app as App & { dragManager?: { draggable?: { type?: string; file?: unknown; files?: unknown[] } } }).dragManager?.draggable;
		const fromDrag = drag?.file ?? drag?.files?.[0];
		if (fromDrag instanceof TFile) return fromDrag.extension === 'md' ? fromDrag : null;
		const text = e.dataTransfer?.getData('text/plain')?.trim() ?? '';
		if (!text) return null;
		let path = text;
		const uri = /^obsidian:\/\/open\?(.*)$/.exec(text);
		if (uri) path = new URLSearchParams(uri[1]).get('file') ?? '';
		const wiki = /^!?\[\[([^\]|#]+)/.exec(text);
		if (wiki) path = wiki[1]!;
		const file = this.app.metadataCache.getFirstLinkpathDest(path, this.file?.path ?? '') ?? this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && file.extension === 'md' ? file : null;
	}

	/** A click with the river, route or thread tool. */
	private place(e: PointerEvent): void {
		const [sx, sy] = this.local(e);
		const cell = this.canvas.cellAt(sx, sy);
		if (!cell || !this.editor) return;
		if (this.tool === 'thread') {
			if (!this.threadSource) this.threadSource = cell;
			else if (cellKeyOf(cell) !== cellKeyOf(this.threadSource)) {
				const from = hexIdFor(...this.threadSource), to = hexIdFor(...cell);
				this.threadSource = null;
				this.threadDialog(null, (spec) => {
					const t = this.editor?.createThread(from, to, spec);
					if (t) this.showThreadColor(t.colorKey);
				});
			}
			this.canvas.paintOverlay();
			return;
		}
		const a = nearestAnchor(...this.scenePoint(e));
		const draft = this.tool === 'river' ? this.riverDraft : this.routeDraft;
		if (draft.length && sameAnchor(draft[draft.length - 1]!, a)) return; // a repeated click
		draft.push(a);
		this.canvas.paintOverlay();
	}

	/** Enter: save the line being drawn (the tool stays, to chain lines). */
	private finishDraft(): void {
		const editor = this.editor;
		if (!editor) return;
		if (this.tool === 'river' || this.tool === 'route') {
			const draft = this.tool === 'river' ? this.riverDraft : this.routeDraft;
			if (draft.length < 2) {
				new Notice('A line needs at least two points.');
				return;
			}
			if (this.tool === 'river') editor.createRiver(draft);
			else {
				editor.createRoute(draft, this.routeKind, this.routeColor);
				if (this.routeKind === 'border' && !this.overlays.borders) this.setOverlays({ borders: true });
			}
			if (this.tool === 'river') this.riverDraft = [];
			else this.routeDraft = [];
			this.canvas.paintOverlay();
		}
	}

	/** In-grid cells whose centre lies inside a screen rectangle. */
	private cellsInBand(x0: number, y0: number, x1: number, y1: number): string[] {
		const scene = this.canvas.getScene();
		if (!scene) return [];
		const cam = this.canvas.camera;
		const ax = (Math.min(x0, x1) - cam.ox) / cam.scale, ay = (Math.min(y0, y1) - cam.oy) / cam.scale;
		const bx = (Math.max(x0, x1) - cam.ox) / cam.scale, by = (Math.max(y0, y1) - cam.oy) / cam.scale;
		const out: string[] = [];
		for (const [q, r] of cellsInRect(ax, ay, bx, by, scene.grid)) {
			const [x, y] = axialToPixel(q, r);
			if (x >= ax && x <= bx && y >= ay && y <= by) out.push(`${q},${r}`);
		}
		return out;
	}

	private wireKeys(): void {
		this.scope = new Scope(this.app.scope);
		for (const t of TOOLS) {
			this.scope.register([], t.key, () => {
				this.setTool(t.id);
				return false;
			});
		}
		this.scope.register([], 'Escape', () => {
			if (this.riverDraft.length || this.routeDraft.length || this.threadSource) {
				this.riverDraft = [];
				this.routeDraft = [];
				this.threadSource = null;
			} else if (this.tool !== 'select') this.setTool('select');
			else if (this.selectedLine || this.selectedThread) {
				this.selectLine(null);
				this.selectThread(null);
			} else this.setSelection([]);
			this.ruler = null;
			this.canvas.paintOverlay();
			return false;
		});
		this.scope.register([], 'Enter', () => {
			this.finishDraft();
			return false;
		});
		this.scope.register([], 'Backspace', () => {
			if (this.tool === 'river') this.riverDraft.pop();
			else if (this.tool === 'route') this.routeDraft.pop();
			else return this.deleteKey();
			this.canvas.paintOverlay();
			return false;
		});
		this.scope.register([], 'Delete', () => this.deleteKey());
		this.scope.register(['Mod'], 'x', () => {
			this.clip(true);
			return false;
		});
		this.scope.register(['Mod'], 'c', () => {
			this.clip(false);
			return false;
		});
		this.scope.register(['Mod'], 'v', () => {
			this.paste();
			return false;
		});
		this.scope.register(['Mod'], 'z', () => {
			this.undoLast();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'z', () => {
			this.redoLast();
			return false;
		});
		this.scope.register(['Mod'], 'y', () => {
			this.redoLast();
			return false;
		});
		this.scope.register([], 'F2', () => {
			const only = this.selection.size === 1 ? cellOfKey([...this.selection][0]!) : null;
			if (only) this.promptRename(only);
			return false;
		});
		this.scope.register([], '[', () => {
			this.setBrush(this.brush - 1);
			return false;
		});
		this.scope.register([], ']', () => {
			this.setBrush(this.brush + 1);
			return false;
		});
	}

	/** Del: the held point, else the selected thread. */
	private deleteKey(): boolean {
		const editor = this.editor;
		if (!editor) return false;
		if (this.selectedLine && this.heldPoint !== null) {
			const alive = editor.removeLinePoint(this.selectedLine.kind, this.selectedLine.id, this.heldPoint);
			if (alive) this.heldPoint = null;
			else this.selectLine(null);
			this.canvas.paintOverlay();
			return false;
		}
		if (this.selectedThread) {
			editor.removeThread(this.selectedThread);
			this.selectThread(null);
			return false;
		}
		if (this.selection.size) {
			this.confirmDelete([...this.selection].map(cellOfKey));
			return false;
		}
		return true; // let the key through
	}

	/** Delete hexes, after asking: their notes are unlinked, never deleted. */
	private confirmDelete(cells: Cell[]): void {
		const editor = this.editor;
		if (!editor || editor.readOnly) return;
		const n = cells.filter(([q, r]) => editor.model.getHex(q, r) || editor.links.has(hexIdFor(q, r))).length;
		if (!n) {
			new Notice('Nothing to delete: the selected hexes are empty.');
			return;
		}
		new ConfirmPrompt(
			this.app,
			n === 1 ? 'Delete hex' : `Delete ${n} hexes`,
			`${n === 1 ? 'Its' : 'Their'} terrain, feature, name and threads go. Linked notes are unlinked, not deleted. Undo brings everything back.`,
			'Delete',
			() => editor.deleteHexes(cells),
		).open();
	}

	/** Ctrl+X / Ctrl+C: the selection, anchored at its top-left (decision 29). */
	private clip(cut: boolean): void {
		const editor = this.editor;
		if (!editor || !this.selection.size) return;
		const cells = [...this.selection].map(cellOfKey);
		const replacedCut = editor.clipboard?.clip.isCut ?? false;
		const n = cut ? editor.cutHexes(cells, topLeftCell(cells)) : editor.copyHexes(cells, topLeftCell(cells));
		if (!n) {
			new Notice(`Nothing to ${cut ? 'cut' : 'copy'}: the selection holds no hex.`);
			return;
		}
		new Notice(
			`${cut ? 'Cut' : 'Copied'} ${n === 1 ? 'hex' : `${n} hexes`}: select where it goes and press Ctrl+V.` +
				(cut && replacedCut ? ' The hexes cut before are no longer on the clipboard (undo brings them back).' : ''),
			4000,
		);
	}

	/** Ctrl+V: top-left of the paste onto top-left of the selection. */
	private paste(): void {
		const editor = this.editor;
		if (!editor || !this.selection.size) return;
		const entry = editor.clipboard;
		if (!entry) {
			new Notice('The clipboard is empty: copy or cut hexes first.');
			return;
		}
		const sel = [...this.selection].map(cellOfKey);
		const fit = fitPaste(entry.clip, sel);
		const refused = editor.pastePrecheck(...fit.at);
		if (refused) {
			new Notice(refused);
			return;
		}
		const go = () => {
			const res = editor.pasteHexes(...fit.at);
			if (!res) return;
			this.setSelection(fit.footprint.map(cellKeyOf));
			const extra = [
				res.threads ? `${res.threads} thread${res.threads === 1 ? '' : 's'} reattached` : '',
				res.threadsDropped ? `${res.threadsDropped} thread${res.threadsDropped === 1 ? '' : 's'} dropped (an end is gone)` : '',
				fit.unfilled.length ? `${fit.unfilled.length} selected hex${fit.unfilled.length === 1 ? '' : 'es'} left alone` : '',
			].filter(Boolean);
			new Notice(`Pasted ${res.hexes === 1 ? 'a hex' : `${res.hexes} hexes`}${extra.length ? ` — ${extra.join('; ')}` : ''}.`, 4000);
		};
		if (fit.outside.length) {
			const busy = fit.outside.filter(([q, r]) => editor.model.getHex(q, r)).length;
			new ConfirmPrompt(
				this.app,
				'Paste beyond the selection?',
				`The paste covers ${fit.footprint.length} hexes; ${fit.outside.length} of them are outside the selection${busy ? `, and ${busy} of those already hold something` : ''}.`,
				'Paste',
				go,
			).open();
		} else go();
	}

	// ----- the whole map ---------------------------------------------------------------

	resizeDialog(): void {
		const editor = this.editor;
		if (!editor || editor.readOnly) return;
		new ResizeModal(this.app, editor).open();
	}

	explodeDialog(): void {
		const editor = this.editor;
		if (!editor || editor.readOnly) return;
		new ExplodeModal(this.app, editor).open();
	}

	// ----- editing: commands ------------------------------------------------------------

	/** Name or rename a hex (a prompt). */
	promptRename(cell: Cell): void {
		const editor = this.editor;
		if (!editor || editor.readOnly) return;
		const current = editor.model.getHex(cell[0], cell[1])?.name ?? '';
		new TextPrompt(this.app, current ? 'Rename hex' : 'Name hex', current, (value) => {
			const given = editor.renameHex(cell[0], cell[1], value);
			if (given && given !== value.trim()) new Notice(`"${value.trim()}" is taken: named it "${given}".`);
		}).open();
	}

	/** The thread dialog: [existing] to edit one, null for a new one. */
	threadDialog(existing: string | null, done: (spec: ThreadSpec) => void): void {
		const t = existing ? this.editor?.model.threads.get(existing) : undefined;
		const spec: ThreadSpec = t
			? { type: t.type, label: t.label, direction: t.direction, status: t.status, color: t.color.toUpperCase() }
			: { type: 'Quest Chain', label: '', direction: 'bidirectional', status: 'active', color: this.lastThreadColor };
		new ThreadModal(this.app, existing ? 'Edit thread' : 'New thread', spec, (s) => {
			this.lastThreadColor = s.color;
			this.savePrefs();
			done(s);
		}).open();
	}

	/** The cells an action on [cell] applies to: the selection when the cell
	 *  is in it, else the cell (which becomes the selection). */
	private targetCells(cell: Cell): Cell[] {
		if (!this.selection.has(cellKeyOf(cell))) this.setSelection([cellKeyOf(cell)]);
		return [...this.selection].map(cellOfKey);
	}

	private cellMenu(cell: Cell, e: MouseEvent): void {
		const editor = this.editor;
		const cells = this.targetCells(cell);
		const multi = cells.length > 1;
		const menu = new Menu();
		if (!editor) {
			menu.addItem((i) => i.setTitle('This map cannot be edited').setDisabled(true));
			menu.showAtMouseEvent(e);
			return;
		}
		const ro = editor.readOnly;
		const held = cells.filter(([q, r]) => editor.model.getHex(q, r)).length;
		menu.addItem((i) => i.setTitle('Cut').setIcon('scissors').setDisabled(ro || !held).onClick(() => this.clip(true)));
		menu.addItem((i) => i.setTitle('Copy').setIcon('copy').setDisabled(!held).onClick(() => this.clip(false)));
		menu.addItem((i) =>
			i
				.setTitle(editor.clipboard ? `Paste ${editor.clipboard.clip.isCut ? 'cut' : 'copied'} hexes here` : 'Paste')
				.setIcon('clipboard-paste')
				.setDisabled(ro || !editor.clipboard)
				.onClick(() => this.paste()),
		);
		menu.addItem((i) =>
			i
				.setTitle(multi ? `Delete ${cells.length} hexes…` : 'Delete hex…')
				.setIcon('trash-2')
				.setDisabled(ro)
				.onClick(() => this.confirmDelete(cells)),
		);
		menu.addSeparator();
		if (!multi) {
			menu.addItem((i) =>
				i
					.setTitle(editor.model.getHex(cell[0], cell[1])?.name ? 'Rename…' : 'Name…')
					.setIcon('pencil')
					.setDisabled(ro)
					.onClick(() => this.promptRename(cell)),
			);
			menu.addSeparator();
		}
		const revealed = editor.allRevealed(cells);
		const n = cells.length;
		menu.addItem((i) =>
			i
				.setTitle(revealed ? (multi ? `Hide ${n} hexes from players` : 'Hide from players') : multi ? `Reveal ${n} hexes to players` : 'Reveal to players')
				.setIcon(revealed ? 'eye-off' : 'eye')
				.setDisabled(ro)
				.onClick(() => editor.setRevealed(cells, !revealed)),
		);
		if (!revealed) {
			menu.addItem((i) =>
				i
					.setTitle(multi ? `Reveal ${n} hexes + line of sight` : 'Reveal + line of sight')
					.setIcon('scan-eye')
					.setDisabled(ro)
					.onClick(() => {
						const changed = editor.revealWithSight(cells).length;
						new Notice(changed ? `Revealed ${changed} hex${changed === 1 ? '' : 'es'} by line of sight` : 'Already revealed — line of sight added nothing', 2500);
					}),
			);
		}
		if (editor.anyFeature(cells)) {
			const hidden = editor.allFeaturesHidden(cells);
			menu.addItem((i) =>
				i
					.setTitle(hidden ? 'Show feature + name to players' : 'Hide feature + name from players')
					.setIcon(hidden ? 'badge-check' : 'badge-x')
					.setDisabled(ro)
					.onClick(() => editor.setFeatureHidden(cells, !hidden)),
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Draw thread to…')
				.setIcon('spline')
				.setDisabled(ro)
				.onClick(() => {
					this.setTool('thread');
					this.threadSource = cell;
					this.canvas.paintOverlay();
				}),
		);
		for (const g of editor.regionsContaining(cells)) {
			menu.addItem((i) =>
				i
					.setTitle(`Remove ${multi ? 'selection' : 'hex'} from region “${g.name || 'Untitled'}”`)
					.setIcon('shapes')
					.setDisabled(ro)
					.onClick(() => editor.removeRegionCells(g.id, cells)),
			);
		}
		menu.showAtMouseEvent(e);
	}

	private lineMenu(line: { kind: LineKind; id: string }, point: number, e: MouseEvent): void {
		const editor = this.editor;
		if (!editor) return;
		const ro = editor.readOnly;
		const name = line.kind === 'river' ? 'river' : (editor.model.routes.get(line.id)?.kind ?? 'route');
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle('Delete point here')
				.setIcon('circle-minus')
				.setDisabled(ro || point < 0)
				.onClick(() => {
					if (!editor.removeLinePoint(line.kind, line.id, point)) this.selectLine(null);
				}),
		);
		menu.addItem((i) => i.setTitle('Edit in the map panel').setIcon('panel-right').onClick(() => void this.panel.toggle()));
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle(`Delete ${name}`)
				.setIcon('trash-2')
				.setDisabled(ro)
				.onClick(() => {
					editor.removeLine(line.kind, line.id);
					this.selectLine(null);
				}),
		);
		menu.showAtMouseEvent(e);
	}

	private threadMenu(id: string, e: MouseEvent): void {
		const editor = this.editor;
		const t = editor?.model.threads.get(id);
		if (!editor || !t) return;
		const ro = editor.readOnly;
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle('Edit…')
				.setIcon('pencil')
				.setDisabled(ro)
				.onClick(() =>
					this.threadDialog(id, (spec) => {
						editor.updateThread(id, spec);
						const now = editor.model.threads.get(id);
						if (now) this.showThreadColor(now.colorKey);
					}),
				),
		);
		menu.addItem((i) =>
			i
				.setTitle('Hide threads of this colour')
				.setIcon('eye-off')
				.onClick(() => {
					this.setOverlays({ hiddenThreadColors: [...new Set([...this.overlays.hiddenThreadColors, t.colorKey])] });
					this.selectThread(null);
					new Notice('Hidden. The map panel shows them again.', 3000);
				}),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Delete thread')
				.setIcon('trash-2')
				.setDisabled(ro)
				.onClick(() => {
					editor.removeThread(id);
					this.selectThread(null);
				}),
		);
		menu.showAtMouseEvent(e);
	}

	// ----- tooltip -----------------------------------------------------------------------

	private showTooltip(cell: [number, number] | null, sx: number, sy: number): void {
		const h = cell && this.canvas.getScene()?.hexAt(cell[0], cell[1]);
		if (!cell || !h || (!h.name && h.terrain === 'default' && !h.feature) || this.gesture) {
			this.hideTooltip();
			return;
		}
		this.tooltip.empty();
		if (h.name) this.tooltip.createDiv({ cls: 'hexlore-map-tooltip-title', text: h.name });
		const biome = h.terrain !== 'default' ? ART.biome(h.terrain)?.variants[h.terrainVariant]?.label : null;
		const feature = h.feature ? ART.feature(h.feature)?.variants[h.featureVariant]?.label : null;
		const terrain = [h.terrain !== 'default' ? `${h.terrain}${biome && h.terrainVariant ? ` (${biome})` : ''}` : null, h.feature ? `${h.feature}${feature && h.featureVariant ? ` (${feature})` : ''}` : null]
			.filter(Boolean)
			.join(' · ');
		if (terrain) this.tooltip.createDiv({ text: terrain });
		this.tooltip.createDiv({ cls: 'hexlore-map-tooltip-id', text: `q${cell[0]} r${cell[1]}` });
		this.tooltip.style.setProperty('--x', `${sx + 14}px`);
		this.tooltip.style.setProperty('--y', `${sy + 14}px`);
		this.tooltip.show();
	}

	private hideTooltip(): void {
		this.tooltip.hide();
	}

	// ----- benchmark -------------------------------------------------------------

	private async bench(): Promise<void> {
		if (!this.data || this.benching) return;
		this.benching = true;
		const progress = new Notice('Benchmarking… keep this window in front.', 0);
		try {
			const report = await runBench(this.stage.win, this.canvas, this.stage, this.data, (m) =>
				progress.setMessage(`Benchmarking: ${m}`),
			);
			const env = {
				Date: new Date().toISOString().slice(0, 16).replace('T', ' '),
				Obsidian: `API ${apiVersion}`,
				Platform: Platform.isWin ? 'Windows' : Platform.isMacOS ? 'macOS' : Platform.isLinux ? 'Linux' : 'mobile',
			};
			const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
			const note = await this.app.vault.create(`HexLore benchmark ${stamp}.md`, reportMarkdown(report, env));
			new Notice(`Benchmark written to ${note.path}`);
			await this.app.workspace.getLeaf('split').openFile(note);
		} catch (e) {
			new Notice(`Benchmark failed: ${(e as Error).message}`);
			console.error(e);
		} finally {
			progress.hide();
			this.benching = false;
		}
	}
}

/** A one-line text prompt (Enter accepts, Esc cancels). */
class TextPrompt extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly initial: string,
		private readonly accept: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		let value = this.initial;
		const done = () => {
			this.close();
			this.accept(value);
		};
		new Setting(this.contentEl).setName('Name').addText((t) => {
			t.setValue(this.initial).onChange((v) => (value = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					done();
				}
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Save').setCta().onClick(done));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Ask before doing something. */
class ConfirmPrompt extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string,
		private readonly action: string,
		private readonly accept: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.contentEl.createEl('p', { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.action)
					.setCta()
					.onClick(() => {
						this.close();
						this.accept();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Resize the grid about its centre; says what would be dropped. */
class ResizeModal extends Modal {
	constructor(
		app: App,
		private readonly editor: MapEditor,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Resize the grid');
		const m = this.editor.model.meta;
		let cols = m.gridCols, rows = m.gridRows;
		const el = this.contentEl;
		el.createEl('p', { cls: 'setting-item-description', text: 'The grid grows and shrinks about its centre.' });
		const num = (v: string, fallback: number) => {
			const n = Number.parseInt(v, 10);
			return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : fallback;
		};
		new Setting(el).setName('Columns').addText((t) => {
			t.inputEl.type = 'number';
			t.setValue(String(cols)).onChange((v) => {
				cols = num(v, cols);
				update();
			});
		});
		new Setting(el).setName('Rows').addText((t) => {
			t.inputEl.type = 'number';
			t.setValue(String(rows)).onChange((v) => {
				rows = num(v, rows);
				update();
			});
		});
		const warn = el.createEl('p', { cls: 'hexlore-warning' });
		let button: ButtonComponent | null = null;
		const update = () => {
			const gone = this.editor.outsideAfterResize(cols, rows).length;
			warn.setText(
				gone
					? `${gone} hex${gone === 1 ? '' : 'es'} would fall outside and be deleted, with their threads and fog. Their notes stay, unlinked. This cannot be undone, and it clears the undo history.`
					: 'Nothing is deleted.',
			);
			warn.toggleClass('mod-warning', gone > 0);
			button?.setButtonText(gone ? `Resize and delete ${gone}` : 'Resize');
		};
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => {
				button = b;
				b.setCta().onClick(() => {
					this.close();
					const n = this.editor.resizeGrid(cols, rows);
					new Notice(`Grid is now ${cols} × ${rows}${n ? `; ${n} hex${n === 1 ? '' : 'es'} deleted` : ''}.`);
				});
			});
		update();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Spread the map out about its populated centre (decision 11). */
class ExplodeModal extends Modal {
	constructor(
		app: App,
		private readonly editor: MapEditor,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Explode the map');
		const el = this.contentEl;
		el.createEl('p', {
			cls: 'setting-item-description',
			text: 'Every hex moves away from the centre, so neighbours end up apart: room to add detail between them. Rivers, roads, regions and threads follow. One undo step.',
		});
		let factor = 2;
		const why = el.createEl('p', { cls: 'hexlore-warning' });
		let button: ButtonComponent | null = null;
		const update = () => {
			const err = this.editor.explodePrecheck(factor);
			why.setText(err ?? '');
			why.toggleClass('mod-warning', !!err);
			button?.setDisabled(!!err);
		};
		new Setting(el).setName('Spread').addDropdown((d) =>
			d
				.addOption('2', '× 2')
				.addOption('3', '× 3')
				.addOption('4', '× 4')
				.setValue('2')
				.onChange((v) => {
					factor = Number(v);
					update();
				}),
		);
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => {
				button = b;
				b.setButtonText('Explode')
					.setCta()
					.onClick(() => {
						this.close();
						const err = this.editor.explodeMap(factor);
						if (err) new Notice(err);
					});
			});
		update();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Thread colours offered besides "by type" (Flutter's swatch row). */
const THREAD_SWATCHES = ['#E05555', '#E08A30', '#D4C050', '#55B855', '#40B8B0', '#5580E0', '#9A55D4', '#E070B0', '#E8E8E8', '#8A8A9A'];

/** New / edit thread: type, label, direction, status, colour. */
class ThreadModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly spec: ThreadSpec,
		private readonly accept: (spec: ThreadSpec) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		const s = { ...this.spec };
		const el = this.contentEl;
		new Setting(el).setName('Type').addDropdown((d) => {
			for (const t of THREAD_TYPES) d.addOption(t, t);
			d.setValue(s.type).onChange((v) => {
				s.type = v as ThreadType;
				renderSwatches();
			});
		});
		new Setting(el).setName('Label').addText((t) => t.setValue(s.label).onChange((v) => (s.label = v)));
		new Setting(el).setName('Direction').addDropdown((d) => {
			for (const v of THREAD_DIRECTIONS) d.addOption(v, v === 'one-way' ? 'One way' : 'Both ways');
			d.setValue(s.direction).onChange((v) => (s.direction = v as ThreadDirection));
		});
		new Setting(el).setName('Status').addDropdown((d) => {
			for (const v of THREAD_STATUSES) d.addOption(v, v[0]!.toUpperCase() + v.slice(1));
			d.setValue(s.status).onChange((v) => {
				s.status = v as ThreadStatus;
				renderSwatches();
			});
		});
		const colour = new Setting(el).setName('Colour').setDesc('A thread’s colour is its group: the map panel shows or hides threads by colour.');
		const row = colour.controlEl.createDiv({ cls: 'hexlore-swatches' });
		const renderSwatches = () => {
			row.empty();
			const byType = row.createDiv({ cls: 'hexlore-swatch', text: 'A' });
			byType.style.setProperty('--chip', threadColorFor(s.type, s.status));
			byType.toggleClass('is-active', !s.color);
			byType.setAttr('aria-label', 'By type');
			byType.addEventListener('click', () => {
				s.color = '';
				renderSwatches();
			});
			for (const hex of THREAD_SWATCHES) {
				const sw = row.createDiv({ cls: 'hexlore-swatch' });
				sw.style.setProperty('--chip', hex);
				sw.toggleClass('is-active', s.color === hex);
				sw.addEventListener('click', () => {
					s.color = hex;
					renderSwatches();
				});
			}
		};
		renderSwatches();
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					this.close();
					this.accept(s);
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Credits for the art the map draws (CC BY needs the attribution shown). */
class CreditsModal extends Modal {
	onOpen(): void {
		this.setTitle('Map art credits');
		const list = this.contentEl.createEl('ul');
		for (const c of ART.credits()) {
			const li = list.createEl('li');
			if (c.url) li.createEl('a', { text: c.name, href: c.url });
			else li.setText(c.name);
			if (c.license) li.appendText(` — ${c.license}`);
		}
		this.contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Feature and biome icons from game-icons.net (CC BY 3.0); Illustrated terrain symbols from Azgaar’s Fantasy Map Generator (MIT).',
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

