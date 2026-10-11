// One MapStore per data folder, shared by every view of that map, fed by the
// vault's change events (batched: a git pull touches many files at once, and
// the map reloads once, after), and flushed when Obsidian quits.

import type { Plugin, TAbstractFile } from 'obsidian';
import { MapStore } from './map_store';
import { VaultMapFs } from './vault_fs';

const EXTERNAL_BATCH_MS = 250;

interface Entry {
	store: Promise<MapStore>;
	fs: VaultMapFs;
	refs: number;
	pending: Set<string>;
	timer: number;
}

/** [dir] after the folder [from] was renamed to [to], or null when [dir]
 *  is not [from] or inside it. */
export function movedPath(dir: string, from: string, to: string): string | null {
	if (dir === from) return to;
	return dir.startsWith(`${from}/`) ? to + dir.slice(from.length) : null;
}

export class StoreRegistry {
	private readonly entries = new Map<string, Entry>();
	/** Where a renamed data folder went: a user that acquired it under the
	 *  old name still releases it under that name. */
	private readonly aliases = new Map<string, string>();

	constructor(private readonly plugin: Plugin) {
		const vault = plugin.app.vault;
		const touched = (f: TAbstractFile) => this.touched(f.path);
		plugin.registerEvent(vault.on('modify', touched));
		plugin.registerEvent(vault.on('create', touched));
		plugin.registerEvent(vault.on('delete', touched));
		plugin.registerEvent(
			vault.on('rename', (f, old) => {
				// A data folder (or a folder above it) moved: its store follows,
				// so its files do not read as deleted and an edit is not written
				// back under the old name.
				this.moved(old, f.path);
				this.touched(f.path);
				this.touched(old);
			}),
		);
		plugin.registerEvent(plugin.app.workspace.on('quit', (tasks) => tasks.add(() => this.flushAll())));
	}

	private resolve(dir: string): string {
		for (let i = 0; i < 64 && this.aliases.has(dir); i++) dir = this.aliases.get(dir)!;
		return dir;
	}

	/** Where the data folder [dir] is now (itself when it never moved). */
	currentDir(dir: string): string {
		return this.resolve(dir);
	}

	/** The store of the data folder [dir], opening it on first use. */
	acquire(dir: string, fallbackName: string): Promise<MapStore> {
		dir = this.resolve(dir);
		let e = this.entries.get(dir);
		if (!e) {
			const fs = new VaultMapFs(this.plugin.app.vault, this.plugin.app.fileManager, dir);
			const store = MapStore.open(fs, fallbackName, {
				set: (fn, ms) => window.setTimeout(fn, ms),
				clear: (h) => window.clearTimeout(h as number),
			});
			const entry: Entry = { store, fs, refs: 0, pending: new Set(), timer: 0 };
			e = entry;
			this.entries.set(dir, entry);
			// A store that failed to open is not kept: the next acquire retries.
			store.catch(() => {
				const at = this.resolve(entry.fs.dir);
				if (this.entries.get(at) === entry) this.entries.delete(at);
			});
		}
		e.refs++;
		return e.store;
	}

	/** One user of [dir]'s store is done; the last one flushes and closes it. */
	async release(dir: string): Promise<void> {
		dir = this.resolve(dir);
		const e = this.entries.get(dir);
		if (!e) return;
		if (--e.refs > 0) return;
		this.entries.delete(dir);
		window.clearTimeout(e.timer);
		const store = await e.store.catch(() => null);
		await store?.close();
	}

	private moved(from: string, to: string): void {
		for (const [dir, e] of [...this.entries]) {
			const next = movedPath(dir, from, to);
			if (next === null || next === dir) continue;
			this.entries.delete(dir);
			this.entries.set(next, e);
			this.aliases.set(dir, next);
			this.aliases.delete(next);
			e.fs.moveTo(next);
			// Batched paths are relative to the folder: they stay valid.
		}
	}

	private touched(path: string): void {
		for (const [dir, e] of this.entries) {
			if (!path.startsWith(`${dir}/`)) continue;
			e.pending.add(path.slice(dir.length + 1));
			window.clearTimeout(e.timer);
			e.timer = window.setTimeout(() => {
				const rels = [...e.pending];
				e.pending.clear();
				void e.store.then((s) => s.externalChange(rels)).catch((err: unknown) => console.error('HexLore: reload failed', err));
			}, EXTERNAL_BATCH_MS);
		}
	}

	async flushAll(): Promise<void> {
		await Promise.all([...this.entries.values()].map((e) => e.store.then((s) => s.flush()).catch(() => undefined)));
	}
}
