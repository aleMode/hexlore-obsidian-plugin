// A map's data folder, loaded: the model plus what is on disk (plan 2.2).
//
// - Edits mark their chunk or layer DIRTY; a debounced flush writes each
//   dirty file whole, from the live model. An empty chunk is deleted. A file
//   whose text would not change is not written.
// - Every write is remembered, so the change event it causes is recognised
//   as our own and ignored.
// - A file changed by someone else (git pull, sync, the Flutter app) reloads
//   ON ITS OWN: only that chunk or layer. Unsaved local edits to that file are
//   discarded and reported in the event (the editor drops the undo entries
//   that touched it).
// - A file that does not parse is reported and never written: the app never
//   overwrites what it could not read.
// - A newer format, or format 1 (which Flutter migrates), opens READ-ONLY.

import { FORMAT_VERSION } from '../core/campaign_meta';
import { MapModel } from '../core/map';
import {
	DecodeError,
	LAYERS,
	LAYER_FILES,
	PAINT_DIR,
	applyFile,
	chunkNameOf,
	encodeChunk,
	encodeLayer,
	fileKeyOf,
	pathOf,
	type FileKey,
	type LayerName,
} from './map_codec';

/** The file access the store needs (paths relative to the data folder). */
export interface MapFs {
	/** The file's text, or null when it does not exist. */
	read(rel: string): Promise<string | null>;
	/** Write the whole file, creating folders as needed. */
	write(rel: string, text: string): Promise<void>;
	remove(rel: string): Promise<void>;
	/** File names (not paths) directly inside [rel]; [] when it does not exist. */
	list(rel: string): Promise<string[]>;
}

export type StoreEvent =
	| { kind: 'reloaded'; files: FileKey[]; discarded: FileKey[] }
	| { kind: 'saved'; files: FileKey[] }
	| { kind: 'problem'; message: string };

export const SAVE_DEBOUNCE_MS = 500;

/** The timers the store's debounce uses (injectable for tests). */
export interface Timers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}


export class MapStore {
	readonly model = new MapModel();
	/** Why this map cannot be saved, or null. */
	readOnlyReason: string | null = null;
	/** Files that did not parse: never written. Path → why. */
	readonly broken = new Map<string, string>();
	/** Broken files an edit was already refused for (one notice each). */
	private readonly warnedBroken = new Set<string>();

	/** Last text known to be on disk, per path (null: no file). */
	private readonly disk = new Map<string, string | null>();
	private readonly dirty = new Map<string, FileKey>();
	private readonly listeners = new Set<(e: StoreEvent) => void>();
	private saveTimer: unknown = null;
	private flushing: Promise<void> = Promise.resolve();

	private constructor(
		private readonly fs: MapFs,
		private readonly fallbackName: string,
		private readonly timers: Timers,
	) {}

	get readOnly(): boolean {
		return this.readOnlyReason !== null;
	}

	/** Load every file of the map. Throws when campaign.json is missing or
	 *  unreadable: without it there is no map. */
	static async open(
		fs: MapFs,
		fallbackName: string,
		timers: Timers,
	): Promise<MapStore> {
		const store = new MapStore(fs, fallbackName, timers);
		const metaText = await fs.read(LAYER_FILES.meta);
		if (metaText === null) throw new Error(`${LAYER_FILES.meta} is missing`);
		store.disk.set(LAYER_FILES.meta, metaText);
		applyFile(store.model, { layer: 'meta' }, metaText, fallbackName); // throws if unreadable
		const format = store.model.meta.format;
		if (format > FORMAT_VERSION) {
			store.readOnlyReason = `saved by a newer HexLore (format ${format}); opened read-only`;
		} else if (format < FORMAT_VERSION) {
			store.readOnlyReason = `format ${format}: open it once in the HexLore app to upgrade it; opened read-only`;
		}
		for (const layer of LAYERS) if (layer !== 'meta') await store.load({ layer });
		for (const name of await fs.list(PAINT_DIR)) {
			const key = fileKeyOf(`${PAINT_DIR}/${name}`);
			if (key) await store.load(key);
		}
		return store;
	}

