// @vitest-environment jsdom
//
// Smoke tests of the plugin's views, run against a stand-in for Obsidian
// (test/mocks/). They catch crashes and broken wiring in the views — what
// unit tests of the pure modules cannot — on the converter fixture's vault.

import './mocks/dom';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
// The mock itself (the same module the plugin gets as 'obsidian'), for its
// test helpers.
import { App, Menu, Modal, Notice, Setting, TFile, useApp, type ToggleComponent, type WorkspaceLeaf } from './mocks/obsidian';
import HexLorePlugin from '../src/main';
import { MAP_VIEW, MapView } from '../src/view/map_view';
import { INSPECTOR_VIEW, InspectorView } from '../src/view/inspector_view';
import { SECTIONS_VIEW, SectionsView } from '../src/view/sections_view';
import { ATLAS_VIEW, type AtlasView } from '../src/view/atlas_view';
import { createMap } from '../src/view/map_menus';
import { readTree } from './helpers/vault_folder';
import { paintMap, stampIcon } from './helpers/importer_synth';
import { SourceGrid } from '../src/importer/grid_calibration';
import { ImportSession } from '../src/importer/import_session';
import { hexIdFor } from '../src/core/hex_data';
import { displayIdFor } from '../src/core/hex';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

let app: App;
let plugin: HexLorePlugin;
let map: MapView;
let mapLeaf: WorkspaceLeaf;

async function openLeaf(type: string, state?: unknown): Promise<WorkspaceLeaf> {
	const leaf = app.workspace.getLeaf();
	await leaf.setViewState({ type, state });
	app.workspace.activeLeaf = leaf;
	return leaf;
}

