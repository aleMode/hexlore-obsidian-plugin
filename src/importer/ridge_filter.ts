// Port of Flutter's lib/importer/ridge_filter.dart (decision 12f): rivers are
// found by a multiscale RIDGE FILTER (Isikdogan et al.'s singularity index
// ψ = |J₀|·J₂ / (1 + J₁²) along the local dominant orientation), not a
// threshold. Five departures from the paper, each found by testing and kept
// here exactly: the input is DEBIASED, σ₁ is fixed at minScale·1.7754,
// gamma normalisation is per-scale σ², minScale is 1.6, and NMS steps along
// the true (interpolated) perpendicular. Coarse scales run on a halved copy.
// Float32 storage, as Dart's Float32List, so the numbers match.

export const SIDE_LOBE_RATIO = 1.7754;

export interface RidgeParams {
	minScale: number;
	scales: number;
	lowRatio: number;
	debiasFactor: number;
	downsampleAbove: number;
}

export const DEFAULT_RIDGE: RidgeParams = { minScale: 1.6, scales: 10, lowRatio: 0.1, debiasFactor: 5, downsampleAbove: 4 };

export const scaleAt = (p: RidgeParams, n: number) => p.minScale * Math.pow(Math.SQRT2, n);

export interface RidgeResponse {
	width: number;
	height: number;
	psi: Float32Array;
	orientation: Float32Array;
	scale: Float32Array;
}

export function ridgeResponse(field: Float32Array, w: number, h: number, params: RidgeParams = DEFAULT_RIDGE): RidgeResponse {
	const psiSquared = new Float32Array(w * h), bestPsi = new Float32Array(w * h);
	const orientation = new Float32Array(w * h), scale = new Float32Array(w * h);
	const debiased = debias(field, w, h, params.minScale * params.debiasFactor);
	const sigma1 = params.minScale * SIDE_LOBE_RATIO;
	let level = debiased, lw = w, lh = h, reduction = 1;
	for (let n = 0; n < params.scales; n++) {
		const sigma = scaleAt(params, n);
		while (sigma / reduction > params.downsampleAbove && lw > 64 && lh > 64) {
			level = halve(level, lw, lh);
			lw = Math.floor(lw / 2);
			lh = Math.floor(lh / 2);
			reduction *= 2;
		}
		const localSigma = sigma / reduction;
		if (localSigma * 3 >= Math.min(lw, lh) / 2) break;
		const small = psiAtScale(level, lw, lh, localSigma, sigma1 / reduction);
		const layer = reduction === 1 ? small : { psi: upsample(small.psi, lw, lh, w, h, reduction), orientation: upsample(small.orientation, lw, lh, w, h, reduction) };
		for (let i = 0; i < bestPsi.length; i++) {
			const v = layer.psi[i]!;
			psiSquared[i] = psiSquared[i]! + v * v;
			if (v > bestPsi[i]!) {
				bestPsi[i] = v;
				orientation[i] = layer.orientation[i]!;
				scale[i] = sigma;
			}
		}
	}
	const psi = new Float32Array(w * h);
	for (let i = 0; i < psi.length; i++) psi[i] = Math.sqrt(psiSquared[i]!);
	return { width: w, height: h, psi, orientation, scale };
}

function psiAtScale(field: Float32Array, w: number, h: number, sigma: number, sigma1: number): { psi: Float32Array; orientation: Float32Array } {
	const j0 = gaussianBlur(field, w, h, sigma);
	const [xx, yy, xy] = hessian(field, w, h, sigma);
	const dx = firstDerivative(field, w, h, sigma1, true);
	const dy = firstDerivative(field, w, h, sigma1, false);
	const psi = new Float32Array(w * h), orientation = new Float32Array(w * h);
	const norm = sigma * sigma;
	for (let i = 0; i < psi.length; i++) {
		const a = xx[i]!, b = yy[i]!, c = xy[i]!;
		const theta = 0.5 * Math.atan2(c, a - b);
		const cosT = Math.cos(theta), sinT = Math.sin(theta);
		const j2 = a * cosT * cosT + c * sinT * cosT * 2 + b * sinT * sinT;
		const j1 = dx[i]! * cosT + dy[i]! * sinT;
		const response = j2 < 0 ? (Math.abs(j0[i]!) * -j2) / (1 + j1 * j1) : 0;
		psi[i] = response * norm;
		orientation[i] = theta;
	}
	return { psi, orientation };
}

/** Keep a pixel only if it beats its two neighbours ACROSS the ridge
 *  (bilinear samples one step along the true perpendicular). */
