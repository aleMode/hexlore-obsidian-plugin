// Port of Flutter's lib/sketch/bucket_fill.dart: "fill the enclosed area
// around this point" over VECTOR strokes, which have no inside of their own.
//
// A TEMPORARY raster: every item is stamped as ink, the clicked non-ink
// component is flooded, and its outer contour is traced back into a scene
// polygon. Three rules (see the Dart file):
// - a leak is a refusal, not a flood (reaching the border = not enclosed);
// - gaps close by DILATION, then the fill grows back over the band;
// - the raster resolution (`step`) is the caller's: only the view knows its zoom.

import { SketchFill, SketchLabel, SketchShape, SketchStroke, UnknownSketchItem, simplifyPolyline, type SketchDocument, type SketchItem } from '../core/sketch';

export interface BucketFillParams {
	/** Region of interest, scene px (the viewport, padded). */
	left: number;
	top: number;
	right: number;
	bottom: number;
	/** Scene px per raster px. */
	step: number;
	/** Gap-closing radius, raster px. */
	gapPx?: number;
	/** Contour simplification tolerance, raster px. */
	simplifyPx?: number;
}

export type BucketFillFailure = 'notEnclosed' | 'onInk' | 'tooSmall';
export type BucketFillResult = { polygon: [number, number][]; failure: null } | { polygon: null; failure: BucketFillFailure };

const fail = (failure: BucketFillFailure): BucketFillResult => ({ polygon: null, failure });
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class Raster {
	readonly bits: Uint8Array;
	constructor(
		readonly w: number,
		readonly h: number,
	) {
		this.bits = new Uint8Array(w * h);
	}
	get(x: number, y: number): boolean {
		return x >= 0 && y >= 0 && x < this.w && y < this.h && this.bits[y * this.w + x] !== 0;
	}
	set(x: number, y: number): void {
		if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.bits[y * this.w + x] = 1;
	}
	/** Disc dilation by r px; [exclude] pixels are never set. */
	dilated(r: number, exclude?: Raster): Raster {
		const out = new Raster(this.w, this.h);
		const offsets: [number, number][] = [];
		for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
		const { w, h } = this;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (this.bits[y * w + x] === 0) continue;
				for (const [dx, dy] of offsets) {
					const px = x + dx, py = y + dy;
					if (px < 0 || py < 0 || px >= w || py >= h) continue;
					if (exclude && exclude.bits[py * w + px] !== 0) continue;
					out.bits[py * w + px] = 1;
				}
			}
		}
		return out;
	}
}

function disc(r: Raster, cx: number, cy: number, radius: number): void {
	const rad = radius < 0.5 ? 0.5 : radius;
	const x0 = Math.floor(cx - rad), x1 = Math.ceil(cx + rad);
	const y0 = Math.floor(cy - rad), y1 = Math.ceil(cy + rad);
	const r2 = rad * rad;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
			if (dx * dx + dy * dy <= r2) r.set(x, y);
		}
	}
}

function thickSegment(r: Raster, ax: number, ay: number, bx: number, by: number, radius: number): void {
	const dx = bx - ax, dy = by - ay;
	const steps = clampInt(Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.5), 1, 100000);
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		disc(r, ax + dx * t, ay + dy * t, radius);
	}
}

function stamp(r: Raster, item: SketchItem, p: BucketFillParams): void {
	const rx = (x: number) => (x - p.left) / p.step;
	const ry = (y: number) => (y - p.top) / p.step;
	if (item instanceof SketchStroke) {
		const rad = item.width / 2 / p.step;
		if (item.points.length === 1) disc(r, rx(item.points[0]![0]), ry(item.points[0]![1]), rad);
		for (let i = 0; i + 1 < item.points.length; i++) {
			const [ax, ay] = item.points[i]!, [bx, by] = item.points[i + 1]!;
			thickSegment(r, rx(ax), ry(ay), rx(bx), ry(by), rad);
		}
	} else if (item instanceof SketchShape) {
		const rad = item.width / 2 / p.step;
		const l = rx(item.left), t = ry(item.top), rr = rx(item.right), b = ry(item.bottom);
		if (item.kind === 'line') {
			thickSegment(r, rx(item.x1), ry(item.y1), rx(item.x2), ry(item.y2), rad);
		} else if (item.kind === 'rect') {
			if (item.filled) {
				for (let y = Math.floor(t); y <= Math.ceil(b); y++) for (let x = Math.floor(l); x <= Math.ceil(rr); x++) r.set(x, y);
			} else {
				thickSegment(r, l, t, rr, t, rad);
				thickSegment(r, rr, t, rr, b, rad);
				thickSegment(r, rr, b, l, b, rad);
				thickSegment(r, l, b, l, t, rad);
			}
		} else {
			const cx = (l + rr) / 2, cy = (t + b) / 2, ex = (rr - l) / 2, ey = (b - t) / 2;
			if (ex <= 0 || ey <= 0) return;
			if (item.filled) {
				for (let y = Math.floor(t); y <= Math.ceil(b); y++) {
					for (let x = Math.floor(l); x <= Math.ceil(rr); x++) {
						const nx = (x + 0.5 - cx) / ex, ny = (y + 0.5 - cy) / ey;
						if (nx * nx + ny * ny <= 1) r.set(x, y);
					}
				}
			} else {
				const n = clampInt(Math.ceil((ex + ey) * 4), 16, 4000);
				let px = cx + ex, py = cy;
				for (let i = 1; i <= n; i++) {
					const a = (2 * Math.PI * i) / n;
					const qx = cx + ex * Math.cos(a), qy = cy + ey * Math.sin(a);
					thickSegment(r, px, py, qx, qy, rad);
					px = qx;
					py = qy;
				}
			}
		}
	} else if (item instanceof SketchFill || item instanceof SketchLabel || item instanceof UnknownSketchItem) {
		// An existing fill is not a barrier (a new fill stops at the lake's
		// OUTLINE, and covers an old fill); labels are annotations.
	}
}

