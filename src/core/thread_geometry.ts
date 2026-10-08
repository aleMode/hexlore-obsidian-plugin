// Port of Flutter's lib/core/thread_geometry.dart: threads laid out as a
// COURSE (decision 27). Each thread is a quadratic Bézier, trimmed so it
// starts and ends a ring away from the hex centres. Several threads between
// the same two hexes fan out: Ribbon offsets them sideways, Arc bows each
// further one wider.

import { HEX_RADIUS } from './geometry';

export type ThreadStyle = 'ribbon' | 'arc';
export const parseThreadStyle = (v: unknown): ThreadStyle => (v === 'ribbon' ? 'ribbon' : 'arc');

export const THREAD_END_TRIM = 0.5;
export const THREAD_PARALLEL_GAP = 0.3;
export const THREAD_BOW_SHARE = 0.18;
export const THREAD_BOW_MIN = 0.35;
export const THREAD_BOW_MAX = 1.6;
export const THREAD_BOW_STEP = 0.45;

type P = [number, number];

export interface ThreadLink {
	id: string;
	from: string;
	to: string;
	a: P;
	b: P;
}

export class ThreadShape {
	constructor(
		readonly p0: P,
		readonly p1: P,
		readonly p2: P,
		readonly t0: number,
		readonly t1: number,
	) {}

	at(t: number): P {
		const u = 1 - t;
		return [
			u * u * this.p0[0] + 2 * u * t * this.p1[0] + t * t * this.p2[0],
			u * u * this.p0[1] + 2 * u * t * this.p1[1] + t * t * this.p2[1],
		];
	}

	tangentAt(t: number): P {
		const dx = 2 * (1 - t) * (this.p1[0] - this.p0[0]) + 2 * t * (this.p2[0] - this.p1[0]);
		const dy = 2 * (1 - t) * (this.p1[1] - this.p0[1]) + 2 * t * (this.p2[1] - this.p1[1]);
		const len = Math.hypot(dx, dy);
		return len === 0 ? [1, 0] : [dx / len, dy / len];
	}

	sample(segments = 24): P[] {
		const out: P[] = [];
		for (let i = 0; i <= segments; i++) out.push(this.at(this.t0 + ((this.t1 - this.t0) * i) / segments));
		return out;
	}

	get start(): P {
		return this.at(this.t0);
	}
	get end(): P {
		return this.at(this.t1);
	}
	get midT(): number {
		return (this.t0 + this.t1) / 2;
	}
}

/** Dart's String.compareTo. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function layoutThreads(links: ThreadLink[], style: ThreadStyle, radius = HEX_RADIUS): Map<string, ThreadShape> {
	const groups = new Map<string, ThreadLink[]>();
	for (const l of links) {
		const key = cmp(l.from, l.to) <= 0 ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
		let g = groups.get(key);
		if (!g) groups.set(key, (g = []));
		g.push(l);
	}
	const out = new Map<string, ThreadShape>();
	for (const group of groups.values()) {
		group.sort((x, y) => cmp(x.id, y.id));
		if (style === 'arc') {
			const perDirection = new Map<string, number>();
			for (const l of group) {
				const k = perDirection.has(l.from) ? perDirection.get(l.from)! + 1 : 0;
				perDirection.set(l.from, k);
				const shape = curved(l, k, radius);
				if (shape) out.set(l.id, shape);
			}
		} else {
			const n = group.length;
			group.forEach((l, i) => {
				const forward = cmp(l.from, l.to) <= 0;
				const offset = (i - (n - 1) / 2) * THREAD_PARALLEL_GAP * radius;
				const shape = straight(l, forward ? offset : -offset, radius);
				if (shape) out.set(l.id, shape);
			});
		}
	}
	return out;
}

function straight(l: ThreadLink, offset: number, radius: number): ThreadShape | null {
	const [ax, ay] = l.a, [bx, by] = l.b;
	const dx = bx - ax, dy = by - ay;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len === 0) return null;
	const nx = -dy / len, ny = dx / len; // right-hand normal (y down)
	const p0: P = [ax + nx * offset, ay + ny * offset];
	const p2: P = [bx + nx * offset, by + ny * offset];
	const p1: P = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
	return trimmed(p0, p1, p2, l.a, l.b, radius);
}

function curved(l: ThreadLink, k: number, radius: number): ThreadShape | null {
	const [ax, ay] = l.a, [bx, by] = l.b;
	const dx = bx - ax, dy = by - ay;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len === 0) return null;
	const nx = -dy / len, ny = dx / len;
	const bow = Math.min(Math.max(len * THREAD_BOW_SHARE, THREAD_BOW_MIN * radius), THREAD_BOW_MAX * radius) + k * THREAD_BOW_STEP * radius;
	// A quadratic's apex is half way to its control point: place it at 2×.
	const p1: P = [(ax + bx) / 2 + nx * bow * 2, (ay + by) / 2 + ny * bow * 2];
	return trimmed(l.a, p1, l.b, l.a, l.b, radius);
}

function trimmed(p0: P, p1: P, p2: P, ca: P, cb: P, radius: number): ThreadShape | null {
	const full = new ThreadShape(p0, p1, p2, 0, 1);
	const ring = THREAD_END_TRIM * radius;
	const dist = (p: P, c: P) => Math.sqrt((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2);
	const leave = (from: number, to: number, c: P) => {
		if (dist(full.at(to), c) < ring) return to;
		let lo = from, hi = to;
		for (let i = 0; i < 30; i++) {
			const mid = (lo + hi) / 2;
			if (dist(full.at(mid), c) < ring) lo = mid;
			else hi = mid;
		}
		return hi;
	};
	const t0 = leave(0, 0.5, ca);
	const t1 = leave(1, 0.5, cb);
	if (t1 - t0 <= 1e-6) return null;
	return new ThreadShape(p0, p1, p2, t0, t1);
}
