import { describe, expect, it } from 'vitest';
import { MapEditor } from '../src/edit/editor';
import { encodeAll } from '../src/storage/map_codec';
import { MapStore } from '../src/storage/map_store';
import { fixtureMap } from './helpers/fixture_map';
import { MemoryFs } from './helpers/memory_fs';

async function setup() {
	const fs = new MemoryFs(Object.fromEntries(encodeAll(fixtureMap())));
	const store = await MapStore.open(fs, 'X', { set: () => 0, clear: () => {} });
	const editor = new MapEditor(store);
	const written: Map<string, string[] | null>[] = [];
	editor.linkWriter = (c) => {
		written.push(new Map(c));
	};
	editor.links = new Map([['q0_r0', ['Home']], ['q1_r0', ['Oasis', 'Well lore']]]);
	return { store, editor, written };
}

describe('deleting hexes', () => {
	it('removes records, threads and note LINKS; undo brings all back', async () => {
		const { store, editor, written } = await setup();
		editor.createThread('q0_r0', 'q17_r-3', { type: 'Rumor', label: '', direction: 'bidirectional', status: 'active', color: '' });
		expect(editor.deleteHexes([[0, 0], [5, 5]])).toBe(1);
		expect(store.model.getHex(0, 0)).toBeUndefined();
		expect(store.model.threads.size).toBe(0);
		expect(written.at(-1)).toEqual(new Map([['q0_r0', null]]));
		expect(store.model.revealed.has('q0_r0')).toBe(true); // fog stays with the cell
		editor.undoLast();
		expect(store.model.getHex(0, 0)!.terrain).toBe('forest');
		expect(store.model.threads.size).toBe(1);
		expect(editor.links.get('q0_r0')).toEqual(['Home']);
	});
});

describe('cut, copy, paste (decision 29)', () => {
	it('copy duplicates content and notes, names become "- 2"; the target keeps its own notes', async () => {
		const { store, editor } = await setup();
		store.model.getHex(1, 0)!.name = 'Oasis';
		editor.links.set('q6_r1', ['Already here']);
		editor.copyHexes([[1, 0]], [1, 0]);
		const res = editor.pasteHexes(6, 1)!;
		expect(res.hexes).toBe(1);
		const pasted = store.model.getHex(6, 1)!;
		expect(pasted.terrain).toBe('desert');
		expect(pasted.name).toBe('Oasis - 2');
		expect(editor.links.get('q6_r1')).toEqual(['Already here', 'Oasis', 'Well lore']);
		expect(editor.clipboard).not.toBeNull(); // a copy pastes any number of times
		editor.undoLast();
		expect(store.model.getHex(6, 1)).toBeUndefined();
		expect(editor.links.get('q6_r1')).toEqual(['Already here']);
	});

	it('a cut moves hexes, their threads and notes, and pastes once', async () => {
		const { store, editor } = await setup();
		editor.createThread('q0_r0', 'q17_r-3', { type: 'Rumor', label: '', direction: 'bidirectional', status: 'active', color: '' });
		expect(editor.cutHexes([[0, 0], [1, 0]], [0, 0])).toBe(2);
		expect(store.model.getHex(0, 0)).toBeUndefined();
		expect(editor.links.has('q0_r0')).toBe(false);
		editor.pasteHexes(4, 2);
		expect(store.model.getHex(4, 2)!.terrain).toBe('forest');
		expect(store.model.getHex(5, 2)!.feature).toBe('well');
		expect([...store.model.threads.values()][0]!.fromHex).toBe('q4_r2');
		expect(editor.links.get('q4_r2')).toEqual(['Home']);
		expect(editor.clipboard).toBeNull();
		editor.undoLast(); // the paste: the cut goes back on the clipboard
		expect(editor.clipboard?.clip.isCut).toBe(true);
		editor.undoLast(); // the cut: restored, clipboard emptied
		expect(store.model.getHex(0, 0)!.terrain).toBe('forest');
		expect(editor.clipboard).toBeNull();
		expect(editor.links.get('q0_r0')).toEqual(['Home']);
	});

	it('a hex holding ONLY notes is cut, copied, pasted and deleted like any other', async () => {
		const { store, editor } = await setup();
		editor.links.set('q6_r1', ['Hermit']);
		expect(store.model.getHex(6, 1)).toBeUndefined();
		expect(editor.cutHexes([[6, 1]], [6, 1])).toBe(1);
		expect(editor.links.has('q6_r1')).toBe(false);
		editor.pasteHexes(8, 2);
		expect(editor.links.get('q8_r2')).toEqual(['Hermit']);
		expect(store.model.getHex(8, 2)).toBeUndefined(); // still no record
		editor.undoLast();
		editor.undoLast();
		expect(editor.links.get('q6_r1')).toEqual(['Hermit']);
		expect(store.model.getHex(6, 1)).toBeUndefined(); // undo made no empty record

		// Pasted onto a painted hex, a notes-only hex adds notes and keeps the paint.
		editor.copyHexes([[6, 1]], [6, 1]);
		editor.pasteHexes(0, 0);
		expect(store.model.getHex(0, 0)!.terrain).toBe('forest');
		expect(editor.links.get('q0_r0')).toEqual(['Home', 'Hermit']);

		expect(editor.deleteHexes([[6, 1]])).toBe(1);
		expect(editor.links.has('q6_r1')).toBe(false);
	});

	it('refuses a paste with any cell off the grid', async () => {
		const { editor } = await setup();
		editor.copyHexes([[0, 0], [1, 0]], [0, 0]);
		expect(editor.pastePrecheck(39, 0)).toMatch(/1 of 2/);
		expect(editor.pasteHexes(39, 0)).toBeNull();
	});
});

