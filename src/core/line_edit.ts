// Port of Flutter's lib/core/line_edit.dart (decision 8c): editing a river or
// a route ONE POINT AT A TIME on the GM canvas. A drag moves one point and
// adds none; landing on a neighbour merges the two (that is how a drag
// shortens a line); an edit that would leave fewer than two points is
// refused (null), never stored.

import { sameAnchor, type Anchor } from './river';

export interface LineEdit {
	nodes: Anchor[];
	/** The moved / inserted point's index in [nodes]. */
	index: number;
}

export function moveLinePoint(nodes: Anchor[], index: number, target: Anchor): LineEdit | null {
	if (index < 0 || index >= nodes.length) return null;
	const out = [...nodes];
	out[index] = target;
	if (index > 0 && sameAnchor(out[index - 1]!, target)) {
		out.splice(index, 1);
		return out.length < 2 ? null : { nodes: out, index: index - 1 };
	}
	if (index + 1 < out.length && sameAnchor(out[index + 1]!, target)) {
		out.splice(index, 1);
		return out.length < 2 ? null : { nodes: out, index };
	}
	return { nodes: out, index };
}

/** Insert [node] on link [segment] (between points segment and segment+1). */
export function insertLinePoint(nodes: Anchor[], segment: number, node: Anchor): LineEdit | null {
	if (segment < 0 || segment + 1 >= nodes.length) return null;
	if (sameAnchor(nodes[segment]!, node)) return { nodes: [...nodes], index: segment };
	if (sameAnchor(nodes[segment + 1]!, node)) return { nodes: [...nodes], index: segment + 1 };
	const out = [...nodes];
	out.splice(segment + 1, 0, node);
	return { nodes: out, index: segment + 1 };
}

/** The link of a polyline nearest a point: [segment, distance]. */
export function nearestLineSegment(points: [number, number][], x: number, y: number): [number, number] | null {
	if (points.length < 2) return null;
	let best = -1, bestD2 = Infinity;
	for (let i = 0; i + 1 < points.length; i++) {
		const [ax, ay] = points[i]!, [bx, by] = points[i + 1]!;
		const dx = bx - ax, dy = by - ay;
		const len2 = dx * dx + dy * dy;
		const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
		const px = ax + t * dx - x, py = ay + t * dy - y;
		const d2 = px * px + py * py;
		if (d2 < bestD2) {
			bestD2 = d2;
			best = i;
		}
	}
	return [best, Math.sqrt(bestD2)];
}
