// Port of Flutter's lib/core/route.dart: canonical edges and the route model
// (highway / road / trail / border along the shared anchor lattice).

import { canonicalVertex, HEX_EDGE_NEIGHBORS, anchor, type Anchor } from './river';
import { bool, dbl, int, num, str, unknownKeys, type JsonObject } from './json';

const mod6 = (k: number) => ((k % 6) + 6) % 6;

/** Canonical id of hex (q, r)'s edge k: from the lexicographically smaller
 *  of the two hexes sharing it. */
export function canonicalEdge(q: number, r: number, k: number): [number, number, number] {
	const [dq, dr] = HEX_EDGE_NEIGHBORS[mod6(k)]!;
	const nq = q + dq, nr = r + dr;
	if (q < nq || (q === nq && r <= nr)) return [q, r, mod6(k)];
	return [nq, nr, (mod6(k) + 3) % 6];
}

export const vertexNode = (q: number, r: number, corner: number): Anchor => {
	const [cq, cr, cc] = canonicalVertex(q, r, corner);
	return anchor('v', cq, cr, cc);
};

export const edgeNode = (q: number, r: number, k: number): Anchor => {
	const [eq, er, ek] = canonicalEdge(q, r, k);
	return anchor('e', eq, er, ek);
};

export const centreNode = (q: number, r: number): Anchor => anchor('c', q, r, 0);

/** The route kinds this build knows; any other is kept, drawn as a road, and
 *  never served to players. */
export const ROUTE_KINDS = ['highway', 'road', 'trail', 'border'] as const;
export const isKnownRouteKind = (k: string) => (ROUTE_KINDS as readonly string[]).includes(k);

const ROUTE_KEYS = new Set(['id', 'kind', 'nodes', 'color', 'width', 'player_visible']);

export class Route {
	/** Kept as the raw string, so a newer kind survives. */
	kind = 'road';
	nodes: Anchor[] = [];
	color = '#6B4A2F';
	width = 1.0;
	/** Roads and trails: true. A border is created hidden from players. */
	playerVisible = true;
	extra: JsonObject = {};

	constructor(readonly id: string) {}

	toJson(): JsonObject {
		return {
			id: this.id,
			kind: this.kind,
			nodes: this.nodes.map((n) => ({ kind: n.kind, q: n.q, r: n.r, k: n.k })),
			color: this.color,
			width: dbl(this.width),
			player_visible: this.playerVisible,
			...this.extra,
		};
	}

	static fromJson(json: JsonObject): Route | null {
		const id = str(json.id);
		if (id === undefined) return null;
		const r = new Route(id);
		r.kind = str(json.kind) ?? 'road';
		r.nodes = [];
		if (Array.isArray(json.nodes)) {
			for (const n of json.nodes) {
				if (n === null || typeof n !== 'object' || Array.isArray(n)) continue;
				const o = n as JsonObject;
				const kind = str(o.kind), q = int(o.q), rr = int(o.r);
				if (kind === undefined || q === undefined || rr === undefined) continue;
				r.nodes.push(anchor(kind, q, rr, int(o.k) ?? 0));
			}
		}
		r.color = str(json.color) ?? '#6B4A2F';
		r.width = num(json.width) ?? 1.0;
		r.playerVisible = bool(json.player_visible) ?? true;
		r.extra = unknownKeys(json, ROUTE_KEYS);
		return r;
	}

	copy(): Route {
		const r = new Route(this.id);
		r.kind = this.kind;
		r.nodes = this.nodes.map((n) => ({ ...n }));
		r.color = this.color;
		r.width = this.width;
		r.playerVisible = this.playerVisible;
		r.extra = { ...this.extra };
		return r;
	}
}
