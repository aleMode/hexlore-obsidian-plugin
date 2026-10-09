// Port of Flutter's lib/importer/river_tracer.dart (decisions 12c, 12f): the
// ASSIST path for rivers (12h: drawing is the default). Water likeness (a
// FIELD, 5-bit LUT over Lab) → ridge filter → non-maxima suppression →
// peak-relative hysteresis → wide-pixel (lake) rejection → parallel-track
// suppression → skeleton graph (spurs pruned, gaps linked) → per-component
// longest-path decomposition → duplicate and enclosing-loop rejection.
// Iteration orders and rounding follow the Dart code so results match.

import { dartRound } from '../core/geometry';
import type { SourceGrid } from './grid_calibration';
import { argbToLab, deltaE } from './lab';
import type { Raster } from './raster';
import { DEFAULT_RIDGE, hysteresis, ridgeResponse, suppressNonMaxima, type RidgeParams } from './ridge_filter';

export interface TracedRiver {
	points: [number, number][];
	widthPx: number;
}

export const riverLengthPx = (r: TracedRiver) => {
	let total = 0;
	for (let i = 1; i < r.points.length; i++) total += Math.hypot(r.points[i]![0] - r.points[i - 1]![0], r.points[i]![1] - r.points[i - 1]![1]);
	return total;
};

export interface RiverTraceParams {
	tolerance: number;
	maxWidthFactor: number;
	minLengthFactor: number;
	simplifyFactor: number;
	maxGapFactor: number;
	maxGapAngle: number;
	strongFraction: number;
	parallelSpacingPx: number;
	duplicateSpacingPx: number;
	maxBridgedFraction: number;
	ridge: RidgeParams;
}

export const DEFAULT_TRACE: RiverTraceParams = {
	tolerance: 20,
	maxWidthFactor: 0.45,
	minLengthFactor: 3,
	simplifyFactor: 0.08,
	maxGapFactor: 2,
	maxGapAngle: 1.4,
	strongFraction: 0.02,
	parallelSpacingPx: 4,
	duplicateSpacingPx: 12,
	maxBridgedFraction: 0.8,
	ridge: DEFAULT_RIDGE,
};

/** Ridge scale σ → a river's painted width, px. */
export const SCALE_TO_WIDTH = 2.6;

/** Water colours to seed the trace with: the confirmed water groups' colours
 *  if any, else the most common blue-ish colour of the image (a GUESS). */
export function suggestRiverSeeds(image: Raster, hints: Iterable<number> = []): number[] {
	const fromHints = new Set<number>();
	for (const a of hints) fromHints.add((a | 0xff000000) >>> 0);
	if (fromHints.size) return [...fromHints].slice(0, 4);
	const stride = Math.max(1, dartRound(Math.sqrt((image.width * image.height) / 200000)));
	const counts = new Map<number, number>(), sums = new Map<number, [number, number, number]>();
	for (let y = 0; y < image.height; y += stride) {
		for (let x = 0; x < image.width; x += stride) {
			const i = (y * image.width + x) * 4;
			const r = image.data[i]!, g = image.data[i + 1]!, b = image.data[i + 2]!;
			if (b < r + 20 || b < g + 8) continue;
			const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
			counts.set(bin, (counts.get(bin) ?? 0) + 1);
			const s = sums.get(bin) ?? [0, 0, 0];
			sums.set(bin, [s[0] + r, s[1] + g, s[2] + b]);
		}
	}
	if (!counts.size) return [];
	let best: [number, number] | null = null;
	for (const e of counts) if (!best || e[1] > best[1]) best = e;
	const [sr, sg, sb] = sums.get(best![0])!;
	const n = best![1];
	return [(0xff000000 | (Math.floor(sr / n) << 16) | (Math.floor(sg / n) << 8) | Math.floor(sb / n)) >>> 0];
}

export interface RiverTrace {
	width: number;
	height: number;
	likeness: Float32Array;
	psi: Float32Array;
	centerlines: Uint8Array;
	mask: Uint8Array;
	rivers: TracedRiver[];
}

