// Illustrated textures: each distinct (variant id, layout, mirror, feature
// slot, LOD, ground, slice, resolution, obstacles, blend mask) is drawn once
// and blitted per hex. Ported from player.js (itself a mirror of Flutter's
// texture_paint.dart).
//
// The 2.0 benchmark found player.js's fixed 384-canvas LRU thrashing: one
// frame needed more distinct textures than it held, so every frame redrew
// most of them. This cache is bounded by PIXELS instead, and with tiles a
// texture is drawn once per tile, not once per frame.
//
// SPRITES (stamps, feature glyphs, feature objects) are PACKED INTO ATLAS
// PAGES (Flutter's decision 22): a few 2048² canvases, shelf-packed, evicted
// whole (LRU). A sprite is drawn once and blitted for every hex: Clean
// direct frames went from 50 to 17 ms between frames. Texture SLICES go in
// pages too, but a paint makes every raster it draws BEFORE drawing any
// (painter.prepare). Without that, slices in pages measured 150 ms between
// frames: each was made into a page the paint had just drawn from, a flush
// of the page per slice. A canvas each measured worse in direct frames
// (50 vs 33 ms between frames: no batching across hundreds of canvases).
//
// A raster is drawn on a CPU canvas and its pixels copied into the page
// (cpuRaster): a cold pan makes 500–900 of them, each dozens of small paths,
// which the GPU process rasterised slowly. Measured (benchmark, cold
// Illustrated pan at zoom 1, same run): on the GPU 34 ms between frames and
// 9% dropped, in software 17 ms and 2%.
//
// Zooming must not re-key every texture on screen at once (decision 23b):
// the resolution and the object LOD have HYSTERESIS, and a frame may make
// only so many new textures — past that, a key is drawn from its raster at
// another resolution or LOD, and the paint counts as SOFT (redone later).

import { HEX_RADIUS as R, hexCorners } from '../core/geometry';
import { ART } from './art';
import { TEX, TEXTURES, type Obstacle, type Placement, type TextureVariant, type Tones } from './vendor';

/** A 2D canvas the cache can draw into: OffscreenCanvas, or an element. */
export interface Surface {
	width: number;
	height: number;
	getContext(kind: '2d', options?: CanvasRenderingContext2DSettings): unknown;
}
export type SurfaceFactory = (w: number, h: number) => Surface;

export type Slice = 'ground' | 'behind' | 'front';

/** An atlas page's side, px. */
export const ATLAS_PAGE = 2048;
/** A slice wider or taller than this (gutter included) gets its own canvas. */
const ATLAS_MAX_ENTRY = 512;
/** Transparent px around each entry: a scaled blit samples past its rect. */
const GUTTER = 2;
const PXS = [16, 32, 64, 128, 256];

interface Shelf {
	y: number;
	h: number;
	x: number;
}

interface Page {
	surface: Surface;
	shelves: Shelf[];
	nextY: number;
	/** The paint that last drew from it (a page in use is never evicted). */
	lastUse: number;
	keys: string[];
}

/** Where one raster is: a rect of an atlas page, or a canvas of its own,
 *  and where its top-left sits relative to its origin (a hex centre), in
 *  offscreen px, at [perScene] offscreen px per scene px. */
interface Hit {
	src: Surface;
	sx: number;
	sy: number;
	w: number;
	h: number;
	left: number;
	top: number;
	perScene: number;
	page: Page | null;
}

/** A scene rect around a sprite's origin: [x0, y0, x1, y1]. */
export type SpriteBox = [number, number, number, number];

/** The resolution (offscreen px per hex radius) and object LOD a paint's
 *  textures use. */
