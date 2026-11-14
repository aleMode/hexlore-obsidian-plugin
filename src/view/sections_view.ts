// The sections sidebar (plan §1.4, item 2.5): the active map's sections,
// each a folder of notes. For browsing and for where a new note lands; it
// never changes what a hex links to. Hovering a note lights up its hexes on
// the map; a note can be dragged onto a hex.
//
// Sections are per CAMPAIGN, in the index's frontmatter. With none set, the
// defaults are shown (and written the first time the list is changed).

import { AbstractInputSuggest, ItemView, Menu, Modal, Notice, Setting, TFile, TFolder, normalizePath, setIcon, type App, type Events, type WorkspaceLeaf } from 'obsidian';
import { displayIdFor } from '../core/hex';
import { hexIdFor } from '../core/hex_data';
import { DEFAULT_SECTIONS, sectionProblems, type Section } from '../storage/hexmap_index';
import { sectionsOf, writeSections } from '../storage/index_file';
import type { HexLoreSettings } from '../settings';
import { asButton } from './a11y';
import { KIND_ICON, NewNoteModal } from './inspector_view';
import { HOVER_SOURCE, MAP_STATE_EVENT, MapView } from './map_view';
import { createNote, hexesOfNote, noteKind, notesInFolder, templateFiles } from './vault_notes';

export const SECTIONS_VIEW = 'hexlore-sections';

const openKey = (map: string, folder: string) => `hexlore-section-open:${map}:${folder}`;