export const traceRivers = (image: Raster, grid: SourceGrid, seeds: number[], params: RiverTraceParams = DEFAULT_TRACE) => traceRiversDebug(image, grid, seeds, params).rivers;

export function traceRiversDebug(image: Raster, grid: SourceGrid, seeds: number[], params: RiverTraceParams = DEFAULT_TRACE): RiverTrace {
	const w = image.width, h = image.height;
	if (!seeds.length) return { width: w, height: h, likeness: new Float32Array(w * h), psi: new Float32Array(w * h), centerlines: new Uint8Array(w * h), mask: new Uint8Array(w * h), rivers: [] };
	const likeness = waterLikeness(image, seeds, params.tolerance);
	const ridge = ridgeResponse(likeness, w, h, params.ridge);
	const nms = suppressNonMaxima(ridge);
	const high = centerlineThreshold(nms, params.strongFraction);
	const centerlines = hysteresis(nms, w, h, high, high * params.ridge.lowRatio);
	const dist = new Float32Array(ridge.scale);
	const mask = new Uint8Array(centerlines);
	rejectWidePixels(mask, dist, params.maxWidthFactor * grid.radius);
	dropParallelTracks(mask, nms, ridge.orientation, w, h, params.parallelSpacingPx);
	const graph = SkeletonGraph.build(mask, w, h);
	graph.prune(Math.min(params.minLengthFactor, 1.2) * grid.radius);
	graph.linkGaps(params.maxGapFactor * grid.radius, params.maxGapAngle);
	const minLength = params.minLengthFactor * grid.radius;
	const epsilon = params.simplifyFactor * grid.radius;
	const rivers: TracedRiver[] = [];
	for (const [chain, bridgedFraction] of graph.decompose(minLength)) {
		if (chain.length < 2) continue;
		const points = chain.map((p): [number, number] => [(p % w) + 0.5, Math.floor(p / w) + 0.5]);
		const river = { points: simplify(points, epsilon), widthPx: medianWidth(chain, dist) };
		if (riverLengthPx(river) < minLength || bridgedFraction > params.maxBridgedFraction) continue;
		rivers.push(river);
	}
	rivers.sort((a, b) => riverLengthPx(b) - riverLengthPx(a));
	dropDuplicateCourses(rivers, params.duplicateSpacingPx);
	dropEnclosingLoops(rivers, params.duplicateSpacingPx);
	return { width: w, height: h, likeness, psi: ridge.psi, centerlines, mask, rivers };
}

/** 1 at a seed colour falling to 0 at [tolerance] ΔE (a 5-bit LUT, or a
 *  full map re-converts the same colours a hundred thousand times). */
export function waterLikeness(image: Raster, seeds: number[], tolerance: number): Float32Array {
	const w = image.width, h = image.height;
	const field = new Float32Array(w * h);
	if (!seeds.length || tolerance <= 0) return field;
	const labSeeds = seeds.map(argbToLab);
	const lut = new Float32Array(1 << 15), known = new Uint8Array(1 << 15);
	for (let i = 0, p = 0; i < w * h; i++, p += 4) {
		const r = image.data[p]!, g = image.data[p + 1]!, b = image.data[p + 2]!;
		const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
		if (!known[bin]) {
			const lab = argbToLab((0xff000000 | ((((bin >> 10) << 3) | 4) << 16) | (((((bin >> 5) & 0x1f) << 3) | 4) << 8) | (((bin & 0x1f) << 3) | 4)) >>> 0);
			let best = Infinity;
			for (const s of labSeeds) best = Math.min(best, deltaE(lab, s));
			lut[bin] = Math.min(1, Math.max(0, 1 - best / tolerance));
			known[bin] = 1;
		}
		field[i] = lut[bin]!;
	}
	return field;
}

