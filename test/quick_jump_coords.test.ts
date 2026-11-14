import { describe, expect, it } from 'vitest';
import { displayIdFor } from '../src/core/hex';
import { parseJumpCoords } from '../src/core/quick_jump';

describe('quick jump by coordinates', () => {
	it('reads display ids as displayIdFor writes them, and axial ids', () => {
		for (const [q, r] of [[0, 0], [5, 2], [25, 9], [26, 0], [27, 40], [-1, 3], [-27, -2], [3, -1]] as const) {
			expect(parseJumpCoords(displayIdFor(q, r))).toEqual([q, r]);
		}
		expect(parseJumpCoords(' f3 ')).toEqual([5, 2]);
		expect(parseJumpCoords('q5_r-2')).toEqual([5, -2]);
		expect(parseJumpCoords('Q5 R-2')).toEqual([5, -2]);
		expect(parseJumpCoords('Fort')).toBeNull();
		expect(parseJumpCoords('Road 66')).toBeNull();
	});
});