export class SectionsView extends ItemView {
	private map: MapView | null = null;
	private timer = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly settings: () => HexLoreSettings,
	) {
		super(leaf);
	}

	getViewType(): string {
		return SECTIONS_VIEW;
	}

	getDisplayText(): string {
		return 'Map sections';
	}

	getIcon(): string {
		return 'library';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('hexlore-sections');
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf?.view instanceof MapView && leaf.view !== this.map) this.follow(leaf.view);
			}),
		);
		this.registerEvent(
			(this.app.workspace as Events).on(MAP_STATE_EVENT, (view: unknown) => {
				if (!(view instanceof MapView)) return;
				if (view.closed) {
					if (this.map === view) this.follow(this.otherMap(view));
				} else if (!this.map) this.follow(view);
				else if (this.map === view) this.soon();
			}),
		);
		// A note added, moved, renamed or retyped changes the lists.
		this.registerEvent(this.app.vault.on('create', () => this.soon()));
		this.registerEvent(this.app.vault.on('delete', () => this.soon()));
		this.registerEvent(this.app.vault.on('rename', () => this.soon()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.soon()));
		const active = this.app.workspace.getActiveViewOfType(MapView) ?? this.app.workspace.getLeavesOfType('hexlore-map')[0]?.view;
		this.follow(active instanceof MapView ? active : null);
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.timer);
		this.map?.setHoverHighlight(null);
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

	/** Re-render shortly: events come in bursts (a rename touches many). */
	private soon(): void {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.render(), 150);
	}

	private index(): TFile | null {
		return this.map?.mapState().file ?? null;
	}

	private sections(): { list: Section[]; custom: boolean } {
		const index = this.index();
		const set = index ? sectionsOf(this.app, index) : null;
		return set ? { list: set, custom: true } : { list: [...DEFAULT_SECTIONS], custom: false };
	}

	private render(): void {
		const el = this.contentEl;
		const scroll = el.scrollTop;
		el.empty();
		const index = this.index();
		if (!this.map || !index) {
			el.createDiv({ cls: 'hexlore-panel-empty', text: 'Open a map to see its sections.' });
			return;
		}
		const map = this.map;
		const header = el.createDiv({ cls: 'hexlore-panel-header' });
		header.createDiv({ cls: 'hexlore-panel-title', text: index.basename.replace(/\.hexmap$/, '') });
		header.createDiv({ cls: 'hexlore-panel-status', text: 'Sections: folders of notes for this campaign' });

		const { list, custom } = this.sections();
		for (const p of sectionProblems(list)) el.createDiv({ cls: 'hexlore-warning', text: p });
		const byNote = map.hexesByNote();
		const selection = map.mapState().selection;
		const editor = map.mapState().editor;

		list.forEach((section, i) => {
			const notes = notesInFolder(this.app, section.folder);
			const details = el.createEl('details', { cls: 'hexlore-section' });
			details.open = this.app.loadLocalStorage(openKey(index.path, section.folder)) !== false;
			details.addEventListener('toggle', () => this.app.saveLocalStorage(openKey(index.path, section.folder), details.open));
			const summary = details.createEl('summary', { cls: 'hexlore-section-head' });
			summary.createSpan({ cls: 'hexlore-section-name', text: section.name });
			summary.createSpan({ cls: 'hexlore-section-count', text: String(notes.length) });
			const add = asButton(summary.createDiv({ cls: 'clickable-icon' }));
			setIcon(add, 'file-plus');
			add.setAttr('aria-label', `New note in ${section.name}`);
			add.addEventListener('click', (e) => {
				e.preventDefault();
				this.newNote(section);
			});
			const more = asButton(summary.createDiv({ cls: 'clickable-icon' }));
			setIcon(more, 'more-horizontal');
			more.setAttr('aria-label', 'Section options');
			more.addEventListener('click', (e) => {
				e.preventDefault();
				this.sectionMenu(e, list, i);
			});

			const body = details.createDiv({ cls: 'hexlore-section-notes' });
			if (!(this.app.vault.getAbstractFileByPath(section.folder) instanceof TFolder)) {
				body.createDiv({ cls: 'setting-item-description', text: `No folder “${section.folder}” yet: it is made with the first note.` });
			} else if (!notes.length) {
				body.createDiv({ cls: 'setting-item-description', text: 'No notes yet.' });
			}
			for (const file of notes) {
				const hexes = hexesOfNote(this.app, file, byNote);
				const row = body.createDiv({ cls: 'hexlore-note-row hexlore-section-note' });
				row.draggable = true;
				const icon = row.createDiv({ cls: 'hexlore-note-kind' });
				setIcon(icon, KIND_ICON[noteKind(this.app, file)]);
				const sub = file.parent && file.parent.path !== section.folder ? file.parent.path.slice(section.folder.length + 1) + '/' : '';
				const name = row.createDiv({ cls: 'hexlore-section-note-name', text: file.basename });
				if (sub) name.prepend(createSpan({ cls: 'hexlore-section-sub', text: sub }));
				if (hexes.size) {
					const badge = row.createDiv({ cls: 'hexlore-hex-badge', text: String(hexes.size) });
					setIcon(badge.createSpan({ prepend: true }), 'hexagon');
					badge.setAttr('aria-label', `On ${hexes.size === 1 ? 'one hex' : `${hexes.size} hexes`}: click to show`);
					badge.addEventListener('click', (e) => {
						e.stopPropagation();
						map.showHexes(hexes, file.basename);
					});
				}
				row.addEventListener('click', (e) => void this.open(file, e.ctrlKey || e.metaKey));
				row.addEventListener('mouseenter', (e) => {
					map.setHoverHighlight(hexes);
					this.app.workspace.trigger('hover-link', { event: e, source: HOVER_SOURCE, hoverParent: this, targetEl: row, linktext: file.path, sourcePath: '' });
				});
				row.addEventListener('mouseleave', () => map.setHoverHighlight(null));
				row.addEventListener('dragstart', (e) => {
					// Obsidian's own drag where it exists (private API); a wikilink otherwise.
					const dm = (this.app as App & { dragManager?: { dragFile?: (e: DragEvent, f: TFile) => unknown; onDragStart?: (e: DragEvent, d: unknown) => void } }).dragManager;
					const data = dm?.dragFile?.(e, file);
					if (data && dm?.onDragStart) dm.onDragStart(e, data);
					else e.dataTransfer?.setData('text/plain', `[[${this.app.metadataCache.fileToLinktext(file, index.path, true)}]]`);
				});
				row.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					const menu = new Menu();
					menu.addItem((it) => it.setTitle('Open beside the map').setIcon('file').onClick(() => void this.open(file, false)));
					menu.addItem((it) => it.setTitle('Open in a new tab').setIcon('file-plus').onClick(() => void this.open(file, true)));
					if (hexes.size) menu.addItem((it) => it.setTitle('Show its hexes').setIcon('locate').onClick(() => map.showHexes(hexes, file.basename)));
					if (editor && !editor.readOnly && selection.length === 1) {
						const id = hexIdFor(...selection[0]!);
						const link = this.app.metadataCache.fileToLinktext(file, index.path, true);
						const current = editor.hexNotes(id);
						menu.addItem((it) =>
							it
								.setTitle(`Link to the selected hex (${displayIdFor(...selection[0]!)})`)
								.setIcon('link')
								.setDisabled(current.includes(link))
								.onClick(() => editor.setHexNotes(id, [...current, link], `Link “${file.basename}”`)),
						);
					}
					menu.showAtMouseEvent(e);
				});
			}
		});

		new Setting(el)
			.addButton((b) => b.setButtonText('Add section…').onClick(() => this.editSection(list, null)))
			.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip('Restore the default sections (folders and notes are not touched)')
					.setDisabled(!custom)
					.onClick(() => void this.save([...DEFAULT_SECTIONS])),
			);
		if (!custom) el.createDiv({ cls: 'setting-item-description', text: 'These are the default sections. Changing them saves the list in the map’s note.' });
		el.scrollTop = scroll;
	}

	/** Open [file] without replacing the map: in a Markdown pane if there is
	 *  one, else beside the map; [tab]: a new tab. */
	private async open(file: TFile, tab: boolean): Promise<void> {
		const ws = this.app.workspace;
		if (tab) return ws.getLeaf('tab').openFile(file);
		const md = ws.getLeavesOfType('markdown')[0];
		await (md ?? ws.getLeaf('split')).openFile(file);
		if (md) await ws.revealLeaf(md);
	}

	private newNote(section: Section): void {
		const index = this.index();
		if (!index) return;
		const { list } = this.sections();
		new NewNoteModal(this.app, {
			heading: `New note in ${section.name}`,
			title: '',
			sections: list,
			section: section.name,
			templates: templateFiles(this.app, this.settings().templatesFolder),
			accept: async (choice) => {
				const file = await createNote(this.app, { ...choice, vars: { title: choice.title, hex: '', map: index.basename.replace(/\.hexmap$/, '') }, location: null });
				await this.open(file, false);
			},
		}).open();
	}

	private sectionMenu(e: MouseEvent, list: Section[], i: number): void {
		const s = list[i]!;
		const menu = new Menu();
		menu.addItem((it) => it.setTitle('Edit…').setIcon('pencil').onClick(() => this.editSection(list, i)));
		menu.addItem((it) =>
			it
				.setTitle('Move up')
				.setIcon('arrow-up')
				.setDisabled(i === 0)
				.onClick(() => void this.save(swap(list, i, i - 1))),
		);
		menu.addItem((it) =>
			it
				.setTitle('Move down')
				.setIcon('arrow-down')
				.setDisabled(i === list.length - 1)
				.onClick(() => void this.save(swap(list, i, i + 1))),
		);
		menu.addSeparator();
		menu.addItem((it) =>
			it
				.setTitle(`Remove “${s.name}” from the list`)
				.setIcon('x')
				.onClick(() => void this.save(list.filter((_, j) => j !== i))),
		);
		menu.showAtMouseEvent(e);
	}

	/** Add a section ([i] null) or edit one. Nesting and shared folders are
	 *  refused (Q11). */
	private editSection(list: Section[], i: number | null): void {
		new SectionModal(this.app, i === null ? null : list[i]!, templateFiles(this.app, this.settings().templatesFolder), async (s) => {
			const next = [...list];
			if (i === null) next.push(s);
			else next[i] = s;
			const problems = sectionProblems(next);
			if (problems.length) {
				new Notice(`Not saved: ${problems.join('; ')}.`, 6000);
				return false;
			}
			if (!this.app.vault.getAbstractFileByPath(s.folder)) await this.app.vault.createFolder(s.folder).catch(() => undefined);
			await this.save(next);
			return true;
		}).open();
	}

	private async save(list: Section[]): Promise<void> {
		const index = this.index();
		if (!index) return;
		await writeSections(this.app, index, list);
		this.soon();
	}
}

