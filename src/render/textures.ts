// Illustrated textures: each distinct (variant id, layout, mirror, feature
// slot, LOD, ground, slice, resolution, obstacles, blend mask) is drawn once
// into an offscreen canvas and blitted per hex. Ported from player.js (itself
// a mirror of Flutter's texture_paint.dart).
//
// The 2.0 benchmark found player.js's fixed 384-canvas LRU thrashing: one
// frame needed more distinct textures than it held, so every frame redrew
// most of them. This cache is bounded by PIXELS instead, and with tiles a
// texture is drawn once per tile, not once per frame.

import { HEX_RADIUS as R, hexCorners } from '../core/geometry';
import { ART } from './art';
import { TEX, TEXTURES, type Obstacle, type Placement, type TextureVariant, type Tones } from './vendor';

/** A 2D canvas the cache can draw into: OffscreenCanvas, or an element. */
export interface Surface {
	width: number;
	height: number;
	getContext(kind: '2d'): unknown;
}
export type SurfaceFactory = (w: number, h: number) => Surface;

export type Slice = 'ground' | 'behind' | 'front';

/** One slice of one hex's texture: the canvas and where its top-left sits
 *  relative to the hex centre, in offscreen px. */
interface Hit {
	cv: Surface;
	left: number;
	top: number;
	px: number;
}

/** Everything the three texture passes need for one hex. */
export interface HexTexture {
	q: number;
	r: number;
	terrain: string;
	variantId: string;
	variant: TextureVariant;
	ground: string;
	/** Hex centre, scene px. */
	cx: number;
	cy: number;
	px: number;
	lod: number;
	pick: { layout: number; flip: boolean };
	slot: number | null;
	obstacles: Obstacle[];
	obstacleKey: string;
	blendMask: number;
}

const ctx2d = (s: Surface) => s.getContext('2d') as CanvasRenderingContext2D;

function argbCss(argb: number, alpha: number): string {
	return `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${alpha})`;
}

function hexCss(hex: string, alpha: number, parse: (h: string) => [number, number, number]): string {
	if (alpha >= 1) return hex;
	const [r, g, b] = parse(hex);
	return `rgba(${r},${g},${b},${alpha})`;
}

export class TextureCache {
	private readonly hits = new Map<string, Hit | null>(); // insertion order = LRU order
	private readonly paths = new Map<number, Path2D>();
	private pixels = 0;
	/** Textures drawn since the counter was last read (for the benchmark). */
	made = 0;

	constructor(
		private readonly makeSurface: SurfaceFactory,
		private readonly parseHex: (h: string) => [number, number, number],
		/** Offscreen pixels held at most (64 MB at 4 bytes a pixel). */
		private readonly maxPixels = 16_000_000,
	) {}

	clear(): void {
		this.hits.clear();
		this.pixels = 0;
	}

