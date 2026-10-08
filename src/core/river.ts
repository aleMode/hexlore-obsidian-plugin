// Port of Flutter's lib/core/river.dart: canonical vertices and the river model.
//
// Each grid vertex has one canonical id (q, r, c) with c ∈ {0, 1}:
//   corner 0 of (q,r) → (q,   r,   0)     corner 3 → (q-1, r,   1)
//   corner 1 of (q,r) → (q,   r,   1)     corner 4 → (q-1, r,   0)
//   corner 2 of (q,r) → (q-1, r+1, 0)     corner 5 → (q,   r-1, 1)

import { dbl, num, str, unknownKeys, type Json, type JsonObject } from './json';

export type VertexId = [number, number, number];

const CORNER_MAP: VertexId[] = [
	[0, 0, 0],
	[0, 0, 1],
	[-1, 1, 0],
	[-1, 0, 1],
	[-1, 0, 0],
	[0, -1, 1],
];

const mod6 = (k: number) => ((k % 6) + 6) % 6;

/** Canonical id of any of the 6 corners of (q, r). */
export function canonicalVertex(q: number, r: number, corner: number): VertexId {
	const [dq, dr, c] = CORNER_MAP[mod6(corner)]!;
	return [q + dq, r + dr, c];
}

/** The 3 canonical vertices adjacent to canonical vertex (q, r, c). */
export function vertexNeighbors(q: number, r: number, c: number): VertexId[] {
	if (c === 0) return [[q, r, 1], [q, r - 1, 1], [q + 1, r - 1, 1]];
	return [[q, r, 0], [q - 1, r + 1, 0], [q, r + 1, 0]];
}

/** The (up to) 3 hexes sharing canonical vertex (q, r, c). */
export function vertexTouchingHexes(q: number, r: number, c: number): [number, number][] {
	if (c === 0) return [[q, r], [q + 1, r - 1], [q + 1, r]];
	return [[q, r], [q + 1, r], [q, r + 1]];
}

/** The hex across each of the 6 edges; edge k lies between corners k and k+1.
 *  The opposite of edge k is (k + 3) % 6. */
export const HEX_EDGE_NEIGHBORS: readonly [number, number][] = [
	[1, 0],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[0, -1],
	[1, -1],
];

/** One anchor: kind "v" corner / "e" edge midpoint / "c" centre, q, r, k. */
export interface Anchor {
	kind: string;
	q: number;
	r: number;
	k: number;
}

export const anchor = (kind: string, q: number, r: number, k = 0): Anchor => ({ kind, q, r, k });
export const sameAnchor = (a: Anchor, b: Anchor) => a.kind === b.kind && a.q === b.q && a.r === b.r && a.k === b.k;

/** The stored form of a river anchor: always `[kind, q, r, k]`. */
export function riverNodeJson(n: Anchor): Json[] {
	return [n.kind, n.q, n.r, n.k];
}

/** A stored river anchor, in either form: `[q, r, c]` (legacy corner) or
 *  `[kind, q, r, k]`. Null when it is neither. */
export function riverNodeFrom(raw: unknown): Anchor | null {
	if (!Array.isArray(raw) || !raw.length) return null;
	const n = (i: number, d = 0) => Math.trunc(num(raw[i]) ?? d);
	if (typeof raw[0] === 'string') {
		if (num(raw[1]) === undefined || num(raw[2]) === undefined) return null;
		return anchor(raw[0], n(1), n(2), n(3));
	}
	if (num(raw[0]) === undefined || num(raw[1]) === undefined) return null;
	return anchor('v', n(0), n(1), n(2));
}

/** The hexes sharing an anchor: what decides player visibility. */
export function anchorTouchingHexes(n: Anchor): [number, number][] {
	if (n.kind === 'c') return [[n.q, n.r]];
	if (n.kind === 'v') return vertexTouchingHexes(n.q, n.r, n.k);
	const [dq, dr] = HEX_EDGE_NEIGHBORS[mod6(n.k)]!;
	return [[n.q, n.r], [n.q + dq, n.r + dr]];
}

export const RIVER_WIDTH_MIN = 0.25;
export const RIVER_WIDTH_MAX = 4.0;

const RIVER_KEYS = new Set(['id', 'vertices', 'width']);

/** A river: a connected sequence of anchors. */
export class River {
	nodes: Anchor[] = [];
	width = 1.0;
	extra: JsonObject = {};

	constructor(readonly id: string) {}

	toJson(): JsonObject {
		return { id: this.id, vertices: this.nodes.map(riverNodeJson), width: dbl(this.width), ...this.extra };
	}

	static fromJson(json: JsonObject): River | null {
		const id = str(json.id);
		if (id === undefined) return null;
		const r = new River(id);
		r.nodes = Array.isArray(json.vertices) ? json.vertices.map(riverNodeFrom).filter((a): a is Anchor => a !== null) : [];
		r.width = num(json.width) ?? 1.0;
		r.extra = unknownKeys(json, RIVER_KEYS);
		return r;
	}

	copy(): River {
		const r = new River(this.id);
		r.nodes = this.nodes.map((n) => ({ ...n }));
		r.width = this.width;
		r.extra = { ...this.extra };
		return r;
	}
}
