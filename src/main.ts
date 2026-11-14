import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, type TAbstractFile, type ViewState } from 'obsidian';
import { exportToFlutter } from './convert/export_command';
import { fileMenu, ribbonMenu, type MenuActions } from './plugin_menus';
import { PlayerControl } from './server/control';
import { HexLoreSettingTab, readSettings, type HexLoreSettings } from './settings';
import { afterFolderRename, afterIndexRename, type DataLinkFix } from './storage/data_link';
import { readSections, sectionsAfterRename, sectionsFrontmatter } from './storage/hexmap_index';
import { sectionsOf } from './storage/index_file';
import { StoreRegistry } from './storage/store_registry';
import { renamePaths, type AtlasLayout } from './view/atlas_layout';
import { ATLAS_VIEW, AtlasPickerModal, AtlasView } from './view/atlas_view';
import { INSPECTOR_VIEW, InspectorView } from './view/inspector_view';
import { around } from './patch';
import { noteRenames } from './view/vault_notes';
import { MapPicker, NewMapModal, newMapFolder } from './view/map_menus';
import { HOVER_SOURCE, MAP_VIEW, MapView, isMapIndex } from './view/map_view';
import { SECTIONS_VIEW, SectionsView } from './view/sections_view';

export default class HexLorePlugin extends Plugin {
	settings!: HexLoreSettings;

	/** Index notes the GM chose to read as Markdown this session. */
	private asMarkdown = new Set<string>();

	private stores!: StoreRegistry;
	private sectionRenames: Promise<void> = Promise.resolve();
	players!: PlayerControl;