export function suppressNonMaxima(response: RidgeResponse): Float32Array {
	const { width: w, height: h, psi } = response;
	const out = new Float32Array(w * h);
	const sample = (x: number, y: number) => {
		if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
		const x0 = Math.floor(x), y0 = Math.floor(y);
		const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
		const fx = x - x0, fy = y - y0;
		return psi[y0 * w + x0]! * (1 - fx) * (1 - fy) + psi[y0 * w + x1]! * fx * (1 - fy) + psi[y1 * w + x0]! * (1 - fx) * fy + psi[y1 * w + x1]! * fx * fy;
	};
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const v = psi[i]!;
			if (v <= 0) continue;
			const theta = response.orientation[i]!;
			const nx = -Math.sin(theta), ny = Math.cos(theta);
			if (v > sample(x + nx, y + ny) && v >= sample(x - nx, y - ny)) out[i] = v;
		}
	}
	return out;
}

/** Keep every 8-connected component of ≥ low that holds one pixel ≥ high. */
export function hysteresis(nms: Float32Array, w: number, h: number, high: number, low: number): Uint8Array {
	const mask = new Uint8Array(w * h), seen = new Uint8Array(w * h);
	const stack: number[] = [], component: number[] = [];
	for (let start = 0; start < nms.length; start++) {
		if (seen[start] || nms[start]! < low) continue;
		stack.length = 0;
		stack.push(start);
		component.length = 0;
		seen[start] = 1;
		let strong = false;
		while (stack.length) {
			const i = stack.pop()!;
			component.push(i);
			if (nms[i]! >= high) strong = true;
			const x = i % w, y = Math.floor(i / w);
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					if (!dx && !dy) continue;
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const j = ny * w + nx;
					if (seen[j] || nms[j]! < low) continue;
					seen[j] = 1;
					stack.push(j);
				}
			}
		}
		if (strong) for (const i of component) mask[i] = 1;
	}
	return mask;
}

/** Otsu over the positive values (kept for the record: the tracer uses a
 *  peak-relative threshold instead, decision 12f). */
export function otsuThreshold(values: Float32Array, bins = 256): number {
	let maxValue = 0;
	for (const v of values) if (v > maxValue) maxValue = v;
	if (maxValue <= 0) return 0;
	const histogram = new Int32Array(bins);
	let total = 0;
	for (const v of values) {
		if (v <= 0) continue;
		histogram[Math.min(bins - 1, Math.max(0, Math.floor((v / maxValue) * (bins - 1))))]!++;
		total++;
	}
	if (!total) return 0;
	let sum = 0;
	for (let i = 0; i < bins; i++) sum += i * histogram[i]!;
	let sumB = 0, weightB = 0, best = 0, bestVariance = -1;
	for (let i = 0; i < bins; i++) {
		weightB += histogram[i]!;
		if (!weightB) continue;
		const weightF = total - weightB;
		if (!weightF) break;
		sumB += i * histogram[i]!;
		const meanB = sumB / weightB, meanF = (sum - sumB) / weightF;
		const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
		if (variance > bestVariance) {
			bestVariance = variance;
			best = i;
		}
	}
	return (best / (bins - 1)) * maxValue;
}

function debias(field: Float32Array, w: number, h: number, sigma: number): Float32Array {
	const mean = gaussianBlur(field, w, h, sigma);
	const out = new Float32Array(w * h);
	for (let i = 0; i < out.length; i++) out[i] = field[i]! - mean[i]!;
	return out;
}

const kernelRadius = (sigma: number) => Math.trunc(sigma * 3) + 1;

function gaussianKernel(sigma: number): Float64Array {
	const radius = kernelRadius(sigma);
	const k = new Float64Array(2 * radius + 1);
	let total = 0;
	for (let i = -radius; i <= radius; i++) {
		const v = Math.exp(-(i * i) / (2 * sigma * sigma));
		k[i + radius] = v;
		total += v;
	}
	for (let i = 0; i < k.length; i++) k[i]! /= total;
	return k;
}

function gaussianD1Kernel(sigma: number): Float64Array {
	const radius = kernelRadius(sigma);
	const k = new Float64Array(2 * radius + 1);
	let norm = 0;
	for (let i = -radius; i <= radius; i++) {
		const g = Math.exp(-(i * i) / (2 * sigma * sigma));
		k[i + radius] = (-i * g) / (sigma * sigma);
		norm += g;
	}
	for (let i = 0; i < k.length; i++) k[i]! /= norm;
	return k;
}