describe('moving, exploding, resizing (decision 11)', () => {
	it('moves a selection with its notes; undo restores; blocked moves refused', async () => {
		const { store, editor } = await setup();
		expect(editor.canMoveSelection([[0, 0]], 1, 0)).toBe(false); // onto (1,0)
		expect(editor.moveSelection([[0, 0], [1, 0]], 3, 1)).toBe(true);
		expect(store.model.getHex(3, 1)!.terrain).toBe('forest');
		expect(editor.links.get('q4_r1')).toEqual(['Oasis', 'Well lore']);
		expect(store.model.revealed.has('q3_r1')).toBe(true); // fog moved with q0_r0
		editor.undoLast();
		expect(store.model.getHex(0, 0)!.terrain).toBe('forest');
		expect(editor.links.get('q1_r0')).toEqual(['Oasis', 'Well lore']);
		expect(editor.links.has('q4_r1')).toBe(false);
	});

	it('a notes-only hex moves with the selection', async () => {
		const { editor } = await setup();
		editor.links.set('q6_r1', ['Hermit']);
		expect(editor.moveSelection([[6, 1]], 1, 1)).toBe(true);
		expect(editor.links.get('q7_r2')).toEqual(['Hermit']);
		expect(editor.links.has('q6_r1')).toBe(false);
		editor.undoLast();
		expect(editor.links.get('q6_r1')).toEqual(['Hermit']);
		expect(editor.links.has('q7_r2')).toBe(false);
	});

	it('explodes about the centroid, refusing when the grid is too small', async () => {
		const { store, editor } = await setup();
		editor.deleteHexes([[17, -3], [-5, 4]]); // keep the map well inside the grid
		editor.moveSelection([[0, 0], [1, 0]], 10, 5);
		expect(editor.explodePrecheck(20)).toMatch(/Enlarge the grid/);
		expect(editor.explodeMap(2)).toBeNull();
		const cells = [...store.model.hexes.values()].map((h) => [h.q, h.r]);
		expect(cells).toHaveLength(2);
		expect(Math.abs(cells[0]![0]! - cells[1]![0]!)).toBe(2); // neighbours now two apart
		editor.undoLast();
		expect(store.model.getHex(10, 5)!.terrain).toBe('forest');
	});

	it('resizes about the centre, dropping what falls outside, and clears the history', async () => {
		const { store, editor, written } = await setup();
		editor.renameHex(0, 0, 'X');
		const gone = editor.outsideAfterResize(10, 10).map((h) => h.id).sort();
		expect(editor.resizeGrid(10, 10)).toBe(gone.length);
		expect(store.model.meta.gridCols).toBe(10);
		expect(store.model.meta.gridMinQ).toBe(15);
		expect(editor.undo.canUndo).toBe(false);
		expect([...(written.at(-1)?.keys() ?? [])].sort()).toEqual(gone.filter((id) => ['q0_r0', 'q1_r0'].includes(id)));
	});
});

describe("a hex's notes", () => {
	it('links, reorders and unlinks as undo steps, writing deltas to the index', async () => {
		const { editor, written } = await setup();
		editor.setHexNotes('q0_r0', ['Home', 'Ruins'], 'Link');
		editor.setHexNotes('q0_r0', ['Ruins', 'Home'], 'Reorder');
		expect(written.at(-1)).toEqual(new Map([['q0_r0', ['Ruins', 'Home']]]));
		editor.setHexNotes('q0_r0', [], 'Unlink');
		expect(written.at(-1)).toEqual(new Map([['q0_r0', null]]));
		editor.undoLast();
		editor.undoLast();
		expect(editor.hexNotes('q0_r0')).toEqual(['Home', 'Ruins']);
	});
});

describe('reading the index while link writes are in flight', () => {
	it('keeps the unwritten changes on top of what the file says', async () => {
		const { editor } = await setup();
		let finish = () => {};
		editor.linkWriter = () => new Promise<void>((resolve) => (finish = resolve));
		editor.setHexNotes('q0_r0', ['Home', 'Ruins'], 'Link');
		editor.linksFromIndex(new Map([['q0_r0', ['Home']]])); // the file before the write
		expect(editor.hexNotes('q0_r0')).toEqual(['Home', 'Ruins']);
		finish();
		await Promise.resolve();
		editor.linksFromIndex(new Map([['q0_r0', ['Home']]])); // written: the file wins again
		expect(editor.hexNotes('q0_r0')).toEqual(['Home']);
	});
});