	on(listener: (e: StoreEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(e: StoreEvent): void {
		for (const l of this.listeners) l(e);
	}

	/** Read one file into the model. A parse failure marks it broken. */
	private async load(key: FileKey): Promise<void> {
		const path = pathOf(key);
		const text = await this.fs.read(path);
		this.disk.set(path, text);
		try {
			applyFile(this.model, key, text, this.fallbackName);
			this.broken.delete(path);
			this.warnedBroken.delete(path);
		} catch (e) {
			if (!(e instanceof DecodeError)) throw e;
			this.broken.set(path, e.message);
			this.emit({ kind: 'problem', message: `${e.message} — left as it is, and not saved over` });
		}
	}

	// ----- edits -------------------------------------------------------------

	/** The hex at (q, r) changed. */
	markHex(q: number, r: number): void {
		this.mark({ chunk: chunkNameOf(q, r) });
	}

	markLayer(layer: LayerName): void {
		this.mark({ layer });
	}

	private mark(key: FileKey): void {
		if (this.readOnly) return;
		this.dirty.set(pathOf(key), key);
		this.scheduleSave();
	}

	get hasUnsavedChanges(): boolean {
		return this.dirty.size > 0;
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) this.timers.clear(this.saveTimer);
		this.saveTimer = this.timers.set(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Write every dirty file now. Flushes run one after another. */
	flush(): Promise<void> {
		if (this.saveTimer !== null) {
			this.timers.clear(this.saveTimer);
			this.saveTimer = null;
		}
		this.flushing = this.flushing.then(() => this.flushNow());
		return this.flushing;
	}

	private async flushNow(): Promise<void> {
		if (this.readOnly || !this.dirty.size) return;
		const keys = [...this.dirty.values()];
		this.dirty.clear();
		const written: FileKey[] = [];
		for (const key of keys) {
			const path = pathOf(key);
			if (this.broken.has(path)) {
				// The edit is in the model but can never be saved: say so, once
				// per file (a brush stroke would otherwise say it every flush).
				if (!this.warnedBroken.has(path)) {
					this.warnedBroken.add(path);
					this.emit({ kind: 'problem', message: `Not saved: ${path} could not be read, so it is not written over. Edits there are lost on reload — repair the file first.` });
				}
				continue;
			}
			const text = 'layer' in key ? encodeLayer(this.model, key.layer) : encodeChunk(this.model, key.chunk);
			const onDisk = this.disk.get(path) ?? null;
			if (text === onDisk) continue;
			// Remember first: the change event may arrive before the write returns.
			this.disk.set(path, text);
			try {
				if (text === null) await this.fs.remove(path);
				else await this.fs.write(path, text);
				written.push(key);
			} catch (e) {
				this.disk.set(path, onDisk);
				this.dirty.set(path, key); // try again with the next save
				this.emit({ kind: 'problem', message: `Could not save ${path}: ${(e as Error).message}` });
			}
		}
		if (written.length) this.emit({ kind: 'saved', files: written });
	}

	// ----- changes from outside ----------------------------------------------

	/** Files under the data folder changed on disk (paths relative to it).
	 *  Each one we own and did not write ourselves is reloaded on its own. */
	async externalChange(rels: Iterable<string>): Promise<void> {
		await this.flushing;
		const reloaded: FileKey[] = [];
		const discarded: FileKey[] = [];
		for (const rel of new Set(rels)) {
			const key = fileKeyOf(rel);
			if (!key) continue; // not a file this app owns
			const text = await this.fs.read(rel);
			if (this.disk.has(rel) && this.disk.get(rel) === text) continue; // our own write
			if (this.dirty.delete(rel)) discarded.push(key);
			try {
				applyFile(this.model, key, text, this.fallbackName);
				this.broken.delete(rel);
				this.warnedBroken.delete(rel);
			} catch (e) {
				if (!(e instanceof DecodeError)) throw e;
				this.broken.set(rel, e.message);
				this.emit({ kind: 'problem', message: `${e.message} — left as it is, and not saved over` });
			}
			this.disk.set(rel, text);
			if ('layer' in key && key.layer === 'meta') {
				const format = this.model.meta.format;
				if (format !== FORMAT_VERSION && !this.readOnly) {
					this.readOnlyReason = `campaign.json now says format ${format}; opened read-only`;
				}
			}
			reloaded.push(key);
		}
		if (reloaded.length) this.emit({ kind: 'reloaded', files: reloaded, discarded });
	}

	/** Flush and stop. */
	async close(): Promise<void> {
		await this.flush();
		this.listeners.clear();
	}
}
