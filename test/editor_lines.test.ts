import { describe, expect, it } from 'vitest';
import { insertLinePoint, moveLinePoint, nearestLineSegment } from '../src/core/line_edit';
import { anchor } from '../src/core/river';
import { MapEditor, type ThreadSpec } from '../src/edit/editor';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { MemoryFs } from './helpers/memory_fs';

const c = (q: number, r: number) => anchor('c', q, r, 0);

async function setup() {
	const fs = new MemoryFs(Object.fromEntries(encodeAll(fixtureMap())));
	const store = await MapStore.open(fs, 'X', { set: () => 0, clear: () => {} });
	return { fs, store, editor: new MapEditor(store) };
}

describe('line_edit (decision 8c)', () => {
	const line = [c(0, 0), c(1, 0), c(2, 0), c(3, 0)];
	it('moves one point and adds none', () => {
		expect(moveLinePoint(line, 1, c(1, 1))).toEqual({ nodes: [c(0, 0), c(1, 1), c(2, 0), c(3, 0)], index: 1 });
	});
	it('merges a point dropped on its neighbour, and refuses a line of one point', () => {
		expect(moveLinePoint(line, 1, c(2, 0))).toEqual({ nodes: [c(0, 0), c(2, 0), c(3, 0)], index: 1 });
		expect(moveLinePoint([c(0, 0), c(1, 0)], 1, c(0, 0))).toBeNull();
	});
	it('inserts on a link, but not a duplicate of its ends', () => {
		expect(insertLinePoint(line, 0, c(0, 1))!.nodes).toEqual([c(0, 0), c(0, 1), c(1, 0), c(2, 0), c(3, 0)]);
		expect(insertLinePoint(line, 0, c(1, 0))).toEqual({ nodes: line, index: 1 });
	});
	it('finds the nearest link', () => {
		expect(nearestLineSegment([[0, 0], [10, 0], [10, 10]], 9, 6)).toEqual([1, 1]);
	});
});

describe('editing rivers and routes', () => {
	it('draws, edits point by point, and undoes each gesture', async () => {
		const { editor, store } = await setup();
		const r = editor.createRiver([c(0, 0), c(1, 0), c(2, 0)])!;
		expect(r.id).toBe('river_002');
		const from = r.nodes.map((n) => ({ ...n }));
		editor.moveLinePointLive('river', r.id, from, 1, c(1, 1));
		editor.moveLinePointLive('river', r.id, from, 1, c(2, 0)); // passes over a neighbour…
		editor.moveLinePointLive('river', r.id, from, 1, c(1, -1)); // …and leaves no trace
		editor.pushLineNodesChange('river', r.id, from);
		expect(store.model.rivers.get(r.id)!.nodes).toEqual([c(0, 0), c(1, -1), c(2, 0)]);
		editor.undoLast();
		expect(store.model.rivers.get(r.id)!.nodes).toEqual(from);
		editor.undoLast();
		expect(store.model.rivers.has(r.id)).toBe(false);
	});

	it('creates a border hidden from players', async () => {
		const { editor } = await setup();
		expect(editor.createRoute([c(0, 0), c(0, 1)], 'border', '#8B1E3F')!.playerVisible).toBe(false);
		expect(editor.createRoute([c(0, 0), c(0, 1)], 'trail', '#6B4A2F')!.playerVisible).toBe(true);
	});

	it('deletes a point, and the whole line when one point would be left', async () => {
		const { editor, store } = await setup();
		const r = editor.createRiver([c(0, 0), c(1, 0), c(2, 0)])!;
		expect(editor.removeLinePoint('river', r.id, 1)).toBe(true);
		expect(editor.removeLinePoint('river', r.id, 0)).toBe(false);
		expect(store.model.rivers.has(r.id)).toBe(false);
		editor.undoLast();
		expect(store.model.rivers.get(r.id)!.nodes).toHaveLength(2);
	});

	it('merges consecutive width changes into one undo entry', async () => {
		const { editor, store } = await setup();
		for (const w of [1.2, 1.4, 1.6]) editor.setRiverWidth('river_001', w);
		expect(store.model.rivers.get('river_001')!.width).toBe(1.6);
		editor.undoLast();
		expect(store.model.rivers.get('river_001')!.width).toBe(1);
	});
});

describe('editing regions', () => {
	it('paints a drag as one undo entry, Ctrl-drag removes', async () => {
		const { editor, store } = await setup();
		const g = editor.createRegion('North')!;
		expect(editor.createRegion('North')!.name).toBe('North 2');
		editor.paintRegion(g.id, [[0, 0], [1, 0]], true);
		editor.paintRegion(g.id, [[2, 0], [999, 0]], true); // off-grid ignored
		editor.endRegionStroke();
		expect(store.model.regions.get(g.id)!.cells).toEqual([[0, 0], [1, 0], [2, 0]]);
		editor.paintRegion(g.id, [[1, 0]], false);
		editor.endRegionStroke();
		editor.undoLast();
		expect(store.model.regions.get(g.id)!.cells).toHaveLength(3);
		editor.undoLast();
		expect(store.model.regions.get(g.id)!.cells).toHaveLength(0);
	});

	it('removing a region drops the undo entries that painted it', async () => {
		const { editor } = await setup();
		const g = editor.createRegion('South')!;
		editor.paintRegion(g.id, [[0, 0]], true);
		editor.endRegionStroke();
		editor.removeRegion(g.id);
		expect(editor.undo.canUndo).toBe(false);
	});
});

describe('editing threads', () => {
	const spec: ThreadSpec = { type: 'Rumor', label: 'Whispers', direction: 'one-way', status: 'active', color: '' };
	it('creates, edits and deletes, each undoable', async () => {
		const { editor, store } = await setup();
		const t = editor.createThread('q0_r0', 'q2_r1', spec)!;
		editor.updateThread(t.id, { ...spec, status: 'resolved', color: '#55B855' });
		expect(store.model.threads.get(t.id)!.effectiveColor()).toBe('#55B855');
		editor.removeThread(t.id);
		editor.undoLast();
		editor.undoLast();
		expect(store.model.threads.get(t.id)!.status).toBe('active');
		expect(editor.createThread('q0_r0', 'q0_r0', spec)).toBeNull();
	});
});
