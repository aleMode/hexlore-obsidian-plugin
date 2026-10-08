import { MarkdownView, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
import { StoreRegistry } from './storage/store_registry';
import { INSPECTOR_VIEW, InspectorView } from './view/inspector_view';
import { HOVER_SOURCE, MAP_VIEW, MapView, isMapIndex } from './view/map_view';

export default class HexLorePlugin extends Plugin {
	/** Index notes the GM chose to read as Markdown this session. */
	private asMarkdown = new Set<string>();

	private stores!: StoreRegistry;

	async onload() {
		this.stores = new StoreRegistry(this);
		this.registerView(MAP_VIEW, (leaf) => new MapView(leaf, (file, l) => this.openMarkdown(file, l), this.stores, {
				ensure: () => this.showPanel(false),
				toggle: () => this.togglePanel(),
			}));
		this.registerView(INSPECTOR_VIEW, (leaf) => new InspectorView(leaf));
		// Ctrl-hover on a hex previews its principal note (Page preview).
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'Hex maps', defaultMod: true });

		this.addCommand({
			id: 'show-panel',
			name: 'Show the side panel',
			callback: () => void this.showPanel(true),
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

	onunload() {
		// Unsaved edits are written before the plugin goes (best effort:
		// Obsidian does not wait for this).
		void this.stores.flushAll();
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

	private openMarkdown(file: TFile, leaf: WorkspaceLeaf) {
		this.asMarkdown.add(file.path);
		void leaf.setViewState({ type: 'markdown', active: true, state: { file: file.path, mode: 'source' } });
	}
}
