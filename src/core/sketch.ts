// Port of Flutter's lib/core/sketch.dart: the GM-only free-drawing layer
// (decision 19) — swatches, items in z-order, and the hexify record.
//
// Precision: scene coordinates and sizes are rounded to 0.1 px and pressure
// to 2 decimals when an item is CREATED, so memory and disk never disagree.
// Every coordinate is a Dart double, so it is written as one (`100.0`).

import { TERRAINS, terrainColors, isTerrain, type Terrain } from './hex_data';
import { bool, compareCells, dbl, int, num, rawIfUnknown, str, unknownKeys, type Json, type JsonObject } from './json';
import { readTerrainVariant, terrainVariantId } from './variant_ids';

export const SWATCH_KINDS = ['none', 'biome', 'river', 'road', 'trail'] as const;
export type SwatchKind = (typeof SWATCH_KINDS)[number];

const dartRound = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
export const roundScene = (v: number) => dartRound(v * 10) / 10;
export const roundPressure = (p: number) => dartRound(p * 100) / 100;

const SWATCH_KEYS = new Set(['id', 'name', 'color', 'kind', 'terrain', 'variant']);

export class Swatch {
	extra: JsonObject = {};
	raw: JsonObject = {};
	private _kind: SwatchKind;

	constructor(
		readonly id: string,
		public name: string,
		public color: string,
		kind: SwatchKind = 'none',
		public terrain: Terrain | null = null,
		public variant = 0,
	) {
		this._kind = kind;
	}

	get kind(): SwatchKind {
		return this._kind;
	}
	set kind(v: SwatchKind) {
		this._kind = v;
		delete this.raw.kind;
	}

	toJson(): JsonObject {
		const o: JsonObject = { id: this.id, name: this.name, color: this.color, kind: this.raw.kind ?? this.kind };
		if ('terrain' in this.raw || this.terrain !== null) o.terrain = this.raw.terrain ?? this.terrain!;
		if ('variant' in this.raw || this.variant !== 0) {
			o.variant = this.raw.variant ?? (this.terrain === null ? this.variant : (terrainVariantId(this.terrain, this.variant) ?? this.variant));
		}
		return { ...o, ...this.extra };
	}

	static fromJson(j: JsonObject): Swatch | null {
		const id = str(j.id);
		if (id === undefined) return null;
		const rawKind = j.kind, rawTerrain = j.terrain, rawVariant = j.variant;
		const kind = (SWATCH_KINDS as readonly string[]).includes(rawKind as string) ? (rawKind as SwatchKind) : 'none';
		const terrain = isTerrain(rawTerrain) ? rawTerrain : null;
		const kindOk = rawKind === undefined || rawKind === null || kind === rawKind;
		const terrainOk = rawTerrain === undefined || rawTerrain === null || terrain !== null;
		const variant = terrain === null ? (rawVariant === undefined || rawVariant === null || rawVariant === 0 ? 0 : null) : readTerrainVariant(terrain, rawVariant);
		// A biome swatch whose biome is unknown would paint the fallback on
		// hexify, so it means nothing instead.
		const s = new Swatch(id, str(j.name) ?? '', str(j.color) ?? '#000000', kindOk && terrainOk ? kind : 'none', terrain, variant ?? 0);
		s.extra = unknownKeys(j, SWATCH_KEYS);
		s.raw = {
			...((!kindOk || !terrainOk) && rawKind !== undefined && rawKind !== null ? { kind: rawKind } : {}),
			...rawIfUnknown('terrain', rawTerrain, terrainOk),
			...rawIfUnknown('variant', rawVariant, variant !== null),
		};
		return s;
	}
}

export function defaultSwatches(): Swatch[] {
	return [
		...TERRAINS.filter((t) => t !== 'default').map((t) => new Swatch(`biome:${t}`, t, terrainColors[t], 'biome', t)),
		new Swatch('river', 'river', '#3A7DBF', 'river'),
		new Swatch('road', 'road', '#6B4A2F', 'road'),
		new Swatch('trail', 'trail', '#A08060', 'trail'),
		// Light inks: the canvas is dark, so "pen ink" is cream.
		new Swatch('ink', 'ink', '#E8E4D8'),
		new Swatch('ink:grey', 'grey', '#9A9AB0'),
		new Swatch('ink:red', 'red', '#C0392B'),
	];
}

