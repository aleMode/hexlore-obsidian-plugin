// Port of Flutter's lib/sketch/hexify.dart: a sketch → per-cell paint
// intents + rivers + routes (decision 19). Area by SAMPLING (19 points a
// cell; the topmost area item covering a point names its biome; the majority
// takes the cell at `minCoverage`); lines are SNAPPED to the anchor lattice.
// Labels, ink swatches and shapes in a line swatch never contribute.

import { HEX_RADIUS, axialToPixel, cellsInRect } from '../core/geometry';
import type { Hex } from '../core/hex';
import type { Terrain } from '../core/hex_data';
import { PaintPick } from '../core/hex_paint';
import { RIVER_WIDTH_MAX, RIVER_WIDTH_MIN, type Anchor } from '../core/river';
import { RIVER_BASE_STROKE_PX, snapScenePolyline } from '../core/river_snap';
import { SketchFill, SketchShape, SketchStroke, pointInPolygon, type Bounds, type HexifyRecord, type SketchDocument, type SketchItem } from '../core/sketch';

export interface HexifyOptions {
	minCoverage?: number;
	/** Cells inside the sketch's extent that no biome reaches become sea. */
	fillSea?: boolean;
}

export interface ImportCell {
	q: number;
	r: number;
	pick: PaintPick;
}
export interface ImportRiver {
	nodes: Anchor[];
	width: number;
}
export interface ImportRoute {
	kind: 'road' | 'trail';
	nodes: Anchor[];
	width: number;
}

export interface HexifyResult {
	cells: ImportCell[];
	rivers: ImportRiver[];
	routes: ImportRoute[];
	sampledCells: number;
}

