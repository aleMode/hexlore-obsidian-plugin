// The map view of a `.hexmap.md` index (items 2.2–2.3; editing is 2.4).
//
// The map comes from the data folder's shared MapStore (one per folder, so
// two views of a map agree) and the hex → note links from the index. Files
// changed outside (a git pull, a sync, the Flutter app) reload on their own.
// Camera and display choices are per device (§1.2): they live in the vault's
// local storage, never in a synced file.

import { FuzzySuggestModal, ItemView, Menu, Modal, Notice, Platform, Scope, Setting, TFile, type ButtonComponent, type HoverPopover, apiVersion, normalizePath, type App, type Events, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { nearestAnchor } from '../core/anchors';
import { HEX_RADIUS as R, axialToPixel, cellsInRect, hexDistance, nodePixel, pixelToAxial } from '../core/geometry';
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
import { PLAYERS_EVENT, type PlayerControl } from '../server/control';
import { TopBar } from './top_bar';
import { DisplayPanel, type DisplayPanelState } from './display_panel';
import { WheelClassifier } from './wheel_intent';
import { MapPicker, NewMapModal, newMapFolder, QuickJumpModal, RIVER_WIDTH_PRESETS, RiverWidthModal, ScaleModal, StylusProbeModal, UnassignedModal, type JumpTarget, type Unassigned } from './map_menus';
import { NewNoteModal, newHexNote } from './inspector_view';
import { HOVER_SOURCE, openNote, type NoteOpening } from './open_note';
import { createNote, notesInFolder, noteKind, templateFiles } from './vault_notes';
import { DEFAULT_SECTIONS, type Section } from '../storage/hexmap_index';
import { sectionsOf } from '../storage/index_file';
import { displayIdFor } from '../core/hex';
import { threadColorGroups } from '../core/overlay_filter';
import { ImageExportModal } from './image_export_modal';
import { ConfirmModal } from './inspector_view';
import { rollRegion } from './encounter_roller';
import { HexifyModal } from './hexify_modal';
import { ImportWizard, UNDERLAY_CONFIG } from './import_wizard';
import { UnderlayConfig } from '../importer/underlay';
import { SKETCH_TOOLS, SketchMode } from './sketch_mode';
import { TRACE_CONFIG, initialTrace, readTraceConfig, writeTraceConfig, type TraceImage } from './trace_image';
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
	/** The underlay's opacity. */
	underlayOpacity: number;
}