export type Bounds = [number, number, number, number];
export type StrokePoint = [number, number, number];

function dist(ax: number, ay: number, bx: number, by: number): number {
	return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const abx = bx - ax, aby = by - ay;
	const len2 = abx * abx + aby * aby;
	if (len2 === 0) return dist(px, py, ax, ay);
	const t = Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / len2));
	return dist(px, py, ax + abx * t, ay + aby * t);
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
	const n = poly.length;
	if (n < 3) return false;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
		if (yi > y !== yj > y) {
			const xCross = xj + ((y - yj) * (xi - xj)) / (yi - yj);
			if (x < xCross) inside = !inside;
		}
	}
	return inside;
}

function polygonEdgeDistance(x: number, y: number, poly: [number, number][]): number {
	let best = Infinity;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
		best = Math.min(best, segmentDistance(x, y, xj, yj, xi, yi));
	}
	return best;
}

/** Douglas–Peucker. */
export function simplifyPolyline(pts: [number, number][], epsilon: number): [number, number][] {
	if (pts.length < 3) return [...pts];
	const keep = new Array<boolean>(pts.length).fill(false);
	keep[0] = keep[pts.length - 1] = true;
	const stack: [number, number][] = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let maxD = 0, idx = -1;
		const [ax, ay] = pts[a]!, [bx, by] = pts[b]!;
		for (let i = a + 1; i < b; i++) {
			const [x, y] = pts[i]!;
			const d = segmentDistance(x, y, ax, ay, bx, by);
			if (d > maxD) {
				maxD = d;
				idx = i;
			}
		}
		if (idx >= 0 && maxD > epsilon) {
			keep[idx] = true;
			stack.push([a, idx], [idx, b]);
		}
	}
	return pts.filter((_, i) => keep[i]);
}

/** Drop points closer than [minStep] to the last kept one (ends kept). */
export function thinStroke(points: StrokePoint[], minStep: number): StrokePoint[] {
	if (points.length < 3) return [...points];
	const out: StrokePoint[] = [points[0]!];
	for (let i = 1; i < points.length - 1; i++) {
		const [lx, ly] = out[out.length - 1]!, [x, y] = points[i]!;
		if (dist(x, y, lx, ly) >= minStep) out.push(points[i]!);
	}
	out.push(points[points.length - 1]!);
	return out;
}

export abstract class SketchItem {
	extra: JsonObject = {};
	constructor(readonly id: string) {}
	abstract toJson(): JsonObject;
	abstract bounds(): Bounds;
	abstract hitTest(x: number, y: number, tolerance: number): boolean;

	static fromJson(j: JsonObject): SketchItem | null {
		switch (j.type) {
			case 'stroke':
				return SketchStroke.fromJson(j);
			case 'shape':
				return SketchShape.fromJson(j);
			case 'fill':
				return SketchFill.fromJson(j);
			case 'label':
				return SketchLabel.fromJson(j);
		}
		// A type this build has no case for is KEPT, not dropped.
		return typeof j.id === 'string' ? new UnknownSketchItem(j) : null;
	}
}

export class UnknownSketchItem extends SketchItem {
	constructor(readonly json: JsonObject) {
		super(json.id as string);
	}
	toJson(): JsonObject {
		return this.json;
	}
	bounds(): Bounds {
		return [Infinity, Infinity, -Infinity, -Infinity];
	}
	hitTest(): boolean {
		return false;
	}
}

const nums = (v: Json | undefined): number[] | null => {
	if (!Array.isArray(v)) return null;
	const out: number[] = [];
	for (const x of v) {
		const n = num(x);
		if (n === undefined) return null;
		out.push(n);
	}
	return out;
};

