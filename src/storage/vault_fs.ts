// MapFs over Obsidian's Vault API (plan 2.2): writes go through the vault so
// its cache, its events and sync plugins all see them.

import { TFile, TFolder, normalizePath, type FileManager, type Vault } from 'obsidian';
import type { MapFs } from './map_store';

export class VaultMapFs implements MapFs {
	constructor(
		private readonly vault: Vault,
		private readonly files: FileManager,
		/** The data folder, vault-relative. */
		readonly dir: string,
	) {}

	private path(rel: string): string {
		return normalizePath(`${this.dir}/${rel}`);
	}

	async read(rel: string): Promise<string | null> {
		const path = this.path(rel);
		const f = this.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return this.vault.read(f);
		// Not indexed (yet): ask the disk.
		return (await this.vault.adapter.exists(path)) ? this.vault.adapter.read(path) : null;
	}

	async write(rel: string, text: string): Promise<void> {
		const path = this.path(rel);
		const f = this.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			await this.vault.modify(f, text);
			return;
		}
		const parent = path.split('/').slice(0, -1).join('/');
		if (parent && !this.vault.getAbstractFileByPath(parent)) {
			try {
				await this.vault.createFolder(parent);
			} catch {
				// Created meanwhile (or present on disk but not indexed): fine.
			}
		}
		try {
			await this.vault.create(path, text);
		} catch {
			// It appeared between the check and the create.
			await this.vault.adapter.write(path, text);
		}
	}

	async remove(rel: string): Promise<void> {
		const path = this.path(rel);
		const f = this.vault.getAbstractFileByPath(path);
		// An emptied chunk follows the user's deletion setting, like any file.
		if (f instanceof TFile) await this.files.trashFile(f);
		else if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
	}

	async list(rel: string): Promise<string[]> {
		const path = this.path(rel);
		const f = this.vault.getAbstractFileByPath(path);
		if (f instanceof TFolder) return f.children.filter((c): c is TFile => c instanceof TFile).map((c) => c.name);
		if (!(await this.vault.adapter.exists(path))) return [];
		return (await this.vault.adapter.list(path)).files.map((p) => p.split('/').pop()!);
	}
}
