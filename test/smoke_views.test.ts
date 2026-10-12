// @vitest-environment jsdom
//
// Smoke tests of the plugin's views, run against a stand-in for Obsidian
// (test/mocks/). They catch crashes and broken wiring in the views — what
// unit tests of the pure modules cannot — on the converter fixture's vault.

import './mocks/dom';
import { beforeAll, describe, expect, it } from 'vitest';
// The mock itself (the same module the plugin gets as 'obsidian'), for its
// test helpers.
import { App, Menu, Modal, Notice, TFile, useApp, type WorkspaceLeaf } from './mocks/obsidian';
import HexLorePlugin from '../src/main';
import { MAP_VIEW, MapView } from '../src/view/map_view';
import { INSPECTOR_VIEW, InspectorView } from '../src/view/inspector_view';
import { SECTIONS_VIEW, SectionsView } from '../src/view/sections_view';
import { readTree } from './helpers/vault_folder';
import { paintMap, stampIcon } from './helpers/importer_synth';
import { SourceGrid } from '../src/importer/grid_calibration';
import { ImportSession } from '../src/importer/import_session';

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
		m.close();
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

describe('the brush palette', () => {
	it('names every biome and icon, draws variants, and keeps erasing apart', () => {
		const swatch = map.containerEl.querySelector<HTMLElement>('.hexlore-pick-swatch')!;
		map.setTool('paint');
		swatch.click();
		const pal = map.containerEl.querySelector<HTMLElement>('.hexlore-palette')!;
		const titles = () => Array.from(pal.querySelectorAll('.hexlore-palette-title'), (t) => t.textContent);
		const labels = (n: number) => Array.from(pal.querySelectorAll('.hexlore-palette-grid')[n]!.querySelectorAll('.hexlore-palette-label'), (l) => l.textContent);
		expect(labels(0)).toEqual(expect.arrayContaining(['Forest', 'Mountain', 'Sea']));
		expect(labels(1)).toEqual(expect.arrayContaining(['City', 'Ruins', 'Dungeon']));
		expect(pal.querySelectorAll('.hexlore-palette-item canvas.hexlore-pick-preview').length).toBeGreaterThan(10);
		const pick = (label: string) => Array.from(pal.querySelectorAll<HTMLElement>('.hexlore-palette-item')).find((t) => t.textContent === label)!.click();
		pick('City');
		expect(titles()).toContain('City variants');
		expect(titles().at(-1)).toBe('Erase'); // its own section, last
		pick('Icon');
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