export class SketchStroke extends SketchItem {
	readonly points: StrokePoint[];
	constructor(id: string, readonly swatchId: string, readonly width: number, points: StrokePoint[]) {
		super(id);
		this.points = points.map(([x, y, p]) => [roundScene(x), roundScene(y), roundPressure(p)]);
	}
	toJson(): JsonObject {
		return {
			type: 'stroke',
			id: this.id,
			swatch: this.swatchId,
			width: dbl(this.width),
			points: this.points.flatMap(([x, y, p]) => [dbl(x), dbl(y), dbl(p)]),
			...this.extra,
		};
	}
	static fromJson(j: JsonObject): SketchStroke | null {
		const flat = nums(j.points), id = str(j.id), swatch = str(j.swatch), width = num(j.width);
		if (!flat || id === undefined || swatch === undefined || width === undefined) return null;
		const pts: StrokePoint[] = [];
		for (let i = 0; i + 2 < flat.length; i += 3) pts.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
		const s = new SketchStroke(id, swatch, width, pts);
		s.extra = unknownKeys(j, new Set(['type', 'id', 'swatch', 'width', 'points']));
		return s;
	}
	bounds(): Bounds {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const [x, y] of this.points) {
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		}
		const h = this.width / 2;
		return [x0 - h, y0 - h, x1 + h, y1 + h];
	}
	hitTest(x: number, y: number, tolerance: number): boolean {
		const reach = this.width / 2 + tolerance;
		if (this.points.length === 1) return dist(x, y, this.points[0]![0], this.points[0]![1]) <= reach;
		for (let i = 0; i + 1 < this.points.length; i++) {
			const [ax, ay] = this.points[i]!, [bx, by] = this.points[i + 1]!;
			if (segmentDistance(x, y, ax, ay, bx, by) <= reach) return true;
		}
		return false;
	}
}

export const SHAPE_KINDS = ['line', 'rect', 'ellipse'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export class SketchShape extends SketchItem {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	/** An unknown kind, kept (drawn as a line). */
	rawKind: string | null = null;
	constructor(
		id: string,
		readonly kind: ShapeKind,
		readonly swatchId: string,
		readonly width: number,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		readonly filled = false,
	) {
		super(id);
		this.x1 = roundScene(x1);
		this.y1 = roundScene(y1);
		this.x2 = roundScene(x2);
		this.y2 = roundScene(y2);
	}
	get left(): number {
		return Math.min(this.x1, this.x2);
	}
	get top(): number {
		return Math.min(this.y1, this.y2);
	}
	get right(): number {
		return Math.max(this.x1, this.x2);
	}
	get bottom(): number {
		return Math.max(this.y1, this.y2);
	}
	toJson(): JsonObject {
		return {
			type: 'shape',
			id: this.id,
			kind: this.rawKind ?? this.kind,
			swatch: this.swatchId,
			width: dbl(this.width),
			x1: dbl(this.x1),
			y1: dbl(this.y1),
			x2: dbl(this.x2),
			y2: dbl(this.y2),
			...(this.filled ? { filled: true } : {}),
			...this.extra,
		};
	}
	static fromJson(j: JsonObject): SketchShape | null {
		const id = str(j.id), swatch = str(j.swatch), width = num(j.width);
		const x1 = num(j.x1), y1 = num(j.y1), x2 = num(j.x2), y2 = num(j.y2);
		if (id === undefined || swatch === undefined || width === undefined || x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
			return null;
		}
		const known = (SHAPE_KINDS as readonly string[]).includes(j.kind as string);
		const s = new SketchShape(id, known ? (j.kind as ShapeKind) : 'line', swatch, width, x1, y1, x2, y2, bool(j.filled) ?? false);
		s.rawKind = known ? null : (str(j.kind) ?? null);
		s.extra = unknownKeys(j, new Set(['type', 'id', 'kind', 'swatch', 'width', 'x1', 'y1', 'x2', 'y2', 'filled']));
		return s;
	}
	bounds(): Bounds {
		const h = this.width / 2;
		return [this.left - h, this.top - h, this.right + h, this.bottom + h];
	}
	hitTest(x: number, y: number, tolerance: number): boolean {
		const reach = this.width / 2 + tolerance;
		switch (this.kind) {
			case 'line':
				return segmentDistance(x, y, this.x1, this.y1, this.x2, this.y2) <= reach;
			case 'rect': {
				const inside = x >= this.left - reach && x <= this.right + reach && y >= this.top - reach && y <= this.bottom + reach;
				if (!inside) return false;
				if (this.filled) return true;
				return x <= this.left + reach || x >= this.right - reach || y <= this.top + reach || y >= this.bottom - reach;
			}
			case 'ellipse': {
				const cx = (this.left + this.right) / 2, cy = (this.top + this.bottom) / 2;
				const rx = (this.right - this.left) / 2, ry = (this.bottom - this.top) / 2;
				if (rx <= 0 || ry <= 0) return segmentDistance(x, y, this.x1, this.y1, this.x2, this.y2) <= reach;
				const nx = (x - cx) / rx, ny = (y - cy) / ry;
				const d = Math.sqrt(nx * nx + ny * ny);
				const band = reach / Math.min(rx, ry);
				return this.filled ? d <= 1 + band : Math.abs(d - 1) <= band;
			}
		}
	}
}

export class SketchFill extends SketchItem {
	readonly polygon: [number, number][];
	constructor(id: string, readonly swatchId: string, polygon: [number, number][]) {
		super(id);
		this.polygon = polygon.map(([x, y]) => [roundScene(x), roundScene(y)]);
	}
	toJson(): JsonObject {
		return { type: 'fill', id: this.id, swatch: this.swatchId, polygon: this.polygon.flatMap(([x, y]) => [dbl(x), dbl(y)]), ...this.extra };
	}
	static fromJson(j: JsonObject): SketchFill | null {
		const flat = nums(j.polygon), id = str(j.id), swatch = str(j.swatch);
		if (!flat || id === undefined || swatch === undefined) return null;
		const poly: [number, number][] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) poly.push([flat[i]!, flat[i + 1]!]);
		const f = new SketchFill(id, swatch, poly);
		f.extra = unknownKeys(j, new Set(['type', 'id', 'swatch', 'polygon']));
		return f;
	}
	bounds(): Bounds {
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const [x, y] of this.polygon) {
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		}
		return [x0, y0, x1, y1];
	}
	hitTest(x: number, y: number, tolerance: number): boolean {
		return pointInPolygon(x, y, this.polygon) || (tolerance > 0 && polygonEdgeDistance(x, y, this.polygon) <= tolerance);
	}
}

