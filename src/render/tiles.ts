// The base layer as image tiles (decision 23 in the Flutter repo): while the
// camera only translates, a frame draws a dozen images instead of the map.
//
// A tile set is built at one zoom: tile (i, j) holds the device-px square
// [i·T, j·T, T, T] of the scene scaled by scale·dpr. Its KEY is everything the
// base layer depends on (scene revision, style, blend, dpr); a different key
// is a different set.

import { CANVAS_BG, type MapScene, type MapStyle } from './scene';
import type { MapPainter } from './painter';
import type { Surface, SurfaceFactory } from './textures';

export const TILE = 512; // device px

export interface LayerKey {
	revision: number;
	style: MapStyle;
	blend: boolean;
	dpr: number;
}

export const sameKey = (a: LayerKey, b: LayerKey) =>
	a.revision === b.revision && a.style === b.style && a.blend === b.blend && a.dpr === b.dpr;

export class TileSet {
	private readonly tiles = new Map<string, Surface>(); // insertion order = LRU
	/** Tiles rendered over this set's life (for the benchmark). */
	rendered = 0;

	constructor(
		readonly key: LayerKey,
		/** CSS px per scene px the set is built at. */
		readonly scale: number,
		private readonly scene: MapScene,
		private readonly painter: MapPainter,
		private readonly makeSurface: SurfaceFactory,
		private readonly maxTiles = 64,
	) {}

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

	/** Render tile (i, j) now. */
	render(i: number, j: number): Surface {
		const k = this.scale * this.key.dpr; // device px per scene px
		const surface = this.makeSurface(TILE, TILE);
		const c = surface.getContext('2d') as CanvasRenderingContext2D;
		c.fillStyle = CANVAS_BG;
		c.fillRect(0, 0, TILE, TILE);
		c.setTransform(k, 0, 0, k, -i * TILE, -j * TILE);
		this.painter.paint(c, this.scene, {
			style: this.key.style,
			blend: this.key.blend,
			scale: this.scale,
			dpr: this.key.dpr,
			rect: [(i * TILE) / k, (j * TILE) / k, ((i + 1) * TILE) / k, ((j + 1) * TILE) / k],
		});
		this.tiles.set(`${i},${j}`, surface);
		while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value as string);
		this.rendered++;
		return surface;
	}

	clear(): void {
		this.tiles.clear();
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
