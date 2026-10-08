// Port of Flutter's lib/core/river_edit.dart: editing a river ONE POINT AT A
// TIME (decision 8c). Every edit re-walks the disturbed links along the
// anchor lattice (connectVertices), so a chain is never broken.

import { anchorNeighbors } from './anchors';
import { HEX_RADIUS, nodePixel } from './geometry';
import { sameAnchor, type Anchor } from './river';

export interface RiverEdit {
	nodes: Anchor[];
	index: number;
}

const px = (a: Anchor) => nodePixel(a.kind, a.q, a.r, a.k);
const key = (a: Anchor) => `${a.kind},${a.q},${a.r},${a.k}`;

/** Move node [index] to [target], re-walking both links. */
export function moveRiverNode(nodes: Anchor[], index: number, target: Anchor): RiverEdit {
	if (index < 0 || index >= nodes.length) return { nodes: [...nodes], index };
	const rebuilt: Anchor[] = [];
	let moved = 0;
	nodes.forEach((n, i) => {
		const v = i === index ? target : n;
		if (!rebuilt.length) rebuilt.push(v);
		else rebuilt.push(...connectVertices(rebuilt[rebuilt.length - 1]!, v).slice(1));
		if (i === index) moved = rebuilt.length - 1;
	});
	return { nodes: rebuilt, index: moved };
}

/** Insert [node] on the link after [index], walking to and from it. */
export function insertRiverNodeOnLink(nodes: Anchor[], index: number, node: Anchor): RiverEdit {
	if (index < 0 || index + 1 >= nodes.length) return { nodes: [...nodes], index: -1 };
	const head = nodes.slice(0, index + 1), tail = nodes.slice(index + 1);
	const rebuilt = [...head, ...connectVertices(head[head.length - 1]!, node).slice(1)];
	const inserted = rebuilt.length - 1;
	rebuilt.push(...connectVertices(node, tail[0]!).slice(1), ...tail.slice(1));
	return { nodes: rebuilt, index: inserted };
}

/** Remove node [index], bridging the gap along the lattice. A two-node river
 *  keeps both. */
export function removeRiverNodeAt(nodes: Anchor[], index: number): Anchor[] {
	if (index < 0 || index >= nodes.length || nodes.length <= 2) return [...nodes];
	const out = [...nodes];
	out.splice(index, 1);
	if (index === 0 || index >= out.length) return out;
	const walk = connectVertices(out[index - 1]!, out[index]!);
	out.splice(index, 0, ...walk.slice(1, -1));
	return out;
}

/** The lattice walk from [a] to [b] that hugs the straight line between them
 *  (A* over anchorNeighbors; a step costs its true length plus a pull toward
 *  the line). Unreachable within the budget: drawn straight. */
export function connectVertices(a: Anchor, b: Anchor, maxExpansions = 20000): Anchor[] {
	if (sameAnchor(a, b)) return [a];
	const [ax, ay] = px(a), [bx, by] = px(b);
	const guideCost = (x: number, y: number) => {
		const vx = bx - ax, vy = by - ay;
		const len2 = vx * vx + vy * vy;
		const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2));
		return Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) / HEX_RADIUS;
	};
	const open: Anchor[] = [a];
	const g = new Map<string, number>([[key(a), 0]]);
	const f = new Map<string, number>([[key(a), 0]]);
	const cameFrom = new Map<string, Anchor>();
	let expansions = 0;
	while (open.length && expansions++ < maxExpansions) {
		let pick = 0;
		for (let i = 1; i < open.length; i++) if (f.get(key(open[i]!))! < f.get(key(open[pick]!))!) pick = i;
		const current = open.splice(pick, 1)[0]!;
		if (sameAnchor(current, b)) break;
		const gc = g.get(key(current))!;
		const [cx, cy] = px(current);
		for (const n of anchorNeighbors(current)) {
			const [nx, ny] = px(n);
			const candidate = gc + Math.hypot(nx - cx, ny - cy) / HEX_RADIUS + 0.25 * guideCost(nx, ny);
			if (candidate >= (g.get(key(n)) ?? Infinity)) continue;
			g.set(key(n), candidate);
			f.set(key(n), candidate + Math.hypot(bx - nx, by - ny) / HEX_RADIUS);
			cameFrom.set(key(n), current);
			open.push(n);
		}
	}
	if (!cameFrom.has(key(b))) return [a, b];
	const path: Anchor[] = [b];
	let cursor = b;
	while (!sameAnchor(cursor, a)) {
		cursor = cameFrom.get(key(cursor))!;
		path.unshift(cursor);
	}
	return path;
}