export class SketchLabel extends SketchItem {
	private _x: number;
	private _y: number;
	private _size: number;
	constructor(id: string, public text: string, x: number, y: number, size = 18, public color = '#E8E4D8') {
		super(id);
		this._x = roundScene(x);
		this._y = roundScene(y);
		this._size = roundScene(size);
	}
	get x(): number {
		return this._x;
	}
	set x(v: number) {
		this._x = roundScene(v);
	}
	get y(): number {
		return this._y;
	}
	set y(v: number) {
		this._y = roundScene(v);
	}
	get size(): number {
		return this._size;
	}
	set size(v: number) {
		this._size = roundScene(v);
	}
	get approxWidth(): number {
		return Math.max(1, this.text.length) * this.size * 0.6;
	}
	toJson(): JsonObject {
		return { type: 'label', id: this.id, text: this.text, x: dbl(this.x), y: dbl(this.y), size: dbl(this.size), color: this.color, ...this.extra };
	}
	static fromJson(j: JsonObject): SketchLabel | null {
		const id = str(j.id), x = num(j.x), y = num(j.y);
		if (id === undefined || x === undefined || y === undefined) return null;
		const l = new SketchLabel(id, str(j.text) ?? '', x, y, num(j.size) ?? 18, str(j.color) ?? '#E8E4D8');
		l.extra = unknownKeys(j, new Set(['type', 'id', 'text', 'x', 'y', 'size', 'color']));
		return l;
	}
	bounds(): Bounds {
		return [this.x, this.y - this.size, this.x + this.approxWidth, this.y + this.size * 0.3];
	}
	hitTest(x: number, y: number, tolerance: number): boolean {
		const [l, t, r, b] = this.bounds();
		return x >= l - tolerance && x <= r + tolerance && y >= t - tolerance && y <= b + tolerance;
	}
}

export class SketchDocument {
	extra: JsonObject = {};
	constructor(
		readonly swatches: Swatch[] = defaultSwatches(),
		readonly items: SketchItem[] = [],
		private nextIdValue = 1,
	) {}

	get isEmpty(): boolean {
		return this.items.length === 0;
	}

	swatch(id: string): Swatch | undefined {
		return this.swatches.find((s) => s.id === id);
	}

	colorOf(swatchId: string): string {
		return this.swatch(swatchId)?.color ?? '#E8E4D8';
	}