function swap<T>(list: T[], a: number, b: number): T[] {
	const next = [...list];
	[next[a], next[b]] = [next[b]!, next[a]!];
	return next;
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly input: HTMLInputElement,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.input.dispatchEvent(new Event('input'));
		this.close();
	}
}

/** A section: its name, its folder (an existing one, or a new one that is
 *  made), and the template its new notes start from. */
class SectionModal extends Modal {
	constructor(
		app: App,
		private readonly initial: Section | null,
		private readonly templates: TFile[],
		private readonly accept: (s: Section) => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.initial ? 'Edit section' : 'Add section');
		let name = this.initial?.name ?? '';
		let folder = this.initial?.folder ?? '';
		let template = this.initial?.template ?? '';
		let folderTouched = !!this.initial;
		let folderInput: HTMLInputElement | null = null;
		new Setting(this.contentEl).setName('Name').addText((t) => {
			t.setValue(name).onChange((v) => {
				name = v;
				// The folder follows the name until it is set by hand.
				if (!folderTouched && folderInput) {
					folder = v.trim();
					folderInput.value = folder;
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.setName('Folder')
			.setDesc('An existing folder, or a new one (it is made). Its notes, subfolders included, are the section. A section cannot sit inside another.')
			.addText((t) => {
				folderInput = t.inputEl;
				new FolderSuggest(this.app, t.inputEl);
				t.setValue(folder).onChange((v) => {
					folder = v;
					folderTouched = true;
				});
			});
		new Setting(this.contentEl)
			.setName('Template')
			.setDesc('New notes in this section start from it.')
			.addDropdown((d) => {
				d.addOption('', 'None');
				for (const f of this.templates) d.addOption(f.path, f.basename);
				if (template && !this.templates.some((f) => f.path === template)) d.addOption(template, `${template} (not in the templates folder)`);
				d.setValue(template).onChange((v) => (template = v));
			});
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(this.initial ? 'Save' : 'Add')
				.setCta()
				.onClick(async () => {
					const n = name.trim();
					const f = normalizePath(folder.trim().replace(/^\/+|\/+$/g, ''));
					if (!n || !f || f === '/') {
						new Notice('A section needs a name and a folder.');
						return;
					}
					if (await this.accept(template ? { name: n, folder: f, template } : { name: n, folder: f })) this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