/** Peak-relative, not Otsu (after NMS there is only one class left). */
export function centerlineThreshold(nms: Float32Array, fraction = 0.02): number {
	let peak = 0;
	for (const v of nms) if (v > peak) peak = v;
	return peak * fraction;
}

/** Compare only ACROSS the ridge: a stronger track within [spacingPx] wins. */
function dropParallelTracks(mask: Uint8Array, nms: Float32Array, orientation: Float32Array, w: number, h: number, spacingPx: number): void {
	if (spacingPx <= 1) return;
	const doomed: number[] = [];
	const steps = Math.ceil(spacingPx);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (!mask[i]) continue;
			const v = nms[i]!, theta = orientation[i]!;
			const px = -Math.sin(theta), py = Math.cos(theta);
			let beaten = false;
			for (let step = 1; step <= steps && !beaten; step++) {
				for (const sign of [1, -1]) {
					const nx = dartRound(x + px * step * sign), ny = dartRound(y + py * step * sign);
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const j = ny * w + nx;
					if (mask[j] && nms[j]! > v) {
						beaten = true;
						break;
					}
				}
			}
			if (beaten) doomed.push(i);
		}
	}
	for (const i of doomed) mask[i] = 0;
}

/** A lake's shore comes back to where it started: as one loop, or as two
 *  arcs sharing both ends. */
function dropEnclosingLoops(rivers: TracedRiver[], spacingPx: number): void {
	const near = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= spacingPx * 2;
	const doomed = new Set<number>();
	for (let i = 0; i < rivers.length; i++) {
		const a = rivers[i]!;
		if (a.points.length < 3) continue;
		if (near(a.points[0]!, a.points[a.points.length - 1]!)) {
			doomed.add(i);
			continue;
		}
		for (let j = i + 1; j < rivers.length; j++) {
			const b = rivers[j]!;
			if (b.points.length < 3) continue;
			const af = a.points[0]!, al = a.points[a.points.length - 1]!, bf = b.points[0]!, bl = b.points[b.points.length - 1]!;
			if ((near(af, bf) && near(al, bl)) || (near(af, bl) && near(al, bf))) {
				doomed.add(i);
				doomed.add(j);
			}
		}
	}
	if (!doomed.size) return;
	const keep = rivers.filter((_, i) => !doomed.has(i));
	rivers.splice(0, rivers.length, ...keep);
}

/** A course more than 70 % within [spacingPx] of a longer one is a duplicate. */
function dropDuplicateCourses(rivers: TracedRiver[], spacingPx: number): void {
	const keep: TracedRiver[] = [];
	for (const river of rivers) {
		let covered = 0;
		for (const p of river.points) {
			for (const other of keep) {
				if (distanceToPolyline(p, other.points) <= spacingPx) {
					covered++;
					break;
				}
			}
		}
		if (river.points.length && covered / river.points.length > 0.7) continue;
		keep.push(river);
	}
	rivers.splice(0, rivers.length, ...keep);
}

function distanceToPolyline(p: [number, number], line: [number, number][]): number {
	let best = Infinity;
	for (let i = 1; i < line.length; i++) best = Math.min(best, pointSegmentDistance(p, line[i - 1]!, line[i]!));
	return best;
}

function rejectWidePixels(mask: Uint8Array, scale: Float32Array, maxWidthPx: number): void {
	for (let i = 0; i < mask.length; i++) if (mask[i] && SCALE_TO_WIDTH * scale[i]! > maxWidthPx) mask[i] = 0;
}

class Branch {
	dead = false;
	constructor(
		readonly a: number,
		readonly b: number,
		readonly pixels: number[],
		readonly width: number,
		readonly bridge = false,
	) {}

	get length(): number {
		let total = 0;
		for (let i = 1; i < this.pixels.length; i++) {
			const dx = (this.pixels[i]! % this.width) - (this.pixels[i - 1]! % this.width);
			const dy = Math.floor(this.pixels[i]! / this.width) - Math.floor(this.pixels[i - 1]! / this.width);
			total += dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
		}
		return total;
	}

