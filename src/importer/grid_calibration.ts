// Port of Flutter's lib/importer/grid_calibration.dart (decision 12): the
// mapping between pixels of an imported map image and the axial cells of the
// grid drawn on it, solved from two clicked centres of ADJACENT hexes — their
// distance gives the radius (√3·R apart either way) and their angle the
// orientation (flat-top neighbours at 30°+60°k, pointy-top at 60°k). Source
// axial = campaign axial by identity; a pointy source leans ~30°.

import { axialRound } from '../core/geometry';

const SQRT3 = Math.sqrt(3);

export type SourceOrientation = 'flat' | 'pointy';

export class SourceGrid {
	constructor(
		readonly orientation: SourceOrientation,
		/** Centre-to-corner, image px. */
		readonly radius: number,
		/** Image px of the centre of source cell (0, 0). */
		readonly originX: number,
		readonly originY: number,
	) {}

	centerOf(q: number, r: number): [number, number] {
		return this.centerOfF(q, r);
	}

	/** For fractional axial coords (the inverse of fractionalAxial). */
	centerOfF(q: number, r: number): [number, number] {
		if (this.orientation === 'flat') return [this.originX + this.radius * 1.5 * q, this.originY + this.radius * SQRT3 * (r + q / 2)];
		return [this.originX + this.radius * SQRT3 * (q + r / 2), this.originY + this.radius * 1.5 * r];
	}

	fractionalAxial(x: number, y: number): [number, number] {
		const dx = x - this.originX, dy = y - this.originY;
		if (this.orientation === 'flat') return [((2 / 3) * dx) / this.radius, ((-1 / 3) * dx + (SQRT3 / 3) * dy) / this.radius];
		return [((SQRT3 / 3) * dx - (1 / 3) * dy) / this.radius, ((2 / 3) * dy) / this.radius];
	}

	cellAt(x: number, y: number): [number, number] {
		return axialRound(...this.fractionalAxial(x, y));
	}

	with(change: Partial<{ orientation: SourceOrientation; radius: number; originX: number; originY: number }>): SourceGrid {
		return new SourceGrid(change.orientation ?? this.orientation, change.radius ?? this.radius, change.originX ?? this.originX, change.originY ?? this.originY);
	}

	toJson(): Record<string, unknown> {
		return { orientation: this.orientation, radius: this.radius, origin_x: this.originX, origin_y: this.originY };
	}

	static fromJson(j: Record<string, unknown>): SourceGrid {
		return new SourceGrid(j.orientation === 'pointy' ? 'pointy' : 'flat', Number(j.radius), Number(j.origin_x), Number(j.origin_y));
	}
}

/** Solve from the centres of two ADJACENT hexes; [a] becomes cell (0, 0).
 *  Null when they are under 4 px apart. */
export function solveGrid(a: [number, number], b: [number, number]): SourceGrid | null {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const dist = Math.sqrt(dx * dx + dy * dy);
	if (dist < 4) return null;
	const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
	const distToComb = (base: number) => {
		const m = ((((angle - base) % 60) + 60) % 60);
		return Math.min(m, 60 - m);
	};
	const orientation: SourceOrientation = distToComb(30) <= distToComb(0) ? 'flat' : 'pointy';
	return new SourceGrid(orientation, dist / SQRT3, a[0], a[1]);
}

/** Every source cell whose centre lies inside a w × h image. */
export function sourceCells(grid: SourceGrid, width: number, height: number): [number, number][] {
	let qLo = Infinity, qHi = -Infinity, rLo = Infinity, rHi = -Infinity;
	for (const [x, y] of [
		[0, 0],
		[width, 0],
		[0, height],
		[width, height],
	] as const) {
		const [qf, rf] = grid.fractionalAxial(x, y);
		qLo = Math.min(qLo, qf);
		qHi = Math.max(qHi, qf);
		rLo = Math.min(rLo, rf);
		rHi = Math.max(rHi, rf);
	}
	const out: [number, number][] = [];
	for (let q = Math.floor(qLo) - 1; q <= Math.ceil(qHi) + 1; q++) {
		for (let r = Math.floor(rLo) - 1; r <= Math.ceil(rHi) + 1; r++) {
			const [cx, cy] = grid.centerOf(q, r);
			if (cx >= 0 && cx < width && cy >= 0 && cy < height) out.push([q, r]);
		}
	}
	return out;
}
