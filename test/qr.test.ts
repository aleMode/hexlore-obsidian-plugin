import { describe, expect, it } from 'vitest';
import { qrModules } from '../src/server/qr';

describe('the player link as a QR code', () => {
	it('encodes a LAN link as a square with the three finder patterns', () => {
		const m = qrModules('http://192.168.1.20:5174');
		const n = m.length;
		expect(n).toBeGreaterThanOrEqual(21);
		expect(m.every((row) => row.length === n)).toBe(true);
		// Finder patterns: a dark 7×7 ring in three corners.
		for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
			expect(m[r]![c]).toBe(true);
			expect(m[r + 6]![c + 6]).toBe(true);
			expect(m[r + 1]![c + 1]).toBe(false);
			expect(m[r + 3]![c + 3]).toBe(true);
		}
	});
});