/** Centre, six at 0.45 R toward the corners, twelve at 0.85 / 0.82 R. */
export const SAMPLE_PATTERN: [number, number][] = (() => {
	const out: [number, number][] = [[0, 0]];
	for (let i = 0; i < 6; i++) {
		const a = (Math.PI / 3) * i;
		out.push([0.45 * Math.cos(a), 0.45 * Math.sin(a)]);
	}
	for (let i = 0; i < 12; i++) {
		const a = (Math.PI / 6) * i;
		const r = i % 2 === 0 ? 0.85 : 0.82;
		out.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	return out;
})();

const ROUTE_BASE_PX = { road: 5.0, trail: 3.5 };
const clampWidth = (w: number) => Math.min(RIVER_WIDTH_MAX, Math.max(RIVER_WIDTH_MIN, w));

const swatchIdOf = (item: SketchItem): string | null =>
	item instanceof SketchStroke || item instanceof SketchShape || item instanceof SketchFill ? item.swatchId : null;

function linePoints(item: SketchItem): [number, number][] {
	if (item instanceof SketchStroke) return item.points.map(([x, y]) => [x, y]);
	if (item instanceof SketchShape && item.kind === 'line') return [[item.x1, item.y1], [item.x2, item.y2]];
	return [];
}

const lineWidth = (item: SketchItem) => (item instanceof SketchStroke || item instanceof SketchShape ? item.width : 1);

function covers(item: SketchItem, x: number, y: number): boolean {
	if (item instanceof SketchStroke || item instanceof SketchShape) return item.hitTest(x, y, 0);
	if (item instanceof SketchFill) return pointInPolygon(x, y, item.polygon);
	return false;
}

const intersects = (a: Bounds, b: Bounds) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Samples the sketch's WHOLE extent; whether an off-grid cell grows the grid
 *  is the import plan's decision. */
export function hexifySketch(doc: SketchDocument, options: HexifyOptions = {}): HexifyResult {
	const minCoverage = options.minCoverage ?? 0.5, fillSea = options.fillSea ?? false;
	const areas: { item: SketchItem; terrain: Terrain; variant: number; bounds: Bounds }[] = [];
	const rivers: ImportRiver[] = [];
	const routes: ImportRoute[] = [];
	for (const item of doc.items) {
		const id = swatchIdOf(item);
		const swatch = id === null ? undefined : doc.swatch(id);
		if (!swatch) continue;
		if (swatch.kind === 'biome') {
			const t = swatch.terrain;
			if (t === null || t === 'default') continue;
			areas.push({ item, terrain: t, variant: swatch.variant, bounds: item.bounds() });
		} else if (swatch.kind === 'river' || swatch.kind === 'road' || swatch.kind === 'trail') {
			const pts = linePoints(item);
			if (pts.length < 2) continue;
			const chain = snapScenePolyline(pts);
			if (chain.length < 2) continue;
			const width = lineWidth(item);
			if (swatch.kind === 'river') rivers.push({ nodes: chain, width: clampWidth(width / RIVER_BASE_STROKE_PX) });
			else routes.push({ kind: swatch.kind, nodes: chain, width: clampWidth(width / ROUTE_BASE_PX[swatch.kind]) });
		}
	}

	const cells: ImportCell[] = [];
	let sampled = 0;
	if (areas.length) {
		let bl = Infinity, bt = Infinity, br = -Infinity, bb = -Infinity;
		for (const a of areas) {
			bl = Math.min(bl, a.bounds[0]);
			bt = Math.min(bt, a.bounds[1]);
			br = Math.max(br, a.bounds[2]);
			bb = Math.max(bb, a.bounds[3]);
		}
		const r = HEX_RADIUS;
		const [left, top, right, bottom] = [bl - r, bt - r, br + r, bb + r];
		// cellsInRect clamps to a window: hand it one spanning the rect itself.
		const colW = r * 1.5, rowH = r * Math.sqrt(3);
		const qLo = Math.floor(left / colW) - 1, qHi = Math.ceil(right / colW) + 1;
		const uLo = Math.floor(top / rowH) - 3, uHi = Math.ceil(bottom / rowH) + 3;
		for (const [q, rr] of cellsInRect(left, top, right, bottom, { minQ: qLo, cols: qHi - qLo + 1, rows: uHi - uLo + 1, rShift: uLo })) {
			const [cx, cy] = axialToPixel(q, rr);
			const cellBox: Bounds = [cx - r, cy - r, cx + r, cy + r];
			const near = areas.filter((a) => intersects(a.bounds, cellBox));
			if (!near.length && !fillSea) continue;
			sampled++;
			const votes = new Map<string, { terrain: Terrain; variant: number; n: number }>();
			for (const [ox, oy] of SAMPLE_PATTERN) {
				const px = cx + ox * r, py = cy + oy * r;
				for (let i = near.length - 1; i >= 0; i--) {
					const a = near[i]!;
					if (!covers(a.item, px, py)) continue;
					const key = `${a.terrain}|${a.variant}`;
					const v = votes.get(key);
					if (v) v.n++;
					else votes.set(key, { terrain: a.terrain, variant: a.variant, n: 1 });
					break; // topmost wins
				}
			}
			let best: { terrain: Terrain; variant: number; n: number } | null = null;
			for (const v of votes.values()) if (v.n > (best?.n ?? 0)) best = v;
			const coverage = (best?.n ?? 0) / SAMPLE_PATTERN.length;
			if (best && coverage >= minCoverage) cells.push({ q, r: rr, pick: PaintPick.biome(best.terrain, best.variant) });
			else if (fillSea && !best) cells.push({ q, r: rr, pick: PaintPick.biome('sea') });
		}
	}
	return { cells, rivers, routes, sampledCells: sampled };
}

export interface ProtectedHexify {
	cells: ImportCell[];
	protectedCells: number;
	removeRivers: string[];
	removeRoutes: string[];
}

/** Keep what the GM edited by hand since the last Hexify: a cell the record
 *  says Hexify painted but which now carries something else. */
export function protectHandEdits(
	result: HexifyResult,
	record: HexifyRecord,
	hexAt: (q: number, r: number) => Hex | undefined,
	rivers: Iterable<string>,
	routes: Iterable<string>,
	keepHandEdits = true,
	replaceOwnLines = true,
): ProtectedHexify {
	const kept: ImportCell[] = [];
	let protectedCount = 0;
	for (const cell of result.cells) {
		const wrote = record.cells.get(`${cell.q},${cell.r}`);
		if (keepHandEdits && wrote) {
			const hex = hexAt(cell.q, cell.r);
			if (!hex || hex.terrain !== wrote[0] || hex.terrainVariant !== wrote[1]) {
				protectedCount++;
				continue;
			}
		}
		kept.push(cell);
	}
	const riverSet = new Set(rivers), routeSet = new Set(routes);
	return {
		cells: kept,
		protectedCells: protectedCount,
		removeRivers: replaceOwnLines ? record.rivers.filter((id) => riverSet.has(id)) : [],
		removeRoutes: replaceOwnLines ? record.routes.filter((id) => routeSet.has(id)) : [],
	};
}
