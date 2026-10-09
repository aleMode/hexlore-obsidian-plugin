import { describe, expect, it } from 'vitest';
import { axialToPixel, hexCorners } from '../src/core/geometry';
import { planImport } from '../src/core/import_plan';
import { SketchFill, SketchStroke } from '../src/core/sketch';
import { MapEditor } from '../src/edit/editor';
import { hexifySketch, protectHandEdits } from '../src/sketch/hexify';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { MemoryFs } from './helpers/memory_fs';

async function setup() {
	const fs = new MemoryFs(Object.fromEntries(encodeAll(fixtureMap())));
	const store = await MapStore.open(fs, 'X', { set: () => 0, clear: () => {} });
	return { store, editor: new MapEditor(store) };
}

/** A fill covering hex (q, r) generously. */
const fillOver = (id: string, swatch: string, q: number, r: number) => {
	const [cx, cy] = axialToPixel(q, r);
	return new SketchFill(id, swatch, hexCorners(cx, cy, 60));
};

describe('sketch editing (decision 19)', () => {
	it('draws, fills below the strokes, erases — on its own history', async () => {
		const { editor } = await setup();
		const mapUndo = editor.undo.canUndo;
		editor.addSketchItem(new SketchStroke('s_1', 'ink', 4, [[0, 0, 1], [10, 10, 1]]));
		editor.addSketchFill(fillOver('s_2', 'biome:forest', 5, 5));
		expect(editor.sketch.items.map((i) => i.id)).toEqual(['s_2', 's_1']); // the fill went under
		editor.removeSketchItem('s_1');
		expect(editor.sketch.items.map((i) => i.id)).toEqual(['s_2']);
		expect(editor.undo.canUndo).toBe(mapUndo); // the map's history is untouched
		editor.sketchUndoLast();
		expect(editor.sketch.items.map((i) => i.id)).toEqual(['s_2', 's_1']);
		editor.sketchUndoLast();
		editor.sketchUndoLast();
		expect(editor.sketch.items).toEqual([]);
		editor.sketchRedoLast();
		expect(editor.sketch.items.map((i) => i.id)).toEqual(['s_1']);
	});
});

describe('the swatch editor', () => {
	it('replaces the palette as one sketch undo step', async () => {
		const { editor } = await setup();
		const before = editor.sketch.swatches.map((s) => s.id);
		const next = editor.sketch.swatches.slice(0, 2);
		editor.setSketchSwatches(next);
		expect(editor.sketch.swatches.map((s) => s.id)).toEqual(before.slice(0, 2));
		editor.sketchUndoLast();
		expect(editor.sketch.swatches.map((s) => s.id)).toEqual(before);
	});
});

describe('hexify → plan → apply (decisions 12b, 19)', () => {
	it('paints the covered cell, records it, and undoes in one step', async () => {
		const { store, editor } = await setup();
		editor.addSketchFill(fillOver('s_1', 'biome:swamp', 6, 2));
		const res = hexifySketch(editor.sketch);
		expect(res.cells.some((c) => c.q === 6 && c.r === 2)).toBe(true);
		const m = store.model;
		const plan = planImport({
			entries: res.cells,
			mode: 'overwrite',
			autoResize: false,
			currentWindow: m.meta.grid,
			existingCells: [...m.hexes.values()].map((h): [number, number] => [h.q, h.r]),
			occupiedCells: new Set([...m.hexes.values()].filter((h) => h.terrain !== 'default' || h.feature).map((h) => `${h.q},${h.r}`)),
		});
		const out = editor.applyImport(plan, true);
		expect(out.applied).toBeGreaterThan(0);
		expect(m.getHex(6, 2)!.terrain).toBe('swamp');
		expect(m.hexified!.cells.get('6,2')).toEqual(['swamp', 0]);
		// A hand edit after hexify is protected on the next run.
		editor.paint([[6, 2]], (await import('../src/core/hex_paint')).PaintPick.biome('desert'));
		editor.endStroke();
		const again = protectHandEdits(hexifySketch(editor.sketch), m.hexified!, (q, r) => m.getHex(q, r), m.rivers.keys(), m.routes.keys());
		expect(again.protectedCells).toBeGreaterThan(0);
		editor.undoLast(); // the hand edit
		editor.undoLast(); // the hexify
		expect(m.getHex(6, 2)?.terrain ?? 'default').toBe('default');
		expect(m.hexified).toBeNull();
	});

	it('skipOccupied leaves painted cells; replaceAll clears the rest', () => {
		const pick = { isEmpty: false } as never;
		const base = { entries: [{ q: 0, r: 0, pick }, { q: 1, r: 0, pick }], autoResize: false, currentWindow: { minQ: 0, cols: 5, rows: 5, rShift: 0 }, existingCells: [] as [number, number][] };
		const skip = planImport({ ...base, mode: 'skipOccupied', occupiedCells: new Set(['0,0']) });
		expect(skip.writes.map((w) => w.q)).toEqual([1]);
		expect(skip.skippedOccupied).toBe(1);
		const all = planImport({ ...base, mode: 'replaceAll', occupiedCells: new Set(['0,0', '3,3']) });
		expect(all.clears).toEqual([[3, 3]]);
		expect(all.clearFeatures).toBe(true);
		const outside = planImport({ ...base, entries: [{ q: 40, r: 0, pick }], mode: 'overwrite', occupiedCells: new Set(), autoResize: true });
		expect(outside.window).not.toBeNull();
		expect(outside.skippedOutside).toBe(0);
	});
});
