// A plain RGBA raster — the importer's image type (the browser's ImageData
// shape; Flutter's importer uses package:image). Pure: the pixel operations
// the pipeline needs, mirroring package:image where the numbers matter
// (copyResize "average", grayscale, truncating stores).

export interface Raster {
	width: number;
	height: number;
	/** RGBA, row-major, 4 bytes a pixel. */
	data: Uint8ClampedArray;
}

export function raster(width: number, height: number): Raster {
	return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

export function setRgb(img: Raster, x: number, y: number, r: number, g: number, b: number): void {
	const i = (y * img.width + x) * 4;
	img.data[i] = r;
	img.data[i + 1] = g;
	img.data[i + 2] = b;
	img.data[i + 3] = 255;
}

/** 0xAARRGGBB of a pixel (alpha forced opaque, as the importer reads it). */
export function argbAt(img: Raster, x: number, y: number): number {
	const i = (y * img.width + x) * 4;
	return (0xff000000 | (img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!) >>> 0;
}

export function lumaAt(img: Raster, x: number, y: number): number {
	const i = (y * img.width + x) * 4;
	return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
}

/** A copy of the rectangle (clamped to the image). */
export function crop(img: Raster, x0: number, y0: number, w: number, h: number): Raster {
	const out = raster(Math.max(0, w), Math.max(0, h));
	for (let y = 0; y < out.height; y++) {
		const src = ((y0 + y) * img.width + x0) * 4;
		out.data.set(img.data.subarray(src, src + out.width * 4), y * out.width * 4);
	}
	return out;
}

/** package:image's copyResize(interpolation: average): each target pixel is
 *  the mean of its source box, stored truncated. */
export function resizeAverage(img: Raster, w: number, h: number): Raster {
	if (w === img.width && h === img.height) return { width: w, height: h, data: new Uint8ClampedArray(img.data) };
	const out = raster(w, h);
	const dy = img.height / h, dx = img.width / w;
	for (let y = 0; y < h; y++) {
		const ay1 = Math.trunc(y * dy);
		let ay2 = Math.trunc((y + 1) * dy);
		if (ay2 === ay1) ay2++;
		for (let x = 0; x < w; x++) {
			const ax1 = Math.trunc(x * dx);
			let ax2 = Math.trunc((x + 1) * dx);
			if (ax2 === ax1) ax2++;
			let r = 0, g = 0, b = 0, a = 0, n = 0;
			for (let sy = ay1; sy < ay2; sy++) {
				for (let sx = ax1; sx < ax2; sx++, n++) {
					// package:image clamps reads outside the frame to its edge.
					const cx = Math.min(sx, img.width - 1), cy = Math.min(sy, img.height - 1);
					const i = (cy * img.width + cx) * 4;
					r += img.data[i]!;
					g += img.data[i + 1]!;
					b += img.data[i + 2]!;
					a += img.data[i + 3]!;
				}
			}
			const o = (y * w + x) * 4;
			out.data[o] = Math.trunc(r / n);
			out.data[o + 1] = Math.trunc(g / n);
			out.data[o + 2] = Math.trunc(b / n);
			out.data[o + 3] = Math.trunc(a / n);
		}
	}
	return out;
}

/** package:image's grayscale: every channel set to the (truncated) luma. */
export function grayscale(img: Raster): Raster {
	const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
	for (let i = 0; i < out.data.length; i += 4) {
		const l = Math.trunc(0.299 * out.data[i]! + 0.587 * out.data[i + 1]! + 0.114 * out.data[i + 2]!);
		out.data[i] = out.data[i + 1] = out.data[i + 2] = l;
	}
	return out;
}
