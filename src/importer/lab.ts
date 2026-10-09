// CIE Lab (D65) and CIE76 ΔE: the importer compares colours in Lab so a
// distance tracks perception (Flutter's libraries.dart).

export interface LabColor {
	l: number;
	a: number;
	b: number;
}

/** sRGB (0xAARRGGBB) → CIE Lab, D65. */
export function argbToLab(argb: number): LabColor {
	const channel = (v: number) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	const r = channel((argb >> 16) & 0xff), g = channel((argb >> 8) & 0xff), b = channel(argb & 0xff);
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
	const f = (t: number) => (t > 0.008856 ? Math.pow(t, 1 / 3) : 7.787 * t + 16 / 116);
	const fx = f(x), fy = f(y), fz = f(z);
	return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE76 ΔE. */
export function deltaE(a: LabColor, b: LabColor): number {
	const dl = a.l - b.l, da = a.a - b.a, db = a.b - b.b;
	return Math.sqrt(dl * dl + da * da + db * db);
}

