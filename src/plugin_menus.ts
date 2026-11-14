// What the plugin adds to Obsidian's own menus: right-clicking a map file or
// a note (file explorer, tab, link) and the ribbon icon. A map's own actions
// live in its Map menu (view/map_view.ts); these are the ways in from outside
// a map, so nothing needs the command palette to be found.

import { Menu, Platform, type TFile } from 'obsidian';

/** What the menus ask of the plugin. */
export interface MenuActions {
	isMap(file: TFile): boolean;
	openMap(file: TFile): void;
	openMarkdown(file: TFile): void;
	newMap(): void;
	pickMap(): void;
	mapsTogether(): void;
	showPanel(): void;
	showSections(): void;
	/** Is [file]'s map the one served to players? */
	serves(file: TFile): boolean;
	startPlayers(file: TFile): void;
	stopPlayers(): void;
	copyPlayerLink(): void;
	exportCampaign(file: TFile): void;
	/** Is [note] on a hex of an open map? */
	isOnOpenMap(note: TFile): boolean;
	showOnMap(note: TFile): void;
}

const SECTION = 'hexlore';

/** The entries for [file] in a file menu (explorer, tab header, link). */
export function fileMenu(menu: Menu, file: TFile, a: MenuActions): void {
	if (a.isMap(file)) {
		const item = (title: string, icon: string, run: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).setSection(SECTION).onClick(run));
		item('Open as map', 'hexagon', () => a.openMap(file));
		item('Open as Markdown', 'file-text', () => a.openMarkdown(file));
		// Phones and tablets cannot run the server: no entry rather than one that apologises.
		if (Platform.isDesktopApp && a.serves(file)) {
			item('Copy the player link', 'copy', () => a.copyPlayerLink());
			item('Stop the player view', 'square', () => a.stopPlayers());
		} else if (Platform.isDesktopApp) {
			item('Start the player view', 'cast', () => a.startPlayers(file));
		}
		if (Platform.isDesktopApp) item('Export as a campaign folder…', 'folder-output', () => a.exportCampaign(file));
		item('Show maps together…', 'layers', () => a.mapsTogether());
	} else if (a.isOnOpenMap(file)) {
		menu.addItem((i) => i.setTitle('Show on the map').setIcon('hexagon').setSection(SECTION).onClick(() => a.showOnMap(file)));
	}
}

/** The ribbon icon's menu: a way in for a vault with no map yet, and the sidebars. */
export function ribbonMenu(a: MenuActions): Menu {
	const menu = new Menu();
	menu.addItem((i) => i.setTitle('New map…').setIcon('folder-plus').onClick(() => a.newMap()));
	menu.addItem((i) => i.setTitle('Open map…').setIcon('folder-open').onClick(() => a.pickMap()));
	menu.addItem((i) => i.setTitle('Show maps together…').setIcon('layers').onClick(() => a.mapsTogether()));
	menu.addSeparator();
	menu.addItem((i) => i.setTitle('Map panel').setIcon('panel-right').onClick(() => a.showPanel()));
	menu.addItem((i) => i.setTitle('Sections').setIcon('list-tree').onClick(() => a.showSections()));
	return menu;
}
