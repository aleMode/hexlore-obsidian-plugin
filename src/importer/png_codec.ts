// PNG coding for the importer's icon patches (libraries keep them as base64
// PNG, the Flutter app's format) through UPNG (pure JS, MIT): no canvas,
// synchronous, the same in the plugin and in the tests.

import { decode, encode, toRGBA8 } from '@pdf-lib/upng';
import type { PatchCodec } from './libraries';
import type { Raster } from './raster';

function toBase64(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
	const s = atob(b64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

export function encodePng(img: Raster): Uint8Array {
	return new Uint8Array(encode([img.data.slice().buffer], img.width, img.height, 0));
}

export function decodePng(bytes: Uint8Array): Raster | null {
	try {
		const png = decode(bytes.slice().buffer);
		const rgba = toRGBA8(png)[0];
		if (!rgba) return null;
		return { width: png.width, height: png.height, data: new Uint8ClampedArray(rgba) };
	} catch {
		return null;
	}
}

export const PNG_PATCHES: PatchCodec = {
	encode: (patch) => toBase64(encodePng(patch)),
	decode: (b64) => {
		try {
			return decodePng(fromBase64(b64));
		} catch {
			return null;
		}
	},
};
