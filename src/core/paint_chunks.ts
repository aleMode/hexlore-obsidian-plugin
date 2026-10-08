// Port of Flutter's lib/core/paint_chunks.dart: the paint layer is cut into
// 16×16 chunks on the lattice (q and the unstaggered row), never on the grid
// window, so resizing the window never moves a hex to another file.

import { floorDiv, unstaggeredRow } from './geometry';

export const CHUNK_SIZE = 16;

/** The chunk holding hex (q, r): [cx, cy, file name]. */
export function chunkOf(q: number, r: number): [number, number, string] {
	const cx = floorDiv(q, CHUNK_SIZE), cy = floorDiv(unstaggeredRow(q, r), CHUNK_SIZE);
	return [cx, cy, `c_${cx}_${cy}.json`];
}