export interface TextureResolution {
	px: number;
	lod: number;
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

/** Give a canvas's memory back now (see tiles.ts's releaseSurface). */
function releaseSurface(s: Surface): void {
	s.width = 0;
	s.height = 0;
}

function argbCss(argb: number, alpha: number): string {
	return `rgba(${(argb >>> 16) & 255},${(argb >>> 8) & 255},${argb & 255},${alpha})`;
}

function hexCss(hex: string, alpha: number, parse: (h: string) => [number, number, number]): string {
	if (alpha >= 1) return hex;
	const [r, g, b] = parse(hex);
	return `rgba(${r},${g},${b},${alpha})`;
}

/** The object LOD bucket's CSS-px radius range, widened by 15% each way:
 *  a bucket is kept while the radius stays in it (LOD hysteresis). */
function lodHolds(bucket: number, radiusPx: number): boolean {
	const lo = bucket === 0 ? 0 : bucket === 1 ? 22 : 34;
	const hi = bucket === 0 ? 22 : bucket === 1 ? 34 : Infinity;
	return radiusPx >= lo / 1.15 && radiusPx < hi * 1.15;
}

export class TextureCache {
	/** Every slice made, by key (null: nothing to draw). */
	private readonly hits = new Map<string, Hit | null>();
	/** The slices with a canvas of their own, least recently used first. */
	private readonly loose = new Map<string, Hit>();
	private loosePixels = 0;
	private readonly pages: Page[] = [];
	/** Draw each raster on a CPU canvas and copy its pixels into its page
	 *  (else drawn into the page on the GPU; the benchmark compares). */
	private onCpu = true;
	/** The CPU canvas rasters are drawn on before they are copied. */
	private scratch: CanvasRenderingContext2D | null = null;
	private readonly paths = new Map<number, Path2D>();
	/** The zoom buckets each sprite has a raster at (for stand-ins). */
	private readonly spriteKs = new Map<string, Set<number>>();
	private paintNo = 0;
	private budget = Infinity;
	private sticky: TextureResolution | null = null;
	/** Textures and sprites drawn so far (for tests and the benchmark). */
	made = 0;
	/** Slices drawn from another resolution's or LOD's raster: a paint that
	 *  raised it is soft, and should be done again. */
	soft = 0;

	constructor(
		private readonly makeSurface: SurfaceFactory,
		private readonly parseHex: (h: string) => [number, number, number],
		/** Offscreen pixels held at most (128 MB at 4 bytes a pixel), in
		 *  atlas pages and canvases of their own (maxPages). The cache
		 *  must hold the view and its prefetched ring: a 1080p Illustrated +
		 *  Blend view at zoom 1 needs ~11M px of slices, and a cache smaller
		 *  than that evicts every frame what it then draws again (350 ms
		 *  frames, measured with the first atlas). */
		private readonly maxPixels = 32_000_000,
	) {}

	/** Pages held at most: three quarters of the pixels (never under two). */
	private get maxPages(): number {
		return Math.max(2, Math.floor((this.maxPixels * 0.75) / (ATLAS_PAGE * ATLAS_PAGE)));
	}

	/** Pixels of canvases of their own (rasters too big for a page): the rest. */
	private get maxLoosePixels(): number {
		return Math.max(this.maxPixels - this.maxPages * ATLAS_PAGE * ATLAS_PAGE, this.maxPixels / 4);
	}

	get cpuRaster(): boolean {
		return this.onCpu;
	}

	/** Where rasters are drawn (off: the GPU, as measured against): drops
	 *  every raster. */
	set cpuRaster(on: boolean) {
		this.clear();
		this.onCpu = on;
	}

	private scratchContext(): CanvasRenderingContext2D {
		// willReadFrequently: a canvas Chromium keeps in CPU memory and
		// rasterises in software.
		this.scratch ??= this.makeSurface(ATLAS_MAX_ENTRY, ATLAS_MAX_ENTRY).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
		return this.scratch;
	}

	clear(): void {
		for (const page of this.pages) releaseSurface(page.surface);
		for (const hit of this.loose.values()) releaseSurface(hit.src);
		this.pages.length = 0;
		this.loose.clear();
		this.hits.clear();
		this.spriteKs.clear();
		this.loosePixels = 0;
		this.sticky = null;
	}

	/** Atlas pages held (for tests and the benchmark). */
	get pageCount(): number {
		return this.pages.length;
	}