/** Per MAP, on this device: what is shown (decision 27). */
export interface OverlayState {
	threads: boolean;
	hiddenThreadColors: string[];
	regions: boolean;
	hiddenRegions: string[];
	borders: boolean;
	/** The imported picture under the map (decision 12: hidden on open). */
	underlay: boolean;
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

export const DISPLAY_KEY = 'hexlore-display';
const EDITOR_KEY = 'hexlore-editor';
const DRAG_SLOP = 5; // px before a press becomes a drag
const FOG_HIDE = '#E05555';

export { HOVER_SOURCE } from './open_note';

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

/** Where a space is typed, not a pan: text fields, text areas, editors. */
function isTextEntry(target: EventTarget | null): boolean {
	// By tag name, not `instanceof`: a map in a popout window has its own
	// element classes.
	const t = target as HTMLElement | null;
	if (!t || typeof t.tagName !== 'string') return false;
	if (t.isContentEditable || t.closest('[contenteditable=""], [contenteditable="true"]')) return true;
	if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
	return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes((t as HTMLInputElement).type);
}

export function makeSurface(w: number, h: number): Surface {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
	const c = createEl('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export class MapView extends ItemView {
	/** Page preview's window over the map (Obsidian sets it). */
	hoverPopover: HoverPopover | null = null;
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
	private fullscreen = false;

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
	private readonly wheel = new WheelClassifier();
	private broadcastPending = 0;
	private broadcastAfterStroke = false;
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
	private overlays: OverlayState = { threads: true, hiddenThreadColors: [], regions: true, hiddenRegions: [], borders: true, underlay: false };
	/** The imported picture and its image → scene affine, when the map has one. */
	private underlay: { img: HTMLImageElement; m: [number, number, number, number, number, number]; name: string } | null = null;
	/** Region id → its note, from the index. */
	private regionLinks = new Map<string, string[]>();
	/** The hexes the note being read stands for (an NPC: its place's hexes),
	 *  and the ones a hovered note in the sections list stands for. */
	private noteHighlight: { name: string; ids: Set<string> } | null = null;
	private hoverHighlight: Set<string> | null = null;
	/** The Sketch view: a mode of this view, sharing its camera (item 2.8). */
	sketchMode!: SketchMode;
	private topBar: TopBar | null = null;
	private displayPanel: DisplayPanel | null = null;
	private trace: TraceImage | null = null;
	private traceSaveTimer = 0;
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
			/** Show it if it is hidden (the "Show the map panel when a hex is clicked" setting decides). */
			revealOnClick: () => void;
			/** How notes opened from the map show (a setting). */
			noteOpening: () => NoteOpening;
			/** Live player votes on this map: hex id → count. */
			votes: (file: TFile | null) => Map<string, number>;
			/** "Export as a campaign folder…" (item 2.7). */
			exportFlutter: (file: TFile) => void;
			/** The plugin's folder (the importer's libraries live there). */
			pluginDir: string;
			/** The player view (the top bar's players button). */
			players: PlayerControl;
			playerLan: () => boolean;
			setPlayerLan: (on: boolean) => void;
			templatesFolder: () => string;
			/** "New map" gives the map a folder of its own (a setting). */
			mapFolders: () => boolean;
			/** "Show maps together…": pick the maps, then show them. */
			mapsTogether: () => void;
			/** The Sections list in the left sidebar. */
			showSections: () => void;
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
		this.canvas.onCameraChange = () => {
			this.saveCameraSoon();
			this.sketchMode?.schedule();
		};
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
		this.tool = TOOLS.some((t) => t.id === prefs.tool) ? prefs.tool! : 'select';
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
		this.sketchMode = new SketchMode({
			app: this.app,
			stage: this.stage,
			canvas: this.canvas,
			editor: () => this.editor,
			grid: () => this.editor?.model.meta.grid ?? this.data?.grid ?? null,
			mapScale: () => this.editor?.model.meta.scale ?? MapScale.defaults,
			spaceDown: () => this.spaceDown,
			trace: () => this.trace,
			traceMoved: (t) => this.setTrace(t),
			askLabel: (initial, done) => new LabelPrompt(this.app, initial, done).open(),
			changed: () => {
				this.toolbar.el.toggle(!this.sketchMode.active);
				this.broadcast();
			},
		});

		this.addAction('file-text', 'Open as Markdown', () => {
			if (this.file) this.openAsMarkdown(this.file, this.leaf);
		});
		this.buildTopBar(root);
		this.registerDomEvent(root.doc, 'fullscreenchange', () => {
			if (!root.doc.fullscreenElement) this.setFullscreen(false);
		});
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf && leaf !== this.leaf) this.setFullscreen(false);
			}),
		);

		this.wireInput();
		this.registerEvent(
			this.app.vault.on('rename', (f, old) => {
				// The data folder moved (the registry already moved the store):
				// follow it, so the index's updated `data:` is not a new map.
				if (this.storeDir) {
					const now = this.registry.currentDir(this.storeDir);
					if (now !== this.storeDir) this.storeDir = this.dataDir = now;
				}
				if (old === this.state.file) {
					this.state = { file: f.path };
					this.file = f instanceof TFile ? f : null;
					this.refreshHeader();
					this.app.workspace.requestSaveLayout();
				}
			}),
		);
		// Player votes come and go: redraw their badges.
		this.registerEvent(
			(this.app.workspace as Events).on(PLAYERS_EVENT, () => {
				this.canvas.paintOverlay();
				this.broadcast();
			}),
		);
		// The note being read: highlight the hexes it stands for.
		this.registerEvent(this.app.workspace.on('file-open', (f) => this.followNote(f)));
		this.registerEvent(
			this.app.metadataCache.on('changed', (f) => {
				if (f === this.app.workspace.getActiveFile() && f !== this.file) this.followNote(f);
				if (f !== this.file) return;
				// The index's `data:` may point somewhere else now; else its links changed.
				if (dataFolderOf(this.app, f) !== this.dataDir) void this.loadMap();
				else {
					const before = new Set(this.links.keys());
					void this.readIndex().then(() => this.relinkScene(before));
				}
			}),
		);
		if (this.state.file || this.state.synthetic) await this.loadMap();
		// Also when Obsidian reopens a map from the last session.
		this.app.workspace.onLayoutReady(() => void this.panel.ensure());
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.setFullscreen(false);
		this.displayPanel?.close();
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
		this.sketchMode?.resize();
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
		void this.loadUnderlay();
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

	/** The hexes with notes changed: a hex with notes counts as content, so
	 *  only the hexes whose links came or went are drawn again — not the
	 *  whole map (every tile, the overview and every cache). */
	private relinkScene(before: ReadonlySet<string>): void {
		const scene = this.canvas.getScene();
		const model = this.store?.model;
		if (!scene || !model) return this.rebuildScene();
		const now = new Set(this.links.keys());
		for (const id of new Set([...before, ...now])) {
			if (before.has(id) === now.has(id)) continue;
			const h = model.hexes.get(id);
			if (h) scene.setHex(sceneHexOf(h, now));
		}
		this.canvas.requestFrame();
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
			underlayOpacity: typeof d?.underlayOpacity === 'number' ? Math.min(1, Math.max(0.05, d.underlayOpacity)) : 0.45,
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

	/** What the Display & overlays panel shows (decisions 27, 30). */
	displayState(): DisplayPanelState {
		const m = this.editor?.model;
		const sk = this.sketchMode.prefs;
		return {
			display: this.loadDisplay(),
			overlays: this.overlays,
			threadGroups: m ? threadColorGroups(m.threads.values()) : [],
			regions: m ? [...m.regions.values()].sort((a, b) => a.zOrder - b.zOrder || (a.id < b.id ? -1 : 1)).map((g) => ({ id: g.id, name: g.name, color: g.color })) : [],
			borders: m ? [...m.routes.values()].filter((r) => r.kind === 'border').length : 0,
			underlay: this.underlayName,
			sketchOverlay: sk.overlay,
			sketchOverlayMode: sk.overlayMode,
		};
	}

	// ----- the top bar (decision 30) ------------------------------------------------------

	private buildTopBar(root: HTMLElement): void {
		const players = this.panel.players;
		this.topBar = new TopBar(root, {
			fullscreen: () => this.fullscreen,
			toggleFullscreen: () => this.setFullscreen(!this.fullscreen),
			mapName: () => this.file?.basename.replace(/\.hexmap$/, '') ?? (this.state.synthetic ? 'Synthetic 100×100' : ''),
			hasEditor: () => !!this.editor && !this.editor.readOnly,
			sketching: () => this.sketchMode.active,
			setSketching: (on) => this.toggleSketch(on),
			canUndo: () => (this.sketchMode.active ? !!this.editor?.sketchUndo.canUndo : !!this.editor?.undo.canUndo),
			canRedo: () => (this.sketchMode.active ? !!this.editor?.sketchUndo.canRedo : !!this.editor?.undo.canRedo),
			undoLabel: () => (this.sketchMode.active ? this.editor?.sketchUndo.nextUndoLabel : this.editor?.undo.nextUndoLabel) ?? null,
			redoLabel: () => (this.sketchMode.active ? this.editor?.sketchUndo.nextRedoLabel : this.editor?.undo.nextRedoLabel) ?? null,
			undo: () => (this.sketchMode.active ? this.sketchMode.undo() : this.undoLast()),
			redo: () => (this.sketchMode.active ? this.sketchMode.redo() : this.redoLast()),
			resetView: () => this.canvas.fit(),
			playersRunning: () => players.serves(this.file),
			playersUrl: () => players.url,
			togglePlayers: () => {
				if (!this.file) return;
				if (players.serves(this.file)) void players.stop();
				else void players.start(this.file);
			},
			mapMenu: (e) => this.mapMenu(e),
			quickJump: () => this.quickJump(),
			adventuresMenu: (e) => this.sectionMenu(e, 'Adventures', 'New adventure…'),
			notesMenu: (e) => this.sectionMenu(e, 'GM notes', 'New session document…', true),
			toggleDisplay: (button) => this.displayPanel?.toggle(button),
			playersMenu: (e) => this.playersMenu(e),
			togglePanel: () => {
				// The panel is in the sidebar, under a fullscreen map.
				this.setFullscreen(false);
				void this.panel.toggle();
			},
		});
		root.prepend(this.topBar.el);
		this.displayPanel = new DisplayPanel(root, {
			app: this.app,
			displayState: () => this.displayState(),
			setDisplay: (change) => this.setDisplay(change),
			setOverlays: (change) => this.setOverlays(change),
			showSketchOverlay: (shown, mode) => this.sketchMode.showOverlay(shown, mode),
			removeUnderlay: () => void this.removeUnderlay(),
		});
	}

	/** Fullscreen: the map view leaves its tab and covers the window (and
	 *  the screen, where the platform allows). Obsidian's menus, dialogs and
	 *  hover previews still show above it. Leaving: the button, Esc with
	 *  nothing else to clear, or another tab becoming active (a note opened
	 *  beside the map would be hidden under it). */
	setFullscreen(on: boolean): void {
		if (on === this.fullscreen) return;
		this.fullscreen = on;
		const root = this.contentEl;
		const doc = root.doc;
		if (on) {
			doc.body.appendChild(root);
			root.addClass('is-fullscreen');
			if (!doc.fullscreenElement && doc.fullscreenEnabled) doc.documentElement.requestFullscreen().catch(() => {});
		} else {
			root.removeClass('is-fullscreen');
			this.containerEl.appendChild(root);
			if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
		}
		this.topBar?.refresh();
		this.onResize();
	}

	/** The map menu, labelled with its name (Flutter's campaign menu). */
	private mapMenu(evt: MouseEvent): void {
		const ro = !this.editor || this.editor.readOnly;
		const menu = new Menu();
		const label = (t: string) => menu.addItem((i) => i.setTitle(t).setIsLabel(true));
		if (this.file) label(this.file.basename.replace(/\.hexmap$/, ''));
		menu.addItem((i) => i.setTitle('New map…').setIcon('folder-plus').onClick(() => this.newMap()));
		menu.addItem((i) =>
			i
				.setTitle('Open map…')
				.setIcon('folder-open')
				.onClick(() => new MapPicker(this.app, (f) => isMapIndex(this.app, f), (f) => void this.app.workspace.getLeaf('tab').openFile(f)).open()),
		);
		menu.addItem((i) => i.setTitle('Show maps together…').setIcon('layers').onClick(() => this.panel.mapsTogether()));
		menu.addSeparator();
		label('Map');
		menu.addItem((i) => i.setTitle('Map scale…').setIcon('ruler').setDisabled(ro).onClick(() => this.scaleDialog()));
		menu.addItem((i) => i.setTitle('Resize grid…').setIcon('scaling').setDisabled(ro).onClick(() => this.resizeDialog()));
		menu.addItem((i) => i.setTitle('Explode map…').setIcon('expand').setDisabled(ro).onClick(() => this.explodeDialog()));
		label('Import');
		menu.addItem((i) => i.setTitle('Import map image…').setIcon('image-plus').setDisabled(ro).onClick(() => this.importImage()));
		label('Export');
		menu.addItem((i) => i.setTitle('Export image (PNG / PDF)…').setIcon('image-down').setDisabled(!this.store).onClick(() => this.exportImage()));
		menu.addItem((i) =>
			i
				.setTitle('Export as a campaign folder…')
				.setIcon('folder-output')
				.setDisabled(!this.file || !Platform.isDesktopApp)
				.onClick(() => this.file && void this.panel.exportFlutter(this.file)),
		);
		menu.addSeparator();
		label('Sidebars');
		menu.addItem((i) => i.setTitle('Map panel').setIcon('panel-right').onClick(() => void this.panel.toggle()));
		menu.addItem((i) => i.setTitle('Sections').setIcon('list-tree').onClick(() => this.panel.showSections()));
		menu.addSeparator();
		label('HexLore');
		menu.addItem((i) => i.setTitle('Pen and trackpad diagnostics…').setIcon('pen-tool').onClick(() => new StylusProbeModal(this.app).open()));
		menu.addItem((i) => i.setTitle('Benchmark the renderer').setIcon('gauge').onClick(() => void this.bench()));
		menu.addItem((i) => i.setTitle('About and credits…').setIcon('info').onClick(() => new CreditsModal(this.app).open()));
		menu.showAtMouseEvent(evt);
	}

	private newMap(): void {
		const own = this.panel.mapFolders();
		new NewMapModal(this.app, newMapFolder(this.file, own), own, (f) => void this.app.workspace.getLeaf('tab').openFile(f)).open();
	}

	private scaleDialog(): void {
		const editor = this.editor;
		if (!editor) return;
		new ScaleModal(this.app, editor.model.meta.scale, (s) => editor.setScale(s)).open();
	}

	/** The notes of one section as a menu (Adventures; Session notes), with
	 *  "new" and — for notes — the unassigned characters and quests. */
	private sectionMenu(evt: MouseEvent, sectionName: string, newLabel: string, withUnassigned = false): void {
		const index = this.file;
		if (!index) return;
		const sections = sectionsOf(this.app, index) ?? [...DEFAULT_SECTIONS];
		const section = sections.find((x) => x.name.toLowerCase() === sectionName.toLowerCase());
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(sectionName === 'GM notes' ? 'Session notes' : sectionName).setIsLabel(true));
		const notes = section ? notesInFolder(this.app, section.folder) : [];
		if (sectionName === 'Adventures') {
			const order = (f: TFile) => {
				const o: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.order;
				return typeof o === 'number' ? o : Infinity;
			};
			notes.sort((a, b) => order(a) - order(b) || a.basename.localeCompare(b.basename));
		}
		for (const f of notes) menu.addItem((i) => i.setTitle(f.basename).setIcon('file-text').onClick(() => void this.openBeside(f)));
		if (!notes.length) menu.addItem((i) => i.setTitle(section ? 'None yet' : `No “${sectionName}” section`).setDisabled(true));
		menu.addItem((i) =>
			i
				.setTitle(newLabel)
				.setIcon('plus')
				.setDisabled(!section)
				.onClick(() => section && this.newSectionNote(section, sections)),
		);
		if (withUnassigned) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle('Unassigned characters and quests…').setIcon('user-search').onClick(() => this.unassigned()));
		}
		menu.showAtMouseEvent(evt);
	}

	private newSectionNote(section: Section, sections: Section[]): void {
		const index = this.file;
		if (!index) return;
		new NewNoteModal(this.app, {
			heading: `New note in ${section.name}`,
			title: '',
			sections,
			section: section.name,
			templates: templateFiles(this.app, this.panel.templatesFolder()),
			accept: async (choice) => {
				const file = await createNote(this.app, { ...choice, vars: { title: choice.title, hex: '', map: index.basename.replace(/\.hexmap$/, '') }, location: null });
				await this.openBeside(file);
			},
		}).open();
	}

	/** Open a note without replacing the map: beside it. */
	private async openBeside(f: TFile): Promise<void> {
		await this.app.workspace.getLeaf('split').openFile(f);
	}

	/** Characters and quests on no hex (Flutter's "Unassigned entities…"). */
	private unassigned(): void {
		const byNote = this.hexesByNote();
		const items: Unassigned[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const k = noteKind(this.app, f);
			if ((k === 'npc' || k === 'quest') && !hexesOfNote(this.app, f, byNote).size) items.push({ file: f, kind: k });
		}
		items.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
		const only = this.selection.size === 1 ? cellOfKey([...this.selection][0]!) : null;
		const editor = this.editor;
		new UnassignedModal(
			this.app,
			items,
			only ? displayIdFor(...only) : null,
			(f) => void this.openBeside(f),
			(f) => {
				if (!only || !editor || !this.file) return;
				const id = hexIdFor(...only);
				const link = this.app.metadataCache.fileToLinktext(f, this.file.path, true);
				const cur = editor.hexNotes(id);
				if (!cur.includes(link)) editor.setHexNotes(id, [...cur, link], `Link “${f.basename}”`);
			},
		).open();
	}

	/** Quick jump (Ctrl+K): hexes by name, regions, and the notes on the map. */
	quickJump(): void {
		const m = this.editor?.model;
		if (!m || !this.file) return;
		const entries: JumpTarget[] = [];
		for (const h of m.hexes.values()) if (h.name) entries.push({ label: h.name, kind: 'hex', hexes: new Set([h.id]), file: null });
		for (const g of m.regions.values()) if (g.name) entries.push({ label: g.name, kind: 'region', hexes: new Set(g.cells.map(([q, r]) => hexIdFor(q, r))), file: null });
		const byNote = this.hexesByNote();
		const seen = new Set<string>();
		const addNote = (f: TFile) => {
			if (seen.has(f.path)) return;
			seen.add(f.path);
			const k = noteKind(this.app, f);
			entries.push({ label: f.basename, kind: k === 'note' ? 'note' : k, hexes: hexesOfNote(this.app, f, byNote), file: f });
		};
		for (const p of byNote.keys()) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile) addNote(f);
		}
		for (const f of this.app.vault.getMarkdownFiles()) {
			const k = noteKind(this.app, f);
			if (k === 'npc' || k === 'quest') addNote(f);
		}
		const sections = sectionsOf(this.app, this.file) ?? [...DEFAULT_SECTIONS];
		const adv = sections.find((x) => x.name.toLowerCase() === 'adventures');
		if (adv) for (const f of notesInFolder(this.app, adv.folder)) if (!seen.has(f.path)) entries.push({ label: f.basename, kind: 'adventure', hexes: new Set(), file: f });
		new QuickJumpModal(this.app, entries, (t) => {
			if (t.hexes.size) {
				this.showHexes(t.hexes, t.label);
				if (t.hexes.size === 1) {
					const c = cellOfId([...t.hexes][0]!);
					if (c) this.setSelection([cellKeyOf(c)]);
				}
			} else if (t.file) void this.openBeside(t.file);
		}).open();
	}

	/** The players split button's menu (Flutter's ▾). */
	private playersMenu(evt: MouseEvent): void {
		const players = this.panel.players;
		const file = this.file;
		const serving = players.serves(file);
		const url = players.url;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(serving && url ? `Serving at ${url}` : players.running ? 'Serving another map' : 'Player server stopped').setIsLabel(true));
		if (serving && url) menu.addItem((i) => i.setTitle('Copy player link').setIcon('copy').onClick(() => void navigator.clipboard.writeText(url).then(() => new Notice(`Copied ${url}`))));
		else menu.addItem((i) => i.setTitle('Start the player view').setIcon('cast').setDisabled(!file).onClick(() => file && void players.start(file)));
		if (serving) menu.addItem((i) => i.setTitle('Stop the player view').setIcon('square').onClick(() => void players.stop()));
		const lan = this.panel.playerLan();
		menu.addItem((i) => i.setTitle('Serve on the local network').setChecked(lan).onClick(() => this.panel.setPlayerLan(!lan)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle('Fog of war').setIsLabel(true));
		const ro = !this.editor || this.editor.readOnly;
		menu.addItem((i) =>
			i
				.setTitle('Reveal all hexes to players')
				.setIcon('eye')
				.setDisabled(ro)
				.onClick(() => this.allFog(true, serving)),
		);
		menu.addItem((i) =>
			i
				.setTitle('Hide all hexes from players')
				.setIcon('eye-off')
				.setDisabled(ro)
				.onClick(() => this.allFog(false, serving)),
		);
		menu.showAtMouseEvent(evt);
	}

	/** Reveal or hide every hex: asked first (players see it within a poll
	 *  while served, and a misclick sits next to "Start"); one undo step. */
	private allFog(reveal: boolean, serving: boolean): void {
		const go = () => {
			const n = this.editor?.setAllRevealed(reveal) ?? 0;
			new Notice(`${reveal ? 'Revealed' : 'Hid'} ${n} hex${n === 1 ? '' : 'es'}. Ctrl+Z undoes it.`);
		};
		const what = reveal ? 'Reveal every hex to players?' : 'Hide every hex from players?';
		const why = serving ? ' Players connected now see it within a few seconds.' : '';
		new ConfirmModal(this.app, reveal ? 'Reveal all' : 'Hide all', `${what}${why} Undo (Ctrl+Z) puts it back.`, go, reveal ? 'Reveal all' : 'Hide all').open();
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
		// A stroke changes cells on every pointer move, and the map panel
		// rebuilds itself on every broadcast: it hears once, when it ends.
		const g = this.gesture;
		if (g && (g.kind === 'paint' || g.kind === 'fog' || g.kind === 'region')) {
			this.broadcastAfterStroke = true;
			return;
		}
		if (this.broadcastPending) return;
		this.broadcastPending = this.stage.win.requestAnimationFrame(() => {
			this.broadcastPending = 0;
			this.topBar?.refresh();
			this.displayPanel?.refresh();
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
		this.editor?.endFogStroke();
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
		if (e.kind === 'sketch') {
			this.sketchMode.refreshStrip(); // the colours may have changed
			this.sketchMode.schedule();
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
			case 'links': {
				const before = new Set(this.links.keys());
				this.links = new Map([...this.editor!.links].map(([id, l]) => [id, [...l]]));
				this.relinkScene(before);
				return;
			}
			case 'all': {
				// A remap or a resize: everything may have moved.
				this.rebuildScene();
				this.dropStaleSelection();
				this.sketchMode.schedule();
				return;
			}
		}
		this.canvas.requestFrame();
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
			underlay: o?.underlay === true,
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
			if (this.underlay && this.overlays.underlay && !this.sketchMode.active) {
				// Over the hex fills, translucent (decision 12), as the Flutter canvas.
				const [a, b, c, d, tx, ty] = this.underlay.m;
				const k = f.camera.scale * f.dpr;
				f.c.setTransform(k, 0, 0, k, f.camera.ox * f.dpr, f.camera.oy * f.dpr);
				f.c.transform(a, c, b, d, tx, ty);
				f.c.globalAlpha = this.loadDisplay().underlayOpacity;
				f.c.drawImage(this.underlay.img, 0, 0);
				f.c.globalAlpha = 1;
			}
			if (this.noteHighlight) highlightCells(f, idsToCells(this.noteHighlight.ids), NOTE_GLOW, 0.16, 2.5);
			if (this.hoverHighlight) highlightCells(f, idsToCells(this.hoverHighlight), NOTE_GLOW, 0.32, 3.5);
			if (this.selection.size) {
				// Only what is in view: a select-all outline is the whole map.
				const x0 = -f.camera.ox * k - R, y0 = -f.camera.oy * k - R;
				const x1 = x0 + f.width * k + 2 * R, y1 = y0 + f.height * k + 2 * R;
				const shown: Cell[] = [];
				for (const key of this.selection) {
					const cell = cellOfKey(key);
					const [x, y] = axialToPixel(...cell);
					if (x > x0 && x < x1 && y > y0 && y < y1) shown.push(cell);
				}
				strokeCells(f, shown, SELECT_GLOW, 3);
			}
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

	/** Where [cell]'s centre is on screen, in client pixels. */
	screenPointOf(cell: Cell): { clientX: number; clientY: number } {
		const r = this.stage.getBoundingClientRect();
		const cam = this.canvas.camera;
		const [x, y] = axialToPixel(...cell);
		return { clientX: r.left + x * cam.scale + cam.ox, clientY: r.top + y * cam.scale + cam.oy };
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

	/** Touch pointers down, for two-finger pinch / pan (phones, tablets). */
	private touches = new Map<number, [number, number]>();
	private pinch: { dist: number; cx: number; cy: number } | null = null;

	private pinchState(): { dist: number; cx: number; cy: number } {
		const [a, b] = [...this.touches.values()] as [[number, number], [number, number]];
		return { dist: Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
	}

	/** Two fingers: pinch zooms about their midpoint, moving them pans. It
	 *  takes over from whatever the first finger had started. Registered in
	 *  the CAPTURE phase so the tools never see a pinch. */
	private wirePinch(el: HTMLElement): void {
		this.registerDomEvent(
			el,
			'pointerdown',
			(e) => {
				if (e.pointerType !== 'touch') return;
				this.touches.set(e.pointerId, this.local(e));
				if (this.touches.size < 2) return;
				e.stopImmediatePropagation();
				if (this.touches.size === 2) {
					this.abortGesture();
					this.pinch = this.pinchState();
				}
			},
			{ capture: true },
		);
		this.registerDomEvent(
			el,
			'pointermove',
			(e) => {
				if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
				this.touches.set(e.pointerId, this.local(e));
				if (!this.pinch || this.touches.size < 2) return;
				e.stopImmediatePropagation();
				const next = this.pinchState();
				this.canvas.panBy(next.cx - this.pinch.cx, next.cy - this.pinch.cy);
				this.canvas.zoomAt(next.cx, next.cy, next.dist / this.pinch.dist);
				this.pinch = next;
			},
			{ capture: true },
		);
		const lift = (e: PointerEvent) => {
			if (e.pointerType !== 'touch' || !this.touches.delete(e.pointerId)) return;
			if (this.pinch) {
				// The finger left behind must not become a stroke.
				e.stopImmediatePropagation();
				if (this.touches.size < 2) this.pinch = null;
			}
		};
		this.registerDomEvent(el, 'pointerup', lift, { capture: true });
		this.registerDomEvent(el, 'pointercancel', lift, { capture: true });
	}

	/** Drop the gesture in progress (a pinch took over): a paint stroke so
	 *  far stays one undo step; nothing half-placed is committed. */
	private abortGesture(): void {
		if (this.sketchMode.active) {
			this.sketchMode.abortInput();
			return;
		}
		const g = this.gesture;
		this.gesture = null;
		if (g?.kind === 'paint') this.editor?.endStroke();
		if (g?.kind === 'region') this.editor?.endRegionStroke();
		if (g?.kind === 'fog') this.editor?.endFogStroke();
		this.band = null;
		this.stage.removeClass('is-panning');
		this.canvas.paintOverlay();
		this.strokeEnded();
	}

	/** Tell the map panel what a stroke changed, now that it is over. */
	private strokeEnded(): void {
		if (!this.broadcastAfterStroke || this.gesture) return;
		this.broadcastAfterStroke = false;
		this.broadcast();
	}

	private wireInput(): void {
		const el = this.stage;
		this.wirePinch(el);
		// Raw pointer events, never gesture recognisers: trackpad drags must
		// not be lost (the Flutter canvas learned this the hard way).
		this.registerDomEvent(el, 'pointerdown', (e) => {
			el.focus({ preventScroll: true });
			if (this.sketchMode.active) {
				this.sketchMode.pointerDown(e);
				return;
			}
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
					if (cell && editor) this.strokeTo(cell, null, (cells) => editor.paintFog(cells, reveal));
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
			if (this.sketchMode.active) {
				this.sketchMode.pointerUp(e);
				return;
			}
			const g = this.gesture;
			if (!g || g.id !== e.pointerId) return;
			this.gesture = null;
			el.removeClass('is-panning');
			const up = e.type === 'pointerup';
			switch (g.kind) {
				case 'paint':
					this.editor?.endStroke();
					break;
				case 'fog':
					this.editor?.endFogStroke();
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
			this.strokeEnded();
		};
		this.registerDomEvent(el, 'pointerup', end);
		this.registerDomEvent(el, 'pointercancel', end);

		this.registerDomEvent(el, 'pointermove', (e) => {
			if (this.sketchMode.active) {
				this.sketchMode.pointerMove(e);
				return;
			}
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
							else if (g.kind === 'fog') this.strokeTo(cell, g.last, (cells) => editor.paintFog(cells, g.reveal));
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
			if (this.sketchMode.active) return; // right-drag erases there
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
				// Mouse wheel and pinch zoom; a trackpad's two-finger scroll pans.
				if (this.wheel.classify(e) === 'pan') {
					this.canvas.panBy(-e.deltaX, -e.deltaY);
					return;
				}
				const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
				this.canvas.zoomAt(sx, sy, Math.pow(1.15, (-dy / 100) * (e.ctrlKey ? 3 : 1)));
			},
			{ passive: false },
		);
		// Space held: drag pans with any tool. It counts while the view has
		// focus, or while the pointer is over the map and focus is nowhere in
		// particular — clicking a tool or the top bar takes focus off the map,
		// and space must not stop working until the next click on it (which
		// would run the tool). Never while typing, nor for a control focused
		// elsewhere (a dialog's button). Capture phase: a component that stops
		// the key's propagation must not hide the release from us.
		const win = this.stage.win;
		const doc = this.stage.doc;
		let over = false;
		this.registerDomEvent(el, 'pointerenter', () => (over = true));
		this.registerDomEvent(el, 'pointerleave', () => (over = false));
		const setSpace = (on: boolean) => {
			this.spaceDown = on;
			el.toggleClass('is-space-pan', on);
		};
		this.registerDomEvent(
			win,
			'keydown',
			(e) => {
				if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
				const focus = doc.activeElement;
				const ours = !!focus && this.contentEl.contains(focus);
				if (!ours && !(over && (!focus || focus === doc.body))) return;
				setSpace(true);
				e.preventDefault();
			},
			{ capture: true },
		);
		this.registerDomEvent(
			win,
			'keyup',
			(e) => {
				if (e.key === ' ') setSpace(false);
			},
			{ capture: true },
		);
		this.registerDomEvent(win, 'blur', () => setSpace(false));
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
		// A double-click on a hex opens its principal note; on a hex with none,
		// it offers to create the first.
		if (cell && !additive && last && last.cell === cellKeyOf(cell) && now - last.at < 400) {
			this.openPrincipalNote(cell, e);
			this.lastClick = null;
		}
		if (cell) this.panel.revealOnClick();
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

	// ----- the import underlay (item 2.9) ---------------------------------------------------

	/** The map's underlay: the picture linked as `underlay:`, placed by the
	 *  data folder's import/underlay.json. */
	async loadUnderlay(): Promise<void> {
		this.underlay = null;
		const index = this.file;
		if (!index) return;
		const fm = this.app.metadataCache.getFileCache(index)?.frontmatter;
		const link = typeof fm?.underlay === 'string' ? fm.underlay.replace(/^!?\[\[|\]\]$/g, '').split('|')[0]! : '';
		const file = link ? this.app.metadataCache.getFirstLinkpathDest(link, index.path) : null;
		const path = `${this.dataDir}/${UNDERLAY_CONFIG}`;
		if (!file || !(await this.app.vault.adapter.exists(path))) return;
		let cfg: UnderlayConfig | null = null;
		try {
			cfg = UnderlayConfig.fromJson(JSON.parse(await this.app.vault.adapter.read(path)) as Record<string, unknown>);
		} catch {
			cfg = null;
		}
		if (!cfg) return;
		const img = new Image();
		img.src = this.app.vault.getResourcePath(file);
		await img.decode().catch(() => undefined);
		this.underlay = { img, m: cfg.sceneTransform(), name: file.name };
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** The underlay's picture name, or null when the map has none. */
	get underlayName(): string | null {
		return this.underlay?.name ?? null;
	}

	/** Forget the underlay: the link and its placement go, the picture stays. */
	async removeUnderlay(): Promise<void> {
		if (!this.file) return;
		await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
			delete fm.underlay;
		});
		const path = `${this.dataDir}/${UNDERLAY_CONFIG}`;
		if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
		this.underlay = null;
		this.canvas.paintOverlay();
		this.broadcast();
	}

	/** "Import map image…" (item 2.9). */
	importImage(): void {
		if (!this.editor || this.editor.readOnly || !this.file) {
			new Notice('Importing needs an editable map.');
			return;
		}
		new ImportWizard({
			app: this.app,
			editor: this.editor,
			index: this.file,
			dataDir: this.dataDir,
			pluginDir: this.panel.pluginDir,
			underlayChanged: () => {
				this.setOverlays({ underlay: true });
				window.setTimeout(() => void this.loadUnderlay(), 300);
			},
		}).open();
	}

	// ----- the Sketch view (item 2.8) -----------------------------------------------------

	toggleSketch(on = !this.sketchMode.active): void {
		if (on && !this.editor) {
			new Notice('Sketching needs an editable map.');
			return;
		}
		this.sketchMode.setActive(on);
		this.selectLine(null);
		this.canvas.paintOverlay();
		if (on) void this.loadTrace();
	}

	hexify(): void {
		if (!this.editor || this.editor.readOnly) return;
		new HexifyModal(this.app, this.editor).open();
	}

	clearSketch(): void {
		const editor = this.editor;
		if (!editor || !editor.sketch.items.length) return;
		new ConfirmPrompt(this.app, 'Clear the sketch', `Remove all ${editor.sketch.items.length} drawn items? Ctrl+Z in the Sketch view brings them back.`, 'Clear', () => editor.clearSketch()).open();
	}

	/** The trace image as loaded (null when none). */
	get traceImage(): TraceImage | null {
		return this.trace;
	}

	/** Load the trace image: the picture linked from the index, placed by
	 *  the data folder's trace_image.json. */
	private async loadTrace(): Promise<void> {
		if (!this.file) return;
		const fm = this.app.metadataCache.getFileCache(this.file)?.frontmatter;
		const link = typeof fm?.['trace-image'] === 'string' ? (fm['trace-image']).replace(/^!?\[\[|\]\]$/g, '') : '';
		const file = link ? this.app.metadataCache.getFirstLinkpathDest(link.split('|')[0]!, this.file.path) : null;
		if (!file) {
			this.trace = null;
			this.sketchMode.schedule();
			return;
		}
		const path = `${this.dataDir}/${TRACE_CONFIG}`;
		const text = (await this.app.vault.adapter.exists(path)) ? await this.app.vault.adapter.read(path) : null;
		const img = await loadImage(this.app.vault.getResourcePath(file)).catch(() => null);
		if (!img) {
			new Notice(`The trace image “${file.name}” could not be read.`);
			return;
		}
		const view = this.viewRect();
		const cfg = (text && readTraceConfig(text)) || initialTrace([view[0], view[1], view[0] + view[2], view[1] + view[3]], img.naturalWidth, img.naturalHeight);
		this.trace = { ...cfg, image: img };
		this.sketchMode.schedule();
		this.broadcast();
	}

	/** Pick a picture from the vault to trace over. */
	pickTraceImage(): void {
		const file = this.file;
		if (!file) return;
		new ImagePicker(this.app, async (img) => {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm['trace-image'] = `[[${this.app.metadataCache.fileToLinktext(img, file.path, false)}]]`;
			});
			const path = `${this.dataDir}/${TRACE_CONFIG}`;
			if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path); // a new picture, a new placement
			// The frontmatter cache updates a moment later.
			window.setTimeout(() => void this.loadTrace(), 300);
		}).open();
	}

	/** Change the trace image's placement or look; saved shortly after. */
	setTrace(change: Partial<TraceImage>): void {
		if (!this.trace) return;
		this.trace = { ...this.trace, ...change };
		this.sketchMode.schedule();
		this.broadcast();
		window.clearTimeout(this.traceSaveTimer);
		const path = `${this.dataDir}/${TRACE_CONFIG}`;
		const { image: _image, ...cfg } = this.trace;
		void _image;
		this.traceSaveTimer = window.setTimeout(() => void this.app.vault.adapter.write(path, writeTraceConfig(cfg)), 400);
	}

	/** Stop tracing: the link goes; the picture stays in the vault. */
	async removeTrace(): Promise<void> {
		const file = this.file;
		if (!file) return;
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			delete fm['trace-image'];
		});
		const path = `${this.dataDir}/${TRACE_CONFIG}`;
		if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
		this.trace = null;
		this.sketchMode.schedule();
		this.broadcast();
	}

	private viewRect(): [number, number, number, number] {
		const [w, h] = this.canvas.size;
		const cam = this.canvas.camera;
		return [-cam.ox / cam.scale, -cam.oy / cam.scale, w / cam.scale, h / cam.scale];
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
			format: m.meta.format,
			makeSurface,
		}).open();
	}

	/** Open a hex's principal note (as the "Open notes from the map" setting
	 *  says); a hex with no note: ask to create its first. */
	openPrincipalNote(cell: Cell, at: { clientX: number; clientY: number }): void {
		const id = hexIdFor(...cell);
		const link = this.editor?.hexNotes(id)[0] ?? this.links.get(id)?.[0];
		const index = this.file;
		if (!index) return;
		if (link) {
			this.openNoteAt(link.split('|')[0]!, index.path, at);
			return;
		}
		const editor = this.editor;
		if (!editor || editor.readOnly) {
			new Notice('No notes linked to this hex.');
			return;
		}
		newHexNote(this.app, {
			heading: 'This hex has no note yet: create its first?',
			index,
			cell,
			label: editor.model.hexes.get(id)?.name || displayIdFor(...cell),
			editor,
			templatesFolder: this.panel.templatesFolder(),
			opened: (file) => this.openNoteAt(file.path, '', at),
		});
	}

	/** Open a note from the map: in a floating window over it at the pointer
	 *  ([at]), or beside it (the "Open notes from the map" setting). */
	openNoteAt(linktext: string, sourcePath: string, at: { clientX: number; clientY: number }): void {
		openNote(this.app, this.panel.noteOpening(), linktext, sourcePath, { parent: this, el: this.stage, x: at.clientX, y: at.clientY });
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
				if (this.sketchMode.active) return false; // the hex view's keys
				this.setTool(t.id);
				return false;
			});
		}
		// The Sketch view's letters (decision 19); the hex view has none.
		for (const t of SKETCH_TOOLS) {
			this.scope.register([], t.key, () => {
				if (!this.sketchMode.active) return true;
				this.sketchMode.setPrefs({ tool: t.id });
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
			} else if (this.selection.size) this.setSelection([]);
			else if (this.fullscreen) this.setFullscreen(false);
			this.ruler = null;
			this.canvas.paintOverlay();
			return false;
		});
		this.scope.register([], 'Enter', () => {
			this.finishDraft();
			return false;
		});
		this.scope.register([], 'Backspace', () => {
			// Backspace undoes a draft's last point; with no draft it deletes.
			if (this.tool === 'river' && this.riverDraft.length) this.riverDraft.pop();
			else if (this.tool === 'route' && this.routeDraft.length) this.routeDraft.pop();
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
		// Ctrl+Z goes to whichever view is showing: its own history.
		this.scope.register(['Mod'], 'z', () => {
			if (this.sketchMode.active) this.sketchMode.undo();
			else this.undoLast();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'z', () => {
			if (this.sketchMode.active) this.sketchMode.redo();
			else this.redoLast();
			return false;
		});
		this.scope.register(['Mod'], 'y', () => {
			if (this.sketchMode.active) this.sketchMode.redo();
			else this.redoLast();
			return false;
		});
		this.scope.register(['Mod'], 'k', () => {
			this.quickJump();
			return false;
		});
		this.scope.register(['Mod'], '0', () => {
			this.canvas.fit();
			return false;
		});
		this.scope.register([], 'F2', () => {
			const only = this.selection.size === 1 ? cellOfKey([...this.selection][0]!) : null;
			if (only) this.promptRename(only);
			return false;
		});
		this.scope.register([], '[', () => {
			if (this.sketchMode.active) {
				const w = this.sketchMode.prefs.width;
				this.sketchMode.setPrefs({ width: w - (w > 8 ? 2 : 1) });
			} else this.setBrush(this.brush - 1);
			return false;
		});
		this.scope.register([], ']', () => {
			if (this.sketchMode.active) {
				const w = this.sketchMode.prefs.width;
				this.sketchMode.setPrefs({ width: w + (w >= 8 ? 2 : 1) });
			} else this.setBrush(this.brush + 1);
			return false;
		});
	}

	/** Del: the held point, else the selected thread. */
	/** Delete / Backspace: the held point of the selected line, else the
	 *  selected line, thread or hexes (undoable, all of them). */
	private deleteKey(): boolean {
		const editor = this.editor;
		if (!editor) return false;
		const line = this.selectedLine;
		if (line) {
			if (this.heldPoint !== null && editor.removeLinePoint(line.kind, line.id, this.heldPoint)) this.heldPoint = null;
			else {
				if (this.heldPoint === null) editor.removeLine(line.kind, line.id);
				this.selectLine(null);
			}
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
		// Rolling for where the party is: each region here with a note.
		const index = this.file;
		const rollable = index ? editor.regionsContaining(cells).filter((g) => this.regionLinks.get(g.id)?.[0]) : [];
		if (index && rollable.length) menu.addSeparator();
		for (const g of rollable) {
			const region = { id: g.id, name: g.name || 'Untitled', link: this.regionLinks.get(g.id)![0]! };
			menu.addItem((i) =>
				i
					.setTitle(`Roll encounter: ${region.name}`)
					.setIcon('dices')
					.onClick(() => void rollRegion(this.app, index!, region).then((r) => r && this.broadcast())),
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
		const river = line.kind === 'river' ? editor.model.rivers.get(line.id) : undefined;
		if (river) {
			// Width (Flutter's river menu "Width…"): presets, or exact.
			menu.addItem((i) => i.setTitle('Width').setIsLabel(true));
			for (const [label, w] of RIVER_WIDTH_PRESETS) {
				menu.addItem((i) =>
					i
						.setTitle(label)
						.setChecked(river.width === w)
						.setDisabled(ro)
						.onClick(() => {
							editor.setRiverWidth(line.id, w);
							editor.undo.breakMerge(); // each pick its own undo step
						}),
				);
			}
			menu.addItem((i) =>
				i
					.setTitle(`Exact width… (${river.width.toFixed(2)})`)
					.setIcon('ruler')
					.setDisabled(ro)
					.onClick(() => new RiverWidthModal(this.app, () => editor.model.rivers.get(line.id)?.width ?? null, (w) => editor.setRiverWidth(line.id, w), () => editor.undo.breakMerge()).open()),
			);
			menu.addSeparator();
		}
		menu.addItem((i) =>
			i
				.setTitle('Delete point here')
				.setIcon('circle-minus')
				.setDisabled(ro || point < 0)
				.onClick(() => {
					if (!editor.removeLinePoint(line.kind, line.id, point)) this.selectLine(null);
				}),
		);
		if (!river) menu.addItem((i) => i.setTitle('Edit in the map panel').setIcon('panel-right').onClick(() => void this.panel.toggle()));
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

/** An image element for a vault resource URL. */
function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('unreadable image'));
		img.src = src;
	});
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);

/** Pick an image in the vault. */
class ImagePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly accept: (file: TFile) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder('An image to trace over (a scanned map, a screenshot)');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		void this.accept(file);
	}
}

/** A label's text (empty: remove it). */
class LabelPrompt extends Modal {
	constructor(
		app: App,
		private readonly initial: string,
		private readonly done: (text: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.initial ? 'Edit label' : 'New label');
		let value = this.initial;
		let answered = false;
		const finish = () => {
			answered = true;
			this.close();
			this.done(value);
		};
		new Setting(this.contentEl).setName('Text').setDesc(this.initial ? 'Empty removes the label.' : '').addText((t) => {
			t.setValue(value).onChange((v) => (value = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					finish();
				}
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Done').setCta().onClick(finish));
		this.onClose = () => {
			this.contentEl.empty();
			if (!answered) this.done(null);
		};
	}
}
