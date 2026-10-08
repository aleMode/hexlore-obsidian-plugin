import { MarkdownView, Notice, Plugin, TFile, type SettingDefinitionItem, type WorkspaceLeaf } from 'obsidian';
import { PlayerControl } from './server/control';
import { HexLoreSettingTab, readSettings, type HexLoreSettings, type SettingsHost } from './settings';
import { StoreRegistry } from './storage/store_registry';
import { INSPECTOR_VIEW, InspectorView } from './view/inspector_view';
import { HOVER_SOURCE, MAP_VIEW, MapView, isMapIndex } from './view/map_view';
import { SECTIONS_VIEW, SectionsView } from './view/sections_view';

export default class HexLorePlugin extends Plugin implements SettingsHost {
	settings!: HexLoreSettings;
	settingGroups: (() => SettingDefinitionItem[])[] = [];

	/** Index notes the GM chose to read as Markdown this session. */
	private asMarkdown = new Set<string>();

	private stores!: StoreRegistry;
	players!: PlayerControl;

	async onload() {
		this.settings = readSettings(await this.loadData());
		this.addSettingTab(new HexLoreSettingTab(this.app, this));
		this.stores = new StoreRegistry(this);
		this.players = new PlayerControl(this.app, this.stores, () => this.settings, () => this.saveSettings());
		this.settingGroups.push(() => this.players.settingGroup());
		this.players.attachStatusBar(this.addStatusBarItem());
		this.registerView(MAP_VIEW, (leaf) => new MapView(leaf, (file, l) => this.openMarkdown(file, l), this.stores, {
				ensure: () => this.showPanel(false),
				toggle: () => this.togglePanel(),
				sections: () => this.toggleSections(),
				votes: (file) => this.players.voteCounts(file),
			}));
		this.registerView(INSPECTOR_VIEW, (leaf) => new InspectorView(leaf, () => this.settings, this.players));
		this.registerView(SECTIONS_VIEW, (leaf) => new SectionsView(leaf, () => this.settings));
		// Ctrl-hover on a hex previews its principal note (Page preview).
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'Hex maps', defaultMod: true });

		this.addCommand({
			id: 'show-panel',
			name: 'Show the side panel',
			callback: () => void this.showPanel(true),
		});
		this.addCommand({
			id: 'show-sections',
			name: 'Show the map sections',
			callback: () => void this.showSections(true),
		});
		this.addCommand({
			id: 'start-player-view',
			name: 'Start the player view for this map',
			checkCallback: (checking) => {
				const file = this.activeMapFile();
				if (!file) return false;
				if (!checking) void this.players.start(file);
				return true;
			},
		});
		this.addCommand({
			id: 'stop-player-view',
			name: 'Stop the player view',
			checkCallback: (checking) => {
				if (!this.players.running) return false;
				if (!checking) void this.players.stop();
				return true;
			},
		});
		this.addCommand({
			id: 'copy-player-link',
			name: 'Copy the player view link',
			checkCallback: (checking) => {
				const url = this.players.url;
				if (!url) return false;
				if (!checking) void navigator.clipboard.writeText(url).then(() => new Notice(`Copied ${url}`));
				return true;
			},
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

		// A `.hexmap.md` index opens as its map (the Excalidraw pattern): when
		// a Markdown view lands on one, switch that leaf to the map view.
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

	settingChanged(key: string): void {
		if (key === 'playerLan') void this.players.lanChanged();
	}

	/** The map of the active view (a map view, or its index open as Markdown). */
	private activeMapFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MapView);
		if (view) return view.mapState().file;
		const file = this.app.workspace.getActiveFile();
		return isMapIndex(this.app, file) ? file : null;
	}

	onunload() {
		void this.players.stop(false);
		// Unsaved edits are written before the plugin goes (best effort:
		// Obsidian does not wait for this).
		void this.stores.flushAll();
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

	/** The panel lives in the right sidebar; [reveal] brings it to the front. */
	/** The header button: hide the panel when it is showing, else show it. */
	async togglePanel(): Promise<void> {
		const ws = this.app.workspace;
		const leaf = ws.getLeavesOfType(INSPECTOR_VIEW)[0];
		const right = ws.rightSplit;
		// Showing = its sidebar is open and it is the visible tab there.
		if (leaf && !right.collapsed && leaf.view.containerEl.isShown()) {
			right.collapse();
			return;
		}
		await this.showPanel(true);
	}

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
	async toggleSections(): Promise<void> {
		const ws = this.app.workspace;
		const leaf = ws.getLeavesOfType(SECTIONS_VIEW)[0];
		if (leaf && !ws.leftSplit.collapsed && leaf.view.containerEl.isShown()) {
			ws.leftSplit.collapse();
			return;
		}
		await this.showSections(true);
	}

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
