// What is drawn OVER the map and follows the pointer: selection and hover
// rings, the brush footprint, the rubber band, the ruler, the scale bar.
// Repainted on its own canvas, never re-rendering the map (decision 23).
// Colours and widths mirror Flutter's hex_map.dart.

import { HEX_RADIUS as R, axialToPixel, cellInGrid, cellsInRect as cellsInRectFor, hexDistance, hexesWithin, pixelToAxial, type GridWindow } from '../core/geometry';
import { describeRuler, hexStepPx, pickScaleBar, type MapScale } from '../core/map_scale';
import type { Camera } from './map_canvas';

export const HOVER_GLOW = '#7A55D4';
export const SELECT_GLOW = '#B08CF0';
const RULER_INK = '#FFE08A';
const SCALE_BAR_MAX_PX = 180;
const UNIT = Array.from({ length: 6 }, (_, i) => [R * Math.cos((Math.PI / 3) * i), R * Math.sin((Math.PI / 3) * i)] as const);

export interface OverlayFrame {
	c: CanvasRenderingContext2D;
	camera: Camera;
	dpr: number;
	/** CSS px. */
	width: number;
	height: number;
}

/** Enter scene space (snapped like the base layer). */
export function sceneSpace(f: OverlayFrame): void {
	const k = f.camera.scale * f.dpr;
	f.c.setTransform(k, 0, 0, k, Math.round(f.camera.ox * f.dpr), Math.round(f.camera.oy * f.dpr));
}

/** Enter screen space (CSS px). */
export function screenSpace(f: OverlayFrame): void {
	f.c.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
}

function hexPath(c: CanvasRenderingContext2D, q: number, r: number): void {
	const [cx, cy] = axialToPixel(q, r);
	UNIT.forEach(([x, y], i) => (i ? c.lineTo(cx + x, cy + y) : c.moveTo(cx + x, cy + y)));
	c.closePath();
}

/** Outline cells; [widthPx] in screen px. */
export function strokeCells(f: OverlayFrame, cells: Iterable<[number, number]>, color: string, widthPx: number): void {
	sceneSpace(f);
	const c = f.c;
	c.beginPath();
	for (const [q, r] of cells) hexPath(c, q, r);
	c.strokeStyle = color;
	c.lineWidth = widthPx / f.camera.scale;
	c.lineJoin = 'round';
	c.stroke();
}

/** Fill cells with a translucent [color] and outline them: a highlight. */
export function highlightCells(f: OverlayFrame, cells: Iterable<[number, number]>, color: string, alpha: number, widthPx: number): void {
	sceneSpace(f);
	const c = f.c;
	c.beginPath();
	for (const [q, r] of cells) hexPath(c, q, r);
	c.globalAlpha = alpha;
	c.fillStyle = color;
	c.fill();
	c.globalAlpha = 1;
	c.strokeStyle = color;
	c.lineWidth = widthPx / f.camera.scale;
	c.lineJoin = 'round';
	c.stroke();
}

/** The in-grid cells a brush of [radius] centred on [cell] covers. */
export function brushCells(cell: [number, number], radius: number, grid: GridWindow): [number, number][] {
	return hexesWithin(cell[0], cell[1], Math.max(0, radius)).filter(([q, r]) => cellInGrid(q, r, grid));
}

/** Each covered cell outlined, and a ring enclosing the disc. */
export function drawBrush(f: OverlayFrame, cell: [number, number], radius: number, grid: GridWindow, color = HOVER_GLOW): void {
	f.c.globalAlpha = 0.85;
	strokeCells(f, brushCells(cell, radius, grid), color, 1.5);
	f.c.globalAlpha = 1;
	const [cx, cy] = axialToPixel(cell[0], cell[1]);
	f.c.beginPath();
	f.c.arc(cx, cy, R * (1.5 * radius + 1), 0, Math.PI * 2);
	f.c.lineWidth = 2 / f.camera.scale;
	f.c.strokeStyle = color;
	f.c.stroke();
}

