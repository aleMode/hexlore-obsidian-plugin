// Port of Flutter's lib/importer/ink_mask.dart (decision 12k): what is DRAWN
// on a hex, independent of its fill. Ink is a local-contrast primitive —
// blur(luma) − luma above a threshold — not a global luma cut (a map's snow
// is brighter than its forest). Per cell: a coarse ink SHAPE patch, coverage,
// countable blobs and an orientation histogram of the ink's edges.

import type { SourceGrid } from './grid_calibration';
import type { Raster } from './raster';

export const INK_THRESHOLD = 15;
export const INK_BLUR_FRACTION = 0.25;
export const SHAPE_PATCH_SIDE = 28;
export const MIN_STAMP_BLOB_AREA = 40;
export const MAX_STAMP_BLOB_AREA = 900;
export const ORIENTATION_BINS = 8;

export interface InkDescriptor {
	shape: number[];
	coverage: number;
	blobCount: number;
	medianBlobArea: number;
	orientation: number[];
}

export interface InkMask {
	width: number;
	height: number;
	bits: Uint8Array;
	luma: Float32Array;
}

const inkAt = (m: InkMask, x: number, y: number) => x >= 0 && y >= 0 && x < m.width && y < m.height && m.bits[y * m.width + x] === 1;

export function buildInkMask(image: Raster, hexRadius: number): InkMask {
	const w = image.width, h = image.height;
	const luma = new Float32Array(w * h);
	for (let i = 0, p = 0; i < w * h; i++, p += 4) luma[i] = 0.299 * image.data[p]! + 0.587 * image.data[p + 1]! + 0.114 * image.data[p + 2]!;
	const sigma = Math.max(1, hexRadius * INK_BLUR_FRACTION);
	const bg = boxBlur(luma, w, h, Math.round(sigma));
	const bits = new Uint8Array(w * h);
	for (let i = 0; i < bits.length; i++) bits[i] = bg[i]! - luma[i]! > INK_THRESHOLD ? 1 : 0;
	return { width: w, height: h, bits, luma };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
	let cur = src;
	for (let pass = 0; pass < 3; pass++) cur = boxBlurPass(cur, w, h, radius);
	return cur;
}

function boxBlurPass(src: Float32Array, w: number, h: number, radius: number): Float32Array {
	const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
	const span = 2 * radius + 1;
	for (let y = 0; y < h; y++) {
		let sum = 0;
		const row = y * w;
		for (let x = -radius; x <= radius; x++) sum += src[row + clamp(x, 0, w - 1)]!;
		for (let x = 0; x < w; x++) {
			tmp[row + x] = sum / span;
			sum -= src[row + clamp(x - radius, 0, w - 1)]!;
			sum += src[row + clamp(x + radius + 1, 0, w - 1)]!;
		}
	}
	for (let x = 0; x < w; x++) {
		let sum = 0;
		for (let y = -radius; y <= radius; y++) sum += tmp[clamp(y, 0, h - 1) * w + x]!;
		for (let y = 0; y < h; y++) {
			out[y * w + x] = sum / span;
			sum -= tmp[clamp(y - radius, 0, h - 1) * w + x]!;
			sum += tmp[clamp(y + radius + 1, 0, h - 1) * w + x]!;
		}
	}
	return out;
}