function gaussianD2Kernel(sigma: number): Float64Array {
	const radius = kernelRadius(sigma);
	const k = new Float64Array(2 * radius + 1);
	let norm = 0;
	const s2 = sigma * sigma;
	for (let i = -radius; i <= radius; i++) {
		const g = Math.exp(-(i * i) / (2 * s2));
		k[i + radius] = ((i * i) / (s2 * s2) - 1 / s2) * g;
		norm += g;
	}
	for (let i = 0; i < k.length; i++) k[i]! /= norm;
	return k;
}

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
	const k = gaussianKernel(sigma);
	return convolveV(convolveH(src, w, h, k), w, h, k);
}

function firstDerivative(src: Float32Array, w: number, h: number, sigma: number, horizontal: boolean): Float32Array {
	const smooth = gaussianKernel(sigma), d1 = gaussianD1Kernel(sigma);
	return horizontal ? convolveV(convolveH(src, w, h, d1), w, h, smooth) : convolveV(convolveH(src, w, h, smooth), w, h, d1);
}

function hessian(src: Float32Array, w: number, h: number, sigma: number): [Float32Array, Float32Array, Float32Array] {
	const smooth = gaussianKernel(sigma), d1 = gaussianD1Kernel(sigma), d2 = gaussianD2Kernel(sigma);
	return [convolveV(convolveH(src, w, h, d2), w, h, smooth), convolveV(convolveH(src, w, h, smooth), w, h, d2), convolveV(convolveH(src, w, h, d1), w, h, d1)];
}

function convolveH(src: Float32Array, w: number, h: number, kernel: Float64Array): Float32Array {
	const radius = Math.floor(kernel.length / 2);
	const out = new Float32Array(w * h);
	const edge = (row: number, x: number) => {
		let sum = 0;
		for (let k = -radius; k <= radius; k++) {
			let sx = x + k;
			if (sx < 0) sx = 0;
			if (sx >= w) sx = w - 1;
			sum += src[row + sx]! * kernel[k + radius]!;
		}
		return sum;
	};
	for (let y = 0; y < h; y++) {
		const row = y * w;
		for (let x = 0; x < Math.min(radius, w); x++) out[row + x] = edge(row, x);
		const hi = w - radius;
		for (let x = radius; x < hi; x++) {
			let sum = 0;
			const base = row + x - radius;
			for (let k = 0; k < kernel.length; k++) sum += src[base + k]! * kernel[k]!;
			out[row + x] = sum;
		}
		for (let x = Math.max(radius, hi); x < w; x++) out[row + x] = edge(row, x);
	}
	return out;
}

function convolveV(src: Float32Array, w: number, h: number, kernel: Float64Array): Float32Array {
	const radius = Math.floor(kernel.length / 2);
	const out = new Float32Array(w * h);
	const loY = Math.min(radius, h), hiY = Math.max(radius, h - radius);
	const edge = (y: number, x: number) => {
		let sum = 0;
		for (let k = -radius; k <= radius; k++) {
			let sy = y + k;
			if (sy < 0) sy = 0;
			if (sy >= h) sy = h - 1;
			sum += src[sy * w + x]! * kernel[k + radius]!;
		}
		return sum;
	};
	for (let y = 0; y < loY; y++) for (let x = 0; x < w; x++) out[y * w + x] = edge(y, x);
	for (let y = radius; y < h - radius; y++) {
		const row = y * w;
		for (let x = 0; x < w; x++) {
			let sum = 0;
			let base = row - radius * w + x;
			for (let k = 0; k < kernel.length; k++) {
				sum += src[base]! * kernel[k]!;
				base += w;
			}
			out[row + x] = sum;
		}
	}
	for (let y = hiY; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = edge(y, x);
	return out;
}

function halve(src: Float32Array, w: number, h: number): Float32Array {
	const outW = Math.floor(w / 2), outH = Math.floor(h / 2);
	const out = new Float32Array(outW * outH);
	for (let y = 0; y < outH; y++) {
		const sy = y * 2;
		for (let x = 0; x < outW; x++) {
			const sx = x * 2;
			out[y * outW + x] = (src[sy * w + sx]! + src[sy * w + sx + 1]! + src[(sy + 1) * w + sx]! + src[(sy + 1) * w + sx + 1]!) * 0.25;
		}
	}
	return out;
}

function upsample(src: Float32Array, sw: number, sh: number, w: number, h: number, reduction: number): Float32Array {
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		const row = Math.min(Math.floor(y / reduction), sh - 1) * sw;
		for (let x = 0; x < w; x++) out[y * w + x] = src[row + Math.min(Math.floor(x / reduction), sw - 1)]!;
	}
	return out;
}