beforeAll(async () => {
	const files: Record<string, string> = {};
	for (const [p, t] of readTree('vendor/converter/flutter_to_plugin/expected')) files[`Campaign/${p}`] = t;
	// The fixture's links and sections are vault-root relative to its own folder.
	for (const k of Object.keys(files)) if (k.endsWith('.md')) files[k] = files[k]!.replace(/\[\[(Places|NPCs|Regions|GM notes|Quests|Adventures|Factions|Unsorted)\//g, '[[Campaign/$1/').replace(/"folder": "/g, '"folder": "Campaign/');
	app = new App(files);
	useApp(app);
	plugin = new HexLorePlugin(app as never, { id: 'hexlore', dir: `${app.vault.configDir}/plugins/hexlore` } as never);
	await plugin.onload();
	mapLeaf = await openLeaf(MAP_VIEW, { file: 'Campaign/Fixture.hexmap.md' });
	map = mapLeaf.view as unknown as MapView;
	await tick(20);
});

describe('the map view', () => {
	it('opens the map with its notes', () => {
		const state = map.mapState();
		expect(state.file?.path).toBe('Campaign/Fixture.hexmap.md');
		expect(state.editor).not.toBeNull();
		expect(state.links.get('q0_r0')?.[0]).toContain('Base Culto');
		expect(Notice.log.filter((n) => /error|could not/i.test(n))).toEqual([]);
	});

	it('the tab header adds only "Open as Markdown"; the rest is in the top bar', () => {
		const view = map as unknown as { actions: { title: string }[] };
		expect(view.actions.map((a) => a.title)).toEqual(['Open as Markdown']);
		const menu = new Menu();
		map.onPaneMenu(menu as never, 'more-options');
		expect(menu.items).toEqual([]);
	});

	it('space pans with focus off the map, but not while typing or on a control elsewhere', () => {
		const stage = map.contentEl.querySelector<HTMLElement>('.hexlore-map-stage')!;
		const key = (type: string, target: HTMLElement = document.body) => target.dispatchEvent(new KeyboardEvent(type, { key: ' ', bubbles: true, cancelable: true }));
		const panning = () => stage.classList.contains('is-space-pan');
		(document.activeElement as HTMLElement | null)?.blur();
		// Pointer over the map, focus nowhere (a tool button was clicked).
		stage.dispatchEvent(new Event('pointerenter'));
		key('keydown');
		expect(panning()).toBe(true);
		key('keyup');
		expect(panning()).toBe(false);
		// Typing a space in a text field elsewhere stays typing.
		const field = document.body.createEl('textarea');
		field.focus();
		key('keydown', field);
		expect(panning()).toBe(false);
		field.remove();
		// A dialog's button keeps its space.
		const button = document.body.createEl('button');
		button.focus();
		key('keydown', button);
		expect(panning()).toBe(false);
		button.remove();
		// The map focused, pointer away: still the map's.
		stage.dispatchEvent(new Event('pointerleave'));
		stage.focus();
		key('keydown', stage);
		expect(panning()).toBe(true);
		window.dispatchEvent(new Event('blur'));
		expect(panning()).toBe(false);
	});

	it('a note being read highlights its hexes', async () => {
		const npc = app.vault.getAbstractFileByPath('Campaign/NPCs/Hermit.md');
		expect(npc).toBeInstanceOf(TFile);
		app.workspace.trigger('file-open', npc);
		await tick();
		expect(map.highlightedNote?.ids.has('q0_r0')).toBe(true);
	});
});

describe('the side views', () => {
	it('the map panel renders a hex, its notes, people, and the travel votes', async () => {
		const leaf = await openLeaf(INSPECTOR_VIEW);
		const panel = leaf.view as unknown as InspectorView;
		app.workspace.activeLeaf = mapLeaf;
		app.workspace.trigger('active-leaf-change', mapLeaf);
		(map as unknown as { setSelection(c: string[]): void }).setSelection(['0,0']);
		await tick(20);
		const text = panel.contentEl.textContent ?? '';
		expect(text).toContain('Notes');
		expect(text).toContain('Base Culto');
		expect(text).toContain('People and quests here');
		(map as unknown as { setSelection(c: string[]): void }).setSelection([]);
		await tick(20);
		expect(panel.contentEl.textContent).not.toContain('Travel votes');
		await plugin.players.start(map.mapState().file!);
		await tick(20);
		expect(panel.contentEl.textContent).toContain('Travel votes');
		await plugin.players.stop();
		// What the map shows is the top bar's panel, never repeated here.
		expect(panel.contentEl.textContent).not.toContain('Map style');
	});

	it('the sections sidebar lists the fixture’s sections and notes', async () => {
		const leaf = await openLeaf(SECTIONS_VIEW);
		const sections = leaf.view as unknown as SectionsView;
		app.workspace.trigger('active-leaf-change', mapLeaf);
		await tick(200);
		const text = sections.contentEl.textContent ?? '';
		for (const s of ['Places', 'NPCs', 'Quests', 'Factions']) expect(text).toContain(s);
		expect(text).toContain('Hermit');
	});
});

describe('encounters from the panel', () => {
	it('rolls the active region, keeps the roll, and adds it to the session note', async () => {
		const panel = app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0]!.view as unknown as InspectorView;
		app.workspace.activeLeaf = mapLeaf;
		app.workspace.trigger('active-leaf-change', mapLeaf);
		(map as unknown as { setSelection(c: string[]): void }).setSelection([]);
		map.setActiveRegion('region_001');
		await tick(20);
		const roll = Array.from(panel.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Roll')!;
		roll.click();
		await tick(20);
		expect(Notice.log.at(-1)).toMatch(/^Encounter: North: Wolves \(d6 \d\)/);
		expect(panel.contentEl.textContent).toContain('Rolls this session');
		// No encounter-chance in the fixture's note: the check says how to add one.
		Array.from(panel.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Check')!.click();
		await tick(20);
		expect(Notice.log.at(-1)).toMatch(/encounter-chance: 2/);
		// The session log is on: the roll is already in the session note, under its heading.
		expect(panel.contentEl.querySelector('.hexlore-roll-row [aria-label^="Add to"]')).toBeNull();
		await tick(20);
		expect(app.vault.textOf('Campaign/GM notes/Todo.md')).toMatch(/\n## Session log\n\n- \d\d:\d\d · Encounter: North: Wolves \(d6 \d\)\n$/);
		map.setActiveRegion(null);
	});
});

describe('notes from the panel', () => {
	it('"New note…" creates, links and opens a note', async () => {
		const panel = app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0]!.view as unknown as InspectorView;
		(map as unknown as { setSelection(c: string[]): void }).setSelection(['5,5']);
		await tick(20);
		const button = Array.from(panel.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'New note…')!;
		button.click();
		const modal = Modal.open.at(-1)!;
		const create = Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Create')!;
		create.click();
		await tick(20);
		expect(map.mapState().editor!.hexNotes('q5_r5').length).toBe(1);
		expect(app.vault.getMarkdownFiles().some((f) => f.path === 'Campaign/Places/F6.md')).toBe(true);
	});

	it('a click on a panel note opens it in the floating window, editing; Ctrl-click in a new tab', async () => {
		const panel = app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0]!.view as unknown as InspectorView;
		(map as unknown as { setSelection(c: string[]): void }).setSelection(['0,0']);
		await tick(20);
		const hovers: Record<string, unknown>[] = [];
		const ref = app.workspace.on('hover-link', (e) => hovers.push(e as Record<string, unknown>));
		const opened: string[] = [];
		const spy = vi.spyOn(app.workspace, 'openLinkText').mockImplementation((...a: unknown[]) => (opened.push(String(a[2])), Promise.resolve()));
		try {
			const link = Array.from(panel.contentEl.querySelectorAll<HTMLElement>('a.internal-link')).find((a) => a.textContent?.includes('Base Culto'))!;
			link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			expect(hovers.at(-1)).toMatchObject({ source: 'hexlore-map', targetEl: link, state: { mode: 'source' } });
			// Page preview wants Mod for this source: the event carries it.
			expect((hovers.at(-1)!.event as MouseEvent).ctrlKey).toBe(true);
			link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
			expect(opened).toEqual(['tab']);
		} finally {
			app.workspace.offref(ref);
			spy.mockRestore();
		}
	});
});

describe('notes from the map', () => {
	const empty = (): [number, number] => {
		const links = map.mapState().links;
		for (let q = 0; ; q++) if (!links.has(hexIdFor(q, 2)) && !map.mapState().editor!.model.hexes.has(hexIdFor(q, 2))) return [q, 2];
	};

	it('a double-click on a hex with no note asks to create its first, links it and opens it over the map', async () => {
		const hovers: Record<string, unknown>[] = [];
		const ref = app.workspace.on('hover-link', (e) => hovers.push(e as Record<string, unknown>));
		const cell = empty();
		const id = hexIdFor(...cell);
		try {
			map.openPrincipalNote(cell, { clientX: 40, clientY: 30 });
			const modal = Modal.open.at(-1)!;
			expect(modal.titleEl.textContent).toMatch(/no note yet/);
			Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Create')!.click();
			await tick(20);
			const editor = map.mapState().editor!;
			expect(editor.hexNotes(id).length).toBe(1);
			const made = app.vault.getMarkdownFiles().find((f) => f.path === `Campaign/Places/${displayIdFor(...cell)}.md`)!;
			expect(made).toBeTruthy();
			expect(hovers.at(-1)).toMatchObject({ source: 'hexlore-map', linktext: made.path, state: { mode: 'source' } });
			expect(hovers.at(-1)!.targetEl).toBe(map.containerEl.querySelector('.hexlore-map-stage'));
			expect((hovers.at(-1)!.event as MouseEvent).clientX).toBe(40);
			// With a note, a double-click opens it; "a pane beside the map" when set so.
			plugin.settings.noteOpening = 'pane';
			const opened: string[] = [];
			const spy = vi.spyOn(app.workspace, 'openLinkText').mockImplementation((...a: unknown[]) => (opened.push(`${String(a[0])} ${String(a[2])}`), Promise.resolve()));
			const before = Modal.open.length;
			map.openPrincipalNote(cell, { clientX: 40, clientY: 30 });
			spy.mockRestore();
			expect(Modal.open.length).toBe(before);
			expect(opened).toEqual([`${editor.hexNotes(id)[0]} split`]);
			editor.setHexNotes(id, [], 'test cleanup');
		} finally {
			plugin.settings.noteOpening = 'popover';
			app.workspace.offref(ref);
		}
	});

	it('a click on a hex shows the map panel when it is hidden (a setting)', async () => {
		let revealed = 0;
		const spy = vi.spyOn(app.workspace, 'revealLeaf').mockImplementation(() => (revealed++, Promise.resolve()));
		const reveal = () => (map as unknown as { panel: { revealOnClick(): void } }).panel.revealOnClick();
		try {
			reveal();
			expect(revealed).toBe(0); // showing already
			app.workspace.rightSplit.collapsed = true;
			reveal();
			await tick();
			expect(revealed).toBe(1);
			plugin.settings.revealPanel = false;
			reveal();
			await tick();
			expect(revealed).toBe(1);
		} finally {
			plugin.settings.revealPanel = true;
			app.workspace.rightSplit.collapsed = false;
			spy.mockRestore();
		}
	});
});

describe('opening a map file', () => {
	it('shows its map wherever it is opened as Markdown, unless Markdown was asked for', async () => {
		const leaf = app.workspace.getLeaf();
		await leaf.setViewState({ type: 'markdown', state: { file: 'Campaign/Fixture.hexmap.md' } });
		expect(leaf.view).toBeInstanceOf(MapView);
		expect((leaf.view as unknown as MapView).mapState().file?.path).toBe('Campaign/Fixture.hexmap.md');
		// A note stays a note.
		const note = app.workspace.getLeaf();
		await note.setViewState({ type: 'markdown', state: { file: 'Campaign/Places/Base Culto.md' } });
		expect(note.view).toBeNull();
		// "Open as Markdown" is kept.
		const md = app.workspace.getLeaf();
		const p = plugin as unknown as { openMarkdown(f: TFile, l: WorkspaceLeaf): void; asMarkdown: Set<string> };
		const index = app.vault.getAbstractFileByPath('Campaign/Fixture.hexmap.md');
		if (!(index instanceof TFile)) throw new Error('no index');
		p.openMarkdown(index, md);
		await tick();
		expect(md.view).toBeNull();
		p.asMarkdown.clear();
	});
});

describe('the Sketch view', () => {
	it('draws a stroke, undoes it in its own history, hexifies a fill', async () => {
		map.toggleSketch(true);
		await tick();
		const sk = map.sketchMode;
		const stage = map.containerEl.querySelector('.hexlore-map-stage')!;
		const ev = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 7, pointerType: 'mouse' });
		sk.setPrefs({ tool: 'pen', swatchId: 'biome:swamp' });
		sk.pointerDown(ev('pointerdown', 10, 10));
		for (let i = 1; i < 10; i++) sk.pointerMove(ev('pointermove', 10 + i * 5, 10 + i * 3));
		sk.pointerUp(ev('pointerup', 60, 40));
		const editor = map.mapState().editor!;
		expect(editor.sketch.items.length).toBe(1);
		sk.undo();
		expect(editor.sketch.items.length).toBe(0);
		sk.redo();
		map.hexify();
		const hex = Modal.open.at(-1)!;
		expect(hex.contentEl.textContent).toContain('Coverage needed');
		hex.close();
		map.toggleSketch(false);
		expect(stage).toBeTruthy();
	});
});

describe('the dialogs', () => {
	it('export image writes a PNG and a PDF beside the map', async () => {
		for (const format of ['png', 'pdf']) {
			map.exportImage();
			const m = Modal.open.at(-1)!;
			expect(m.contentEl.textContent).toContain('Version');
			(m as unknown as { o: { format: string; version: string } }).o.format = format;
			(m as unknown as { o: { version: string } }).o.version = 'gm';
			Array.from(m.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Export')!.click();
			await tick(300);
			expect(app.vault.getFiles().some((f) => f.path === `Campaign/Fixture GM.${format}`), format).toBe(true);
		}
	});

	it('export as a campaign folder writes a Flutter campaign', async () => {
		const fs = await import('node:fs');
		const os = await import('node:os');
		const path = await import('node:path');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlore-smoke-'));
		try {
			const { exportToFlutter } = await import('../src/convert/export_command');
			await exportToFlutter(app as never, (plugin as unknown as { stores: never }).stores, map.mapState().file!);
			const m = Modal.open.at(-1)!;
			const input = m.contentEl.querySelector('input[type=text]') as HTMLInputElement;
			input.value = `${dir}/out`;
			input.dispatchEvent(new Event('input'));
			Array.from(m.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Export')!.click();
			await tick(300);
			expect(fs.existsSync(`${dir}/out/campaign.json`)).toBe(true);
			expect(fs.existsSync(`${dir}/out/roundtrip.json`)).toBe(true);
			expect(fs.readdirSync(`${dir}/out/npcs`).length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('the settings tab lists its settings', async () => {
		const { HexLoreSettingTab } = await import('../src/settings');
		const tab = new HexLoreSettingTab(app as never, plugin);
		const defs = JSON.stringify(tab.getSettingDefinitions());
		expect(defs).toContain('templatesFolder');
		expect(defs).toContain('mapFolders');
		// Switched from the players menu only (one place per setting).
		expect(defs).not.toContain('playerLan');
		// Travel: one control per terrain; blank hours = cannot be entered.
		expect(defs).toContain('travel.hours.forest');
		expect(defs).toContain('travel.height.hills');
		await tab.setControlValue('travel.hours.forest', '5');
		expect(plugin.settings.travel.terrainHours.forest).toBe(5);
		expect(tab.getControlValue('travel.hours.forest')).toBe(5);
		await tab.setControlValue('travel.hours.forest', '');
		expect(plugin.settings.travel.terrainHours.forest).toBeNull();
		await tab.setControlValue('travel.hours.forest', '4');
		await tab.setControlValue('travel.height.hills', 3);
		expect(plugin.settings.travel.heights.hills).toBe(3);
		await tab.setControlValue('travel.height.hills', 1);
		await tab.setControlValue('travel.referenceMiles', 0);
		expect(plugin.settings.travel.referenceMiles).toBe(3); // refused
	});

	it('the import wizard runs every step on a synthetic map', async () => {
		map.importImage();
		const wiz = Modal.open.at(-1)! as unknown as Record<string, unknown> & { render(): void; close(): void };
		// Hand it an image as if picked (jsdom cannot decode pictures).
		const grid = new SourceGrid('flat', 24, 40, 40);
		const raster = paintMap(grid, 320, 240, (q) => (q < 3 ? [48, 71, 46] : [47, 95, 112]));
		stampIcon(raster, grid, 2, 2);
		const img = createEl('canvas');
		img.width = 320;
		img.height = 240;
		wiz.file = app.vault.getFiles()[0];
		const session = new ImportSession(raster);
		session.calibrate(grid.centerOf(0, 0), grid.centerOf(1, 0));
		wiz.session = session;
		wiz.img = img;
		const { __testing } = await import('../src/view/import_wizard');
		(wiz.body as HTMLElement).empty();
		wiz.stage = new __testing.ImageStage(wiz.body as HTMLElement, img);
		wiz.step = 'calibrate';
		wiz.render();
		const proto = Object.getPrototypeOf(wiz) as Record<string, (...a: unknown[]) => unknown>;
		await (proto.classify!.call(wiz) as Promise<void>);
		expect(wiz.step).toBe('review');
		expect(session.groups.length).toBeGreaterThan(0);
		for (const g of session.biomeGroups) if (session.decisionOf(g).pick.isEmpty) session.decisionOf(g).skip = true;
		wiz.step = 'rivers';
		wiz.render();
		wiz.step = 'place';
		wiz.render();
		await tick(10);
		await (proto.apply!.call(wiz) as Promise<void>);
		expect(Notice.log.some((n) => n.startsWith('Imported:'))).toBe(true);
	});
});

describe('the top bar (Flutter decision 30)', () => {
	const bar = () => map.containerEl.querySelector('.hexlore-topbar') as HTMLElement;
	const button = (sel: string, n = 0) => bar().querySelectorAll<HTMLElement>(sel)[n]!;
	const menuOf = (el: HTMLElement) => {
		Menu.last = null;
		el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return Menu.last as Menu | null;
	};

	it('shows the map name and the view switch', () => {
		expect(bar()).not.toBeNull();
		expect(bar().querySelector('.hexlore-topbar-name')?.textContent).toBe('Fixture');
		const segs = bar().querySelectorAll('.hexlore-segment');
		expect(Array.from(segs, (s) => s.textContent)).toEqual(['Hex', 'Sketch']);
		expect(segs[0]!.classList.contains('is-active')).toBe(true);
	});

	it('the map menu carries the campaign entries', () => {
		const menu = menuOf(button('.hexlore-topbar-map'));
		const titles = menu!.items.map((i) => i.title);
		expect(titles).toEqual(expect.arrayContaining(['New map…', 'Open map…', 'Map scale…', 'Resize grid…', 'Explode map…', 'Import map image…', 'Export image (PNG / PDF)…', 'Pen and trackpad diagnostics…', 'Benchmark the renderer', 'About and credits…']));
		expect(titles.indexOf('Benchmark the renderer')).toBe(titles.indexOf('Pen and trackpad diagnostics…') + 1);
		// The sidebars have a place of their own.
		expect(titles).toEqual(expect.arrayContaining(['Sidebars', 'Map panel', 'Sections']));
		for (const t of ['Map scale…', 'Pen and trackpad diagnostics…', 'New map…']) {
			menu!.choose(t);
			const m = Modal.open.at(-1)!;
			expect(m).toBeDefined();
			m.close();
		}
	});

	it('fullscreen takes the map out of its tab and back; the map panel button leaves it', async () => {
		const icons = () => bar().querySelectorAll<HTMLElement>('.hexlore-topbar-icon-button');
		const full = icons()[0]!;
		const home = map.contentEl.parentElement;
		full.click();
		expect(map.contentEl.parentElement).toBe(document.body);
		expect(map.contentEl.classList.contains('is-fullscreen')).toBe(true);
		expect(full.getAttribute('aria-label')).toMatch(/Leave fullscreen/);
		full.click();
		expect(map.contentEl.parentElement).toBe(home);
		expect(map.contentEl.classList.contains('is-fullscreen')).toBe(false);
		// The panel is in the sidebar, which a fullscreen map would cover.
		const panel = icons()[icons().length - 1]!;
		expect(panel.getAttribute('aria-label')).toMatch(/map panel/);
		full.click();
		panel.click();
		await tick();
		expect(map.contentEl.parentElement).toBe(home);
	});

	it('quick jump finds hexes and notes', () => {
		map.quickJump();
		const m = Modal.open.at(-1) as unknown as { getSuggestions(q: string): { label: string; kind: string }[]; close(): void };
		const all = m.getSuggestions('');
		expect(all.length).toBeGreaterThan(0);
		expect(all.some((e) => e.label === 'Hermit')).toBe(true);
		// Coordinates, as the map shows them, come first.
		expect(m.getSuggestions('C4')[0]).toMatchObject({ label: 'C4', kind: 'coords' });
		expect(m.getSuggestions('Z99').some((e) => e.kind === 'coords')).toBe(false); // off the map
		m.close();
	});

	it('the top bar and the tool strip work from the keyboard', () => {
		const search = bar().querySelectorAll<HTMLElement>('.hexlore-topbar-icon-button')[1]!;
		expect(search.getAttribute('role')).toBe('button');
		expect(search.tabIndex).toBe(0);
		const before = Modal.open.length;
		search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(Modal.open.length).toBe(before + 1);
		Modal.open.at(-1)!.close();
		const fog = map.contentEl.querySelector<HTMLElement>('.hexlore-tool[data-tool="fog"]')!;
		fog.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		expect(fog.getAttribute('aria-pressed')).toBe('true');
		map.contentEl.querySelector<HTMLElement>('.hexlore-tool[data-tool="select"]')!.click();
		// Undo and redo are the top bar's only.
		expect(map.contentEl.querySelectorAll('.hexlore-toolbar [aria-label^="Undo"], .hexlore-toolbar [aria-label="Nothing to undo"]')).toHaveLength(0);
	});

	it('adventures, session notes and players menus build', () => {
		const icons = bar().querySelectorAll<HTMLElement>('.hexlore-topbar-icon-button');
		const titlesOf = (el: HTMLElement) => menuOf(el)?.items.map((i) => i.title) ?? [];
		// left: fullscreen, search, adventures, notes; right: undo, redo, reset, display, players, players ▾, map panel
		expect(titlesOf(icons[2]!)).toContain('New adventure…');
		const notes = titlesOf(icons[3]!);
		expect(notes).toEqual(expect.arrayContaining(['New session document…', 'Unassigned characters and quests…']));
		expect(titlesOf(icons[9]!)).toEqual(expect.arrayContaining(['Serve on the local network', 'Reveal all hexes to players', 'Hide all hexes from players']));
		menuOf(icons[3]!)!.choose('Unassigned characters and quests…');
		Modal.open.at(-1)!.close();
	});

	it('the Display & overlays panel: pills, eyes, the sketch overlay, and closing', async () => {
		const button = bar().querySelectorAll<HTMLElement>('.hexlore-topbar-icon-button')[7]!;
		const panel = () => map.containerEl.querySelector<HTMLElement>('.hexlore-display-panel');
		const rowOf = (label: string) => Array.from(panel()!.querySelectorAll<HTMLElement>('.hexlore-display-row')).find((r) => r.querySelector('.hexlore-display-label')?.textContent === label)!;
		button.click();
		expect(panel()).not.toBeNull();
		const text = panel()!.textContent ?? '';
		for (const t of ['Overlays · this map', 'Display · this device', 'Threads', 'Regions', 'Borders', 'Sketch overlay']) expect(text).toContain(t);
		// One-or-the-other as pills.
		const style = rowOf('Map style').querySelectorAll<HTMLElement>('.hexlore-segment');
		expect(Array.from(style, (s) => s.textContent)).toEqual(['Clean', 'Illustrated']);
		style[1]!.click();
		await tick(20);
		expect(map.mapState().display.style).toBe('illustrated');
		expect(rowOf('Map style').querySelector('.hexlore-segment.is-active')?.textContent).toBe('Illustrated');
		map.setDisplay({ style: 'clean' });
		// The section eye hides the overlay; a second click brings it back.
		const eye = () => rowOf('Regions').querySelector<HTMLElement>('.hexlore-display-icon:not([data-icon^="chevron"])')!;
		eye().click();
		await tick(20);
		expect(map.mapState().overlays.regions).toBe(false);
		eye().click();
		await tick(20);
		expect(map.mapState().overlays.regions).toBe(true);
		// "Labels only" is remembered while the sketch overlay is hidden.
		rowOf('Sketch overlay').querySelector<HTMLElement>('.hexlore-display-chip')!.click();
		await tick(20);
		expect(map.sketchMode.prefs).toMatchObject({ overlay: 'none', overlayMode: 'labels' });
		rowOf('Sketch overlay').querySelector<HTMLElement>('.hexlore-display-icon')!.click();
		await tick(20);
		expect(map.sketchMode.prefs.overlay).toBe('labels');
		map.sketchMode.showOverlay(false, 'full');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(panel()).toBeNull();
		button.click();
		document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		expect(panel()).toBeNull();
	});

	it('the Sketch segment switches the view, Hex switches back', async () => {
		button('.hexlore-segment', 1).dispatchEvent(new MouseEvent('click'));
		await tick(20);
		expect(map.sketchMode.active).toBe(true);
		expect(button('.hexlore-segment', 1).classList.contains('is-active')).toBe(true);
		button('.hexlore-segment', 0).dispatchEvent(new MouseEvent('click'));
		await tick(20);
		expect(map.sketchMode.active).toBe(false);
	});
});

describe('rivers and roads', () => {
	type Lines = {
		lineMenu(line: { kind: 'river' | 'route'; id: string }, point: number, e: MouseEvent): void;
		deleteKey(): boolean;
	};
	const c = (q: number, r: number) => ({ kind: 'c', q, r, k: 0 });

	it('the river menu sets the width (presets, then exact); the panel has no slider', () => {
		const editor = map.mapState().editor!;
		const river = editor.createRiver([c(0, 0), c(1, 0), c(2, 0)])!;
		(map as unknown as Lines).lineMenu({ kind: 'river', id: river.id }, -1, new MouseEvent('contextmenu'));
		const menu = Menu.last!;
		expect(menu.items.map((i) => i.title)).toEqual(expect.arrayContaining(['Width', 'Stream', 'River', 'Wide river', 'Great river']));
		expect(menu.items.find((i) => i.title === 'River')?.checked).toBe(true);
		menu.choose('Wide river');
		expect(editor.model.rivers.get(river.id)!.width).toBe(1.75);
		(map as unknown as Lines).lineMenu({ kind: 'river', id: river.id }, -1, new MouseEvent('contextmenu'));
		Menu.last!.choose('Exact width…');
		const dlg = Modal.open.at(-1)!;
		dlg.contentEl.querySelectorAll('button')[1]!.click(); // +
		expect(editor.model.rivers.get(river.id)!.width).toBeCloseTo(1.9);
		dlg.close();
		editor.undo.undo();
		expect(editor.model.rivers.get(river.id)!.width).toBe(1.75); // the dialog was one step
		map.selectLine({ kind: 'river', id: river.id });
	});

	it('Delete removes the selected river or road (a held point first)', () => {
		const editor = map.mapState().editor!;
		const keys = map as unknown as Lines;
		for (const make of [() => ({ kind: 'river' as const, id: editor.createRiver([c(0, 2), c(1, 2), c(2, 2)])!.id }), () => ({ kind: 'route' as const, id: editor.createRoute([c(0, 3), c(1, 3), c(2, 3)], 'trail', '#6B4A2F')!.id })]) {
			const line = make();
			const lines = () => (line.kind === 'river' ? editor.model.rivers : editor.model.routes);
			map.selectLine(line, 1);
			keys.deleteKey(); // the held point
			expect(lines().get(line.id)?.nodes.length).toBe(2);
			keys.deleteKey(); // then the line itself
			expect(lines().has(line.id)).toBe(false);
			expect(map.mapState().selectedLine).toBeNull();
		}
	});
});

describe('where the plugin can be reached from', () => {
	const fileMenu = (path: string) => {
		const menu = new Menu();
		app.workspace.trigger('file-menu', menu, app.vault.getAbstractFileByPath(path), 'file-explorer');
		return menu;
	};
	const titles = (menu: Menu) => menu.items.map((i) => i.title);

	it('keeps three commands for hotkeys, and the dev map', () => {
		const ids = (plugin as unknown as { commands: { id: string }[] }).commands.map((c) => c.id);
		expect(ids).toEqual(['new-map', 'show-note-on-map', 'open-as-map', 'open-synthetic']);
	});

	it('right-clicking a map file offers what can be done with a map', () => {
		const t = titles(fileMenu('Campaign/Fixture.hexmap.md'));
		expect(t).toEqual(expect.arrayContaining(['Open as map', 'Open as Markdown', 'Start the player view', 'Export as a campaign folder…', 'Show maps together…']));
	});

	it('right-clicking a note on a hex of an open map offers to show it there', () => {
		expect(titles(fileMenu('Campaign/Places/Base Culto.md'))).toContain('Show on the map');
		// A note on no hex, and a folder: nothing of ours.
		expect(titles(fileMenu('Campaign/Adventures/Act One.md'))).not.toContain('Show on the map');
		expect(titles(fileMenu('Campaign'))).toEqual([]);
	});

	it('the ribbon icon opens a menu with the entries a vault with no map needs', () => {
		const icon = (plugin as unknown as { ribbon: { title: string; click: (e: MouseEvent) => void }[] }).ribbon[0]!;
		expect(icon.title).toBe('HexLore');
		Menu.last = null;
		icon.click(new MouseEvent('click'));
		expect(titles(Menu.last!)).toEqual(expect.arrayContaining(['New map…', 'Open map…', 'Show maps together…', 'Map panel', 'Sections']));
	});
});

describe('the brush palette', () => {
	it('its previews take their place in the layout, not the map canvases\' (absolute) one', () => {
		// The stage's rule for the map's own canvases once caught them: the swatch
		// sat on the Select tool and every tile preview piled up in the corner.
		const swatch = map.containerEl.querySelector<HTMLElement>('.hexlore-pick-swatch')!;
		map.setTool('paint');
		swatch.click();
		const previews = Array.from(map.containerEl.querySelectorAll<HTMLElement>('canvas.hexlore-pick-preview'));
		expect(previews.length).toBeGreaterThan(10);
		const mapCanvas = map.containerEl.querySelector('.hexlore-map-stage > canvas')!;
		const absolute = Array.from(readFileSync('styles.css', 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g))
			.filter((m) => /position:\s*absolute/.test(m[2]!))
			.flatMap((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((sel) => sel.trim()));
		const matching = (el: Element) => absolute.filter((sel) => { try { return el.matches(sel); } catch { return false; } });
		for (const c of previews) expect(matching(c)).toEqual([]);
		expect(matching(mapCanvas).length).toBeGreaterThan(0); // the map's own canvases keep theirs
		swatch.click();
	});

	it('names every biome and icon, draws variants, and keeps erasing apart', () => {
		const swatch = map.containerEl.querySelector<HTMLElement>('.hexlore-pick-swatch')!;
		map.setTool('paint');
		swatch.click();
		const pal = map.containerEl.querySelector<HTMLElement>('.hexlore-palette')!;
		const titles = () => Array.from(pal.querySelectorAll('.hexlore-palette-title'), (t) => t.textContent);
		const tabs = () => Array.from(pal.querySelectorAll<HTMLElement>('.hexlore-palette-tab'));
		const tab = (name: string) => tabs().find((t) => t.textContent === name)!;
		const labels = () => Array.from(pal.querySelectorAll('.hexlore-palette-grid:not(.is-variants) .hexlore-palette-label'), (l) => l.textContent);
		// One category at a time, in tabs; it opens on the biomes.
		expect(tabs().map((t) => t.textContent)).toEqual(['Biomes', 'Icons', 'Erase']);
		expect(tab('Biomes').hasClass('is-active')).toBe(true);
		expect(labels()).toEqual(expect.arrayContaining(['Forest', 'Mountain', 'Sea']));
		expect(labels()).not.toContain('City');
		expect(pal.querySelectorAll('.hexlore-palette-item canvas.hexlore-pick-preview').length).toBeGreaterThan(10);
		const pick = (label: string) => Array.from(pal.querySelectorAll<HTMLElement>('.hexlore-palette-item')).find((t) => t.textContent === label)!.click();
		// A biome's variants sit under its grid, and the tab stays.
		pick('Forest');
		expect(titles()).toEqual(['Forest variants']);
		expect(tab('Biomes').hasClass('is-active')).toBe(true);
		tab('Icons').click();
		expect(titles()).toEqual([]); // the variants belong to the tab of what is picked
		tab('Biomes').click();
		expect(titles()).toEqual(['Forest variants']);
		tab('Icons').click();
		expect(labels()).toEqual(expect.arrayContaining(['City', 'Ruins', 'Dungeon']));
		expect(labels()).not.toContain('Forest');
		pick('City');
		expect(titles()).toEqual(['City variants']);
		tab('Biomes').click();
		expect(titles()).toEqual([]); // the pick is now an icon: no biome variants
		tab('Icons').click();
		expect(titles()).toEqual(['City variants']);
		tab('Erase').click();
		expect(titles()).toEqual([]);
		expect(labels()).toEqual(['Biome', 'Icon']); // erasing is a tab of its own
		pick('Icon');
		// Reopened, it comes back to what is picked: the icon eraser.
		swatch.click();
		swatch.click();
		expect(map.containerEl.querySelector('.hexlore-palette-tab.is-active')!.textContent).toBe('Erase');
		expect(map.mapState().editor && (map as unknown as { pick: { clearsFeature: boolean } }).pick.clearsFeature).toBe(true);
		swatch.click();
	});
});

describe('the player view control', () => {
	it('starts and stops on a real port', async () => {
		const file = map.mapState().file!;
		await plugin.players.start(file);
		expect(plugin.players.running).toBe(true);
		expect(plugin.players.url).toMatch(/^http:\/\/127\.0\.0\.1:51\d\d$/);
		// The GM is told where it is and how players come to see anything.
		const told = Modal.open.at(-1)!;
		expect(told.contentEl.textContent).toContain(plugin.players.url!);
		expect(told.contentEl.textContent).toContain('Serve on the local network');
		expect(told.contentEl.textContent).toContain('fog tool');
		told.close();
		// Node's fetch, not Obsidian's requestUrl: this runs under node.
		const res = await globalThis.fetch(`${plugin.players.url}/api/map`).catch(() => null);
		if (res) expect(res.status).toBe(200);
		await plugin.players.stop();
		expect(plugin.players.running).toBe(false);
	});

	it('"Travel here" on a vote reveals, clears the votes and notes the trip', async () => {
		const file = map.mapState().file!;
		await plugin.players.start(file);
		for (const m of [...Modal.open]) m.close();
		const editor = map.mapState().editor!;
		const target = 'q2_r2';
		expect(editor.model.revealed.has(target)).toBe(false);
		const control = plugin.players as unknown as { server: { votes: { cast(v: string, h: string, n: string): boolean } }; changed(): void };
		control.server.votes.cast('v1', target, 'Mara');
		control.server.votes.cast('v2', target, 'Bo');
		control.changed();
		const panel = app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0]!.view as unknown as InspectorView;
		app.workspace.activeLeaf = mapLeaf;
		app.workspace.trigger('active-leaf-change', mapLeaf);
		await tick(20);
		panel.contentEl.querySelector<HTMLElement>('[aria-label^="Travel to"]')!.click();
		const modal = Modal.open.at(-1)!;
		expect(modal.titleEl.textContent).toBe('Travel to C3?');
		const index = map.mapState().file!;
		const hoursBefore = plugin.party.state(index).hours;
		Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Travel')!.click();
		await tick(20);
		try {
			expect(editor.model.revealed.has(target)).toBe(true);
			expect(plugin.players.votes()).toEqual([]);
			// The party is there, and the hex's entry time was added.
			expect(plugin.party.state(index).hex).toBe(target);
			expect(plugin.party.state(index).hours).toBeGreaterThan(hoursBefore);
			expect(app.vault.textOf('Campaign/GM notes/Todo.md')).toMatch(/\n- \d\d:\d\d · Travelled to C3 \([^)]*2 votes: Mara, Bo; revealed \d+ hex(es)?\)\n$/);
			// Players see the party on a revealed hex, and not once it is hidden again.
			const seen = await globalThis.fetch(`${plugin.players.url}/api/party`).catch(() => null);
			if (seen) expect(await seen.json()).toEqual({ hex: target });
			editor.undoLast();
			expect(editor.model.revealed.has(target)).toBe(false);
			const hidden = await globalThis.fetch(`${plugin.players.url}/api/party`).catch(() => null);
			if (hidden) expect(await hidden.json()).toEqual({ hex: null });
		} finally {
			await plugin.players.stop();
			plugin.party.place(index, null);
		}
	});

	it('two starts at once leave one server, and stop closes it', async () => {
		const file = map.mapState().file!;
		const listening = (port: number) =>
			new Promise<boolean>((resolve) => {
				const s = connect(port, '127.0.0.1');
				s.once('connect', () => (s.destroy(), resolve(true)));
				s.once('error', () => resolve(false));
			});
		const free = async () => (await Promise.all([5174, 5175, 5176, 5177, 5178, 5179, 5180].map(listening))).filter(Boolean).length;
		const before = await free();
		await Promise.all([plugin.players.start(file), plugin.players.start(file)]);
		for (const m of [...Modal.open]) m.close();
		expect(plugin.players.running).toBe(true);
		expect(await free()).toBe(before + 1);
		await plugin.players.stop();
		expect(await free()).toBe(before);
	});
});

describe('the party and the preview', () => {
	it('places and moves the party from the hex menu, counting the time', async () => {
		const index = map.mapState().file!;
		const menuAt = (q: number, r: number) => {
			Menu.last = null;
			(map as unknown as { cellMenu(c: [number, number], e: MouseEvent): void }).cellMenu([q, r], new MouseEvent('contextmenu'));
			return Menu.last as unknown as Menu;
		};
		const titles = (m: Menu) => m.items.map((i) => i.title);
		let m = menuAt(1, 1);
		expect(titles(m)).toEqual(expect.arrayContaining(['Move the party here…', 'Place the party here']));
		m.choose('Place the party here');
		expect(plugin.party.state(index).hex).toBe('q1_r1');
		m = menuAt(1, 1);
		expect(titles(m)).toContain('Take the party off the map');
		expect(titles(m)).not.toContain('Move the party here…');
		const before = plugin.party.state(index).hours;
		menuAt(2, 1).choose('Move the party here…');
		const modal = Modal.open.at(-1)!;
		expect(modal.contentEl.textContent).toContain('The party is at B2');
		Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Travel')!.click();
		await tick(20);
		expect(plugin.party.state(index).hex).toBe('q2_r1');
		expect(plugin.party.state(index).hours).toBeGreaterThan(before);
		// The panel shows where it is and the time travelled.
		const panel = app.workspace.getLeavesOfType(INSPECTOR_VIEW)[0]!.view as unknown as InspectorView;
		(map as unknown as { setSelection(c: string[]): void }).setSelection([]);
		await tick(20);
		expect(panel.contentEl.textContent).toContain('Time travelled');
		expect(panel.contentEl.textContent).toContain('C2');
		map.mapState().editor!.undoLast(); // the reveal of the trip
		plugin.party.place(index, null);
		plugin.party.setHours(index, 0);
	});

	it('previews the map as players see it, and goes back', () => {
		const data = () => (map as unknown as { data: { hexes: unknown[] } }).data;
		const gm = data().hexes.length;
		map.setPreviewPlayers(true);
		expect(map.displayState().previewPlayers).toBe(true);
		expect(map.contentEl.querySelector('.hexlore-preview-banner')).not.toBeNull();
		expect(data().hexes.length).toBeLessThan(gm); // only what is revealed
		map.contentEl.querySelector<HTMLElement>('.hexlore-preview-banner')!.click();
		expect(map.displayState().previewPlayers).toBe(false);
		expect(map.contentEl.querySelector('.hexlore-preview-banner')).toBeNull();
		expect(data().hexes.length).toBe(gm);
	});
});

describe('touch', () => {
	it('two fingers pinch-zoom and pan, and paint nothing', async () => {
		const stage = map.containerEl.querySelector('.hexlore-map-stage') as HTMLElement;
		const cam = () => ({ ...(map as unknown as { canvas: { camera: { scale: number; ox: number; oy: number } } }).canvas.camera });
		const touch = (type: string, id: number, x: number, y: number) => stage.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', button: 0, bubbles: true }));
		const before = cam();
		const hexes = map.mapState().editor!.model.hexes.size;
		touch('pointerdown', 1, 100, 100);
		touch('pointerdown', 2, 200, 100);
		touch('pointermove', 2, 300, 100); // fingers apart: zoom in
		touch('pointerup', 2, 300, 100);
		touch('pointerup', 1, 100, 100);
		await tick();
		expect(cam().scale).toBeGreaterThan(before.scale);
		expect(map.mapState().editor!.model.hexes.size).toBe(hexes);
	});
});

describe('maps together', () => {
	const INDEX = 'Campaign/Fixture.hexmap.md';

	it('lists every map with its scale, shows the ones ticked, and changes no map', async () => {
		const files = () => app.vault.getFiles().map((f) => [f.path, app.vault.textOf(f.path)] as const);
		const before = files();
		(plugin as unknown as { pickMapsTogether(): void }).pickMapsTogether();
		await tick(20);
		const modal = Modal.open.at(-1)!;
		const row = Setting.all.find((s) => modal.contentEl.contains(s.settingEl) && s.nameEl.textContent === 'Fixture')!;
		expect(row.descEl.textContent).toMatch(/^1 hex = \d/);
		(row.components[0] as ToggleComponent).change(true);
		expect(plugin.settings.atlas.shown).toEqual([INDEX]);
		Array.from(modal.contentEl.querySelectorAll('button')).find((b) => b.textContent === 'Show')!.click();
		await tick(30);
		const view = app.workspace.getLeavesOfType(ATLAS_VIEW)[0]!.view as unknown as AtlasView;
		expect(view.contentEl.querySelectorAll('.hexlore-atlas-layer').length).toBe(1);
		expect(view.contentEl.querySelector('.hexlore-atlas-name')?.textContent).toBe('Fixture');
		// Never placed: put at the centre, to scale.
		expect(plugin.settings.atlas.maps[INDEX]?.fit).toBe(1);
		expect(files()).toEqual(before);
	});

	it('locked, a drag pans; unlocked, it moves the map and saves where it went', async () => {
		const view = app.workspace.getLeavesOfType(ATLAS_VIEW)[0]!.view as unknown as AtlasView;
		const stage = view.contentEl.querySelector('.hexlore-atlas-stage') as HTMLElement;
		Object.defineProperty(stage, 'clientWidth', { value: 800, configurable: true });
		Object.defineProperty(stage, 'clientHeight', { value: 600, configurable: true });
		view.onResize();
		await tick();
		const drag = (x0: number, y0: number, x1: number, y1: number) => {
			const ev = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 3, pointerType: 'mouse', bubbles: true });
			stage.dispatchEvent(ev('pointerdown', x0, y0));
			stage.dispatchEvent(ev('pointermove', (x0 + x1) / 2, (y0 + y1) / 2));
			stage.dispatchEvent(ev('pointermove', x1, y1));
			stage.dispatchEvent(ev('pointerup', x1, y1));
		};
		const placed = () => ({ ...plugin.settings.atlas.maps[INDEX]! });
		const start = placed();
		drag(400, 300, 450, 330);
		expect(placed()).toEqual(start);
		const lock = Array.from(view.contentEl.querySelectorAll('.hexlore-atlas-button')).find((b) => b.textContent === 'Locked') as HTMLElement;
		lock.click();
		drag(400, 300, 450, 330);
		const moved = placed();
		expect(moved.x).toBeGreaterThan(start.x);
		expect(moved.y).toBeGreaterThan(start.y);
		expect(moved.fit).toBe(1);
		await tick();
		expect(view.contentEl.querySelector('.hexlore-atlas-layer')!.classList.contains('is-hidden')).toBe(false);
	});

	it('the outlines follow the view’s size even when no resize was reported', async () => {
		const view = app.workspace.getLeavesOfType(ATLAS_VIEW)[0]!.view as unknown as AtlasView;
		const stage = view.contentEl.querySelector('.hexlore-atlas-stage') as HTMLElement;
		const overlay = view.contentEl.querySelector('.hexlore-atlas-overlay') as HTMLCanvasElement;
		// The test DOM lays nothing out: the stage and the map layers (which
		// fill it) are given their new size by hand.
		for (const el of [stage, ...Array.from(view.contentEl.querySelectorAll<HTMLElement>('.hexlore-atlas-layer'))]) {
			Object.defineProperty(el, 'clientWidth', { value: 1000, configurable: true });
			Object.defineProperty(el, 'clientHeight', { value: 700, configurable: true });
		}
		stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaMode: 1, clientX: 500, clientY: 350, bubbles: true, cancelable: true }));
		await tick(10);
		expect([overlay.width, overlay.height]).toEqual([1000, 700]);
		// The maps' canvases too.
		const base = view.contentEl.querySelector('.hexlore-atlas-layer canvas') as HTMLCanvasElement;
		expect([base.width, base.height]).toEqual([1000, 700]);
	});

	it('a map hidden while the view changed size draws again when it comes back', async () => {
		// A second map, ten times coarser: zoomed out, the fixture fades away.
		const big = await createMap(app as never, '', 'Continent', 12, 12);
		const meta = 'Continent.hexlore/campaign.json';
		const metaFile = app.vault.getAbstractFileByPath(meta);
		if (!(metaFile instanceof TFile)) throw new Error(`${meta} was not created`);
		await app.vault.modify(metaFile, app.vault.textOf(meta)!.replace('"hex_distance": 6.0', '"hex_distance": 60.0'));
		const set = (plugin as unknown as { setAtlasLayout(l: unknown): void }).setAtlasLayout.bind(plugin);
		set({ shown: [INDEX, big.path], maps: { ...plugin.settings.atlas.maps } });
		await tick(30);
		const view = app.workspace.getLeavesOfType(ATLAS_VIEW)[0]!.view as unknown as AtlasView;
		const stage = view.contentEl.querySelector('.hexlore-atlas-stage') as HTMLElement;
		// Sizes as a browser reports them: none for a hidden element.
		let W = 1000;
		const sized = (el: HTMLElement) => {
			Object.defineProperty(el, 'clientWidth', { get: () => (el.classList.contains('is-hidden') ? 0 : W), configurable: true });
			Object.defineProperty(el, 'clientHeight', { get: () => (el.classList.contains('is-hidden') ? 0 : 700), configurable: true });
		};
		sized(stage);
		view.contentEl.querySelectorAll<HTMLElement>('.hexlore-atlas-layer').forEach(sized);
		const fixture = () => (view as unknown as { layers: Map<string, { host: HTMLElement; canvas: { size: [number, number] } }> }).layers.get(INDEX)!;
		const wheel = (dy: number) => stage.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 1, clientX: 500, clientY: 350, bubbles: true, cancelable: true }));
		for (let i = 0; i < 80; i++) wheel(3); // all the way out
		await tick(20);
		expect(fixture().host.classList.contains('is-hidden')).toBe(true);
		W = 900; // the view changes size meanwhile (a sidebar, Obsidian's zoom)
		wheel(0.1);
		await tick(20);
		// Back to it, at its own zoom ("Centre" in the list).
		const row = [...Array.from(view.contentEl.querySelectorAll('.hexlore-atlas-row'))].find((r) => r.querySelector('.hexlore-atlas-name')?.textContent === 'Fixture')!;
		Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Centre')!.click();
		await tick(20);
		expect(fixture().host.classList.contains('is-hidden')).toBe(false);
		expect(fixture().canvas.size).toEqual([900, 700]);
	});
});
