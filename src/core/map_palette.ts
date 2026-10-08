// The shared render spec: the TypeScript port of Flutter's
// lib/core/map_palette.dart (vendored JS mirror: vendor/player/render_spec.js).
// Pure: no Obsidian or DOM import anywhere under src/core/.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the four bytes of q, the four of r, then the salt byte.
 * Unsigned 32-bit. Math.imul is required: a plain `*` loses the low bits
 * past 2^53 and drifts from Dart (decision 13).
 */
export function hash2(q: number, r: number, salt = 0): number {
	let h = FNV_OFFSET >>> 0;
	const feed = (byte: number) => {
		h = (h ^ (byte & 0xff)) >>> 0;
		h = Math.imul(h, FNV_PRIME) >>> 0;
	};
	for (let shift = 0; shift < 32; shift += 8) feed(q >> shift);
	for (let shift = 0; shift < 32; shift += 8) feed(r >> shift);
	feed(salt);
	return h >>> 0;
}

/** {@link hash2} mapped to 0..1 (24 bits, exact in a double). */
export function hashUnit(q: number, r: number, salt = 0): number {
	return (hash2(q, r, salt) & 0xffffff) / 0xffffff;
}

/** {@link hashUnit} remapped to -amount..+amount. */
export function hashSigned(q: number, r: number, salt: number, amount: number): number {
	return (hashUnit(q, r, salt) * 2 - 1) * amount;
}
