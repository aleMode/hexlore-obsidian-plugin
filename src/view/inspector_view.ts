// The map panel (right sidebar): what is selected on the active map and what
// can be done to it; the regions; the players' travel votes. It follows
// whichever map view was last active. What the map SHOWS is not here: that
// is the top bar's Display & overlays panel (display_panel.ts), and only there.

import { FuzzySuggestModal, ItemView, type HoverPopover, Modal, Notice, Setting, TFile, normalizePath, setIcon, type App, type DropdownComponent, type Events, type WorkspaceLeaf } from 'obsidian';
import { displayIdFor } from '../core/hex';
import { hexIdFor } from '../core/hex_data';
import { formatChance } from '../notes/encounter_table';
import type { Cell, LineKind, MapEditor } from '../edit/editor';
import { ART } from '../render/art';
import { DEFAULT_SECTIONS, type Section } from '../storage/hexmap_index';
import { Swatch } from '../core/sketch';
import { TERRAINS, type Terrain } from '../core/hex_data';
import { toPlain, type JsonObject } from '../core/json';
import { sectionsOf, updateRegionLinks } from '../storage/index_file';
import { HOVER_SOURCE, MAP_STATE_EVENT, MapView, type MapPanelState } from './map_view';
import { addToSessionNote, checkRegion, chooseTable, chosenTable, clearRollHistory, entryText, readRegionNote, rollHistory, rollRegion, sessionNote, type RegionRef, type RollEntry } from './encounter_roller';
import { openNote } from './open_note';
import { NOTE_KINDS, defaultKindFor, type NoteKind } from '../notes/note_meta';
import type { HexLoreSettings } from '../settings';
import { PLAYERS_EVENT, type PlayerControl } from '../server/control';
import { createNote, linkPath, noteKind, outgoingLinks, peopleAt, resolveLink, templateFiles } from './vault_notes';
import { ROUTE_KINDS } from './toolbar';
import { MOD, asButton, setDisabled } from './a11y';
import { TravelModal } from './travel_modal';

export const INSPECTOR_VIEW = 'hexlore-panel';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const SECONDARY_KEY = 'hexlore-panel-secondary';
const SWATCHES_KEY = 'hexlore-panel-swatches';

/** A copy of a swatch, unknown keys and values included. */
function cloneSwatch(s: Swatch): Swatch {
	const c = Swatch.fromJson(toPlain(s.toJson()) as JsonObject)!;
	return c;
}

/** The icon of each kind of note. */
export const KIND_ICON: Record<NoteKind, string> = { note: 'file-text', place: 'map-pin', npc: 'user', quest: 'scroll' };