	/** The resolution a hex of [radiusPx] device px is drawn at: the next
	 *  power of two, so zooming reuses a handful of canvases. */
	static pxFor(radiusPx: number): number {
		return Math.min(256, Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, radiusPx)))));
	}

	private path(symbol: number, part: number): Path2D {
		const key = symbol * 64 + part;
		let p = this.paths.get(key);
		if (!p) {
			p = new Path2D(TEXTURES.symbols[symbol]!.parts[part]![1]);
			this.paths.set(key, p);
		}
		return p;
	}

	/** One placed symbol, at [px] offscreen px per hex radius. Mirrors
	 *  _drawSymbol: shadows, the outline (solid parts stroked double so only
	 *  the silhouette survives the fills), then fills and ink in order. */
	private drawSymbol(c: CanvasRenderingContext2D, p: Placement, tones: Tones, px: number, object: boolean): void {
		const K = TEX.KIND;
		const parts = TEXTURES.symbols[p.symbol]!.parts;
		const s = p.size * px;
		c.save();
		c.translate(p.x * px, p.y * px);
		c.scale(p.flip ? -s : s, s);
		for (let i = 0; i < parts.length; i++) {
			if (parts[i]![0] !== K.shadow) continue;
			c.fillStyle = `rgba(0,0,0,${TEX.textureShadowAlpha})`;
			c.fill(this.path(p.symbol, i));
		}
		if (object) {
			c.lineJoin = 'round';
			c.strokeStyle = tones.outline;
			c.lineWidth = (2 * TEX.textureOutlinePx * (px / R)) / s;
			for (let i = 0; i < parts.length; i++) {
				const [kind, , , , , stroke] = parts[i]!;
				if (stroke === 0 && (kind === K.shape || kind === K.trunk || kind === K.accent || kind === K.snow)) {
					c.stroke(this.path(p.symbol, i));
				}
			}
		}
		for (let i = 0; i < parts.length; i++) {
			const [kind, , shade, argb, opacity, stroke] = parts[i]!;
			let colour: string;
			if (kind === K.shadow) continue;
			else if (kind === K.shape) colour = hexCss(tones.object(shade), opacity, this.parseHex);
			else if (kind === K.trunk) colour = hexCss(tones.trunk, opacity, this.parseHex);
			else if (kind === K.ink) colour = hexCss(tones.outline, opacity, this.parseHex);
			else if (kind === K.ground) colour = hexCss(tones.ground(shade), opacity, this.parseHex);
			else if (kind === K.snow) colour = hexCss(tones.snow(shade), opacity, this.parseHex);
			else colour = argbCss(argb, opacity); // accent
			if (stroke > 0) {
				c.strokeStyle = colour;
				c.lineWidth = stroke;
				c.lineCap = 'round';
				c.stroke(this.path(p.symbol, i));
			} else {
				c.fillStyle = colour;
				c.fill(this.path(p.symbol, i));
			}
		}
		c.restore();
	}

	private slice(t: HexTexture, slice: Slice): Hit | null {
		const key = [
			t.variantId,
			t.pick.layout,
			t.pick.flip,
			t.slot,
			t.lod,
			t.ground,
			slice,
			t.px,
			slice === 'ground' ? '' : t.obstacleKey,
			slice === 'ground' ? 0 : t.blendMask,
		].join('|');
		if (this.hits.has(key)) {
			const hit = this.hits.get(key)!;
			this.hits.delete(key); // most recently used goes last
			this.hits.set(key, hit);
			return hit;
		}
		const layout = t.variant.layouts[t.pick.layout]!;
		const slices = TEX.sliceLayout(layout, {
			flip: t.pick.flip,
			featureSlot: t.slot,
			lodCount: TEX.textureLodCount(t.lod, layout.objects.length / TEX.placementStride),
			obstacles: slice === 'ground' ? [] : t.obstacles,
			blendMask: slice === 'ground' ? 0 : t.blendMask,
		});
		const tones = TEX.textureTones(t.ground, t.variant);
		const objects = slice === 'front' ? slices.front : slices.behind;
		let bounds: [number, number, number, number] | null; // hex radii
		if (slice === 'ground') {
			bounds = slices.ground.length ? [-1, -Math.sqrt(3) / 2, 1, Math.sqrt(3) / 2] : null;
		} else {
			bounds = TEX.objectBounds(objects);
			if (bounds) {
				const pad = (TEX.textureOutlinePx * 2) / R; // the outline is not in the extent
				bounds = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
			}
		}
		let hit: Hit | null = null;
		if (bounds) {
			const px = t.px;
			const left = Math.floor(bounds[0] * px) - 1;
			const top = Math.floor(bounds[1] * px) - 1;
			const cv = this.makeSurface(Math.ceil(bounds[2] * px) + 1 - left, Math.ceil(bounds[3] * px) + 1 - top);
			const c = ctx2d(cv);
			c.translate(-left, -top);
			if (slice === 'ground') {
				c.beginPath();
				hexCorners(0, 0, px).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				c.closePath();
				c.clip();
				for (const p of slices.ground) this.drawSymbol(c, p, tones, px, false);
			} else {
				for (const p of objects) this.drawSymbol(c, p, tones, px, true);
			}
			hit = { cv, left, top, px };
			this.pixels += cv.width * cv.height;
			this.made++;
		}
		this.hits.set(key, hit);
		while (this.pixels > this.maxPixels && this.hits.size > 1) {
			const oldest = this.hits.keys().next().value as string;
			const gone = this.hits.get(oldest);
			if (gone) this.pixels -= gone.cv.width * gone.cv.height;
			this.hits.delete(oldest);
		}
		return hit;
	}

	/** Blit one slice of [t] at its hex, in scene coordinates. */
	blit(c: CanvasRenderingContext2D, t: HexTexture, slice: Slice): void {
		const hit = this.slice(t, slice);
		if (!hit) return;
		const k = R / hit.px; // scene px per offscreen px
		c.drawImage(
			hit.cv as CanvasImageSource,
			t.cx + hit.left * k,
			t.cy + hit.top * k,
			hit.cv.width * k,
			hit.cv.height * k,
		);
	}

	/** Build a hex's texture record. [radiusPx] is the hex's on-screen radius
	 *  in CSS px (it picks the object LOD, as Flutter's logical px do); times
	 *  [dpr] it picks the offscreen resolution. */
	static hexTexture(
		q: number,
		r: number,
		cx: number,
		cy: number,
		terrain: string,
		terrainVariant: number,
		variant: TextureVariant,
		ground: string,
		feature: boolean,
		radiusPx: number,
		dpr: number,
		obstacleSegments: number[][],
		blendMask: number,
	): HexTexture {
		const obstacles = TEX.localObstacles(cx, cy, obstacleSegments, R);
		return {
			q,
			r,
			terrain,
			variantId: ART.biomeVariantId(terrain as never, terrainVariant),
			variant,
			ground,
			cx,
			cy,
			px: TextureCache.pxFor(radiusPx * dpr),
			lod: TEX.textureLodBucket(radiusPx),
			pick: TEX.texturePick(q, r, variant.layouts.length),
			slot: feature ? TEX.featureSlotFor(q, r) : null,
			obstacles,
			obstacleKey: obstacles.map((o) => [o.x1, o.y1, o.x2, o.y2, o.halfWidth].join(',')).join(';'),
			blendMask,
		};
	}
}