	newId(): string {
		for (;;) {
			const id = `s_${String(this.nextIdValue).padStart(4, '0')}`;
			this.nextIdValue++;
			if (this.items.every((it) => it.id !== id)) return id;
		}
	}

	item(id: string): SketchItem | undefined {
		return this.items.find((it) => it.id === id);
	}

	/** The topmost item under a point. */
	hitTest(x: number, y: number, tolerance: number): SketchItem | null {
		for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.hitTest(x, y, tolerance)) return this.items[i]!;
		return null;
	}

	bounds(): Bounds | null {
		if (!this.items.length) return null;
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const it of this.items) {
			if (it instanceof UnknownSketchItem) continue;
			const [l, t, r, b] = it.bounds();
			x0 = Math.min(x0, l);
			y0 = Math.min(y0, t);
			x1 = Math.max(x1, r);
			y1 = Math.max(y1, b);
		}
		return [x0, y0, x1, y1];
	}

	toJson(): JsonObject {
		return {
			version: 1,
			next_id: this.nextIdValue,
			swatches: this.swatches.map((s) => s.toJson()),
			items: this.items.map((it) => it.toJson()),
			...this.extra,
		};
	}

	static fromJson(j: JsonObject): SketchDocument {
		const swatches = (Array.isArray(j.swatches) ? j.swatches : [])
			.map((s) => (s && typeof s === 'object' && !Array.isArray(s) ? Swatch.fromJson(s as JsonObject) : null))
			.filter((s): s is Swatch => s !== null);
		const items = (Array.isArray(j.items) ? j.items : [])
			.map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? SketchItem.fromJson(it as JsonObject) : null))
			.filter((it): it is SketchItem => it !== null);
		const doc = new SketchDocument(swatches.length ? swatches : defaultSwatches(), items, int(j.next_id) ?? 1);
		doc.extra = unknownKeys(j, new Set(['version', 'next_id', 'swatches', 'items']));
		return doc;
	}
}

/** What the last Hexify wrote, so the next one can tell a hand edit. */
export class HexifyRecord {
	/** "q,r" → [terrain, variant index]. */
	readonly cells = new Map<string, [Terrain, number]>();
	rivers: string[] = [];
	routes: string[] = [];
	extra: JsonObject = {};

	get isEmpty(): boolean {
		return !this.cells.size && !this.rivers.length && !this.routes.length;
	}

	toJson(): JsonObject {
		const keys = [...this.cells.keys()].map((k) => k.split(',').map(Number) as [number, number]).sort(compareCells);
		const cells: JsonObject = {};
		for (const [q, r] of keys) {
			const [t, v] = this.cells.get(`${q},${r}`)!;
			cells[`${q}_${r}`] = [t, terrainVariantId(t, v) ?? v];
		}
		return { cells, rivers: [...this.rivers], routes: [...this.routes], ...this.extra };
	}

	static fromJson(j: JsonObject): HexifyRecord {
		const rec = new HexifyRecord();
		const cells = j.cells && typeof j.cells === 'object' && !Array.isArray(j.cells) ? (j.cells as JsonObject) : {};
		for (const [k, v] of Object.entries(cells)) {
			const parts = k.split('_');
			if (parts.length !== 2 || !Array.isArray(v) || !v.length) continue;
			// Dart's int.tryParse: an optional sign, then digits only.
			if (!/^[+-]?\d+$/.test(parts[0]!) || !/^[+-]?\d+$/.test(parts[1]!)) continue;
			const q = Number(parts[0]), r = Number(parts[1]);
			const terrain: Terrain = isTerrain(v[0]) ? v[0] : 'default';
			const stored = v.length > 1 ? v[1] : undefined;
			rec.cells.set(`${q},${r}`, [terrain, readTerrainVariant(terrain, stored) ?? Math.trunc(num(stored) ?? 0)]);
		}
		rec.rivers = (Array.isArray(j.rivers) ? j.rivers : []).filter((x): x is string => typeof x === 'string');
		rec.routes = (Array.isArray(j.routes) ? j.routes : []).filter((x): x is string => typeof x === 'string');
		rec.extra = unknownKeys(j, new Set(['cells', 'rivers', 'routes']));
		return rec;
	}
}