	async onload() {
		this.settings = readSettings(await this.loadData());
		this.addSettingTab(new HexLoreSettingTab(this.app, this));
		this.stores = new StoreRegistry(this);
		this.players = new PlayerControl(this.app, this.stores, () => this.settings, () => this.saveSettings());
		this.players.attachStatusBar(this.addStatusBarItem());
		this.registerView(MAP_VIEW, (leaf) => new MapView(leaf, (file, l) => this.openMarkdown(file, l), this.stores, {
				ensure: () => this.showPanel(false),
				toggle: () => this.togglePanel(),
				revealOnClick: () => {
					if (this.settings.revealPanel && !this.panelShowing()) void this.showPanel(true);
				},
				noteOpening: () => this.settings.noteOpening,
				votes: (file) => this.players.voteCounts(file),
				exportFlutter: (file) => void exportToFlutter(this.app, this.stores, file),
				pluginDir: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
				players: this.players,
				playerLan: () => this.settings.playerLan,
				setPlayerLan: (on) => {
					this.settings.playerLan = on;
					if (on) new Notice('Devices on the same network can now open the player view. On Windows, allow Obsidian through the firewall when asked (private networks).', 8000);
					void this.players.lanChanged();
				},
				templatesFolder: () => this.settings.templatesFolder,
				mapFolders: () => this.settings.mapFolders,
				mapsTogether: () => this.pickMapsTogether(),
				showSections: () => void this.showSections(true),
			}));
		this.registerView(ATLAS_VIEW, (leaf) => new AtlasView(leaf, {
				layout: () => this.atlasLayout(),
				setLayout: (l) => this.setAtlasLayout(l),
				stores: this.stores,
				pick: () => this.pickMapsTogether(false),
			}));
		this.registerView(INSPECTOR_VIEW, (leaf) => new InspectorView(leaf, () => this.settings, this.players));
		this.registerView(SECTIONS_VIEW, (leaf) => new SectionsView(leaf, () => this.settings));
		// Ctrl-hover on a hex previews its principal note (Page preview).
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'Hex maps', defaultMod: true });

		// Everything is in a menu: the ribbon icon, the Map menu, and right-clicking
		// a map file or a note (`plugin_menus.ts`). Three commands stay, for hotkeys.
		this.addCommand({
			id: 'new-map',
			name: 'Create a new map…',
			callback: () => this.newMap(),
		});
		this.addCommand({
			id: 'show-note-on-map',
			name: 'Show this note on the map',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md' || isMapIndex(this.app, file)) return false;
				if (!checking) this.showNoteOnMap(file);
				return true;
			},
		});
		this.addRibbonIcon('hexagon', 'HexLore', (evt) => ribbonMenu(this.menuActions()).showAtMouseEvent(evt));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile) fileMenu(menu, file, this.menuActions());
			}),
		);

		// Renaming the data folder, or the index, must not cut the link between
		// them: `data:` is a plain relative path Obsidian does not update.
		this.registerEvent(this.app.vault.on('rename', (f, old) => void this.followDataRename(f, old)));
		// Section folders and templates are vault paths: they follow too.
		this.registerEvent(this.app.vault.on('rename', (f, old) => {
			// One at a time: a folder rename fires an event per file inside, and two
			// overlapping frontmatter writes would undo each other.
			this.sectionRenames = this.sectionRenames.then(() => this.followSectionRename(old, f.path));
		}));
		// An undo can bring back a link to a note renamed since: it follows.
		this.registerEvent(this.app.vault.on('rename', (f, old) => noteRenames.record(old, f.path)));
		// "Show maps together" keeps its maps by index path: it follows them.
		this.registerEvent(
			this.app.vault.on('rename', (f, old) => {
				const next = renamePaths(this.settings.atlas, old, f.path);
				if (next !== this.settings.atlas) this.setAtlasLayout(next);
			}),
		);

		// A `.hexmap.md` index opens as its map (the Excalidraw pattern): any
		// leaf about to show one as Markdown (file explorer, link, quick
		// switcher, a restored workspace) shows the map instead...
		this.patchSetViewState();
		// ...and a Markdown view that lands on one anyway is switched.
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (!isMapIndex(this.app, file) || this.asMarkdown.has(file.path)) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file === file) void this.openMap(file, view.leaf);
			}),
		);

		this.addCommand({
			id: 'open-as-map',
			name: 'Open this note as a map',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!isMapIndex(this.app, file)) return false;
				if (!checking) {
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					void this.openMap(file, view?.leaf ?? this.app.workspace.getLeaf(false));
				}
				return true;
			},
		});
		this.addCommand({
			id: 'open-synthetic',
			name: 'Open the synthetic 100×100 test map',
			callback: () =>
				void this.app.workspace.getLeaf('tab').setViewState({ type: MAP_VIEW, active: true, state: { synthetic: true } }),
		});
	}

	/** Turn "show this index as Markdown" into "show its map", unless the GM
	 *  asked for Markdown ("Open as Markdown"). Undone on unload. */
	private patchSetViewState(): void {
		const redirect = (state: ViewState): ViewState => {
			const path = state.type === 'markdown' ? state.state?.file : undefined;
			if (typeof path !== 'string' || this.asMarkdown.has(path)) return state;
			const file = this.app.vault.getAbstractFileByPath(path);
			return file instanceof TFile && isMapIndex(this.app, file) ? { ...state, type: MAP_VIEW, state: { file: path } } : state;
		};
		// Through `around`: another plugin may wrap setViewState after us
		// (Excalidraw, Kanban…), and unloading must not remove its wrapper.
		this.register(
			around(WorkspaceLeaf.prototype, 'setViewState', (next) =>
				function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
					return next.call(this, redirect(state), eState);
				},
			),
		);
	}

	private newMap(): void {
		const own = this.settings.mapFolders;
		const folder = newMapFolder(this.app.workspace.getActiveFile(), own);
		new NewMapModal(this.app, folder, own, (f) => void this.app.workspace.getLeaf('tab').openFile(f)).open();
	}

	/** What the ribbon and file menus ask of the plugin. */
	private menuActions(): MenuActions {
		const ws = this.app.workspace;
		const mapViews = () => ws.getLeavesOfType(MAP_VIEW).flatMap((l) => (l.view instanceof MapView ? [l.view] : []));
		return {
			isMap: (f) => isMapIndex(this.app, f),
			openMap: (f) => void this.openMap(f, ws.getLeaf('tab')),
			openMarkdown: (f) => this.openMarkdown(f, ws.getLeaf('tab')),
			newMap: () => this.newMap(),
			pickMap: () => new MapPicker(this.app, (f) => isMapIndex(this.app, f), (f) => void ws.getLeaf('tab').openFile(f)).open(),
			mapsTogether: () => this.pickMapsTogether(),
			showPanel: () => void this.showPanel(true),
			showSections: () => void this.showSections(true),
			serves: (f) => this.players.serves(f),
			startPlayers: (f) => void this.players.start(f),
			stopPlayers: () => void this.players.stop(),
			copyPlayerLink: () => {
				const url = this.players.url;
				if (url) void navigator.clipboard.writeText(url).then(() => new Notice(`Copied ${url}`));
			},
			exportCampaign: (f) => void exportToFlutter(this.app, this.stores, f),
			isOnOpenMap: (f) => mapViews().some((v) => v.hexesOf(f).size > 0),
			showOnMap: (f) => this.showNoteOnMap(f),
		};
	}

	onunload() {
		void this.players.stop(false);
		// Unsaved edits are written before the plugin goes (best effort:
		// Obsidian does not wait for this).
		void this.stores.flushAll();
	}

	/** Keep every index's `data:` pointing at its data folder across a
	 *  rename of either (`storage/data_link.ts`). */
	private async followDataRename(f: TAbstractFile, old: string): Promise<void> {
		const dataOf = (idx: TFile): string | undefined => {
			const d: unknown = this.app.metadataCache.getFileCache(idx)?.frontmatter?.data;
			return typeof d === 'string' && d ? d : undefined;
		};
		const fixes: [TFile, DataLinkFix][] = [];
		if (f instanceof TFolder) {
			for (const idx of this.app.vault.getMarkdownFiles()) {
				if (isMapIndex(this.app, idx)) fixes.push([idx, afterFolderRename(idx.path, dataOf(idx), old, f.path)]);
			}
		} else if (f instanceof TFile && isMapIndex(this.app, f)) {
			const isFolder = (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof TFolder;
			fixes.push([f, afterIndexRename(old, f.path, dataOf(f), isFolder)]);
		}
		for (const [idx, fix] of fixes) {
			if (!fix) continue;
			if ('problem' in fix) new Notice(fix.problem, 15000);
			else await this.app.fileManager.processFrontMatter(idx, (fm: Record<string, unknown>) => (fm.data = fix.data));
		}
	}

	/** Every map whose sections name [from] (or a path under it) now names
	 *  [to]. A folder rename fires one event per file inside it before the
	 *  metadata cache has caught up, so the cache only picks the maps; the
	 *  new list is worked out from the frontmatter as it is when written. */
	private async followSectionRename(from: string, to: string): Promise<void> {
		for (const idx of this.app.vault.getMarkdownFiles()) {
			if (!isMapIndex(this.app, idx)) continue;
			const cached = sectionsOf(this.app, idx);
			if (!cached || !sectionsAfterRename(cached, from, to)) continue;
			try {
				await this.app.fileManager.processFrontMatter(idx, (fm: Record<string, unknown>) => {
					const now = readSections(fm);
					const next = now && sectionsAfterRename(now, from, to);
					if (next) fm.sections = sectionsFrontmatter(next);
				});
			} catch (e) {
				console.error('HexLore: could not update the sections of', idx.path, e);
			}
		}
	}

	/** A copy of the "Show maps together" layout, to change and hand back. */
	private atlasLayout(): AtlasLayout {
		const l = this.settings.atlas;
		return { shown: [...l.shown], maps: Object.fromEntries(Object.entries(l.maps).map(([p, v]) => [p, { ...v }])) };
	}

	private setAtlasLayout(l: AtlasLayout): void {
		this.settings.atlas = l;
		void this.saveSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(ATLAS_VIEW)) if (leaf.view instanceof AtlasView) void leaf.view.sync();
	}

	/** Choose the maps shown together; [open]: then show them (from a view
	 *  already showing them, the choice is enough). */
	private pickMapsTogether(open = true): void {
		new AtlasPickerModal(this.app, () => this.atlasLayout(), (l) => this.setAtlasLayout(l), () => {
			if (open) void this.showMapsTogether();
		}).open();
	}

	private async showMapsTogether(): Promise<void> {
		const ws = this.app.workspace;
		const leaf = ws.getLeavesOfType(ATLAS_VIEW)[0] ?? ws.getLeaf('tab');
		if (leaf.getViewState().type !== ATLAS_VIEW) await leaf.setViewState({ type: ATLAS_VIEW, active: true });
		await ws.revealLeaf(leaf);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Centre the first open map that has hexes for [file] on them. */
	private showNoteOnMap(file: TFile): void {
		for (const leaf of this.app.workspace.getLeavesOfType(MAP_VIEW)) {
			if (!(leaf.view instanceof MapView)) continue;
			const ids = leaf.view.hexesOf(file);
			if (!ids.size) continue;
			void this.app.workspace.revealLeaf(leaf);
			leaf.view.showHexes(ids, file.basename);
			return;
		}
		new Notice(`“${file.basename}” is on no hex of an open map (directly, or through its location).`);
	}

	private async openMap(file: TFile, leaf: WorkspaceLeaf) {
		this.asMarkdown.delete(file.path);
		await leaf.setViewState({ type: MAP_VIEW, active: true, state: { file: file.path } });
	}

	/** The top bar's button: hide the panel when it is showing, else show it. */
	async togglePanel(): Promise<void> {
		const ws = this.app.workspace;
		if (this.panelShowing()) {
			ws.rightSplit.collapse();
			return;
		}
		await this.showPanel(true);
	}

	/** The panel's sidebar is open and it is the visible tab there. */
	private panelShowing(): boolean {
		const leaf = this.app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0];
		return !!leaf && !this.app.workspace.rightSplit.collapsed && leaf.view.containerEl.isShown();
	}

	/** The panel lives in the right sidebar; [reveal] brings it to the front. */
	async showPanel(reveal: boolean): Promise<void> {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(INSPECTOR_VIEW)[0];
		if (!leaf) {
			const right = ws.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: INSPECTOR_VIEW, active: false });
			leaf = right;
		}
		if (reveal) await ws.revealLeaf(leaf);
	}

	/** The sections live in the left sidebar. */
	async showSections(reveal: boolean): Promise<void> {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(SECTIONS_VIEW)[0];
		if (!leaf) {
			const left = ws.getLeftLeaf(false);
			if (!left) return;
			await left.setViewState({ type: SECTIONS_VIEW, active: false });
			leaf = left;
		}
		if (reveal) await ws.revealLeaf(leaf);
	}

	private openMarkdown(file: TFile, leaf: WorkspaceLeaf) {
		this.asMarkdown.add(file.path);
		void leaf.setViewState({ type: 'markdown', active: true, state: { file: file.path, mode: 'source' } });
	}
}
