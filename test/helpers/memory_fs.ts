import type { MapFs } from '../../src/storage/map_store';

/** An in-memory data folder that records every write. */
export class MemoryFs implements MapFs {
	readonly files = new Map<string, string>();
	readonly log: string[] = [];
	failWrites = false;

	constructor(initial: Record<string, string> = {}) {
		for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
	}

	async read(rel: string): Promise<string | null> {
		return this.files.get(rel) ?? null;
	}

	async write(rel: string, text: string): Promise<void> {
		if (this.failWrites) throw new Error('disk full');
		this.log.push(`write ${rel}`);
		this.files.set(rel, text);
	}

	async remove(rel: string): Promise<void> {
		this.log.push(`remove ${rel}`);
		this.files.delete(rel);
	}

	async list(rel: string): Promise<string[]> {
		const prefix = `${rel}/`;
		return [...this.files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
	}
}

/** Node's timers, for a store under test (vi's fake timers patch these). */
export const nodeTimers = {
	set: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