export function describeCell(mask: InkMask, grid: SourceGrid, q: number, r: number): InkDescriptor {
	const [cx, cy] = grid.centerOf(q, r);
	const rad = 0.85 * ((grid.radius * Math.sqrt(3)) / 2);
	const x0 = Math.max(Math.floor(cx - rad), 0), x1 = Math.min(Math.ceil(cx + rad), mask.width - 1);
	const y0 = Math.max(Math.floor(cy - rad), 0), y1 = Math.min(Math.ceil(cy + rad), mask.height - 1);
	const n = SHAPE_PATCH_SIDE * SHAPE_PATCH_SIDE;
	const shape = new Array<number>(n).fill(0), counts = new Array<number>(n).fill(0);
	const orient = new Array<number>(ORIENTATION_BINS).fill(0);
	let inkPixels = 0, total = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx, dy = y - cy;
			if (dx * dx + dy * dy > rad * rad) continue;
			total++;
			const isInk = mask.bits[y * mask.width + x] === 1;
			if (isInk) inkPixels++;
			const px = clamp(Math.floor((((x - cx) / rad + 1) / 2) * SHAPE_PATCH_SIDE), 0, SHAPE_PATCH_SIDE - 1);
			const py = clamp(Math.floor((((y - cy) / rad + 1) / 2) * SHAPE_PATCH_SIDE), 0, SHAPE_PATCH_SIDE - 1);
			const idx = py * SHAPE_PATCH_SIDE + px;
			shape[idx]! += isInk ? 1 : 0;
			counts[idx]!++;
			if (isInk && x > 0 && y > 0 && x < mask.width - 1 && y < mask.height - 1) {
				const gx = mask.luma[y * mask.width + x + 1]! - mask.luma[y * mask.width + x - 1]!;
				const gy = mask.luma[(y + 1) * mask.width + x]! - mask.luma[(y - 1) * mask.width + x]!;
				const magnitude = Math.sqrt(gx * gx + gy * gy);
				if (magnitude > 8) {
					let angle = Math.atan2(gy, gx);
					if (angle < 0) angle += Math.PI;
					if (angle >= Math.PI) angle -= Math.PI;
					orient[clamp(Math.floor((angle / Math.PI) * ORIENTATION_BINS), 0, ORIENTATION_BINS - 1)]! += magnitude;
				}
			}
		}
	}
	for (let i = 0; i < n; i++) if (counts[i]! > 0) shape[i]! /= counts[i]!;
	const orientSum = orient.reduce((a, b) => a + b, 0);
	if (orientSum > 0) for (let i = 0; i < orient.length; i++) orient[i]! /= orientSum;
	const countable = blobAreas(mask, x0, x1, y0, y1, cx, cy, rad)
		.filter((a) => a >= MIN_STAMP_BLOB_AREA && a <= MAX_STAMP_BLOB_AREA)
		.sort((a, b) => a - b);
	return {
		shape,
		coverage: total === 0 ? 0 : inkPixels / total,
		blobCount: countable.length,
		medianBlobArea: countable.length ? countable[Math.floor(countable.length / 2)]! : 0,
		orientation: orient,
	};
}

function blobAreas(mask: InkMask, x0: number, x1: number, y0: number, y1: number, cx: number, cy: number, rad: number): number[] {
	const w = x1 - x0 + 1, h = y1 - y0 + 1;
	if (w <= 0 || h <= 0) return [];
	const seen = new Uint8Array(w * h);
	const areas: number[] = [];
	const inDisc = (x: number, y: number) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad;
	const DIRS = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
	] as const;
	for (let sy = 0; sy < h; sy++) {
		for (let sx = 0; sx < w; sx++) {
			if (seen[sy * w + sx]) continue;
			const gx0 = x0 + sx, gy0 = y0 + sy;
			if (!inDisc(gx0, gy0) || !inkAt(mask, gx0, gy0)) continue;
			let area = 0;
			const stack = [sy * w + sx];
			seen[sy * w + sx] = 1;
			while (stack.length) {
				const cell = stack.pop()!;
				const lx = cell % w, ly = Math.floor(cell / w);
				area++;
				for (const [ddx, ddy] of DIRS) {
					const nx = lx + ddx, ny = ly + ddy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx]) continue;
					const gx = x0 + nx, gy = y0 + ny;
					if (!inDisc(gx, gy) || !inkAt(mask, gx, gy)) continue;
					seen[ny * w + nx] = 1;
					stack.push(ny * w + nx);
				}
			}
			areas.push(area);
		}
	}
	return areas;
}

/** Zero-mean NCC of two shape patches (−1..1); flat ones correlate at 0. */
export function shapeSimilarity(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	if (!n) return 0;
	let ma = 0, mb = 0;
	for (let i = 0; i < n; i++) {
		ma += a[i]!;
		mb += b[i]!;
	}
	ma /= n;
	mb /= n;
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < n; i++) {
		const da = a[i]! - ma, db = b[i]! - mb;
		dot += da * db;
		na += da * da;
		nb += db * db;
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Histogram intersection of two orientation histograms (0..1). */
export function orientationSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || !a.length) return 0;
	let inter = 0;
	for (let i = 0; i < a.length; i++) inter += Math.min(a[i]!, b[i]!);
	return clamp(inter, 0, 1);
}

export function blobSimilarity(a: InkDescriptor, b: InkDescriptor): number {
	const dc = Math.abs(a.blobCount - b.blobCount) / 5;
	const maxArea = Math.max(a.medianBlobArea, b.medianBlobArea);
	const da = maxArea <= 0 ? 0 : Math.abs(a.medianBlobArea - b.medianBlobArea) / maxArea;
	return clamp(1 - (0.6 * dc + 0.4 * da), 0, 1);
}