/** Flood 4-connected non-barrier pixels; false once the border is reached. */
function flood(barrier: Raster, out: Raster, sx: number, sy: number): boolean {
	const { w, h } = barrier;
	const stack = [sy * w + sx];
	out.bits[sy * w + sx] = 1;
	while (stack.length) {
		const i = stack.pop()!;
		const x = i % w, y = Math.floor(i / w);
		if (x === 0 || y === 0 || x === w - 1 || y === h - 1) return false;
		for (const [nx, ny] of [
			[x + 1, y],
			[x - 1, y],
			[x, y + 1],
			[x, y - 1],
		] as const) {
			const j = ny * w + nx;
			if (out.bits[j] !== 0 || barrier.bits[j] !== 0) continue;
			out.bits[j] = 1;
			stack.push(j);
		}
	}
	return true;
}

/** Outer contour of the top-most component as pixel-corner coordinates,
 *  clockwise (crack following, region on the right). */
function traceOuterContour(r: Raster): [number, number][] {
	let startX = -1, startY = -1;
	outer: for (let y = 0; y < r.h; y++) {
		for (let x = 0; x < r.w; x++) {
			if (r.bits[y * r.w + x] !== 0) {
				startX = x;
				startY = y;
				break outer;
			}
		}
	}
	if (startX < 0) return [];
	const dxs = [1, 0, -1, 0], dys = [0, 1, 0, -1];
	let cx = startX, cy = startY, d = 0;
	const pts: [number, number][] = [];
	let guard = 0;
	const maxSteps = 4 * (r.w + 2) * (r.h + 2);
	do {
		let ra: [number, number], la: [number, number];
		if (d === 0) [ra, la] = [[cx, cy], [cx, cy - 1]];
		else if (d === 1) [ra, la] = [[cx - 1, cy], [cx, cy]];
		else if (d === 2) [ra, la] = [[cx - 1, cy - 1], [cx - 1, cy]];
		else [ra, la] = [[cx, cy - 1], [cx - 1, cy - 1]];
		if (!r.get(ra[0], ra[1])) {
			pts.push([cx, cy]);
			d = (d + 1) % 4;
		} else if (r.get(la[0], la[1])) {
			pts.push([cx, cy]);
			d = (d + 3) % 4;
		} else {
			cx += dxs[d]!;
			cy += dys[d]!;
		}
		if (++guard > maxSteps) break;
	} while (!(cx === startX && cy === startY && d === 0 && pts.length));
	const out: [number, number][] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
	}
	if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
	return out;
}

export function bucketFill(doc: SketchDocument, x: number, y: number, p: BucketFillParams): BucketFillResult {
	const gapPx = p.gapPx ?? 2, simplifyPx = p.simplifyPx ?? 1.0;
	const w = clampInt(Math.ceil((p.right - p.left) / p.step), 4, 4096);
	const h = clampInt(Math.ceil((p.bottom - p.top) / p.step), 4, 4096);
	const ink = new Raster(w, h);
	for (const item of doc.items) stamp(ink, item, p);
	const sx = Math.floor((x - p.left) / p.step), sy = Math.floor((y - p.top) / p.step);
	if (sx < 0 || sy < 0 || sx >= w || sy >= h) return fail('notEnclosed');
	if (ink.get(sx, sy)) return fail('onInk');
	const barrier = gapPx > 0 ? ink.dilated(gapPx) : ink;
	if (barrier.get(sx, sy)) return fail('onInk'); // inside a stroke's closing band
	const filled = new Raster(w, h);
	if (!flood(barrier, filled, sx, sy)) return fail('notEnclosed');
	const region = gapPx > 0 ? filled.dilated(gapPx, ink) : filled;
	const contour = traceOuterContour(region);
	if (contour.length < 3) return fail('tooSmall');
	const simplified = simplifyPolyline(contour, simplifyPx);
	if (simplified.length < 3) return fail('tooSmall');
	return { polygon: simplified.map(([cx, cy]) => [p.left + cx * p.step, p.top + cy * p.step]), failure: null };
}
