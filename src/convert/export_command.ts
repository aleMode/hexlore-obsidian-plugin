// "Export as a campaign folder…" from Obsidian (plan item 2.7): gathers
// the map, its index links, its sections and the notes (docs/converter.md
// §5.1), plans the Flutter campaign (flutter_export.ts) and writes it with
// Node's fs into a folder OUTSIDE the vault. Desktop only.

import { FileSystemAdapter, Modal, Notice, Setting, TFile, TFolder, type App } from 'obsidian';
import { nodeModule } from '../desktop';
import { kindOf, locationLinks } from '../notes/note_meta';
import { DEFAULT_SECTIONS, parseHexList, parseLinks, REGIONS, type Section } from '../storage/hexmap_index';
import { sectionsOf } from '../storage/index_file';
import type { StoreRegistry } from '../storage/store_registry';
import { dataFolderOf } from '../view/map_view';
import { linkPath } from '../view/vault_notes';
import { planFlutterExport, type VaultNote } from './flutter_export';
import { folderProblem, folderState, writeFlutterCampaign, type Fs } from './write';

/** The notes that go (§5.1): linked from the index, in a section folder, or
 *  the place of an NPC or quest among those. */
async function gatherNotes(app: App, index: TFile, hexLinks: Map<string, string[]>, regionLinks: Map<string, string[]>, sections: Section[]): Promise<Map<string, VaultNote>> {
	const files = new Set<TFile>();
	const add = (f: TFile | null) => {
		if (f && f.extension === 'md' && !f.path.endsWith('.hexmap.md')) files.add(f);
	};
	const resolve = (link: string, from: string) => app.metadataCache.getFirstLinkpathDest(linkPath(link), from);
	for (const list of [...hexLinks.values(), ...regionLinks.values()]) for (const l of list) add(resolve(l, index.path));
	for (const s of sections) {
		const folder = app.vault.getAbstractFileByPath(s.folder);
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (c instanceof TFolder) walk(c);
				else if (c instanceof TFile) add(c);
			}
		};
		if (folder instanceof TFolder) walk(folder);
	}
	for (const f of [...files]) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		const k = kindOf(fm);
		if (k === 'npc' || k === 'quest') for (const l of locationLinks(fm)) add(resolve(l, f.path));
	}
	const out = new Map<string, VaultNote>();
	for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		out.set(f.path, { path: f.path, text: await app.vault.cachedRead(f), frontmatter: app.metadataCache.getFileCache(f)?.frontmatter ?? null });
	}
	return out;
}

/** The vault's folder on disk, or null (not a desktop vault). */
function vaultBase(app: App): string | null {
	const a = app.vault.adapter;
	return a instanceof FileSystemAdapter ? a.getBasePath().replace(/\\/g, '/').replace(/\/+$/, '') : null;
}

export async function exportToFlutter(app: App, stores: StoreRegistry, index: TFile): Promise<void> {
	const fs = await nodeModule('fs');
	if (!fs) {
		new Notice('Exporting a campaign folder needs Obsidian on a computer.');
		return;
	}
	const base = vaultBase(app);
	const name = index.basename.replace(/\.hexmap$/, '');
	const parent = base ? base.slice(0, base.lastIndexOf('/')) : '';
	new ExportModal(app, `${parent}/${name} (HexLore)`, base, fs, async (dir) => {
		const dataDir = dataFolderOf(app, index);
		const store = await stores.acquire(dataDir, name);
		try {
			await store.flush();
			const text = await app.vault.read(index);
			const hexLinks = parseHexList(text).hexes;
			const regionLinks = parseLinks(text, REGIONS).links;
			const sections = sectionsOf(app, index) ?? [...DEFAULT_SECTIONS];
			const notes = await gatherNotes(app, index, hexLinks, regionLinks, sections);
			const plan = planFlutterExport({
				model: store.model,
				indexPath: index.path,
				hexLinks,
				regionLinks,
				sections,
				notes,
				resolve: (link, from) => app.metadataCache.getFirstLinkpathDest(linkPath(link), from)?.path ?? null,
			});
			const r = await writeFlutterCampaign(fs, dir, plan.files);
			new Notice(`Exported “${name}”: ${r.written} files in ${dir}. Open that folder in the desktop app.`, 10000);
			if (r.backupDir) new Notice(`${r.setAside} file${r.setAside === 1 ? '' : 's'} the export no longer has were moved to ${r.backupDir}, not deleted.`, 15000);
			for (const r of plan.reports) new Notice(r, 10000);
		} finally {
			await stores.release(dataDir);
		}
	}).open();
}

class ExportModal extends Modal {
	constructor(
		app: App,
		private readonly initial: string,
		private readonly base: string | null,
		private readonly fs: Fs,
		private readonly run: (dir: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Export as a campaign folder');
		let dir = this.initial;
		this.contentEl.createEl('p', {
			text: 'Writes this map and its notes as a campaign folder for the desktop app. The section a note is in decides where it goes; character and quest notes become characters and quests there. Exporting the campaign back to the vault from the app puts the notes back where they were.',
		});
		const status = this.contentEl.createDiv({ cls: 'setting-item-description' });
		let confirm = false;
		const check = () => {
			const problem = folderProblem(dir, this.base);
			if (problem) {
				status.setText(problem);
				return false;
			}
			const state = folderState(this.fs, dir.trim());
			status.setText(
				state === 'empty'
					? 'A new folder.'
					: state === 'export'
						? 'An earlier export: it is updated (changes made to it in HexLore since are replaced — export them to the vault first).'
						: 'This folder holds other files: a HexLore campaign there is REPLACED (files the export does not write are moved to a "(replaced …)" folder beside it). Turn on the switch below to go ahead.',
			);
			return state !== 'other' || confirm;
		};
		new Setting(this.contentEl).setName('Folder').addText((t) => {
			t.setValue(dir).onChange((v) => {
				dir = v;
				check();
			});
			t.inputEl.addClass('hexlore-wide-input');
		});
		new Setting(this.contentEl).setName('Replace what is there').addToggle((t) => t.setValue(false).onChange((v) => (confirm = v)));
		check();
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('Export')
				.setCta()
				.onClick(async () => {
					if (!check()) return;
					b.setDisabled(true);
					try {
						await this.run(dir.trim().replace(/\\/g, '/').replace(/\/+$/, ''));
						this.close();
					} catch (e) {
						new Notice(`Export failed: ${(e as Error).message}`);
						b.setDisabled(false);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
