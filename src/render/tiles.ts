// The base layer as image tiles (decision 23 in the Flutter repo): while the
// camera only translates, a frame draws a few dozen images instead of the map.
//
// A tile set is built at one zoom: tile (i, j) holds the device-px square
// [i·T, j·T, T, T] of the scene scaled by scale·dpr. Its KEY is what the whole
// layer depends on (scene epoch, style, blend, dpr); a different key is a
// different set. Within one epoch an edit only INVALIDATES the tiles its
// damage touches (scene.damageSince), so a brush stroke redraws a few tiles,
// not the view.
//
// Tiles are 256 px: an Illustrated tile is mostly raster work the browser does
// AFTER the frame, so one 512 px tile scrolling in was a dropped frame of its
// own (the 100×100 benchmark: 58 ms frames panning, 100 ms with Blend).

import { CANVAS_BG, boxesOverlap, type Box, type MapScene, type MapStyle } from './scene';
import type { MapPainter } from './painter';
import type { Surface, SurfaceFactory } from './textures';

export const TILE = 256; // device px

export interface LayerKey {
	epoch: number;
	style: MapStyle;
	blend: boolean;
	dpr: number;
}

export const sameKey = (a: LayerKey, b: LayerKey) =>
	a.epoch === b.epoch && a.style === b.style && a.blend === b.blend && a.dpr === b.dpr;

/** Give a canvas's memory back now. A dropped canvas otherwise holds its
 *  backing store (GPU memory, for an accelerated one) until it is garbage
 *  collected. A canvas already drawn somewhere is safe: drawImage took a
 *  snapshot of it. */
export function releaseSurface(s: Surface): void {
	s.width = 0;
	s.height = 0;
}

/** Tile canvases to reuse: a new canvas is a new backing store, and a pan
 *  or a zoom settle goes through dozens of tiles a second. */
export class TilePool {
	private readonly free: Surface[] = [];

	constructor(
		private readonly makeSurface: SurfaceFactory,
		private readonly max = 64,
	) {}

	take(): Surface {
		return this.free.pop() ?? this.makeSurface(TILE, TILE);
	}

	give(s: Surface): void {
		if (this.free.length < this.max) this.free.push(s);
		else releaseSurface(s);
	}

	get size(): number {
		return this.free.length;
	}
}

/** A tile's 2D context. Tiles are painted edge to edge, so opaque: the
 *  compositor need not blend them. A pooled canvas keeps its context.
 *  [transparent]: a map laid over another ("Show maps together"). */
const tileContext = (s: Surface, transparent: boolean) => s.getContext('2d', { alpha: transparent }) as CanvasRenderingContext2D;

export class TileSet {
	private readonly tiles = new Map<string, Surface>(); // insertion order = LRU
	/** Tiles painted with stand-in textures (over a frame's texture budget):
	 *  to be painted again while idle. */
	private readonly softTiles = new Set<string>();
	/** Tiles rendered over this set's life (for the benchmark). */
	rendered = 0;
	/** The scene revision the held tiles show. */
	revision: number;

	constructor(
		readonly key: LayerKey,
		/** CSS px per scene px the set is built at. */
		readonly scale: number,
		private readonly scene: MapScene,
		private readonly painter: MapPainter,
		private readonly makeSurface: SurfaceFactory,
		/** 64 MB of tiles at 4 bytes a pixel. */
		private readonly maxTiles = 256,
		/** Where tiles come from and go back to (none: made and dropped). */
		private readonly pool: TilePool | null = null,
		/** Cleared, not filled with the background: what is under the map
		 *  shows through where nothing is painted. */
		private readonly transparent = false,
	) {
		this.revision = scene.revision;
	}

	private newTile(): Surface {
		return this.pool ? this.pool.take() : this.makeSurface(TILE, TILE);
	}

	private dropTile(s: Surface): void {
		if (this.pool) this.pool.give(s);
		else releaseSurface(s);
	}

	get(i: number, j: number): Surface | undefined {
		const id = `${i},${j}`;
		const t = this.tiles.get(id);
		if (t) {
			this.tiles.delete(id);
			this.tiles.set(id, t);
		}
		return t;
	}

	has(i: number, j: number): boolean {
		return this.tiles.has(`${i},${j}`);
	}

	/** The scene rect tile (i, j) covers. */
	sceneRect(i: number, j: number): Box {
		const k = this.scale * this.key.dpr; // device px per scene px
		return [(i * TILE) / k, (j * TILE) / k, ((i + 1) * TILE) / k, ((j + 1) * TILE) / k];
	}

	/** Render tile (i, j) now. */
	render(i: number, j: number): Surface {
		const soft = this.painter.textures.soft;
		const surface = this.paintBlock(i, j, 1, 1);
		return this.hold(i, j, surface, this.painter.textures.soft !== soft);
	}

	isSoft(i: number, j: number): boolean {
		return this.softTiles.has(`${i},${j}`);
	}

