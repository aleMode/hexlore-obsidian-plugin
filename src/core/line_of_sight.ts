// Port of Flutter's lib/core/line_of_sight.dart (decision 5b): which cells an
// observer standing on a hex can see, from terrain heights alone.
//
// A cell at distance d with height h is in range when h + d ≤ eye (taller
// things are seen from further). A cell in between blocks when it rises to
// the sight line. The ring within minRadius is always seen.

import { axialRound, hexDistance, hexesWithin } from './geometry';
import type { Terrain } from './hex_data';

export const TERRAIN_HEIGHT: Record<Terrain, number> = {
	volcano: 3,
	mountain: 2,
	hills: 1,
	forest: 1,
	jungle: 1,
	swamp: 1,
	plains: 0,
	desert: 0,
	tundra: 0,
	sea: 0,
	lake: 0,
	default: 0,
};

export const heightOf = (t: Terrain) => TERRAIN_HEIGHT[t] ?? 0;

/** The cells on the straight line between two hexes, both included. */
export function hexLine(q1: number, r1: number, q2: number, r2: number): [number, number][] {
	const n = hexDistance(q1, r1, q2, r2);
	if (n === 0) return [[q1, r1]];
	// Nudged in cube space, so ties round consistently.
	const e = 1e-6;
	const x1 = q1 + e, z1 = r1 + e;
	const out: [number, number][] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		out.push(axialRound(x1 + (q2 - x1) * t, z1 + (r2 - z1) * t));
	}
	return out;
}

export function visibleFrom(
	oq: number,
	or: number,
	heightAt: (q: number, r: number) => number,
	minRadius = 1,
): [number, number][] {
	const eye = heightAt(oq, or);
	const radius = Math.max(minRadius, eye);
	const visible: [number, number][] = [[oq, or]];
	for (const [q, r] of hexesWithin(oq, or, radius)) {
		const d = hexDistance(oq, or, q, r);
		if (d === 0) continue;
		if (d <= minRadius) {
			visible.push([q, r]);
			continue;
		}
		const target = heightAt(q, r);
		if (target + d > eye) continue;
		if (blocked(oq, or, q, r, d, eye, target, heightAt)) continue;
		visible.push([q, r]);
	}
	return visible;
}

function blocked(oq: number, or: number, tq: number, tr: number, d: number, eye: number, target: number, heightAt: (q: number, r: number) => number): boolean {
	if (d < 2) return false;
	const line = hexLine(oq, or, tq, tr);
	for (let i = 1; i < line.length - 1; i++) {
		const [q, r] = line[i]!;
		if (heightAt(q, r) * d >= eye * d + (target - eye) * i) return true;
	}
	return false;
}