/** A screen-space rubber band. */
export function drawBand(f: OverlayFrame, x0: number, y0: number, x1: number, y1: number): void {
	screenSpace(f);
	const c = f.c;
	c.fillStyle = 'rgba(176,140,240,0.12)';
	c.strokeStyle = SELECT_GLOW;
	c.lineWidth = 1;
	c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
	c.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/** Straight-line hex widths between two scene points, plus the cells walked
 *  (null when either end is off the grid). Flutter's rulerMeasure. */
export function rulerMeasure(a: [number, number], b: [number, number], grid: GridWindow): { hexes: number; steps?: number } {
	const hexes = Math.hypot(b[0] - a[0], b[1] - a[1]) / hexStepPx(R);
	const [qa, ra] = pixelToAxial(a[0], a[1]);
	const [qb, rb] = pixelToAxial(b[0], b[1]);
	const inGrid = cellInGrid(qa, ra, grid) && cellInGrid(qb, rb, grid);
	return inGrid ? { hexes, steps: hexDistance(qa, ra, qb, rb) } : { hexes };
}

function pill(f: OverlayFrame, text: string, nx: number, ny: number): void {
	const c = f.c;
	c.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
	const w = c.measureText(text).width + 12, h = 20;
	let left = nx + 12, top = ny - 12 - h;
	if (left + w > f.width - 4) left = nx - 12 - w;
	if (top < 4) top = ny + 12;
	left = Math.min(Math.max(4, left), Math.max(4, f.width - w - 4));
	top = Math.min(Math.max(4, top), Math.max(4, f.height - h - 4));
	c.fillStyle = 'rgba(232,232,240,0.95)';
	c.beginPath();
	c.roundRect(left, top, w, h, 6);
	c.fill();
	c.fillStyle = '#1A1A2E';
	c.textAlign = 'left';
	c.textBaseline = 'middle';
	c.fillText(text, left + 6, top + h / 2 + 0.5);
}

export function drawRuler(f: OverlayFrame, a: [number, number], b: [number, number], grid: GridWindow, scale: MapScale): void {
	screenSpace(f);
	const c = f.c;
	const s = (p: [number, number]) => [p[0] * f.camera.scale + f.camera.ox, p[1] * f.camera.scale + f.camera.oy] as const;
	const [ax, ay] = s(a), [bx, by] = s(b);
	c.lineCap = 'round';
	for (const [color, w] of [
		['rgba(0,0,0,0.67)', 4],
		[RULER_INK, 2],
	] as const) {
		c.strokeStyle = color;
		c.lineWidth = w;
		c.beginPath();
		c.moveTo(ax, ay);
		c.lineTo(bx, by);
		c.stroke();
	}
	for (const [x, y] of [
		[ax, ay],
		[bx, by],
	] as const) {
		c.fillStyle = 'rgba(0,0,0,0.67)';
		c.beginPath();
		c.arc(x, y, 4, 0, Math.PI * 2);
		c.fill();
		c.fillStyle = RULER_INK;
		c.beginPath();
		c.arc(x, y, 3, 0, Math.PI * 2);
		c.fill();
	}
	const m = rulerMeasure(a, b, grid);
	pill(f, describeRuler(scale, m.hexes, m.steps), bx, by);
}

/** Bottom-left, always on: the longest round distance that fits 180 px. */
export function drawScaleBar(f: OverlayFrame, scale: MapScale): void {
	const bar = pickScaleBar(scale, hexStepPx(R) * f.camera.scale, SCALE_BAR_MAX_PX);
	if (!bar) return;
	screenSpace(f);
	const c = f.c;
	const x0 = 14, y = f.height - 14 - 18, x1 = x0 + bar.px;
	for (const [color, w] of [
		['rgba(0,0,0,0.67)', 4],
		['#E8E8F0', 2],
	] as const) {
		c.strokeStyle = color;
		c.lineWidth = w;
		c.beginPath();
		c.moveTo(x0, y);
		c.lineTo(x1, y);
		c.moveTo(x0, y - 5);
		c.lineTo(x0, y + 5);
		c.moveTo(x1, y - 5);
		c.lineTo(x1, y + 5);
		c.stroke();
	}
	const hexText = Number.isInteger(bar.hexes) ? `${bar.hexes} hex${bar.hexes === 1 ? '' : 'es'}` : `${bar.hexes.toFixed(1)} hexes`;
	c.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
	c.textAlign = 'left';
	c.textBaseline = 'top';
	c.shadowColor = 'rgba(0,0,0,0.8)';
	c.shadowBlur = 3;
	c.fillStyle = '#E8E8F0';
	c.fillText(`${scale.formatDistance(bar.distance)}  ·  ${hexText}`, x0, y + 7);
	c.shadowBlur = 0;
	c.shadowColor = 'transparent';
}

/** A polyline in scene coordinates; [widthPx] and [dash] in screen px. */
export function drawLine(f: OverlayFrame, pts: [number, number][], color: string, widthPx: number, dash: number[] = []): void {
	if (pts.length < 2) return;
	sceneSpace(f);
	const c = f.c, k = 1 / f.camera.scale;
	c.strokeStyle = color;
	c.lineWidth = widthPx * k;
	c.lineCap = 'round';
	c.lineJoin = 'round';
	c.setLineDash(dash.map((d) => d * k));
	c.beginPath();
	pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.stroke();
	c.setLineDash([]);
}

/** A handle: a dot of [radiusPx] screen px at a scene point. */
export function drawHandle(f: OverlayFrame, p: [number, number], radiusPx: number, fill: string, stroke: string, strokePx: number): void {
	sceneSpace(f);
	const c = f.c, k = 1 / f.camera.scale;
	c.beginPath();
	c.arc(p[0], p[1], radiusPx * k, 0, Math.PI * 2);
	c.fillStyle = fill;
	c.fill();
	c.lineWidth = strokePx * k;
	c.strokeStyle = stroke;
	c.stroke();
}

/** The index of the point nearest [p], or -1. */
export function nearestIndex(pts: [number, number][], p: [number, number]): number {
	let best = -1, bestD = Infinity;
	pts.forEach(([x, y], i) => {
		const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	});
	return best;
}

/** Every anchor a point can snap to, as dots (decision 8c): the densest
 *  thing on screen, so nothing below 6 px of hex radius and corners only
 *  below 14 px. */
export function drawAnchorField(f: OverlayFrame, grid: GridWindow, color: string): void {
	const radiusPx = R * f.camera.scale;
	if (radiusPx < 6) return;
	const full = radiusPx >= 14;
	sceneSpace(f);
	const c = f.c, k = 1 / f.camera.scale;
	const x0 = -f.camera.ox * k, y0 = -f.camera.oy * k;
	const x1 = x0 + f.width * k, y1 = y0 + f.height * k;
	const dots = new Path2D();
	const dot = (x: number, y: number) => {
		dots.moveTo(x + 2 * k, y);
		dots.arc(x, y, 2 * k, 0, Math.PI * 2);
	};
	for (const [q, r] of cellsInRectFor(x0, y0, x1, y1, grid)) {
		const [cx, cy] = axialToPixel(q, r);
		// Each cell owns corners 0 and 1, and edges 0..2: every anchor once.
		dot(cx + R, cy);
		dot(cx + R * 0.5, cy + R * (Math.sqrt(3) / 2));
		if (!full) continue;
		dot(cx, cy);
		for (let e = 0; e < 3; e++) {
			const a = (Math.PI / 180) * (30 + 60 * e);
			dot(cx + R * (Math.sqrt(3) / 2) * Math.cos(a), cy + R * (Math.sqrt(3) / 2) * Math.sin(a));
		}
	}
	c.globalAlpha = 0.85;
	c.fillStyle = color;
	c.fill(dots);
	c.globalAlpha = 1;
}

/** The selection at its drag target: filled, outlined (red when blocked). */
export function drawGhost(f: OverlayFrame, cells: [number, number][], color: string): void {
	sceneSpace(f);
	const c = f.c;
	c.beginPath();
	for (const [q, r] of cells) hexPath(c, q, r);
	c.globalAlpha = 0.22;
	c.fillStyle = color;
	c.fill();
	c.globalAlpha = 1;
	c.strokeStyle = color;
	c.lineWidth = 2 / f.camera.scale;
	c.stroke();
}
