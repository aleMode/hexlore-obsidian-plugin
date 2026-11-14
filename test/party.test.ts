import { describe, expect, it } from 'vitest';
import { readPartyBook, renamePartyBook } from '../src/party/party';

describe('the party book', () => {
	it('reads tolerantly, dropping bad hexes and times', () => {
		expect(readPartyBook({ 'A.hexmap.md': { hex: 'q1_r-2', hours: 5 }, 'B.hexmap.md': { hex: 'F3', hours: -1 }, C: 3 })).toEqual({
			'A.hexmap.md': { hex: 'q1_r-2', hours: 5 },
			'B.hexmap.md': { hex: null, hours: 0 },
		});
		expect(readPartyBook(undefined)).toEqual({});
	});

	it('follows a renamed map or folder', () => {
		const book = { 'Camp/West.hexmap.md': { hex: 'q0_r0', hours: 2 } };
		expect(renamePartyBook(book, 'Camp/West.hexmap.md', 'Camp/Far west.hexmap.md')).toEqual({ 'Camp/Far west.hexmap.md': { hex: 'q0_r0', hours: 2 } });
		expect(renamePartyBook(book, 'Camp', 'Campaign')).toEqual({ 'Campaign/West.hexmap.md': { hex: 'q0_r0', hours: 2 } });
		expect(renamePartyBook(book, 'Other', 'Else')).toBeNull();
	});
});