	/** The resolution a hex of [radiusPx] device px is drawn at: the next
	 *  power of two, so zooming reuses a handful of rasters. */
	static pxFor(radiusPx: number): number {
		return Math.min(256, Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, radiusPx)))));
	}

	/** The resolution and LOD for hexes of [radiusPx] CSS px: kept from the
	 *  last call until the zoom is clearly past them (raster upscaled more
	 *  than 1.3×, downscaled more than 2.6×; LOD 15% past its threshold), so
	 *  a zoom near a threshold does not re-key every texture on screen. */
	resolution(radiusPx: number, dpr: number): TextureResolution {
		const dev = radiusPx * dpr;
		const held = this.sticky;
		const px = held && dev <= held.px * 1.3 && dev >= held.px / 2.6 ? held.px : TextureCache.pxFor(dev);
		const lod = held && lodHolds(held.lod, radiusPx) ? held.lod : TEX.textureLodBucket(radiusPx);
		if (!held || held.px !== px || held.lod !== lod) this.sticky = { px, lod };
		return this.sticky!;
	}

	/** Start a frame: it may make at most [n] new textures. */
	beginFrame(n: number): void {
		this.budget = n;
	}

	/** New textures the frame may still make. */
	get budgetLeft(): number {
		return this.budget;
	}

	/** Make [t]'s three slices now if they are not held (pre-warming): no
	 *  stand-ins, nothing drawn. False once the budget is spent. */
	ensure(t: HexTexture): boolean {
		for (const slice of ['ground', 'behind', 'front'] as const) {
			const key = TextureCache.key(t, slice, t.px, t.lod);
			if (this.hits.has(key)) continue;
			if (this.budget <= 0 || this.full) return false;
			const hit = this.make(key, t, slice);
			if (hit) this.budget--; // nothing to draw costs nothing
			this.hits.set(key, hit);
		}
		return true;
	}

	/** No room left without evicting a page: pre-warming stops there — it
	 *  must never push out what the view is drawn from. */
	private get full(): boolean {
		const pagesFull = this.pages.length >= this.maxPages && this.pages.every((p) => p.nextY > ATLAS_PAGE - 160);
		return pagesFull || this.loosePixels > this.maxLoosePixels * 0.9;
	}

	/** Start a paint: pages over the limit go (none is in use yet). */
	beginPaint(): void {
		this.paintNo++;
		while (this.pages.length > this.maxPages) {
			const victim = this.leastUsedPage();
			if (!victim) break;
			this.evictPage(victim);
			releaseSurface(victim.surface);
			this.pages.splice(this.pages.indexOf(victim), 1);
		}
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

	private static key(t: HexTexture, slice: Slice, px: number, lod: number): string {
		return [
			t.variantId,
			t.pick.layout,
			t.pick.flip,
			t.slot,
			lod,
			t.ground,
			slice,
			px,
			slice === 'ground' ? '' : t.obstacleKey,
			slice === 'ground' ? 0 : t.blendMask,
		].join('|');
	}

	private touch(key: string, hit: Hit | null): void {
		if (!hit) return;
		if (hit.page) hit.page.lastUse = this.paintNo;
		else {
			this.loose.delete(key); // most recently used goes last
			this.loose.set(key, hit);
		}
	}

	private slice(t: HexTexture, slice: Slice): Hit | null {
		const key = TextureCache.key(t, slice, t.px, t.lod);
		const known = this.hits.get(key);
		if (known !== undefined) {
			this.touch(key, known);
			return known;
		}
		if (this.budget <= 0) {
			// Over the frame's budget: this key at another resolution or LOD
			// stands in, and the paint is soft.
			for (const lod of [t.lod, 0, 1, 2]) {
				for (const px of PXS) {
					if (px === t.px && lod === t.lod) continue;
					const k = TextureCache.key(t, slice, px, lod);
					const other = this.hits.get(k);
					if (other === undefined) continue;
					this.touch(k, other);
					this.soft++;
					return other;
				}
			}
			// Nothing to stand in: make it anyway (a first sight, not a zoom).
		}
		const hit = this.make(key, t, slice);
		if (hit) this.budget--; // nothing to draw costs nothing
		this.hits.set(key, hit);
		return hit;
	}

	/** Draw one slice: into an atlas page, or a canvas of its own. */
	private make(key: string, t: HexTexture, slice: Slice): Hit | null {
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
		if (!bounds) return null;
		const px = t.px;
		const left = Math.floor(bounds[0] * px) - 1;
		const top = Math.floor(bounds[1] * px) - 1;
		const w = Math.ceil(bounds[2] * px) + 1 - left;
		const h = Math.ceil(bounds[3] * px) + 1 - top;
		const draw = (c: CanvasRenderingContext2D) => {
			if (slice === 'ground') {
				c.beginPath();
				hexCorners(0, 0, px).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				c.closePath();
				c.clip();
				for (const p of slices.ground) this.drawSymbol(c, p, tones, px, false);
			} else {
				for (const p of objects) this.drawSymbol(c, p, tones, px, true);
			}
		};
		return this.store(key, left, top, w, h, px / R, (c) => draw(c));
	}

	/** Put a w × h raster whose top-left is (left, top) from its origin into
	 *  an atlas page (or a canvas of its own if too big), drawn by [draw]
	 *  with the origin at (0, 0). */
	private store(key: string, left: number, top: number, w: number, h: number, perScene: number, draw: (c: CanvasRenderingContext2D) => void): Hit {
		this.made++;
		if (w + 2 * GUTTER <= ATLAS_MAX_ENTRY && h + 2 * GUTTER <= ATLAS_MAX_ENTRY) {
			const { page, x, y } = this.allocate(w + 2 * GUTTER, h + 2 * GUTTER);
			const ox = x + GUTTER, oy = y + GUTTER;
			if (this.onCpu) {
				// Drawn in software, then one upload: a raster is dozens of
				// small filled and stroked paths, costly for the GPU process.
				const s = this.scratchContext();
				s.setTransform(1, 0, 0, 1, 0, 0);
				s.clearRect(0, 0, w, h);
				s.save();
				s.beginPath();
				s.rect(0, 0, w, h);
				s.clip();
				s.translate(-left, -top);
				draw(s);
				s.restore();
				ctx2d(page.surface).putImageData(s.getImageData(0, 0, w, h), ox, oy);
			} else {
				const c = ctx2d(page.surface);
				c.setTransform(1, 0, 0, 1, 0, 0);
				c.save();
				c.beginPath();
				c.rect(ox, oy, w, h); // the entry is the raster's own canvas
				c.clip();
				c.translate(ox - left, oy - top);
				draw(c);
				c.restore();
			}
			page.keys.push(key);
			page.lastUse = this.paintNo;
			return { src: page.surface, sx: ox, sy: oy, w, h, left, top, perScene, page };
		}
		const cv = this.makeSurface(w, h);
		const c = ctx2d(cv);
		c.translate(-left, -top);
		draw(c);
		const hit: Hit = { src: cv, sx: 0, sy: 0, w, h, left, top, perScene, page: null };
		this.loose.set(key, hit);
		this.loosePixels += w * h;
		while (this.loosePixels > this.maxLoosePixels && this.loose.size > 1) {
			const [oldest, gone] = this.loose.entries().next().value as [string, Hit];
			this.loosePixels -= gone.w * gone.h;
			releaseSurface(gone.src); // its memory now, not at the next GC
			this.loose.delete(oldest);
			this.hits.delete(oldest);
		}
		return hit;
	}

	/** A free w × h rect in some page: a shelf it fits (not much taller), a
	 *  new shelf, a new page, or the least recently used page emptied. */
	private allocate(w: number, h: number): { page: Page; x: number; y: number } {
		for (const page of this.pages) {
			const at = this.place(page, w, h);
			if (at) return { page, ...at };
		}
		let page = this.pages.length < this.maxPages ? null : this.leastUsedPage();
		if (page) this.evictPage(page);
		else {
			// Under the limit, or every page in use by this paint (over the
			// limit for now; beginPaint trims).
			page = { surface: this.makeSurface(ATLAS_PAGE, ATLAS_PAGE), shelves: [], nextY: 0, lastUse: this.paintNo, keys: [] };
			this.pages.push(page);
		}
		return { page, ...this.place(page, w, h)! };
	}

	private place(page: Page, w: number, h: number): { x: number; y: number } | null {
		for (const s of page.shelves) {
			if (s.h >= h && s.h <= h * 1.5 + 4 && s.x + w <= ATLAS_PAGE) {
				const x = s.x;
				s.x += w;
				return { x, y: s.y };
			}
		}
		if (page.nextY + h > ATLAS_PAGE) return null;
		const y = page.nextY;
		page.shelves.push({ y, h, x: w });
		page.nextY += h;
		return { x: 0, y };
	}

	/** The page used longest ago, not by the paint under way. */
	private leastUsedPage(): Page | null {
		let best: Page | null = null;
		for (const p of this.pages) if (p.lastUse < this.paintNo && (!best || p.lastUse < best.lastUse)) best = p;
		return best;
	}

	/** Forget a page's slices and empty it for reuse. */
	private evictPage(page: Page): void {
		for (const k of page.keys) this.hits.delete(k);
		const c = ctx2d(page.surface);
		c.setTransform(1, 0, 0, 1, 0, 0);
		c.clearRect(0, 0, ATLAS_PAGE, ATLAS_PAGE);
		page.keys = [];
		page.shelves = [];
		page.nextY = 0;
	}

	/** Make [t]'s slices now, drawing nothing (a paint's first pass, see
	 *  atlasSlices): over the budget, stand-ins as in blit. */
	prepare(t: HexTexture): void {
		for (const slice of ['ground', 'behind', 'front'] as const) this.slice(t, slice);
	}

	/** Blit one slice of [t] at its hex, in scene coordinates. */
	blit(c: CanvasRenderingContext2D, t: HexTexture, slice: Slice): void {
		const hit = this.slice(t, slice);
		if (hit) TextureCache.draw(c, hit, t.cx, t.cy);
	}

	private static draw(c: CanvasRenderingContext2D, hit: Hit, x: number, y: number): void {
		const s = 1 / hit.perScene; // scene px per offscreen px
		c.drawImage(hit.src as CanvasImageSource, hit.sx, hit.sy, hit.w, hit.h, x + hit.left * s, y + hit.top * s, hit.w * s, hit.h * s);
	}

	/** The zoom bucket a sprite is drawn at for [k] device px per scene px:
	 *  the ⅛ octave at or above it, so a sprite is never enlarged and at
	 *  most 9% reduced (Flutter's stamp atlas buckets, decision 23). */
	static spriteBucket(k: number): number {
		return 2 ** (Math.ceil(Math.log2(k) * 8 - 1e-9) / 8);
	}

	/** Draw a SPRITE at scene (x, y): a drawing that depends only on [key]
	 *  and the zoom (a stamp, a feature), drawn once by [draw] in scene
	 *  units around the origin over [box] (worked out only then: every
	 *  paint asks for every sprite twice), at the zoom bucket of [k] device
	 *  px per scene px ([draw] gets the bucket's own k), and blitted from
	 *  then on. Over the frame's budget, another bucket's raster stands in. */
	sprite(c: CanvasRenderingContext2D | null, key: string, x: number, y: number, box: () => SpriteBox, k: number, draw: (c: CanvasRenderingContext2D, k: number) => void): void {
		const kq = TextureCache.spriteBucket(k);
		const full = `${key}@${kq}`;
		let hit = this.hits.get(full);
		if (hit !== undefined) this.touch(full, hit);
		else if (!c && (this.budget <= 0 || this.full)) return; // pre-warming: out of budget, or of room
		else {
			const others = this.spriteKs.get(key);
			// Over budget: the nearest bucket still held stands in.
			let best = 0;
			if (this.budget <= 0 && others) {
				for (const o of others) {
					if (!this.hits.has(`${key}@${o}`)) others.delete(o); // evicted since
					else if (!best || Math.abs(Math.log(o / kq)) < Math.abs(Math.log(best / kq))) best = o;
				}
			}
			if (best) {
				const k2 = `${key}@${best}`;
				hit = this.hits.get(k2)!;
				this.touch(k2, hit);
				this.soft++;
			} else {
				this.budget--;
				const [bx0, by0, bx1, by1] = box();
				const left = Math.floor(bx0 * kq) - 1, top = Math.floor(by0 * kq) - 1;
				const w = Math.ceil(bx1 * kq) + 1 - left, h = Math.ceil(by1 * kq) + 1 - top;
				hit = w > 0 && h > 0 ? this.store(full, left, top, w, h, kq, (cc) => {
					cc.scale(kq, kq);
					draw(cc, kq);
				}) : null;
				this.hits.set(full, hit);
				if (others) others.add(kq);
				else this.spriteKs.set(key, new Set([kq]));
			}
		}
		if (hit && c) TextureCache.draw(c, hit, x, y); // no context: pre-warming
	}

	/** Build a hex's texture record, at the paint's [res] (resolution()). */
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
		res: TextureResolution,
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
			px: res.px,
			lod: res.lod,
			pick: TEX.texturePick(q, r, variant.layouts.length),
			slot: feature ? TEX.featureSlotFor(q, r) : null,
			obstacles,
			obstacleKey: obstacles.map((o) => [o.x1, o.y1, o.x2, o.y2, o.halfWidth].join(',')).join(';'),
			blendMask,
		};
	}
}