	other(node: number): number {
		return node === this.a ? this.b : this.a;
	}
}

class SkeletonGraph {
	constructor(
		readonly width: number,
		readonly branches: Branch[],
		readonly incident: Map<number, number[]>,
	) {}

	static build(skeleton: Uint8Array, w: number, h: number): SkeletonGraph {
		const neighbours = new Map<number, number[]>();
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				if (!skeleton[i]) continue;
				const list: number[] = [];
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
						if (skeleton[ny * w + nx]) list.push(ny * w + nx);
					}
				}
				neighbours.set(i, list);
			}
		}
		const isNode = new Set<number>();
		for (const [k, v] of neighbours) if (v.length !== 2) isNode.add(k);
		const branches: Branch[] = [];
		const walked = new Set<string>();
		const walk = (start: number, first: number) => {
			const key = `${start},${first}`;
			if (walked.has(key)) return;
			walked.add(key);
			const pixels = [start];
			let previous = start, current = first;
			for (;;) {
				pixels.push(current);
				if (isNode.has(current)) break;
				const next = neighbours.get(current)!.find((n) => n !== previous) ?? -1;
				if (next < 0) break;
				previous = current;
				current = next;
			}
			if (pixels.length >= 2) walked.add(`${pixels[pixels.length - 1]},${pixels[pixels.length - 2]}`);
			branches.push(new Branch(start, pixels[pixels.length - 1]!, pixels, w));
		};
		for (const node of isNode) for (const n of neighbours.get(node)!) walk(node, n);
		// Node-free rings (a closed loop with no junction).
		const claimed = new Set<number>();
		for (const b of branches) for (const p of b.pixels) claimed.add(p);
		for (const [pixel, ring] of neighbours) {
			if (claimed.has(pixel) || !ring.length) continue;
			const loop = [pixel];
			let previous = pixel, current = ring[0]!;
			while (current !== pixel) {
				loop.push(current);
				claimed.add(current);
				const next = neighbours.get(current)!.find((n) => n !== previous) ?? pixel;
				previous = current;
				current = next;
			}
			claimed.add(pixel);
			loop.push(pixel);
			branches.push(new Branch(pixel, pixel, loop, w));
		}
		const incident = new Map<number, number[]>();
		branches.forEach((b, i) => {
			(incident.get(b.a) ?? incident.set(b.a, []).get(b.a)!).push(i);
			if (b.b !== b.a) (incident.get(b.b) ?? incident.set(b.b, []).get(b.b)!).push(i);
		});
		return new SkeletonGraph(w, branches, incident);
	}

	/** Shave short spurs hanging off a junction (never a whole stroke). */
	prune(minLengthPx: number): void {
		for (let round = 0; round < 4; round++) {
			let changed = false;
			for (const b of this.branches) {
				if (b.dead || b.a === b.b) continue;
				const degA = this.liveDegree(b.a), degB = this.liveDegree(b.b);
				if (degA !== 1 && degB !== 1) continue;
				if (degA === 1 && degB === 1) continue;
				if (b.length >= minLengthPx) continue;
				b.dead = true;
				changed = true;
			}
			if (!changed) return;
		}
	}

	private liveDegree(node: number): number {
		let count = 0;
		for (const i of this.incident.get(node) ?? []) if (!this.branches[i]!.dead) count++;
		return count;
	}

	/** Rejoin ends a label or bridge interrupted: both aimed along the join,
	 *  the gap short; shortest gaps first, each end used once. */
	linkGaps(maxGapPx: number, maxAngle: number): void {
		const ends: number[] = [];
		for (const b of this.branches) {
			if (b.dead || b.a === b.b) continue;
			if (this.liveDegree(b.a) === 1) ends.push(b.a);
			if (this.liveDegree(b.b) === 1) ends.push(b.b);
		}
		if (ends.length < 2) return;
		const candidates: [number, number, number][] = [];
		for (let i = 0; i < ends.length; i++) {
			for (let j = i + 1; j < ends.length; j++) {
				const a = ends[i]!, b = ends[j]!;
				if (a === b) continue;
				const dx = (b % this.width) - (a % this.width), dy = Math.floor(b / this.width) - Math.floor(a / this.width);
				const gap = Math.sqrt(dx * dx + dy * dy);
				if (gap <= 0 || gap > maxGapPx) continue;
				const ta = this.tangentAt(a), tb = this.tangentAt(b);
				if (!ta || !tb) continue;
				if (angleBetween(ta, [dx / gap, dy / gap]) > maxAngle) continue;
				if (angleBetween(tb, [-dx / gap, -dy / gap]) > maxAngle) continue;
				candidates.push([gap, a, b]);
			}
		}
		candidates.sort((p, q) => p[0] - q[0]);
		const used = new Set<number>();
		for (const [, a, b] of candidates) {
			if (used.has(a) || used.has(b)) continue;
			used.add(a);
			used.add(b);
			const index = this.branches.length;
			this.branches.push(new Branch(a, b, this.line(a, b), this.width, true));
			(this.incident.get(a) ?? this.incident.set(a, []).get(a)!).push(index);
			(this.incident.get(b) ?? this.incident.set(b, []).get(b)!).push(index);
		}
	}

	private tangentAt(node: number): [number, number] | null {
		for (const i of this.incident.get(node) ?? []) {
			const b = this.branches[i]!;
			if (b.dead) continue;
			const pixels = b.a === node ? b.pixels : [...b.pixels].reverse();
			const back = pixels[Math.min(8, pixels.length - 1)]!;
			const dx = (node % this.width) - (back % this.width), dy = Math.floor(node / this.width) - Math.floor(back / this.width);
			const len = Math.sqrt(dx * dx + dy * dy);
			if (len === 0) continue;
			return [dx / len, dy / len];
		}
		return null;
	}

	private line(a: number, b: number): number[] {
		const x0 = a % this.width, y0 = Math.floor(a / this.width), x1 = b % this.width, y1 = Math.floor(b / this.width);
		const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
		if (!steps) return [a];
		const out: number[] = [];
		for (let s = 0; s <= steps; s++) {
			const t = s / steps;
			out.push(dartRound(y0 + (y1 - y0) * t) * this.width + dartRound(x0 + (x1 - x0) * t));
		}
		return out;
	}

	/** Per component (junk filtered by total ink), repeatedly the longest
	 *  path: main stem first, then tributaries. [pixels, bridged fraction]. */
	decompose(minLengthPx: number): [number[], number][] {
		const chains: [number[], number][] = [];
		for (const component of this.components()) {
			const ink = component.reduce((s, i) => s + this.branches[i]!.length, 0);
			if (ink < minLengthPx) {
				for (const i of component) this.branches[i]!.dead = true;
				continue;
			}
			let guard = 0;
			while (guard++ < 500) {
				const path = this.longestPathIn(component);
				if (!path) break;
				const length = path.reduce((s, i) => s + this.branches[i]!.length, 0);
				if (length < minLengthPx) {
					for (const i of component) this.branches[i]!.dead = true;
					break;
				}
				const bridged = path.reduce((s, i) => s + (this.branches[i]!.bridge ? this.branches[i]!.length : 0), 0);
				chains.push([this.stitch(path), length <= 0 ? 0 : bridged / length]);
				for (const i of path) this.branches[i]!.dead = true;
			}
		}
		return chains;
	}

	private components(): number[][] {
		const seen = new Uint8Array(this.branches.length);
		const groups: number[][] = [];
		for (let start = 0; start < this.branches.length; start++) {
			if (seen[start] || this.branches[start]!.dead) continue;
			seen[start] = 1;
			const stack = [start], group: number[] = [];
			while (stack.length) {
				const i = stack.pop()!;
				group.push(i);
				const b = this.branches[i]!;
				for (const node of [b.a, b.b]) {
					for (const j of this.incident.get(node) ?? []) {
						if (seen[j] || this.branches[j]!.dead) continue;
						seen[j] = 1;
						stack.push(j);
					}
				}
			}
			groups.push(group);
		}
		return groups;
	}

	private longestPathIn(component: number[]): number[] | null {
		let seed: number | null = null;
		for (const i of component) {
			if (!this.branches[i]!.dead) {
				seed = this.branches[i]!.a;
				break;
			}
		}
		if (seed === null) return null;
		const [far] = this.sweep(seed);
		const [, path] = this.sweep(far);
		return path.length ? path : null;
	}

	/** Dijkstra from [start]: the farthest node and the branches to it. */
	private sweep(start: number): [number, number[]] {
		const best = new Map<number, number>([[start, 0]]);
		const via = new Map<number, number>(), from = new Map<number, number>();
		const queue = [start];
		let farNode = start, farDist = 0;
		while (queue.length) {
			let pick = 0;
			for (let i = 1; i < queue.length; i++) if (best.get(queue[i]!)! < best.get(queue[pick]!)!) pick = i;
			const node = queue.splice(pick, 1)[0]!;
			const d = best.get(node)!;
			if (d > farDist) {
				farDist = d;
				farNode = node;
			}
			for (const i of this.incident.get(node) ?? []) {
				const b = this.branches[i]!;
				if (b.dead) continue;
				const next = b.other(node);
				if (next === node) continue;
				const candidate = d + b.length;
				if (candidate < (best.get(next) ?? Infinity)) {
					best.set(next, candidate);
					via.set(next, i);
					from.set(next, node);
					queue.push(next);
				}
			}
		}
		const path: number[] = [];
		let cursor = farNode;
		while (via.has(cursor)) {
			path.unshift(via.get(cursor)!);
			cursor = from.get(cursor)!;
		}
		if (!path.length) for (const i of this.incident.get(start) ?? []) if (!this.branches[i]!.dead) return [start, [i]];
		return [farNode, path];
	}

	private stitch(path: number[]): number[] {
		if (!path.length) return [];
		const first = this.branches[path[0]!]!;
		let pixels = [...first.pixels];
		if (path.length > 1) {
			const second = this.branches[path[1]!]!;
			const shared = second.a === first.a || second.b === first.a ? first.a : first.b;
			if (pixels[0] === shared) pixels = pixels.reverse();
		}
		for (let i = 1; i < path.length; i++) {
			const b = this.branches[path[i]!]!;
			const next = b.pixels[0] === pixels[pixels.length - 1] ? b.pixels : [...b.pixels].reverse();
			pixels.push(...next.slice(1));
		}
		return pixels;
	}
}

