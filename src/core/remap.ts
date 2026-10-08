// Port of Flutter's lib/core/remap.dart (decision 11): ONE engine behind
// "Explode map…" and moving a selection. A cell transform is applied to every
// hex and everything pointing at hexes, and what it changed is returned so
// the caller can undo it as one step.
//
// The plugin has no NPC or quest records (they are notes): instead the
// result carries the old→new hex id map, which the `.hexmap.md` index uses
// to move each hex's note list.

import { cellInGrid, floorDiv } from './geometry';
import type { Hex } from './hex';
import type { MapModel } from './map';
import { canonicalVertex, anchor, type Anchor } from './river';
import { canonicalEdge } from './route';
import type { River } from './river';
import type { Route } from './route';
import type { Thread } from './thread';

export type CellTransform = (q: number, r: number) => [number, number];

/** Spread every cell k× apart about [anchorCell]. */
export function explodeTransform(anchorCell: [number, number], k: number): CellTransform {
	return (q, r) => [anchorCell[0] + k * (q - anchorCell[0]), anchorCell[1] + k * (r - anchorCell[1])];
}

/** Move [cells] by (dq, dr); everything else stays. */
export function moveTransform(cells: Set<string>, dq: number, dr: number): CellTransform {
	return (q, r) => (cells.has(`${q},${r}`) ? [q + dq, r + dr] : [q, r]);
}

export function populatedCentroid(m: MapModel): [number, number] {
	if (!m.hexes.size) return [0, 0];
	let sq = 0, sr = 0;
	for (const h of m.hexes.values()) {
		sq += h.q;
		sr += h.r;
	}
	const round = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
	return [round(sq / m.hexes.size), round(sr / m.hexes.size)];
}

export function hexesOutsideAfter(m: MapModel, t: CellTransform): Hex[] {
	return [...m.hexes.values()].filter((h) => {
		const [q, r] = t(h.q, h.r);
		return !cellInGrid(q, r, m.meta.grid);
	});
}

/** The (cols, rows) a window needs to hold [cells]. */
export function requiredWindow(cells: Iterable<[number, number]>): [number, number] {
	let first = true;
	let minQ = 0, maxQ = 0, minO = 0, maxO = 0;
	for (const [q, r] of cells) {
		const o = r + floorDiv(q, 2);
		if (first) {
			minQ = maxQ = q;
			minO = maxO = o;
			first = false;
			continue;
		}
		minQ = Math.min(minQ, q);
		maxQ = Math.max(maxQ, q);
		minO = Math.min(minO, o);
		maxO = Math.max(maxO, o);
	}
	return first ? [0, 0] : [maxQ - minQ + 1, maxO - minO + 1];
}

/** Every stored hex of [cells] lands in the grid on a free cell. */
export function canMoveCells(m: MapModel, cells: Set<string>, dq: number, dr: number): boolean {
	for (const key of cells) {
		const [q, r] = key.split(',').map(Number) as [number, number];
		if (!m.getHex(q, r)) continue;
		const tq = q + dq, tr = r + dr;
		if (!cellInGrid(tq, tr, m.meta.grid)) return false;
		if (m.getHex(tq, tr) && !cells.has(`${tq},${tr}`)) return false;
	}
	return true;
}

export class RemapResult {
	/** Old hex id → new hex id, for every hex that moved. */
	readonly hexIds = new Map<string, string>();
	readonly hexesBefore: Hex[] = [];
	readonly threadsBefore: Thread[] = [];
	readonly riversBefore: River[] = [];
	readonly routesBefore: Route[] = [];
	readonly regionCellsBefore = new Map<string, [number, number][]>();
	/** The revealed set before, when a revealed hex moved. */
	revealedBefore: Set<string> | null = null;

	get changedAnything(): boolean {
		return (
			this.hexesBefore.length > 0 ||
			this.threadsBefore.length > 0 ||
			this.riversBefore.length > 0 ||
			this.routesBefore.length > 0 ||
			this.regionCellsBefore.size > 0
		);
	}
}

function moveAnchor(n: Anchor, nq: number, nr: number): Anchor {
	if (n.kind === 'v') {
		const [cq, cr, cc] = canonicalVertex(nq, nr, n.k);
		return anchor('v', cq, cr, cc);
	}
	if (n.kind === 'e') {
		const [eq, er, ek] = canonicalEdge(nq, nr, n.k);
		return anchor('e', eq, er, ek);
	}
	return anchor('c', nq, nr, 0);
}

/** Apply [t] to the map in place. Anchors move with their canonical owner
 *  cell and are re-canonicalised (an edge's owner can flip). */
export function applyCellRemap(m: MapModel, t: CellTransform): RemapResult {
	const res = new RemapResult();
	// 1. Hexes: remove every moving key first, then insert, so a permutation
	//    never clobbers an unprocessed hex.
	const moved = [...m.hexes.values()].filter((h) => {
		const [q, r] = t(h.q, h.r);
		return q !== h.q || r !== h.r;
	});
	for (const h of moved) {
		res.hexesBefore.push(h.copy());
		m.hexes.delete(h.id);
	}
	for (const h of moved) {
		const [nq, nr] = t(h.q, h.r);
		const nh = h.copyAt(nq, nr);
		m.hexes.set(nh.id, nh);
		res.hexIds.set(h.id, nh.id);
	}
	// Player fog moves with the hexes it belongs to.
	if (moved.some((h) => m.revealed.has(h.id))) {
		res.revealedBefore = new Set(m.revealed);
		const now = [...m.revealed].map((id) => res.hexIds.get(id) ?? id);
		for (const id of res.hexIds.keys()) if (res.revealedBefore.has(id)) m.revealed.delete(id);
		for (const id of now) m.revealed.add(id);
	}
	// 2. Threads: endpoints are hex ids.
	for (const th of m.threads.values()) {
		const nf = res.hexIds.get(th.fromHex), nt = res.hexIds.get(th.toHex);
		if (!nf && !nt) continue;
		res.threadsBefore.push(th.copy());
		if (nf) th.fromHex = nf;
		if (nt) th.toHex = nt;
	}
	// 3. Regions: member cells, kept sorted.
	for (const reg of m.regions.values()) {
		let changed = false;
		const cells = reg.cells.map(([q, r]) => {
			const [nq, nr] = t(q, r);
			if (nq !== q || nr !== r) changed = true;
			return [nq, nr] as [number, number];
		});
		if (!changed) continue;
		res.regionCellsBefore.set(reg.id, reg.cells.map(([q, r]) => [q, r]));
		reg.cells = cells.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
	}
	// 4–5. Rivers and routes.
	const remapLine = (nodes: Anchor[]): Anchor[] | null => {
		let changed = false;
		const out = nodes.map((n) => {
			const [nq, nr] = t(n.q, n.r);
			if (nq === n.q && nr === n.r) return n;
			changed = true;
			return moveAnchor(n, nq, nr);
		});
		return changed ? out : null;
	};
	for (const riv of m.rivers.values()) {
		const nodes = remapLine(riv.nodes);
		if (!nodes) continue;
		res.riversBefore.push(riv.copy());
		riv.nodes = nodes;
	}
	for (const rt of m.routes.values()) {
		const nodes = remapLine(rt.nodes);
		if (!nodes) continue;
		res.routesBefore.push(rt.copy());
		rt.nodes = nodes;
	}
	return res;
}
