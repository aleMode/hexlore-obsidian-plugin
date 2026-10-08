// Port of Flutter's lib/core/geometry.dart: flat-top hexes, radius R (centre
// to corner). The river/route anchor GRAPH (anchorNeighbors, nearestAnchor)
// waits for the editor (item 2.4), with the canonicalisation it needs.

export const HEX_RADIUS = 48;

/** Zoom limits of a map view. */
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 4;

const SQRT3 = Math.sqrt(3);
const DEG = Math.PI / 180;

export type Point = [number, number];
export type Cell = [number, number];
/** A pixel rect as [x, y, w, h]. */
export type Rect = [number, number, number, number];

/** Dart's `round()`: ties away from zero (JavaScript's go toward +∞). */
export function dartRound(v: number): number {
	return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** Python/Dart floor division, for negative columns. */
export function floorDiv(a: number, b: number): number {
	return Math.floor(a / b);
}

/** Centre pixel of hex (q, r). */
export function axialToPixel(q: number, r: number, radius = HEX_RADIUS): Point {
	return [radius * 1.5 * q, radius * SQRT3 * (r + q / 2)];
}

/** The six corners of a hex centred at (cx, cy); corner 0 at 0°. */
export function hexCorners(cx: number, cy: number, radius = HEX_RADIUS): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < 6; i++) {
		out.push([cx + radius * Math.cos(DEG * 60 * i), cy + radius * Math.sin(DEG * 60 * i)]);
	}
	return out;
}

/** Canonical vertex (q, r, corner ∈ {0, 1}) → pixel. */
export function vertexPixel(q: number, r: number, corner: number, radius = HEX_RADIUS): Point {
	const [cx, cy] = axialToPixel(q, r, radius);
	const a = DEG * 60 * corner;
	return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
}

/** Midpoint of hex (q, r)'s edge k (at 30 + 60·k degrees, the apothem away). */
export function edgeMidpointPixel(q: number, r: number, k: number, radius = HEX_RADIUS): Point {
	const [cx, cy] = axialToPixel(q, r, radius);
	const apothem = (radius * SQRT3) / 2;
	const a = DEG * (30 + 60 * k);
	return [cx + apothem * Math.cos(a), cy + apothem * Math.sin(a)];
}

/** A river/route anchor → pixel: kind "v" corner, "e" edge midpoint, "c" centre. */
export function nodePixel(kind: string, q: number, r: number, k = 0, radius = HEX_RADIUS): Point {
	if (kind === 'v') return vertexPixel(q, r, k, radius);
	if (kind === 'c') return axialToPixel(q, r, radius);
	return edgeMidpointPixel(q, r, k, radius);
}

/** Fractional axial → nearest hex, by cube rounding. */
export function axialRound(qf: number, rf: number): Cell {
	const xf = qf, zf = rf, yf = -xf - zf;
	let rx = dartRound(xf), ry = dartRound(yf), rz = dartRound(zf);
	const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
	if (dx > dy && dx > dz) rx = -ry - rz;
	else if (dy > dz) ry = -rx - rz;
	else rz = -rx - ry;
	return [rx + 0, rz + 0]; // +0 turns -0 into 0
}

/** Pixel → the hex under it. */
export function pixelToAxial(x: number, y: number, radius = HEX_RADIUS): Cell {
	return axialRound(((2 / 3) * x) / radius, ((-1 / 3) * x + (SQRT3 / 3) * y) / radius);
}

/** First row of column q in a staggered grid window. */
export function colRStart(q: number, rShift = 0): number {
	return -floorDiv(q, 2) + rShift;
}

/** A cell's row with the column's stagger taken out. */
export function unstaggeredRow(q: number, r: number): number {
	return r + floorDiv(q, 2);
}

export function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
	const dq = q1 - q2, dr = r1 - r2;
	return Math.trunc((Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2);
}

/** Every cell within [radius] of (cq, cr). */
export function hexesWithin(cq: number, cr: number, radius: number): Cell[] {
	const out: Cell[] = [];
	for (let dq = -radius; dq <= radius; dq++) {
		const rLo = Math.max(-radius, -dq - radius), rHi = Math.min(radius, -dq + radius);
		for (let dr = rLo; dr <= rHi; dr++) out.push([cq + dq, cr + dr]);
	}
	return out;
}

/** The grid window: columns [minQ, minQ + cols), rows [colRStart, + rows). */
export interface GridWindow {
	minQ: number;
	cols: number;
	rows: number;
	rShift: number;
}

export function cellInGrid(q: number, r: number, g: GridWindow): boolean {
	if (q < g.minQ || q >= g.minQ + g.cols) return false;
	const start = colRStart(q, g.rShift);
	return r >= start && r < start + g.rows;
}

/**
 * The smallest window holding [cells], grown by [pad] (0.10 = +10%) and
 * re-centred. Null for no cells. Returned as [minQ, cols, rows, rShift].
 */
