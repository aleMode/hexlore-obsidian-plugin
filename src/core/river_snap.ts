// Port of the pure half of Flutter's lib/importer/river_snap.dart: snapping a
// scene-pixel polyline onto the anchor lattice (decision 12c). A small
// Viterbi map-match — several candidate anchors per resampled point; the
// chain that wins is close to the ink AND does not wander — then the gaps are
// filled with the lattice walk. The sketch's hexify and the importer's
// drawn rivers both go through here.

import { nearestAnchor } from './anchors';
import { HEX_RADIUS, axialRound, nodePixel } from './geometry';
import { RIVER_WIDTH_MAX, RIVER_WIDTH_MIN, canonicalVertex, anchor, sameAnchor, type Anchor } from './river';
import { connectVertices } from './river_edit';
import { canonicalEdge } from './route';

const SQRT3 = Math.sqrt(3);

/** A river's water stroke at width 1.0, scene px (hex_map.dart's layer). */
export const RIVER_BASE_STROKE_PX = 5.0;

export interface RiverSnapParams {
	/** Resampling step, × the hex radius: finer than half a lattice edge. */
	sampleFactor: number;
	/** Candidates kept per sample (1 would be the greedy snap). */
	candidates: number;
	/** Weight of a detour against being off the ink: higher = straighter. */
	wander: number;
}

export const DEFAULT_SNAP: RiverSnapParams = { sampleFactor: 0.35, candidates: 4, wander: 1.4 };

export function axialToPixelF(q: number, r: number, radius = HEX_RADIUS): [number, number] {
	return [radius * 1.5 * q, radius * SQRT3 * (r + q / 2)];
}

export function pixelToAxialF(x: number, y: number, radius = HEX_RADIUS): [number, number] {
	return [((2 / 3) * x) / radius, ((-1 / 3) * x + (SQRT3 / 3) * y) / radius];
}

/** The anchor nearest a continuous axial position. */
export function nearestAnchorAxial(qf: number, rf: number): Anchor {
	const [x, y] = axialToPixelF(qf, rf);
	return nearestAnchor(x, y);
}

const px = (a: Anchor) => nodePixel(a.kind, a.q, a.r, a.k);

/** Snap a polyline in SCENE pixels to a chain of canonical anchors; [] when
 *  it is too short to be a river. */
export function snapScenePolyline(scene: [number, number][], params: RiverSnapParams = DEFAULT_SNAP): Anchor[] {
	if (scene.length < 2) return [];
	const samples = resample(scene, params.sampleFactor * HEX_RADIUS);
	if (samples.length < 2) return [];
	const chain = viterbi(samples, params);
	if (chain.length < 2) return [];
	const vertices: Anchor[] = [chain[0]!];
	for (let i = 1; i < chain.length; i++) vertices.push(...connectVertices(vertices[vertices.length - 1]!, chain[i]!).slice(1));
	dropBacktracks(vertices);
	return vertices.length < 2 ? [] : vertices;
}

/** Shift a chain by a whole-cell translation (exact on the lattice). */
export function translateVertices(vertices: Anchor[], dq: number, dr: number): Anchor[] {
	return vertices.map((v) => ({ ...v, q: v.q + dq, r: v.r + dr }));
}

/** A painted width in source px → the river's width multiplier. */
export function riverWidthMultiplier(widthPx: number, sourceRadius: number): number {
	if (sourceRadius <= 0) return 1;
	const scenePx = widthPx * (HEX_RADIUS / sourceRadius);
	return Math.min(RIVER_WIDTH_MAX, Math.max(RIVER_WIDTH_MIN, scenePx / RIVER_BASE_STROKE_PX));
}

function resample(points: [number, number][], step: number): [number, number][] {
	if (points.length < 2 || step <= 0) return points;
	const out: [number, number][] = [points[0]!];
	let carry = 0;
	for (let i = 1; i < points.length; i++) {
		const [x0, y0] = points[i - 1]!, [x1, y1] = points[i]!;
		const dx = x1 - x0, dy = y1 - y0;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len === 0) continue;
		let travelled = step - carry;
		while (travelled <= len) {
			const t = travelled / len;
			out.push([x0 + dx * t, y0 + dy * t]);
			travelled += step;
		}
		carry = len - (travelled - step);
	}
	const last = out[out.length - 1]!, end = points[points.length - 1]!;
	if (last[0] !== end[0] || last[1] !== end[1]) out.push(end);
	return out;
}

