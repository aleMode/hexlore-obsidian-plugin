import { describe, expect, it } from 'vitest';
import { around } from '../src/patch';

type Open = (x: string) => string;
/** Stands in for WorkspaceLeaf.prototype: an object holding the method. */
const leaf = (): { open: Open } => ({ open: (x) => `open ${x}` });

describe('around', () => {
	it('wraps, and restores the original when nobody wrapped after us', () => {
		const proto = leaf();
		const original = proto.open;
		const undo = around(proto, 'open', (next) => (x) => next(x.toUpperCase()));
		expect(proto.open('map')).toBe('open MAP');
		undo();
		expect(proto.open).toBe(original);
		expect(proto.open('map')).toBe('open map');
	});

	it('keeps a later wrapper working when ours is undone first', () => {
		const proto = leaf();
		const undoOurs = around(proto, 'open', (next) => (x) => next(`${x}+ours`));
		// Another plugin wraps after us, the usual way.
		const theirs = proto.open;
		proto.open = (x) => theirs(`${x}+theirs`);
		undoOurs();
		// Theirs still runs; ours is a pass-through.
		expect(proto.open('a')).toBe('open a+theirs');
		// They restore what they found; ours stays inert.
		proto.open = theirs;
		expect(proto.open('a')).toBe('open a');
	});
});