	/** Render [cells] now, in as few paints as is not wasteful. A paint has
	 *  a fixed cost however small its rect (every river and road crossing it
	 *  is stroked whole), so neighbouring tiles are painted as ONE block and
	 *  cut out of it. Tiles sit on whole device pixels, so a tile cut from a
	 *  block is the tile painted alone. Returns the tiles rendered (a block
	 *  also renders the tiles between those asked for). */
	renderMany(cells: [number, number][]): number {
		if (!cells.length) return 0;
		if (cells.length === 1) {
			this.render(cells[0]![0], cells[0]![1]);
			return 1;
		}
		const is = cells.map(([i]) => i), js = cells.map(([, j]) => j);
		const i0 = Math.min(...is), i1 = Math.max(...is), j0 = Math.min(...js), j1 = Math.max(...js);
		const w = i1 - i0 + 1, h = j1 - j0 + 1;
		if (w * h > 2 * cells.length) {
			// Sparse: split across the wider side and try each half.
			const byI = w >= h;
			const sorted = [...cells].sort((a, b) => (byI ? a[0] - b[0] : a[1] - b[1]));
			const mid = sorted.length >> 1;
			return this.renderMany(sorted.slice(0, mid)) + this.renderMany(sorted.slice(mid));
		}
		const soft = this.painter.textures.soft;
		const block = this.paintBlock(i0, j0, w, h);
		const blockSoft = this.painter.textures.soft !== soft;
		for (let j = j0; j <= j1; j++) {
			for (let i = i0; i <= i1; i++) {
				const t = this.newTile();
				const c = tileContext(t, this.transparent);
				c.setTransform(1, 0, 0, 1, 0, 0);
				if (this.transparent) c.clearRect(0, 0, TILE, TILE); // a pooled tile still holds its last image
				c.drawImage(block as CanvasImageSource, (i - i0) * TILE, (j - j0) * TILE, TILE, TILE, 0, 0, TILE, TILE);
				this.hold(i, j, t, blockSoft);
			}
		}
		releaseSurface(block);
		return w * h;
	}

	/** Paint the w × h tiles from (i, j) into one surface. */
	private paintBlock(i: number, j: number, w: number, h: number): Surface {
		const k = this.scale * this.key.dpr;
		const surface = w === 1 && h === 1 ? this.newTile() : this.makeSurface(w * TILE, h * TILE);
		const c = tileContext(surface, this.transparent);
		c.setTransform(1, 0, 0, 1, 0, 0);
		if (this.transparent) c.clearRect(0, 0, w * TILE, h * TILE);
		else {
			c.fillStyle = CANVAS_BG;
			c.fillRect(0, 0, w * TILE, h * TILE);
		}
		c.setTransform(k, 0, 0, k, -i * TILE, -j * TILE);
		const [x0, y0] = this.sceneRect(i, j);
		const [, , x1, y1] = this.sceneRect(i + w - 1, j + h - 1);
		this.painter.paint(c, this.scene, {
			style: this.key.style,
			blend: this.key.blend,
			scale: this.scale,
			dpr: this.key.dpr,
			rect: [x0, y0, x1, y1],
		});
		return surface;
	}

	private hold(i: number, j: number, surface: Surface, soft: boolean): Surface {
		const id = `${i},${j}`;
		if (soft) this.softTiles.add(id);
		else this.softTiles.delete(id);
		const old = this.tiles.get(id);
		if (old) {
			this.tiles.delete(id); // a re-render is the most recent
			this.dropTile(old);
		}
		this.tiles.set(id, surface);
		while (this.tiles.size > this.maxTiles) {
			const oldest = this.tiles.keys().next().value as string;
			this.dropTile(this.tiles.get(oldest)!);
			this.tiles.delete(oldest);
			this.softTiles.delete(oldest);
		}
		this.rendered++;
		return surface;
	}

	/** Bring the set up to the scene's revision: drop the tiles the changes
	 *  since touched, and return them (the visible ones must render again
	 *  before the frame shows). False when the changes are not known: the
	 *  set is stale as a whole. */
	catchUp(): [number, number][] | false {
		if (this.revision === this.scene.revision) return [];
		const damage = this.scene.damageSince(this.revision);
		if (!damage) return false;
		this.revision = this.scene.revision;
		const dropped: [number, number][] = [];
		if (!damage.length) return dropped;
		for (const id of [...this.tiles.keys()]) {
			const [i, j] = id.split(',').map(Number) as [number, number];
			const rect = this.sceneRect(i, j);
			if (damage.some((d) => boxesOverlap(d, rect))) {
				this.dropTile(this.tiles.get(id)!);
				this.tiles.delete(id);
				this.softTiles.delete(id);
				dropped.push([i, j]);
			}
		}
		return dropped;
	}

	/** Drop every tile (the set is done with). */
	clear(): void {
		for (const s of this.tiles.values()) this.dropTile(s);
		this.tiles.clear();
		this.softTiles.clear();
	}
}

/** The tile indices covering a device-px viewport of [w]×[h] whose scene
 *  origin sits at device offset (ox, oy) under zoom factor [f] (1 = the set's
 *  own zoom). Ordered from the centre out, so the middle renders first. */
export function tilesCovering(w: number, h: number, ox: number, oy: number, f: number, margin = 0): [number, number][] {
	const span = TILE * f;
	const i0 = Math.floor(-ox / span) - margin, i1 = Math.floor((w - 1 - ox) / span) + margin;
	const j0 = Math.floor(-oy / span) - margin, j1 = Math.floor((h - 1 - oy) / span) + margin;
	const ci = (i0 + i1) / 2, cj = (j0 + j1) / 2;
	const out: [number, number][] = [];
	for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push([i, j]);
	return out.sort((a, b) => Math.hypot(a[0] - ci, a[1] - cj) - Math.hypot(b[0] - ci, b[1] - cj));
}
