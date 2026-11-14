import { describe, expect, it } from 'vitest';
import { PaintPick } from '../src/core/hex_paint';
import { MapEditor, type EditorEvent } from '../src/edit/editor';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { MemoryFs } from './helpers/memory_fs';

async function setup(extra: Record<string, string> = {}) {
	const fs = new MemoryFs({ ...Object.fromEntries(encodeAll(fixtureMap())), ...extra });
	const store = await MapStore.open(fs, 'X', { set: () => 0, clear: () => {} });
	const editor = new MapEditor(store);
	const events: EditorEvent[] = [];
	editor.on((e) => events.push(e));
	return { fs, store, editor, events };
}

describe('the map editor', () => {
	it('paints a stroke as ONE undo entry, and undo/redo restore it exactly', async () => {
		const { editor, store } = await setup();
		const before = encodeAll(store.model);
		editor.paint([[0, 0], [2, 2]], PaintPick.biome('sea'));
		editor.paint([[2, 2], [3, 3]], PaintPick.biome('hills', 1)); // same stroke, cell painted twice
		editor.endStroke();
		expect(store.model.getHex(2, 2)!.terrain).toBe('hills');
		expect(editor.undo.nextUndoLabel).toBe('Paint (3 hexes)');
		editor.undoLast();
		expect(encodeAll(store.model)).toEqual(before);
		editor.redoLast();
		expect(store.model.getHex(3, 3)!.terrainVariant).toBe(1);
		expect(store.model.getHex(0, 0)!.terrain).toBe('sea');
	});

	it('leaves the other layer alone (decision 1c), and a biome clears a legacy fill', async () => {
		const { editor, store } = await setup();
		const well = store.model.getHex(1, 0)!;
		editor.paint([[1, 0]], PaintPick.biome('plains'));
		expect(well.feature).toBe('well');
		well.colorOverride = '#C8A96E';
		editor.paint([[1, 0]], PaintPick.featureOnly('city', 2));
		expect(well.terrain).toBe('plains');
		expect(well.colorOverride).toBe('#C8A96E'); // a feature stamp keeps the fill
		editor.paint([[1, 0]], PaintPick.biome('forest'));
		expect(well.colorOverride).toBeNull();
	});

	it('erasing never leaves an empty record, and undo brings back unknown values', async () => {
		const { editor, store } = await setup({ 'paint/c_0_0.json': '[\n  {"q":5,"r":5,"terrain":"glacier"}\n]\n' });
		editor.paint([[5, 5]], PaintPick.biome('default'));
		editor.endStroke();
		expect(store.model.getHex(5, 5)).toBeUndefined();
		editor.undoLast();
		expect(store.model.getHex(5, 5)!.toJson().terrain).toBe('glacier');
	});

	it('marks the touched chunk for saving', async () => {
		const { editor, store, fs } = await setup();
		editor.paint([[17, -3]], PaintPick.biome('desert'));
		editor.endStroke();
		await store.flush();
		expect(fs.log).toEqual(['write paint/c_1_0.json']);
	});

	it('names hexes uniquely, undoably', async () => {
		const { editor, store } = await setup();
		expect(editor.renameHex(0, 0, 'Fort')).toBe('Fort');
		expect(editor.renameHex(17, -3, ' Fort ')).toBe('Fort 2');
		editor.undoLast();
		expect(store.model.getHex(17, -3)!.name).toBeNull();
		expect(editor.renameHex(3, 3, 'New place')).toBe('New place'); // creates the hex
		editor.undoLast();
		expect(store.model.getHex(3, 3)).toBeUndefined();
	});

	it('reveals and hides, clamped to the grid; line of sight projects once', async () => {
		const { editor, store, events } = await setup();
		expect(editor.setRevealed([[1, 1], [999, 0]], true)).toEqual([[1, 1]]);
		expect(events).toContainEqual({ kind: 'revealed', cells: [[1, 1]] });
		expect(editor.allRevealed([[0, 0], [1, 1]])).toBe(true);
		editor.setRevealed([[1, 1]], false);
		expect(store.model.revealed.has('q1_r1')).toBe(false);
		// Fog is undoable in the plugin (Flutter's decision 9 is not).
		expect(editor.undoLast()).toBe('Hide 1 hex');
		expect(store.model.revealed.has('q1_r1')).toBe(true);
		editor.redoLast();
		expect(store.model.revealed.has('q1_r1')).toBe(false);
	});

	it('makes one undo step of a fog-brush drag, and of reveal all', async () => {
		const { editor, store } = await setup();
		const before = new Set(store.model.revealed);
		editor.paintFog([[2, 2]], true);
		editor.paintFog([[3, 2], [2, 2]], true);
		editor.endFogStroke();
		expect(editor.undo.nextUndoLabel).toBe('Reveal 2 hexes');
		editor.undoLast();
		expect(store.model.revealed).toEqual(before);
		editor.setAllRevealed(true);
		expect(editor.undoLast()).toBe('Reveal all hexes');
		expect(store.model.revealed).toEqual(before);
		// A mountain sees two hexes further than flat ground.
		editor.paint([[10, 5]], PaintPick.biome('mountain'));
		editor.endStroke();
		const seen = editor.sightFrom([[10, 5]]);
		expect(seen.some(([q, r]) => q === 12 && r === 4)).toBe(true);
		expect(editor.sightFrom([[5, 5]]).length).toBe(7); // flat: the ring only
		expect(editor.sightFrom([[0, 3]]).length).toBe(5); // clamped at the grid edge
	});

	it('hides a feature from players, with its name', async () => {
		const { editor, store } = await setup();
		store.model.getHex(1, 0)!.featureHidden = false;
		expect(editor.allFeaturesHidden([[1, 0]])).toBe(false);
		expect(editor.setFeatureHidden([[1, 0], [0, 0]], true)).toEqual([[1, 0]]);
		expect(editor.allFeaturesHidden([[1, 0], [0, 0]])).toBe(true);
	});

	it('drops the undo entries touching a file reloaded from disk', async () => {
		const { editor } = await setup();
		editor.paint([[0, 0]], PaintPick.biome('sea'));
		editor.endStroke();
		editor.paint([[17, -3]], PaintPick.biome('sea'));
		editor.endStroke();
		expect(editor.reloaded(['paint/c_0_0.json'])).toBe(1);
		expect(editor.undo.nextUndoLabel).toBe('Paint (1 hex)');
		editor.undoLast();
		expect(editor.undo.canUndo).toBe(false);
	});

	it('refuses to edit a read-only map', async () => {
		const { editor, store } = await setup({ 'campaign.json': '{"format": 3, "name": "Newer"}' });
		expect(store.readOnly).toBe(true);
		expect(editor.paint([[0, 0]], PaintPick.biome('sea'))).toEqual([]);
		expect(editor.renameHex(0, 0, 'X')).toBeNull();
	});
});

describe('the player filter and records', () => {
	it('serves a revealed cell that has no record, as an empty hex', async () => {
		const { filterCampaignForPlayer } = await import('../src/core/player_filter');
		const { editor, store } = await setup();
		editor.setRevealed([[4, 4]], true);
		const payload = filterCampaignForPlayer(store.model) as { hexes: { id: string; terrain: string }[] };
		expect(payload.hexes.find((h) => h.id === 'q4_r4')).toMatchObject({ terrain: 'default' });
	});
});
