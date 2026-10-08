// One MapStore per data folder, shared by every view of that map, fed by the
// vault's change events (batched: a git pull touches many files at once, and
// the map reloads once, after), and flushed when Obsidian quits.

import type { Plugin, TAbstractFile } from 'obsidian';
import { MapStore } from './map_store';
import { VaultMapFs } from './vault_fs';

const EXTERNAL_BATCH_MS = 250;

interface Entry {
	store: Promise<MapStore>;
	refs: number;
	pending: Set<string>;
	timer: number;
}

export class StoreRegistry {
	private readonly entries = new Map<string, Entry>();

	constructor(private readonly plugin: Plugin) {
		const vault = plugin.app.vault;
		const touched = (f: TAbstractFile) => this.touched(f.path);
		plugin.registerEvent(vault.on('modify', touched));
		plugin.registerEvent(vault.on('create', touched));
		plugin.registerEvent(vault.on('delete', touched));
		plugin.registerEvent(
			vault.on('rename', (f, old) => {
				this.touched(f.path);
				this.touched(old);
			}),
		);
		plugin.registerEvent(plugin.app.workspace.on('quit', (tasks) => tasks.add(() => this.flushAll())));
	}

	/** The store of the data folder [dir], opening it on first use. */
	acquire(dir: string, fallbackName: string): Promise<MapStore> {
		let e = this.entries.get(dir);
		if (!e) {
			const store = MapStore.open(new VaultMapFs(this.plugin.app.vault, this.plugin.app.fileManager, dir), fallbackName, {
				set: (fn, ms) => window.setTimeout(fn, ms),
				clear: (h) => window.clearTimeout(h as number),
			});
			e = { store, refs: 0, pending: new Set(), timer: 0 };
			this.entries.set(dir, e);
			// A store that failed to open is not kept: the next acquire retries.
			store.catch(() => {
				if (this.entries.get(dir) === e) this.entries.delete(dir);
			});
		}
		e.refs++;
		return e.store;
	}

	/** One user of [dir]'s store is done; the last one flushes and closes it. */
	async release(dir: string): Promise<void> {
		const e = this.entries.get(dir);
		if (!e) return;
		if (--e.refs > 0) return;
		this.entries.delete(dir);
		window.clearTimeout(e.timer);
		const store = await e.store.catch(() => null);
		await store?.close();
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
