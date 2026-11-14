import { describe, expect, it, vi } from 'vitest';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore, SAVE_DEBOUNCE_MS, type StoreEvent } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { MemoryFs, nodeTimers } from './helpers/memory_fs';

function folder(): MemoryFs {
	return new MemoryFs(Object.fromEntries(encodeAll(fixtureMap())));
}

async function open(fs: MemoryFs) {
	const events: StoreEvent[] = [];
	const store = await MapStore.open(fs, 'Fallback', nodeTimers);
	store.on((e) => events.push(e));
	return { store, events };
}

describe('the map store', () => {
	it('loads every layer and chunk', async () => {
		const { store } = await open(folder());
		expect(store.model.meta.name).toBe('Fixture');
		expect(store.model.hexes.size).toBe(4);
		expect(store.model.rivers.size).toBe(1);
		expect(store.model.revealed.has('q0_r0')).toBe(true);
		expect(store.readOnly).toBe(false);
	});

	it('writes only the dirty chunk, after the debounce', async () => {
		vi.useFakeTimers();
		try {
			const fs = folder();
			const { store } = await open(fs);
			store.model.getHex(17, -3)!.terrain = 'hills';
			store.markHex(17, -3);
			expect(fs.log).toEqual([]);
			await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
			expect(fs.log).toEqual(['write paint/c_1_0.json']);
			expect(fs.files.get('paint/c_1_0.json')).toContain('"terrain":"hills"');
		} finally {
			vi.useRealTimers();
		}
	});

	it('deletes a chunk left empty, and skips a write that changes nothing', async () => {
		const fs = folder();
		const { store } = await open(fs);
		store.model.hexes.delete('q-5_r4');
		store.markHex(-5, 4);
		store.markHex(0, 0); // unchanged
		await store.flush();
		expect(fs.log).toEqual(['remove paint/c_-1_0.json']);
	});

	it('ignores the change events its own writes cause', async () => {
		const fs = folder();
		const { store, events } = await open(fs);
		store.model.getHex(0, 0)!.name = 'Home';
		store.markHex(0, 0);
		await store.flush();
		await store.externalChange(['paint/c_0_0.json']);
		expect(events.filter((e) => e.kind === 'reloaded')).toEqual([]);
	});

	it('reloads only the file changed outside, discarding unsaved edits to it', async () => {
		const fs = folder();
		const { store, events } = await open(fs);
		store.model.getHex(0, 0)!.name = 'Unsaved';
		store.markHex(0, 0);
		store.model.getHex(17, -3)!.name = 'Kept';
		store.markHex(17, -3);
		fs.files.set('paint/c_0_0.json', '[\n  {"q":0,"r":0,"terrain":"sea"}\n]\n');
		await store.externalChange(['paint/c_0_0.json', 'import/underlay.json']);
		expect(store.model.getHex(0, 0)!.terrain).toBe('sea');
		expect(store.model.getHex(1, 0)).toBeUndefined();
		expect(events).toContainEqual({ kind: 'reloaded', files: [{ chunk: 'c_0_0.json' }], discarded: [{ chunk: 'c_0_0.json' }] });
		await store.flush();
		expect(fs.log).toEqual(['write paint/c_1_0.json']); // the other edit survives
	});

	it('a flush never writes over a file changed outside whose event has not come yet', async () => {
		const fs = folder();
		const { store, events } = await open(fs);
		store.model.getHex(0, 0)!.name = 'Unsaved';
		store.markHex(0, 0);
		// A sync lands while the change event is still batched.
		const pulled = '[\n  {"q":0,"r":0,"terrain":"sea"}\n]\n';
		fs.files.set('paint/c_0_0.json', pulled);
		await store.flush();
		expect(fs.files.get('paint/c_0_0.json')).toBe(pulled);
		await store.flush(); // the reload it started
		expect(store.model.getHex(0, 0)!.terrain).toBe('sea');
		expect(events).toContainEqual({ kind: 'reloaded', files: [{ chunk: 'c_0_0.json' }], discarded: [{ chunk: 'c_0_0.json' }] });
		// The batched event arriving afterwards changes nothing more.
		await store.externalChange(['paint/c_0_0.json']);
		expect(events.filter((e) => e.kind === 'reloaded')).toHaveLength(1);
	});

	it('never writes over a file it could not read', async () => {
		const fs = folder();
		fs.files.set('rivers/rivers.json', '[ this is not json');
		const { store } = await open(fs);
		expect(store.broken.has('rivers/rivers.json')).toBe(true);
		store.markLayer('rivers');
		await store.flush();
		expect(fs.files.get('rivers/rivers.json')).toBe('[ this is not json');
	});

	it('says, once per file, that an edit to a file it could not read is not saved', async () => {
		const fs = folder();
		fs.files.set('paint/c_0_0.json', '{"broken": ');
		const { store, events } = await open(fs);
		events.length = 0;
		store.model.getOrCreateHex(1, 1).name = 'Lost';
		store.markHex(1, 1);
		await store.flush();
		store.markHex(1, 1); // the next stroke: no second notice
		await store.flush();
		const problems = events.filter((e) => e.kind === 'problem');
		expect(problems).toHaveLength(1);
		expect(problems[0]!.kind === 'problem' && problems[0]!.message).toContain('paint/c_0_0.json');
		expect(fs.files.get('paint/c_0_0.json')).toBe('{"broken": ');
		// Repaired outside: a later edit there is saved normally.
		fs.files.set('paint/c_0_0.json', '[]');
		await store.externalChange(['paint/c_0_0.json']);
		store.model.getOrCreateHex(1, 1).name = 'Saved';
		store.markHex(1, 1);
		await store.flush();
		expect(fs.files.get('paint/c_0_0.json')).toContain('Saved');
	});

	it('opens a newer format, or format 1, read-only and writes nothing', async () => {
		for (const format of [3, 1]) {
			const fs = folder();
			fs.files.set('campaign.json', fs.files.get('campaign.json')!.replace('"format": 2', `"format": ${format}`));
			const { store } = await open(fs);
			expect(store.readOnly).toBe(true);
			store.model.getHex(0, 0)!.name = 'X';
			store.markHex(0, 0);
			await store.flush();
			expect(fs.log).toEqual([]);
		}
	});

	it('keeps a failed write dirty and reports it', async () => {
		const fs = folder();
		const { store, events } = await open(fs);
		fs.failWrites = true;
		store.model.getHex(0, 0)!.name = 'X';
		store.markHex(0, 0);
		await store.flush();
		expect(events.some((e) => e.kind === 'problem')).toBe(true);
		expect(store.hasUnsavedChanges).toBe(true);
		fs.failWrites = false;
		await store.flush();
		expect(fs.files.get('paint/c_0_0.json')).toContain('"name":"X"');
	});

	it('refuses to open without campaign.json', async () => {
		await expect(MapStore.open(new MemoryFs(), 'X', nodeTimers)).rejects.toThrow('campaign.json is missing');
	});
});