const NEIGHBOURHOOD: [number, number][] = [
	[0, 0],
	[1, 0],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[0, -1],
	[1, -1],
];

/** Every anchor of the point's cell and its six neighbours, nearest first. */
function candidatesAt(x: number, y: number, count: number): [Anchor, number][] {
	const [qf, rf] = pixelToAxialF(x, y);
	const [q, r] = axialRound(qf, rf);
	const seen = new Set<string>();
	const scored: [Anchor, number][] = [];
	const offer = (v: Anchor) => {
		const k = `${v.kind},${v.q},${v.r},${v.k}`;
		if (seen.has(k)) return;
		seen.add(k);
		const [vx, vy] = px(v);
		scored.push([v, Math.sqrt((vx - x) * (vx - x) + (vy - y) * (vy - y))]);
	};
	for (const [dq, dr] of NEIGHBOURHOOD) {
		const hq = q + dq, hr = r + dr;
		offer(anchor('c', hq, hr, 0));
		for (let corner = 0; corner < 6; corner++) {
			const [vq, vr, vc] = canonicalVertex(hq, hr, corner);
			offer(anchor('v', vq, vr, vc));
			const [eq, er, ek] = canonicalEdge(hq, hr, corner);
			offer(anchor('e', eq, er, ek));
		}
	}
	// Dart sorts this with an UNSTABLE sort; ties (a point at a centre is
	// equidistant from six edges) could order differently here. The fixtures
	// agree today; if a snap ever diverges, port Dart's sort.
	scored.sort((a, b) => a[1] - b[1]);
	return scored.slice(0, count);
}

function viterbi(samples: [number, number][], params: RiverSnapParams): Anchor[] {
	const layers = samples.map(([x, y]) => candidatesAt(x, y, params.candidates));
	if (!layers.length) return [];
	let costs = layers[0]!.map(([, d]) => d / HEX_RADIUS);
	const back: number[][] = [];
	for (let i = 1; i < layers.length; i++) {
		const previous = layers[i - 1]!, current = layers[i]!;
		const [sx0, sy0] = samples[i - 1]!, [sx1, sy1] = samples[i]!;
		const segment = Math.sqrt((sx0 - sx1) ** 2 + (sy0 - sy1) ** 2);
		const next = new Array<number>(current.length).fill(Infinity);
		const choice = new Array<number>(current.length).fill(0);
		current.forEach(([vertex, emission], c) => {
			const [vx, vy] = px(vertex);
			previous.forEach(([pv], p) => {
				const [ppx, ppy] = px(pv);
				const moved = Math.sqrt((vx - ppx) ** 2 + (vy - ppy) ** 2);
				const total = costs[p]! + params.wander * (Math.max(0, moved - segment) / HEX_RADIUS);
				if (total < next[c]!) {
					next[c] = total;
					choice[c] = p;
				}
			});
			next[c]! += emission / HEX_RADIUS;
		});
		costs = next;
		back.push(choice);
	}
	let best = 0;
	for (let i = 1; i < costs.length; i++) if (costs[i]! < costs[best]!) best = i;
	const chain: Anchor[] = [];
	for (let i = layers.length - 1; i >= 0; i--) {
		chain.unshift(layers[i]![best]![0]);
		if (i > 0) best = back[i - 1]![best]!;
	}
	const deduped: Anchor[] = [];
	for (const v of chain) if (!deduped.length || !sameAnchor(deduped[deduped.length - 1]!, v)) deduped.push(v);
	return deduped;
}

/** Remove a → b → a bounces. */
function dropBacktracks(v: Anchor[]): void {
	let i = 1;
	while (i + 1 < v.length) {
		if (sameAnchor(v[i - 1]!, v[i + 1]!)) {
			v.splice(i, 2);
			if (i > 1) i--;
		} else i++;
	}
}