function medianWidth(pixels: number[], scale: Float32Array): number {
	const widths = pixels.map((i) => SCALE_TO_WIDTH * scale[i]!).sort((a, b) => a - b);
	return widths.length ? widths[Math.floor(widths.length / 2)]! : 1;
}

/** Douglas–Peucker. */
function simplify(points: [number, number][], epsilon: number): [number, number][] {
	if (points.length <= 2 || epsilon <= 0) return points;
	const keep = new Array<boolean>(points.length).fill(false);
	keep[0] = keep[points.length - 1] = true;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [lo, hi] = stack.pop()!;
		if (hi <= lo + 1) continue;
		let worst = -1, worstD = epsilon;
		for (let i = lo + 1; i < hi; i++) {
			const d = pointSegmentDistance(points[i]!, points[lo]!, points[hi]!);
			if (d > worstD) {
				worstD = d;
				worst = i;
			}
		}
		if (worst < 0) continue;
		keep[worst] = true;
		stack.push([lo, worst], [worst, hi]);
	}
	return points.filter((_, i) => keep[i]);
}

function pointSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
	const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1];
	const len2 = vx * vx + vy * vy;
	const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
	return Math.hypot(wx - t * vx, wy - t * vy);
}

function angleBetween(a: [number, number], b: [number, number]): number {
	return Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1])));
}
