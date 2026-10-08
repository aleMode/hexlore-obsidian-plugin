// Port of Flutter's lib/core/region.dart: named hex sets drawn as a contour
// and a hatch (decision 7). GM-only.

import { HEX_RADIUS, axialToPixel, hexCorners } from './geometry';
import { int, str, unknownKeys, type JsonObject } from './json';
import { canonicalVertex, HEX_EDGE_NEIGHBORS, type VertexId } from './river';

export type Edge = [VertexId, VertexId];

const REGION_KEYS = new Set(['id', 'name', 'cells', 'color', 'z_order', 'page_file', 'layer' /* retired: dropped */]);

export class Region {
	name = '';
	/** [[q, r], ...] member hexes. */
	cells: [number, number][] = [];
	color = '#B0603A';
	zOrder = 0;
	pageFile: string | null = null;
	extra: JsonObject = {};

	constructor(readonly id: string) {}

	cellSet(): Set<string> {
		return new Set(this.cells.map(([q, r]) => `${q},${r}`));
	}

	toJson(): JsonObject {
		return {
			id: this.id,
			name: this.name,
			cells: this.cells.map(([q, r]) => [q, r]),
			color: this.color,
			z_order: this.zOrder,
			page_file: this.pageFile,
			...this.extra,
		};
	}

	static fromJson(json: JsonObject): Region | null {
		const id = str(json.id);
		if (id === undefined) return null;
		const g = new Region(id);
		g.name = str(json.name) ?? '';
		g.cells = Array.isArray(json.cells)
			? json.cells
					.filter((c): c is [number, number] => Array.isArray(c) && int(c[0]) !== undefined && int(c[1]) !== undefined)
					.map(([q, r]) => [q, r])
			: [];
		g.color = str(json.color) ?? '#B0603A';
		g.zOrder = int(json.z_order) ?? 0;
		g.pageFile = str(json.page_file) ?? null;
		g.extra = unknownKeys(json, REGION_KEYS);
		return g;
	}

	copy(): Region {
		const g = new Region(this.id);
		g.name = this.name;
		g.cells = this.cells.map(([q, r]) => [q, r]);
		g.color = this.color;
		g.zOrder = this.zOrder;
		g.pageFile = this.pageFile;
		g.extra = { ...this.extra };
		return g;
	}
}

function cmpVertex(a: VertexId, b: VertexId): number {
	if (a[0] !== b[0]) return a[0] - b[0];
	if (a[1] !== b[1]) return a[1] - b[1];
	return a[2] - b[2];
}

/** The contour of a set of cells: every edge with a member on one side only,
 *  as canonical vertex pairs, sorted. Keys of [members] are "q,r". */
export function boundaryEdges(members: Iterable<[number, number]>): Edge[] {
	const set = new Set<string>();
	const cells: [number, number][] = [];
	for (const [q, r] of members) {
		if (!set.has(`${q},${r}`)) cells.push([q, r]);
		set.add(`${q},${r}`);
	}
	const edges = new Map<string, Edge>();
	for (const [q, r] of cells) {
		for (let k = 0; k < 6; k++) {
			const [dq, dr] = HEX_EDGE_NEIGHBORS[k]!;
			if (set.has(`${q + dq},${r + dr}`)) continue;
			const va = canonicalVertex(q, r, k), vb = canonicalVertex(q, r, (k + 1) % 6);
			const e: Edge = cmpVertex(va, vb) <= 0 ? [va, vb] : [vb, va];
			edges.set(e.flat().join(','), e);
		}
	}
	return [...edges.values()].sort((a, b) => cmpVertex(a[0], b[0]) || cmpVertex(a[1], b[1]));
}

/** The region's hatch as PRE-CLIPPED segments [x0, y0, x1, y1]: diagonal
 *  lines (x + y = const) every [gap] px, cut to the member hexes, chords on
 *  one line merged. Drawn with no clip path at all (decision 23). */
export function regionHatchSegments(
	members: Iterable<[number, number]>,
	gap = 11,
	radius = HEX_RADIUS,
	origin?: number,
): [number, number, number, number][] {
	const corners: [number, number][][] = [];
	for (const [q, r] of members) {
		const [cx, cy] = axialToPixel(q, r, radius);
		corners.push(hexCorners(cx, cy, radius));
	}
	if (!corners.length) return [];
	let left = Infinity, top = Infinity;
	for (const cs of corners) for (const [x, y] of cs) {
		left = Math.min(left, x);
		top = Math.min(top, y);
	}
	const k0 = origin ?? left + top;
	const chords = new Map<number, [number, number][]>();
	for (const cs of corners) {
		let sMin = Infinity, sMax = -Infinity;
		for (const [x, y] of cs) {
			sMin = Math.min(sMin, x + y);
			sMax = Math.max(sMax, x + y);
		}
		for (let n = Math.ceil((sMin - k0) / gap); k0 + n * gap <= sMax; n++) {
			const k = k0 + n * gap;
			let x0 = Infinity, x1 = -Infinity;
			for (let i = 0; i < 6; i++) {
				const [ax, ay] = cs[i]!, [bx, by] = cs[(i + 1) % 6]!;
				const sa = ax + ay - k, sb = bx + by - k;
				if (sa === sb || ((sa > 0) === (sb > 0) && sa !== 0 && sb !== 0)) continue;
				const x = ax + (bx - ax) * (sa / (sa - sb));
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x);
			}
			if (x1 - x0 > 1e-9) {
				let list = chords.get(n);
				if (!list) chords.set(n, (list = []));
				list.push([x0, x1]);
			}
		}
	}
	const out: [number, number, number, number][] = [];
	for (const n of [...chords.keys()].sort((a, b) => a - b)) {
		const k = k0 + n * gap;
		const list = chords.get(n)!.sort((a, b) => a[0] - b[0]);
		let [s, e] = list[0]!;
		const emit = () => out.push([s, k - s, e, k - e]);
		for (const [a, b] of list.slice(1)) {
			if (a <= e + 1e-6) e = Math.max(e, b);
			else {
				emit();
				[s, e] = [a, b];
			}
		}
		emit();
	}
	return out;
}