export function fitGridWindow(cells: Iterable<Cell>, pad = 0.1): [number, number, number, number] | null {
	let minQ = Infinity, maxQ = -Infinity, minU = Infinity, maxU = -Infinity;
	for (const [q, r] of cells) {
		const u = unstaggeredRow(q, r);
		minQ = Math.min(minQ, q);
		maxQ = Math.max(maxQ, q);
		minU = Math.min(minU, u);
		maxU = Math.max(maxU, u);
	}
	if (minQ > maxQ) return null;
	const cols = maxQ - minQ + 1, rows = maxU - minU + 1;
	const padCols = Math.max(cols, Math.ceil(cols * (1 + pad)));
	const padRows = Math.max(rows, Math.ceil(rows * (1 + pad)));
	return [
		minQ - Math.trunc((padCols - cols) / 2),
		padCols,
		padRows,
		minU - Math.trunc((padRows - rows) / 2),
	];
}

/**
 * The in-grid cells overlapping a scene rect (with a one-cell pad), in column
 * order. Bounded by the rect, never by the grid, so drawing stays O(visible).
 */
export function* cellsInRect(
	left: number,
	top: number,
	right: number,
	bottom: number,
	g: GridWindow,
	radius = HEX_RADIUS,
): Generator<Cell> {
	const colW = radius * 1.5, rowH = radius * SQRT3;
	const qLo = Math.max(Math.floor(left / colW) - 1, g.minQ);
	const qHi = Math.min(Math.ceil(right / colW) + 1, g.minQ + g.cols - 1);
	for (let q = qLo; q <= qHi; q++) {
		const rStart = colRStart(q, g.rShift), rEnd = rStart + g.rows - 1;
		const rLo = Math.max(Math.floor(top / rowH - q / 2) - 1, rStart);
		const rHi = Math.min(Math.ceil(bottom / rowH - q / 2) + 1, rEnd);
		for (let r = rLo; r <= rHi; r++) yield [q, r];
	}
}

/** Every cell (in the grid or not) overlapping a scene rect, with a one-cell pad. */
export function* latticeInRect(left: number, top: number, right: number, bottom: number, radius = HEX_RADIUS): Generator<Cell> {
	const colW = radius * 1.5, rowH = radius * SQRT3;
	const qLo = Math.floor(left / colW) - 1, qHi = Math.ceil(right / colW) + 1;
	for (let q = qLo; q <= qHi; q++) {
		const rLo = Math.floor(top / rowH - q / 2) - 1, rHi = Math.ceil(bottom / rowH - q / 2) + 1;
		for (let r = rLo; r <= rHi; r++) yield [q, r];
	}
}

/** Pixel bounds [x, y, w, h] of the whole grid window, padded by R. */
export function gridPixelBounds(g: GridWindow, radius = HEX_RADIUS): Rect {
	if (g.cols <= 0 || g.rows <= 0) return [0, 0, 0, 0];
	const xs = [axialToPixel(g.minQ, 0, radius)[0], axialToPixel(g.minQ + g.cols - 1, 0, radius)[0]];
	const ys: number[] = [];
	for (const q of g.cols > 1 ? [g.minQ, g.minQ + 1] : [g.minQ]) {
		const start = colRStart(q, g.rShift);
		for (const r of [start, start + g.rows - 1]) ys.push(axialToPixel(q, r, radius)[1]);
	}
	const x0 = Math.min(...xs) - radius, x1 = Math.max(...xs) + radius;
	const y0 = Math.min(...ys) - radius, y1 = Math.max(...ys) + radius;
	return [x0, y0, x1 - x0, y1 - y0];
}

/** Pixel bounds of a set of cells, padded by R; null for none. */
export function cellsPixelBounds(cells: Iterable<Cell>, radius = HEX_RADIUS): Rect | null {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [q, r] of cells) {
		const [cx, cy] = axialToPixel(q, r, radius);
		x0 = Math.min(x0, cx);
		x1 = Math.max(x1, cx);
		y0 = Math.min(y0, cy);
		y1 = Math.max(y1, cy);
	}
	if (x0 > x1) return null;
	return [x0 - radius, y0 - radius, x1 - x0 + radius * 2, y1 - y0 + radius * 2];
}

/**
 * The camera [scale, ox, oy] that centres [rect] in a view, fitted with
 * [padding] px a side, never past [maxFit] nor below [minFit].
 */
export function fitRect(
	rect: Rect,
	viewW: number,
	viewH: number,
	{ padding = 32, maxFit = 1, minFit = MIN_ZOOM }: { padding?: number; maxFit?: number; minFit?: number } = {},
): [number, number, number] {
	const [x, y, w, h] = rect;
	const availW = viewW - padding * 2, availH = viewH - padding * 2;
	let scale = maxFit;
	if (w > 0 && h > 0 && availW > 0 && availH > 0) {
		scale = Math.min(Math.max(Math.min(availW / w, availH / h), Math.min(minFit, maxFit)), maxFit);
	}
	return [scale, viewW / 2 - (x + w / 2) * scale, viewH / 2 - (y + h / 2) * scale];
}

/** The zoom-out limit: the scale that fits the whole grid window. */
export function minScaleForGrid(g: GridWindow, viewW: number, viewH: number): number {
	return fitRect(gridPixelBounds(g), viewW, viewH)[0];
}