export class InspectorView extends ItemView {
	/** Page preview's window (Obsidian sets it). */
	hoverPopover: HoverPopover | null = null;
	private map: MapView | null = null;
	/** A render waited for a field to lose focus. */
	private pending = false;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settings: () => HexLoreSettings,
		private readonly players: PlayerControl,
	) {
		super(leaf);
	}

	getViewType(): string {
		return INSPECTOR_VIEW;
	}

	getDisplayText(): string {
		return 'Map panel';
	}

	getIcon(): string {
		return 'hexagon';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('hexlore-panel');
		this.registerDomEvent(this.contentEl, 'focusout', () => {
			window.setTimeout(() => {
				if (this.pending) this.render();
			}, 0);
		});
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MapView) this.follow(leaf.view);
			}),
		);
		this.registerEvent((this.app.workspace as Events).on(PLAYERS_EVENT, () => this.render()));
		this.registerEvent(
			(this.app.workspace as Events).on(MAP_STATE_EVENT, (view: unknown) => {
				if (!(view instanceof MapView)) return;
				if (view.closed) {
					// Its map is gone: show another open one, or nothing.
					if (this.map === view) this.follow(this.otherMap(view));
					return;
				}
				// Another view only takes over when it becomes active.
				if (!this.map || this.map === view) this.follow(view);
			}),
		);
		const active = this.app.workspace.getActiveViewOfType(MapView) ?? this.app.workspace.getLeavesOfType('hexlore-map')[0]?.view;
		this.follow(active instanceof MapView ? active : null);
	}

	private otherMap(not: MapView): MapView | null {
		for (const leaf of this.app.workspace.getLeavesOfType('hexlore-map')) {
			if (leaf.view instanceof MapView && leaf.view !== not && !leaf.view.closed) return leaf.view;
		}
		return null;
	}

	private follow(view: MapView | null): void {
		this.map = view;
		this.render();
	}

	/** Re-render — but not under a field the GM is using (typing a name,
	 *  dragging a slider): that waits until focus leaves it. */
	private render(): void {
		const active = this.contentEl.doc.activeElement;
		if (active && this.contentEl.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) {
			this.pending = true;
			return;
		}
		this.pending = false;
		const el = this.contentEl;
		const scroll = el.scrollTop;
		el.empty();
		const state = this.map?.mapState();
		if (!state || !this.map) {
			el.createDiv({ cls: 'hexlore-panel-empty', text: 'Open a map to see it here.' });
			return;
		}
		const editor = state.editor;
		const header = el.createDiv({ cls: 'hexlore-panel-header' });
		header.createDiv({ cls: 'hexlore-panel-title', text: state.file?.basename.replace(/\.hexmap$/, '') ?? 'Map' });
		header.createDiv({
			cls: 'hexlore-panel-status',
			text: !editor
				? 'View only'
				: editor.readOnly
					? `Read-only: ${editor.store.readOnlyReason}`
					: editor.store.hasUnsavedChanges
						? 'Saving…'
						: 'All changes saved',
		});

		const lit = this.map.highlightedNote;
		if (lit) {
			const map = this.map;
			new Setting(el)
				.setName(`Highlighted: ${lit.name}`)
				.setDesc(`${plural(lit.ids.size, 'hex', 'hexes')} on this map stand for the note you opened.`)
				.addExtraButton((b) => b.setIcon('locate').setTooltip('Show them').onClick(() => map.showHexes(lit.ids, lit.name)))
				.addExtraButton((b) => b.setIcon('x').setTooltip('Clear the highlight').onClick(() => map.clearNoteHighlight()))
				.settingEl.addClass('hexlore-panel-highlight');
		}
		if (editor && this.map.sketchMode.active) this.renderSketch(editor);
		else if (editor) {
			if (state.selectedLine) this.renderLine(state.selectedLine, state.heldPoint, editor);
			else if (state.selectedThread) this.renderThread(state.selectedThread, editor);
			else if (state.selection.length === 1) this.renderHex(state.selection[0]!, editor, state.links);
			else if (state.selection.length > 1) this.renderMany(state.selection, editor);
			if (state.tool === 'region' || (!state.selectedLine && !state.selectedThread && !state.selection.length)) this.renderRegions(state, editor);
			if (!state.selectedLine && !state.selectedThread && !state.selection.length && state.tool !== 'region') {
				this.renderSummary(editor);
				this.renderVotes(state.file, editor);
			}
		}
		el.scrollTop = scroll;
	}

	private section(name: string): void {
		this.contentEl.createEl('h6', { text: name, cls: 'hexlore-panel-section' });
	}

	private renderSummary(editor: MapEditor): void {
		const el = this.contentEl;
		el.createDiv({ cls: 'setting-item-description', text: `Click a hex, a river, a road or a thread to inspect it. Drag to select several hexes; ${MOD}+click adds one.` });
		const m = editor.model;
		const painted = [...m.hexes.values()].filter((h) => h.terrain !== 'default').length;
		const named = [...m.hexes.values()].filter((h) => h.name).length;
		const info = el.createDiv({ cls: 'hexlore-panel-facts' });
		info.createDiv({ text: `Grid: ${m.meta.gridCols} × ${m.meta.gridRows}` });
		info.createDiv({ text: `${plural(painted, 'painted hex', 'painted hexes')}, ${named} named` });
		info.createDiv({ text: `${plural(m.rivers.size, 'river')}, ${plural(m.routes.size, 'road or border', 'roads and borders')}, ${plural(m.threads.size, 'thread')}` });
		info.createDiv({ text: `${plural(m.revealed.size, 'hex', 'hexes')} revealed to players` });
		info.createDiv({ text: m.meta.scale.describe() });
	}

	// ----- the Sketch view (item 2.8) ---------------------------------------------------

	private renderSketch(editor: MapEditor): void {
		const el = this.contentEl;
		const map = this.map!;
		const sk = map.sketchMode;
		const ro = editor.readOnly;
		el.createEl('h4', { text: 'Sketch', cls: 'hexlore-panel-hex' }).createSpan({ cls: 'hexlore-panel-coords', text: `  ${plural(editor.sketch.items.length, 'item')}` });
		el.createDiv({
			cls: 'setting-item-description',
			text: `Draw freely over the lattice. Biome colours become terrain and river, road and trail colours become lines when you Hexify; ink and labels are notes only. Right-drag (or the pen’s eraser end) erases. ${MOD}+Z undoes here only.`,
		});
		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText('Hexify…')
					.setCta()
					.setDisabled(ro || !editor.sketch.items.length)
					.onClick(() => map.hexify()),
			)
			.addButton((b) => b.setButtonText('Back to the hex view').onClick(() => map.toggleSketch(false)));
		new Setting(el).setName('Show the map underneath').addToggle((t) => t.setValue(sk.prefs.showGhost).onChange((v) => sk.setPrefs({ showGhost: v })));
		new Setting(el).setName('Show the hex lattice').addToggle((t) => t.setValue(sk.prefs.showLattice).onChange((v) => sk.setPrefs({ showLattice: v })));
		new Setting(el).setName('Filled rectangles and ellipses').addToggle((t) => t.setValue(sk.prefs.filled).onChange((v) => sk.setPrefs({ filled: v })));

		this.renderSwatches(editor);

		this.section('Trace image');
		const trace = map.traceImage;
		if (!trace) {
			new Setting(el)
				.setDesc('A picture to draw over: a scanned map, a screenshot. It is only a backdrop: turning the sketch into hexes reads your strokes, never the picture.')
				.addButton((b) =>
					b
						.setButtonText('Pick an image…')
						.setDisabled(ro)
						.onClick(() => map.pickTraceImage()),
				);
		} else {
			new Setting(el).setName('Opacity').addSlider((s) => s.setLimits(0.05, 1, 0.05).setValue(trace.opacity).onChange((v) => map.setTrace({ opacity: v })));
			new Setting(el).setName('Shown').addToggle((t) => t.setValue(trace.visible).onChange((v) => map.setTrace({ visible: v })));
			new Setting(el)
				.setName('Locked')
				.setDesc('Unlocked, the pan tool moves it and its corner resizes it.')
				.addToggle((t) => t.setValue(trace.locked).onChange((v) => map.setTrace({ locked: v })));
			new Setting(el)
				.addButton((b) => b.setButtonText('Change…').onClick(() => map.pickTraceImage()))
				.addButton((b) => b.setButtonText('Remove').onClick(() => void map.removeTrace()));
		}
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Clear the sketch…')
				.setDestructive()
				.setDisabled(ro || !editor.sketch.items.length)
				.onClick(() => map.clearSketch()),
		);
	}

	/** The swatch editor (item 2.8 stage 3): a colour's name, colour and what
	 *  it MEANS — the biome or line it becomes on Hexify, or ink. */
	private renderSwatches(editor: MapEditor): void {
		const details = this.contentEl.createEl('details', { cls: 'hexlore-panel-secondary' });
		details.open = this.app.loadLocalStorage(SWATCHES_KEY) === true;
		details.addEventListener('toggle', () => this.app.saveLocalStorage(SWATCHES_KEY, details.open));
		const doc = editor.sketch;
		details.createEl('summary', { text: `Colours and what they become (${doc.swatches.length})` });
		const ro = editor.readOnly;
		const used = new Set(doc.items.map((it) => (it as { swatchId?: string }).swatchId).filter((x): x is string => !!x));
		const meaning = (s: Swatch) => (s.kind === 'biome' && s.terrain ? `biome:${s.terrain}` : s.kind);
		const edit = (i: number, change: (s: Swatch) => void) => {
			const next = doc.swatches.map((s) => cloneSwatch(s));
			change(next[i]!);
			editor.setSketchSwatches(next);
		};
		doc.swatches.forEach((s, i) => {
			const row = new Setting(details);
			row.settingEl.addClass('hexlore-swatch-row');
			row.addColorPicker((c) => c.setValue(s.color).setDisabled(ro).onChange((v) => edit(i, (x) => (x.color = v.toUpperCase()))));
			row.addText((t) => {
				t.setValue(s.name).setDisabled(ro);
				t.inputEl.addEventListener('change', () => edit(i, (x) => (x.name = t.getValue().trim() || x.name)));
			});
			row.addDropdown((d) => {
				d.addOption('none', 'Ink (notes only)');
				for (const t of TERRAINS) if (t !== 'default') d.addOption(`biome:${t}`, `Biome: ${t}`);
				d.addOption('river', 'River');
				d.addOption('road', 'Road');
				d.addOption('trail', 'Trail');
				d.setValue(meaning(s))
					.setDisabled(ro)
					.onChange((v) =>
						edit(i, (x) => {
							if (v.startsWith('biome:')) {
								x.kind = 'biome';
								x.terrain = v.slice(6) as Terrain;
							} else {
								x.kind = v as Swatch['kind'];
								x.terrain = null;
							}
							x.variant = 0;
						}),
					);
			});
			row.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip(used.has(s.id) ? 'In use: erase what is drawn with it first' : 'Remove this colour')
					.setDisabled(ro || used.has(s.id) || doc.swatches.length <= 1)
					.onClick(() => editor.setSketchSwatches(doc.swatches.filter((_, j) => j !== i).map(cloneSwatch), 'Remove colour')),
			);
		});
		new Setting(details).addButton((b) =>
			b
				.setButtonText('Add a colour')
				.setDisabled(ro)
				.onClick(() => {
					let n = 1;
					while (doc.swatch(`custom:${n}`)) n++;
					editor.setSketchSwatches([...doc.swatches.map(cloneSwatch), new Swatch(`custom:${n}`, `colour ${n}`, '#D4A84A')], 'Add colour');
				}),
		);
	}

	// ----- the player view (item 2.6) -------------------------------------------------

	/** The players' travel votes, while this map is served. Starting and
	 *  stopping the player view is the top bar's players button. */
	private renderVotes(file: TFile | null, editor: MapEditor): void {
		const el = this.contentEl;
		const p = this.players;
		if (!file || !p.serves(file)) return;
		this.section('Travel votes');
		const results = p.votes();
		if (!results.length) {
			el.createDiv({ cls: 'setting-item-description', text: 'None yet: players click a hex on their map to vote for where the party goes next.' });
			return;
		}
		const list = el.createDiv({ cls: 'hexlore-panel-notes' });
		for (const r of results) {
			const row = list.createDiv({ cls: 'hexlore-note-row hexlore-vote-row' });
			row.createSpan({ cls: 'hexlore-vote-count', text: String(r.voterNames.length) });
			const m = /^q(-?\d+)_r(-?\d+)$/.exec(r.hexId);
			const label = editor.model.hexes.get(r.hexId)?.name || (m ? displayIdFor(Number(m[1]), Number(m[2])) : r.hexId);
			const a = row.createEl('a', { text: label, cls: 'internal-link' });
			a.addEventListener('click', (e) => {
				e.preventDefault();
				this.map?.showHexes(new Set([r.hexId]), `Votes for ${label}`);
			});
			row.createSpan({ cls: 'hexlore-vote-names', text: r.voterNames.join(', ') });
			if (m && !editor.readOnly) {
				const go = asButton(row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': `Travel to ${label}` } }));
				setIcon(go, 'footprints');
				go.addEventListener('click', () => new TravelModal({ app: this.app, index: file, editor, clearVotes: () => p.clearVotes() }, [Number(m[1]), Number(m[2])], r).open());
			}
		}
		new Setting(el).addButton((b) => b.setButtonText('Clear votes').onClick(() => p.clearVotes()));
	}

	// ----- hexes ---------------------------------------------------------------------

	private renderHex(cell: Cell, editor: MapEditor, links: Map<string, string[]>): void {
		const el = this.contentEl;
		const [q, r] = cell;
		const h = editor.model.getHex(q, r);
		const ro = editor.readOnly;
		el.createEl('h4', { text: `${displayIdFor(q, r)}`, cls: 'hexlore-panel-hex' }).createSpan({ cls: 'hexlore-panel-coords', text: `  q${q} r${r}` });

		new Setting(el).setName('Name').setDesc('Shown to players once revealed.').addText((t) => {
			t.setValue(h?.name ?? '').setPlaceholder('Unnamed').setDisabled(ro);
			const commit = () => {
				const given = editor.renameHex(q, r, t.getValue());
				if (given && given !== t.getValue().trim()) new Notice(`"${t.getValue().trim()}" is taken: named it "${given}".`);
			};
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					t.inputEl.blur();
				}
			});
			t.inputEl.addEventListener('blur', commit);
		});

		const facts = el.createDiv({ cls: 'hexlore-panel-facts' });
		const biome = h && h.terrain !== 'default' ? `${title(h.terrain)}${h.terrainVariant ? ` · ${ART.biome(h.terrain)?.variants[h.terrainVariant]?.label ?? ''}` : ''}` : 'Unpainted';
		facts.createDiv({ text: `Terrain: ${biome}` });
		if (h?.feature) facts.createDiv({ text: `Feature: ${title(h.feature)}${h.featureVariant ? ` · ${ART.feature(h.feature)?.variants[h.featureVariant]?.label ?? ''}` : ''}` });
		else if (h?.hasUnknownFeature) facts.createDiv({ text: 'Feature: one this version does not know (kept as is)' });
		const regions = editor.regionsContaining([cell]);
		if (regions.length) facts.createDiv({ text: `Region: ${regions.map((g) => g.name || 'Untitled').join(', ')}` });

		this.renderPlayers([cell], editor);

		this.renderNotes(cell, h?.name ?? null, editor, links);
	}

	/** The hex's notes: principal first; reorder, unlink, relink a broken
	 *  one, add (plan §1.3). Then who is here, and the secondary notes. */
	private renderNotes(cell: Cell, name: string | null, editor: MapEditor, links: Map<string, string[]>): void {
		const el = this.contentEl;
		const id = hexIdFor(...cell);
		const notes = editor.hexNotes(id).length ? editor.hexNotes(id) : (links.get(id) ?? []);
		const ro = editor.readOnly;
		const source = this.indexFile()?.path ?? '';
		this.section('Notes');
		if (!notes.length) {
			el.createDiv({ cls: 'setting-item-description', text: 'No notes linked to this hex yet. Create one, link one, or drag a note from the file explorer onto the hex.' });
		} else {
			const list = el.createDiv({ cls: 'hexlore-panel-notes' });
			notes.forEach((link, i) => {
				const row = list.createDiv({ cls: 'hexlore-note-row' });
				const broken = !resolveLink(this.app, link, source);
				this.noteLink(row, link, i === 0);
				const move = (to: number) => {
					const next = [...notes];
					next.splice(to, 0, ...next.splice(i, 1));
					editor.setHexNotes(id, next, 'Reorder notes');
				};
				const button = (icon: string, label: string, disabled: boolean, action: () => void) => {
					const b = asButton(row.createDiv({ cls: 'clickable-icon' }));
					setIcon(b, icon);
					b.setAttr('aria-label', label);
					if (disabled) setDisabled(b, true);
					else b.addEventListener('click', action);
				};
				if (broken) {
					row.addClass('is-broken');
					button('link', 'The note is missing: link another in its place', ro, () =>
						new NotePicker(this.app, `Relink “${linkPath(link)}” to…`, (file) => {
							const next = [...notes];
							next[i] = this.app.metadataCache.fileToLinktext(file, source, true);
							editor.setHexNotes(id, next, 'Relink note');
						}).open(),
					);
				}
				button('arrow-up', i === 1 ? 'Make it the principal note' : 'Move up', ro || i === 0, () => move(i - 1));
				button('arrow-down', 'Move down', ro || i === notes.length - 1, () => move(i + 1));
				button('x', broken ? 'Remove the broken link' : 'Unlink (the note is kept)', ro, () =>
					editor.setHexNotes(
						id,
						notes.filter((_, j) => j !== i),
						broken ? 'Remove broken link' : 'Unlink note',
					),
				);
			});
			el.createDiv({ cls: 'setting-item-description', text: `The first is the principal note: ${MOD}-hover the hex to preview it, double-click the hex to open it.` });
		}
		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText('New note…')
					.setDisabled(ro)
					.onClick(() => this.newHexNote(cell, name ?? displayIdFor(...cell), editor)),
			)
			.addButton((b) =>
				b
					.setButtonText('Link a note…')
					.setDisabled(ro)
					.onClick(() =>
						new NotePicker(this.app, 'Link a note to this hex', (file) => {
							const link = this.app.metadataCache.fileToLinktext(file, source, true);
							const current = editor.hexNotes(id);
							if (!current.includes(link)) editor.setHexNotes(id, [...current, link], `Link “${file.basename}”`);
						}).open(),
					),
			);

		const files = notes.map((l) => resolveLink(this.app, l, source)).filter((f): f is TFile => !!f);
		this.renderPeople(files);
		this.renderSecondary(files);
	}

	/** NPCs and quests here: those whose `location` is one of the hex's notes,
	 *  and those the hex lists itself. */
	private renderPeople(files: TFile[]): void {
		if (!files.length) return;
		const people = peopleAt(this.app, new Set(files.map((f) => f.path)));
		if (!people.length) return;
		this.section('People and quests here');
		const list = this.contentEl.createDiv({ cls: 'hexlore-panel-notes' });
		for (const f of people) {
			const row = list.createDiv({ cls: 'hexlore-note-row' });
			const icon = row.createDiv({ cls: 'hexlore-note-kind' });
			setIcon(icon, KIND_ICON[noteKind(this.app, f)]);
			this.fileLink(row, f);
		}
	}

	/** The notes the main notes link to (Obsidian's outgoing links): the map
	 *  does not store them; listed on request. */
	private renderSecondary(files: TFile[]): void {
		if (!files.length) return;
		const main = new Set(files.map((f) => f.path));
		const seen = new Set<string>();
		const found: TFile[] = [];
		const missing: string[] = [];
		for (const f of files) {
			const out = outgoingLinks(this.app, f);
			for (const g of out.resolved) {
				if (main.has(g.path) || seen.has(g.path) || g.path.endsWith('.hexmap.md')) continue;
				seen.add(g.path);
				found.push(g);
			}
			for (const u of out.unresolved) if (!missing.includes(u)) missing.push(u);
		}
		if (!found.length && !missing.length) return;
		const details = this.contentEl.createEl('details', { cls: 'hexlore-panel-secondary' });
		details.open = this.app.loadLocalStorage(SECONDARY_KEY) === true;
		details.addEventListener('toggle', () => this.app.saveLocalStorage(SECONDARY_KEY, details.open));
		details.createEl('summary', { text: `Linked from these notes (${found.length + missing.length})` });
		const list = details.createDiv({ cls: 'hexlore-panel-notes' });
		for (const f of found) this.fileLink(list.createDiv({ cls: 'hexlore-note-row' }), f);
		for (const m of missing) list.createDiv({ cls: 'hexlore-note-row is-broken' }).createSpan({ cls: 'internal-link is-unresolved', text: m });
	}

	private fileLink(parent: HTMLElement, file: TFile): void {
		const a = parent.createEl('a', { text: file.basename, cls: 'internal-link' });
		a.addEventListener('click', (e) => {
			e.preventDefault();
			this.openFromPanel(file.path, '', a, e);
		});
		a.addEventListener('mouseover', (e) =>
			this.app.workspace.trigger('hover-link', { event: e, source: HOVER_SOURCE, hoverParent: this, targetEl: a, linktext: file.path, sourcePath: '' }),
		);
	}

	/** "New note…" for the selected hex, opened as the map opens notes. */
	private newHexNote(cell: Cell, label: string, editor: MapEditor): void {
		const index = this.indexFile();
		const map = this.map;
		if (!index || !map) return;
		newHexNote(this.app, {
			heading: 'New note for this hex',
			index,
			cell,
			label,
			editor,
			templatesFolder: this.settings().templatesFolder,
			opened: (file) => map.openNoteAt(file.path, '', map.screenPointOf(cell)),
		});
	}

	/** Open a note from the panel: as the map opens notes, the floating
	 *  window beside the link; Ctrl/Cmd: a new tab. */
	private openFromPanel(linktext: string, sourcePath: string, a: HTMLElement, e: MouseEvent): void {
		if (e.ctrlKey || e.metaKey) {
			void this.app.workspace.openLinkText(linktext, sourcePath, 'tab');
			return;
		}
		openNote(this.app, this.settings().noteOpening, linktext, sourcePath, { parent: this, el: a, x: e.clientX, y: e.clientY });
	}

	private noteLink(parent: HTMLElement, link: string, principal: boolean): void {
		const [path, alias] = link.split('|') as [string, string | undefined];
		const a = parent.createEl('a', { text: alias ?? path, cls: `internal-link${principal ? ' is-principal' : ''}` });
		const source = this.map?.mapState().file?.path ?? '';
		if (!this.app.metadataCache.getFirstLinkpathDest(path.split('#')[0]!, source)) a.addClass('is-unresolved');
		a.addEventListener('click', (e) => {
			e.preventDefault();
			this.openFromPanel(path, source, a, e);
		});
		a.addEventListener('mouseover', (e) =>
			this.app.workspace.trigger('hover-link', { event: e, source: HOVER_SOURCE, hoverParent: this, targetEl: a, linktext: path, sourcePath: source }),
		);
	}

	private renderMany(cells: Cell[], editor: MapEditor): void {
		this.contentEl.createEl('h4', { text: `${cells.length} hexes selected`, cls: 'hexlore-panel-hex' });
		this.renderPlayers(cells, editor);
	}

	/** Player visibility: reveal / hide, line of sight, the feature's secrecy. */
	private renderPlayers(cells: Cell[], editor: MapEditor): void {
		const el = this.contentEl;
		this.section('Players');
		const revealed = editor.allRevealed(cells);
		const ro = editor.readOnly;
		const multi = cells.length > 1;
		new Setting(el)
			.setName(revealed ? (multi ? 'All revealed' : 'Revealed') : multi ? 'Not all revealed' : 'Hidden by fog')
			.addButton((b) =>
				b
					.setButtonText(revealed ? 'Hide' : 'Reveal')
					.setDisabled(ro)
					.onClick(() => editor.setRevealed(cells, !revealed)),
			)
			.addButton((b) =>
				b
					.setButtonText('Reveal + line of sight')
					.setTooltip('Reveal what can be seen from here, by terrain height')
					.setDisabled(ro || revealed)
					.onClick(() => {
						const n = editor.revealWithSight(cells).length;
						new Notice(n ? `Revealed ${plural(n, 'hex', 'hexes')} by line of sight` : 'Line of sight added nothing', 2500);
					}),
			);
		if (editor.anyFeature(cells)) {
			const hidden = editor.allFeaturesHidden(cells);
			new Setting(el)
				.setName('Keep the feature secret')
				.setDesc('Players see the biome only: no icon, no name.')
				.addToggle((t) => t.setValue(hidden).setDisabled(ro).onChange((v) => editor.setFeatureHidden(cells, v)));
		}
	}

	// ----- rivers and routes -----------------------------------------------------------

	private renderLine(line: { kind: LineKind; id: string }, held: number | null, editor: MapEditor): void {
		const el = this.contentEl;
		const ro = editor.readOnly;
		const m = editor.model;
		const map = this.map!;
		if (line.kind === 'river') {
			const r = m.rivers.get(line.id);
			if (!r) return;
			el.createEl('h4', { text: 'River', cls: 'hexlore-panel-hex' }).createSpan({ cls: 'hexlore-panel-coords', text: `  ${plural(r.nodes.length, 'point')} · width ${r.width.toFixed(2)}` });
		} else {
			const r = m.routes.get(line.id);
			if (!r) return;
			el.createEl('h4', { text: title(r.kind), cls: 'hexlore-panel-hex' }).createSpan({ cls: 'hexlore-panel-coords', text: `  ${plural(r.nodes.length, 'point')}` });
			new Setting(el).setName('Kind').addDropdown((d) => {
				for (const k of ROUTE_KINDS) d.addOption(k.kind, k.label);
				if (!ROUTE_KINDS.some((k) => k.kind === r.kind)) d.addOption(r.kind, `${r.kind} (newer app)`);
				d.setValue(r.kind)
					.setDisabled(ro)
					.onChange((v) => editor.updateRoute(line.id, { kind: v }));
			});
			new Setting(el).setName('Colour').addColorPicker((c) =>
				c
					.setValue(r.color)
					.setDisabled(ro)
					.onChange((v) => editor.updateRoute(line.id, { color: v.toUpperCase() })),
			);
			new Setting(el)
				.setName('Shown to players')
				.setDesc(r.kind === 'border' ? 'Borders are GM knowledge unless you say so.' : 'Where it crosses revealed hexes.')
				.addToggle((t) =>
					t
						.setValue(r.playerVisible)
						.setDisabled(ro)
						.onChange((v) => editor.updateRoute(line.id, { playerVisible: v })),
				);
		}
		el.createDiv({
			cls: 'setting-item-description',
			text: `Drag a point to move it; double-click the line to add one; click a point and press Delete to remove it. Delete with no point held removes the whole ${line.kind === 'river' ? 'river' : 'line'}.${line.kind === 'river' ? ' Right-click it for its width.' : ''}`,
		});
		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText(held !== null ? 'Delete the held point' : 'Delete a point: click it first')
					.setDisabled(ro || held === null)
					.onClick(() => {
						if (held !== null && !editor.removeLinePoint(line.kind, line.id, held)) map.selectLine(null);
						else map.selectLine(line);
					}),
			)
			.addButton((b) =>
				b
					.setButtonText(`Delete ${line.kind === 'river' ? 'river' : 'route'}`)
					.setDestructive()
					.setDisabled(ro)
					.onClick(() => {
						editor.removeLine(line.kind, line.id);
						map.selectLine(null);
					}),
			);
	}

	// ----- threads -----------------------------------------------------------------------

	private renderThread(id: string, editor: MapEditor): void {
		const t = editor.model.threads.get(id);
		if (!t) return;
		const el = this.contentEl;
		const ro = editor.readOnly;
		const map = this.map!;
		const label = (hexId: string) => {
			const h = editor.model.hexes.get(hexId);
			const m = /^q(-?\d+)_r(-?\d+)$/.exec(hexId);
			return h?.name || (m ? displayIdFor(Number(m[1]), Number(m[2])) : hexId);
		};
		const head = el.createEl('h4', { text: t.label || t.type, cls: 'hexlore-panel-hex' });
		head.style.setProperty('--thread', t.effectiveColor());
		head.addClass('hexlore-panel-thread');
		const facts = el.createDiv({ cls: 'hexlore-panel-facts' });
		facts.createDiv({ text: `${label(t.fromHex)} ${t.direction === 'one-way' ? '→' : '↔'} ${label(t.toHex)}` });
		facts.createDiv({ text: `${t.type} · ${title(t.status)}` });
		new Setting(el)
			.addButton((b) =>
				b
					.setButtonText('Edit thread…')
					.setDisabled(ro)
					.onClick(() => map.threadDialog(id, (spec) => editor.updateThread(id, spec))),
			)
			.addButton((b) =>
				b
					.setButtonText('Delete')
					.setDestructive()
					.setDisabled(ro)
					.onClick(() => {
						editor.removeThread(id);
						map.selectThread(null);
					}),
			);
	}

	// ----- regions -------------------------------------------------------------------------

	private renderRegions(state: MapPanelState, editor: MapEditor): void {
		const el = this.contentEl;
		const map = this.map!;
		const ro = editor.readOnly;
		this.section('Regions');
		const regions = [...editor.model.regions.values()].sort((a, b) => a.zOrder - b.zOrder || (a.id < b.id ? -1 : 1));
		const list = el.createDiv({ cls: 'hexlore-region-list' });
		for (const g of regions) {
			const row = list.createDiv({ cls: 'hexlore-region-row' });
			row.toggleClass('is-active', g.id === state.activeRegion);
			const chip = row.createDiv({ cls: 'hexlore-swatch is-small' });
			chip.style.setProperty('--chip', g.color);
			const name = row.createDiv({ cls: 'hexlore-region-name', text: g.name || 'Untitled' });
			row.createDiv({ cls: 'hexlore-region-count', text: String(g.cells.length) });
			const pick = () => map.setActiveRegion(g.id);
			name.addEventListener('click', pick);
			chip.addEventListener('click', pick);
		}
		if (!regions.length) el.createDiv({ cls: 'setting-item-description', text: 'No regions yet. A region is a named set of hexes with a note: its encounters are rolled from there.' });
		new Setting(el).addButton((b) =>
			b
				.setButtonText('New region…')
				.setDisabled(ro)
				.onClick(() =>
					new NamePrompt(this.app, 'New region', '', (name) => {
						const g = editor.createRegion(name);
						if (g) {
							map.setActiveRegion(g.id);
							if (state.tool !== 'region') map.setTool('region');
						}
					}).open(),
				),
		);

		const g = state.activeRegion ? editor.model.regions.get(state.activeRegion) : undefined;
		if (!g) {
			if (state.file) this.renderRolls(state.file, state);
			return;
		}
		el.createEl('h4', { text: g.name || 'Untitled', cls: 'hexlore-panel-hex' }).createSpan({ cls: 'hexlore-panel-coords', text: `  ${plural(g.cells.length, 'hex', 'hexes')}` });
		new Setting(el).setName('Name').addText((t) => {
			t.setValue(g.name).setDisabled(ro);
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') t.inputEl.blur();
			});
			t.inputEl.addEventListener('blur', () => {
				if (t.getValue().trim() && t.getValue().trim() !== g.name) editor.renameRegion(g.id, t.getValue());
			});
		});
		new Setting(el).setName('Colour').addColorPicker((c) =>
			c
				.setValue(g.color)
				.setDisabled(ro)
				.onChange((v) => editor.setRegionColor(g.id, v.toUpperCase())),
		);
		new Setting(el)
			.setName('Region brush removes')
			.setDesc(`Off: a drag adds hexes. ${MOD}-drag always does the other.`)
			.addToggle((t) => t.setValue(state.regionErase).onChange((v) => map.setRegionErase(v)));

		// Its note: where its encounters are.
		const links = state.regionLinks.get(g.id) ?? [];
		const note = links[0];
		const notes = new Setting(el).setName('Note');
		if (note) {
			this.noteLink(notes.descEl, note, true);
			notes.addButton((b) =>
				b
					.setButtonText('Unlink')
					.setDisabled(ro)
					.onClick(() => void this.setRegionNote(g.id, null)),
			);
		} else {
			notes.setDesc('None yet: its encounters are rolled from its note.');
			notes.addButton((b) =>
				b
					.setButtonText('Create')
					.setDisabled(ro)
					.onClick(() => void this.createRegionNote(g.id, g.name || 'Region')),
			);
			notes.addButton((b) =>
				b
					.setButtonText('Link…')
					.setDisabled(ro)
					.onClick(() => new NotePicker(this.app, 'Link a note to this region', (file) => void this.setRegionNote(g.id, file)).open()),
			);
		}
		if (note && state.file) this.renderEncounters(state.file, { id: g.id, name: g.name || 'Untitled', link: note });
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Delete region…')
				.setDestructive()
				.setDisabled(ro)
				.onClick(() =>
					new ConfirmModal(this.app, 'Delete region', `Delete “${g.name || 'Untitled'}”? Its hexes are not touched, and its note stays.`, () => {
						editor.removeRegion(g.id);
						void this.setRegionNote(g.id, null);
						map.setActiveRegion(null);
					}).open(),
				),
		);
		if (state.file) this.renderRolls(state.file, state);
	}

	/** The active region's encounters: its tables (day / night…), the check
	 *  from its note's `encounter-chance`, and the roll. */
	private renderEncounters(index: TFile, region: RegionRef): void {
		const row = new Setting(this.contentEl).setName('Encounters');
		const done = (e: RollEntry | null) => {
			if (e) this.render();
		};
		row.addButton((b) => b.setButtonText('Check').setTooltip('The encounter check: roll the chance in the note’s properties (“encounter-chance: 2” = 2 in 6), then the table on a hit').onClick(() => void checkRegion(this.app, index, region).then(done)));
		row.addButton((b) => b.setButtonText('Roll').setCta().onClick(() => void rollRegion(this.app, index, region).then(done)));
		// The tables and the chance are in the note: filled in once it is read.
		void readRegionNote(this.app, index, region.link).then((note) => {
			if (!row.settingEl.isConnected || !note) return;
			const parts: string[] = [];
			if (note.chance) parts.push(`Check ${formatChance(note.chance)}.`);
			if (!note.tables.length) parts.push('Its note has no “## Encounters” table or list yet.');
			row.setDesc(parts.join(' '));
			if (note.tables.length > 1) {
				const picked = chosenTable(index, region.id) ?? note.tables[0]!.name;
				row.addDropdown((d) => {
					for (const t of note.tables) d.addOption(t.name, t.name || 'Encounters');
					d.setValue(picked).onChange((v) => chooseTable(index, region.id, v));
					row.controlEl.prepend(d.selectEl);
				});
			}
		});
	}

	/** This session's rolls on the map, newest first: copy one, add it to
	 *  the session note, roll its table again. */
	private renderRolls(index: TFile, state: MapPanelState): void {
		const rolls = rollHistory(index);
		if (!rolls.length) return;
		const el = this.contentEl;
		el.createEl('h4', { text: 'Rolls this session', cls: 'hexlore-panel-hex' });
		const session = sessionNote(this.app, index);
		const list = el.createDiv({ cls: 'hexlore-panel-notes hexlore-rolls' });
		for (const e of rolls.slice(0, 10)) {
			const row = list.createDiv({ cls: 'hexlore-note-row hexlore-roll-row' });
			const d = new Date(e.at);
			row.createSpan({ cls: 'hexlore-roll-time', text: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` });
			const text = row.createDiv({ cls: 'hexlore-roll-text', text: e.line });
			for (const line of e.detail) text.createDiv({ cls: 'hexlore-roll-detail', text: line });
			const action = (icon: string, label: string, run: () => void) => {
				const b = asButton(row.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } }));
				setIcon(b, icon);
				b.addEventListener('click', run);
			};
			action('copy', 'Copy', () => void navigator.clipboard.writeText(entryText(e)).then(() => new Notice('Copied.')));
			action('file-plus', session ? `Add to “${session.basename}”` : 'Add to the session note (none yet)', () => void addToSessionNote(this.app, index, e));
			const region = state.regionLinks.get(e.regionId)?.[0];
			const g = state.editor?.model.regions.get(e.regionId);
			if (e.table !== undefined && region && g) {
				action('dices', 'Roll this table again', () => void rollRegion(this.app, index, { id: g.id, name: g.name || 'Untitled', link: region }, e.table).then((r) => r && this.render()));
			}
		}
		new Setting(el).addButton((b) =>
			b.setButtonText('Clear the list').onClick(() => {
				clearRollHistory(index);
				this.render();
			}),
		);
	}

	private indexFile(): TFile | null {
		return this.map?.mapState().file ?? null;
	}

	private async setRegionNote(regionId: string, file: TFile | null): Promise<void> {
		const index = this.indexFile();
		if (!index) return;
		const link = file ? this.app.metadataCache.fileToLinktext(file, index.path) : null;
		await updateRegionLinks(this.app, index, (regions) => {
			if (link) regions.set(regionId, [link]);
			else regions.delete(regionId);
			return regions;
		});
	}

	/** A note in the Regions section's folder, with an encounters table. */
	private async createRegionNote(regionId: string, name: string): Promise<void> {
		const index = this.indexFile();
		if (!index) return;
		const sections = sectionsOf(this.app, index) ?? [...DEFAULT_SECTIONS];
		const folder = sections.find((s) => s.name === 'Regions')?.folder ?? 'Regions';
		const base = normalizePath(`${folder}/${name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim() || 'Region'}`);
		let path = `${base}.md`;
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
		if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => undefined);
		const file = await this.app.vault.create(path, `---\nencounter-chance: 1 in 6\n---\n\n# ${name}\n\n## Encounters\n\n| d6 | Encounter |\n|---|---|\n| 1-2 | |\n| 3-4 | |\n| 5-6 | |\n`);
		await this.setRegionNote(regionId, file);
		await this.app.workspace.getLeaf('tab').openFile(file);
	}
}

/** A one-line name prompt. */
class NamePrompt extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly initial: string,
		private readonly accept: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		let value = this.initial;
		const done = () => {
			this.close();
			if (value.trim()) this.accept(value.trim());
		};
		new Setting(this.contentEl).setName('Name').addText((t) => {
			t.setValue(this.initial).onChange((v) => (value = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					done();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(done));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly text: string,
		private readonly accept: () => void,
		private readonly action = 'Delete',
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
					.setDestructive()
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

/** "New note" for a hex: a title (prefilled with the hex's label), a
 *  section, a kind and a template; the note is created there and linked to
 *  the hex, then handed to [opened]. An NPC or a quest made here gets the
 *  hex's principal note as its place. */
export function newHexNote(
	app: App,
	o: { heading: string; index: TFile; cell: Cell; label: string; editor: MapEditor; templatesFolder: string; opened: (file: TFile) => void },
): void {
	const { index, cell, editor } = o;
	const id = hexIdFor(...cell);
	const principal = editor.hexNotes(id)[0];
	const place = principal ? resolveLink(app, principal, index.path) : null;
	new NewNoteModal(app, {
		heading: o.heading,
		title: o.label,
		sections: sectionsOf(app, index) ?? [...DEFAULT_SECTIONS],
		section: 'Places',
		templates: templateFiles(app, o.templatesFolder),
		accept: async (choice) => {
			const file = await createNote(app, {
				...choice,
				vars: { title: choice.title, hex: displayIdFor(...cell), map: index.basename.replace(/\.hexmap$/, '') },
				location: place && (choice.kind === 'npc' || choice.kind === 'quest') ? app.metadataCache.fileToLinktext(place, '', true) : null,
			});
			editor.setHexNotes(id, [...editor.hexNotes(id), app.metadataCache.fileToLinktext(file, index.path, true)], `New note “${file.basename}”`);
			o.opened(file);
		},
	}).open();
}

export interface NewNoteChoice {
	title: string;
	folder: string;
	kind: NoteKind;
	template: TFile | null;
}

/** "New note": a title, the section it goes in, its kind and template. */
export class NewNoteModal extends Modal {
	constructor(
		app: App,
		private readonly opts: {
			heading: string;
			title: string;
			sections: Section[];
			/** The section chosen at first (by name). */
			section: string;
			templates: TFile[];
			accept: (choice: NewNoteChoice) => Promise<void>;
		},
	) {
		super(app);
	}

	onOpen(): void {
		const o = this.opts;
		this.setTitle(o.heading);
		const first = o.sections.find((s) => s.name === o.section) ?? o.sections[0];
		const pick: NewNoteChoice = { title: o.title, folder: first?.folder ?? '', kind: defaultKindFor(first?.name ?? ''), template: null };
		const templateOf = (s: Section | undefined) => (s?.template ? (o.templates.find((t) => t.path === s.template) ?? null) : null);
		pick.template = templateOf(first);
		let kindDrop: DropdownComponent | null = null;
		let templateDrop: DropdownComponent | null = null;
		const done = () => {
			this.close();
			void o.accept({ ...pick }).catch((e: unknown) => new Notice(`Could not create the note: ${(e as Error).message}`));
		};
		new Setting(this.contentEl)
			.setName('Title')
			.setDesc('Prefilled with the hex’s name; the two stay independent after.')
			.addText((t) => {
				t.setValue(pick.title).onChange((v) => (pick.title = v));
				t.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						done();
					}
				});
				window.setTimeout(() => t.inputEl.select(), 0);
			});
		new Setting(this.contentEl)
			.setName('Section')
			.setDesc('The folder it goes in.')
			.addDropdown((d) => {
				for (const s of o.sections) d.addOption(s.folder, s.name);
				d.setValue(pick.folder).onChange((v) => {
					pick.folder = v;
					const s = o.sections.find((x) => x.folder === v);
					pick.kind = defaultKindFor(s?.name ?? '');
					kindDrop?.setValue(pick.kind);
					pick.template = templateOf(s);
					templateDrop?.setValue(pick.template?.path ?? '');
				});
			});
		new Setting(this.contentEl)
			.setName('Kind')
			.setDesc('Characters and quests get their fields in the frontmatter, pointing at their place.')
			.addDropdown((d) => {
				kindDrop = d;
				for (const k of NOTE_KINDS) d.addOption(k.kind, k.label);
				d.setValue(pick.kind).onChange((v) => (pick.kind = NOTE_KINDS.find((k) => k.kind === v)?.kind ?? 'note'));
			});
		new Setting(this.contentEl)
			.setName('Template')
			.setDesc(o.templates.length ? 'From the templates folder (plugin settings).' : 'Put notes in the templates folder (plugin settings) to offer them here.')
			.addDropdown((d) => {
				templateDrop = d;
				d.addOption('', 'None');
				for (const t of o.templates) d.addOption(t.path, t.basename);
				d.setValue(pick.template?.path ?? '').onChange((v) => (pick.template = o.templates.find((t) => t.path === v) ?? null));
			});
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(done));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Pick a note in the vault. */
export class NotePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		placeholder: string,
		private readonly accept: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => !f.path.endsWith('.hexmap.md'));
	}

	getItemText(file: TFile): string {
		return file.path.replace(/\.md$/, '');
	}

	onChooseItem(file: TFile): void {
		this.accept(file);
	}
}
