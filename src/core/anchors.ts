// The river / route anchor graph (from Flutter's lib/core/geometry.dart).
//
// Rivers and routes walk the same lattice: corner `v`, edge midpoint `e`,
// hex centre `c`. anchorNeighbors is its SHORT-step edge set — corner↔edge
// (R/2) and edge↔centre (the apothem), plus corner↔corner — so a snapped
// river can hug a curve. Every returned anchor is canonical, which makes the
// graph symmetric. Membership is decided by ENDPOINTS, never by distance:
// six edge midpoints sit exactly R/2 from any corner, and only three of them
// belong to edges ending there.

import { HEX_RADIUS, nodePixel, pixelToAxial } from './geometry';
import { canonicalVertex, HEX_EDGE_NEIGHBORS, anchor, sameAnchor, vertexNeighbors, vertexTouchingHexes, type Anchor } from './river';
import { canonicalEdge } from './route';

const mod6 = (k: number) => ((k % 6) + 6) % 6;

/** The two canonical corners bounding edge k of (q, r). */
export function edgeEndVertices(q: number, r: number, k: number): Anchor[] {
	return [mod6(k), (mod6(k) + 1) % 6].map((corner) => {
		const [cq, cr, cc] = canonicalVertex(q, r, corner);
		return anchor('v', cq, cr, cc);
	});
}

/** The anchors one short step from [node]. */
export function anchorNeighbors(node: Anchor): Anchor[] {
	const out: Anchor[] = [];
	const add = (kind: string, q: number, r: number, k: number) => {
		let c: [number, number, number];
		if (kind === 'v') c = canonicalVertex(q, r, k);
		else if (kind === 'e') c = canonicalEdge(q, r, k);
		else c = [q, r, 0];
		const n = anchor(kind, c[0], c[1], c[2]);
		if (!sameAnchor(n, node) && !out.some((o) => sameAnchor(o, n))) out.push(n);
	};
	if (node.kind === 'c') {
		for (let k = 0; k < 6; k++) add('e', node.q, node.r, k);
		return out;
	}
	if (node.kind === 'e') {
		for (const v of edgeEndVertices(node.q, node.r, node.k)) add('v', v.q, v.r, v.k);
		add('c', node.q, node.r, 0);
		const [dq, dr] = HEX_EDGE_NEIGHBORS[mod6(node.k)]!;
		add('c', node.q + dq, node.r + dr, 0);
		return out;
	}
	for (const [hq, hr] of vertexTouchingHexes(node.q, node.r, node.k)) {
		for (let k = 0; k < 6; k++) {
			const [eq, er, ek] = canonicalEdge(hq, hr, k);
			if (edgeEndVertices(eq, er, ek).some((v) => sameAnchor(v, node))) add('e', eq, er, ek);
		}
	}
	for (const [vq, vr, vc] of vertexNeighbors(node.q, node.r, node.k)) add('v', vq, vr, vc);
	return out;
}

/** The nearest allowed anchor to a scene pixel, canonicalised. */
export function nearestAnchor(x: number, y: number, allowed: readonly string[] = ['v', 'e', 'c'], radius = HEX_RADIUS): Anchor {
	const [q, r] = pixelToAxial(x, y, radius);
	const candidates: Anchor[] = [];
	if (allowed.includes('c')) candidates.push(anchor('c', q, r, 0));
	if (allowed.includes('v')) {
		for (let corner = 0; corner < 6; corner++) {
			const [cq, cr, cc] = canonicalVertex(q, r, corner);
			candidates.push(anchor('v', cq, cr, cc));
		}
	}
	if (allowed.includes('e')) {
		for (let k = 0; k < 6; k++) {
			const [eq, er, ek] = canonicalEdge(q, r, k);
			candidates.push(anchor('e', eq, er, ek));
		}
	}
	let best = candidates[0]!;
	let bestD = Infinity;
	for (const c of candidates) {
		const [px, py] = nodePixel(c.kind, c.q, c.r, c.k, radius);
		const d = (px - x) * (px - x) + (py - y) * (py - y);
		if (d < bestD) {
			bestD = d;
			best = c;
		}
	}
	return best;
}
