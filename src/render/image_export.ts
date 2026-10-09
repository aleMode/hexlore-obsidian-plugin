// "Export image…" (plan item 2.10; Flutter's lib/app/image_export.dart,
// decision 32): the map as a PNG or a multi-page PDF, with the same options
// and rules as the Flutter app's.
//
// - The PLAYERS version is drawn from the player filter's payload
//   (players_scene.ts), never from the GM model, with every GM overlay off.
// - The GM version is the map as displayed, Display & overlays included.
// - Rendering is the map's own painter, offscreen, tile by tile into the
//   output; every image carries the scale bar and a credits line, and
//   nothing interactive (selection, handles, ruler, vote pills).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
	EXPORT_MIN_PX_PER_HEX,
	exportPixelSize,
	exportScaleForHex,
	exportTiles,
	mapHeightMm,
	mapWidthMm,
	pageHeightMm,
	pageWidthMm,
	printPages,
	printScenePxPerMm,
	type PrintLayout,
	type SceneRect,
} from '../core/export_layout';
import { HEX_RADIUS as R, gridPixelBounds, type GridWindow } from '../core/geometry';
import { hexStepPx, pickScaleBar, type MapScale } from '../core/map_scale';
import { MapPainter } from './painter';
import { CANVAS_BG, MapScene, type MapData, type MapStyle, type Overlays } from './scene';
import { TextureCache, type Surface, type SurfaceFactory } from './textures';
import { FEATURE_GLYPHS, SPEC, TEXTURES } from './vendor';

export type ExportFormat = 'png' | 'pdf';
export type ExportVersion = 'players' | 'gm';

export interface ImageExportOptions {
	format: ExportFormat;
	version: ExportVersion;
	style: MapStyle;
	blend: boolean;
	/** The whole grid window, or [view] (the current view's scene rect). */
	area: 'grid' | 'view';
	/** PNG: output px across one hex (corner to corner). */
	pxPerHex: number;
	/** PDF: paper, orientation, scale, overlap. */
	print: PrintLayout;
	/** PDF: raster resolution of the map on the page. */
	dpi: number;
}

/** Browsers refuse canvases past this side (Chrome: 32767; kept well under). */
const MAX_SIDE = 16000;

/** The credits an exported image carries (Flutter's exportCredits). */
export function exportCredits(style: MapStyle): string {
	const glyphs = FEATURE_GLYPHS.credits ?? [];
	const authors = [...new Set(glyphs.map((c) => c.name))];
	const licences = [...new Set(glyphs.map((c) => c.license ?? 'CC BY 3.0'))];
	const parts = [`Icons: game-icons.net, by ${authors.join(', ')} (${licences.join(', ')})`];
	if (style === 'illustrated') for (const c of TEXTURES.credits) parts.push(`Textures: ${c.name} (${c.license ?? ''})`);
	parts.push('Made with HexLore');
	return parts.join('  ·  ');
}

/** The scene exported: the grid window with one hex of margin, or [view]. */
export function exportScene(grid: GridWindow, area: 'grid' | 'view', view?: SceneRect): SceneRect {
	if (area === 'view' && view) return view;
	const [x, y, w, h] = gridPixelBounds(grid);
	return [x - R, y - R, w + 2 * R, h + 2 * R];
}

export interface ExportSource {
	data: MapData;
	/** GM: the overlays as displayed. Players: ignored (all off). */
	overlays: Overlays;
	mapScale: MapScale;
	name: string;
}

const ctx = (s: Surface) => s.getContext('2d') as CanvasRenderingContext2D;

/** Players see no GM overlay, whatever the GM has switched on. */
function sceneFor(src: ExportSource, version: ExportVersion): MapScene {
	const scene = new MapScene(src.data);
	scene.setOverlays(
		version === 'gm'
			? src.overlays
			: { ...src.overlays, threads: false, regions: false, borders: false, gmFog: false, badges: false, hiddenRegions: new Set(), hiddenThreadColors: new Set() },
	);
	return scene;
}

/** Paint [scene] (scene rect) at [scale] into [c] at (dx, dy), tile by tile. */
function paintScene(c: CanvasRenderingContext2D, painter: MapPainter, scene: MapScene, rect: SceneRect, scale: number, o: ImageExportOptions, dx = 0, dy = 0): void {
	for (const t of exportTiles(rect, scale)) {
		c.save();
		c.beginPath();
		c.rect(dx + t.x, dy + t.y, t.w, t.h);
		c.clip();
		c.fillStyle = CANVAS_BG;
		c.fillRect(dx + t.x, dy + t.y, t.w, t.h);
		c.setTransform(scale, 0, 0, scale, dx + t.x - t.scene[0] * scale, dy + t.y - t.scene[1] * scale);
		painter.paint(c, scene, { style: o.style, blend: o.blend, scale, dpr: 1, rect: [t.scene[0], t.scene[1], t.scene[0] + t.scene[2], t.scene[1] + t.scene[3]] });
		c.restore();
	}
}

/** The scale bar at (x, y) (its baseline), [k] times its screen size. */
function drawScaleBarAt(c: CanvasRenderingContext2D, mapScale: MapScale, scale: number, x0: number, y: number, k: number): void {
	const bar = pickScaleBar(mapScale, hexStepPx(R) * scale, 180 * k);
	if (!bar) return;
	const x1 = x0 + bar.px;
	for (const [color, w] of [
		['rgba(0,0,0,0.67)', 4],
		['#E8E8F0', 2],
	] as const) {
		c.strokeStyle = color;
		c.lineWidth = w * k;
		c.beginPath();
		c.moveTo(x0, y);
		c.lineTo(x1, y);
		c.moveTo(x0, y - 5 * k);
		c.lineTo(x0, y + 5 * k);
		c.moveTo(x1, y - 5 * k);
		c.lineTo(x1, y + 5 * k);
		c.stroke();
	}
	const hexText = Number.isInteger(bar.hexes) ? `${bar.hexes} hex${bar.hexes === 1 ? '' : 'es'}` : `${bar.hexes.toFixed(1)} hexes`;
	c.font = `${11 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
	c.textAlign = 'left';
	c.textBaseline = 'top';
	c.fillStyle = '#E8E8F0';
	c.fillText(`${mapScale.formatDistance(bar.distance)}  ·  ${hexText}`, x0, y + 7 * k);
}

export interface ExportResult {
	bytes: Uint8Array;
	/** What the GM should hear (a size capped, …). */
	notes: string[];
}

/** The PNG: the map, then a strip with the scale bar and the credits. */
export async function exportPng(
	src: ExportSource,
	o: ImageExportOptions,
	makeSurface: SurfaceFactory,
	encode: (s: Surface) => Promise<Uint8Array>,
	view?: SceneRect,
): Promise<ExportResult> {
	const notes: string[] = [];
	const rect = exportScene(src.data.grid, o.area, view);
	let pxPerHex = Math.max(o.pxPerHex, EXPORT_MIN_PX_PER_HEX);
	let [w, h] = exportPixelSize(rect, exportScaleForHex(pxPerHex));
	if (Math.max(w, h) > MAX_SIDE) {
		pxPerHex = Math.floor((pxPerHex * MAX_SIDE) / Math.max(w, h));
		notes.push(`The image was too large; it is ${pxPerHex} px per hex instead.`);
		[w, h] = exportPixelSize(rect, exportScaleForHex(pxPerHex));
	}
	const scale = exportScaleForHex(pxPerHex);
	const k = w > 1600 ? w / 1600 : 1;
	const footerH = Math.ceil(46 * k);
	const out = makeSurface(w, h + footerH);
	const c = ctx(out);
	const painter = new MapPainter(new TextureCache(makeSurface, (hex) => SPEC.parseHex(hex)));
	paintScene(c, painter, sceneFor(src, o.version), rect, scale, o);
	// The footer: scale bar left, credits right.
	c.setTransform(1, 0, 0, 1, 0, 0);
	c.fillStyle = CANVAS_BG;
	c.fillRect(0, h, w, footerH);
	drawScaleBarAt(c, src.mapScale, scale, 12 * k, h + 14 * k, k);
	c.font = `${9 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
	c.textAlign = 'right';
	c.textBaseline = 'middle';
	c.fillStyle = '#B8B8C8';
	c.fillText(exportCredits(o.style), w - 12 * k, h + footerH / 2, w * 0.6);
	return { bytes: await encode(out), notes };
}

/** pdf-lib's standard fonts speak WinAnsi only: anything else becomes '?'. */
const winAnsi = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => (ch === '·' ? '·' : '?'));

/** The PDF: the map only, split across overlapping pages, each labelled with
 *  its place in the grid of pages; credits in the footer, the scale bar on
 *  the map. */
export async function exportPdf(
	src: ExportSource,
	o: ImageExportOptions,
	makeSurface: SurfaceFactory,
	encode: (s: Surface) => Promise<Uint8Array>,
	view?: SceneRect,
): Promise<ExportResult> {
	const l = o.print;
	const rect = exportScene(src.data.grid, o.area, view);
	const pages = printPages(rect, l);
	const cols = new Set(pages.map((p) => p.col)).size, rows = new Set(pages.map((p) => p.row)).size;
	const pxPerMm = printScenePxPerMm(rect, l);
	// Output px per scene px at the print resolution, never below full detail.
	const scale = Math.max(o.dpi / 25.4 / pxPerMm, exportScaleForHex(EXPORT_MIN_PX_PER_HEX));
	const painter = new MapPainter(new TextureCache(makeSurface, (hex) => SPEC.parseHex(hex)));
	const scene = sceneFor(src, o.version);
	const credits = winAnsi(exportCredits(o.style));
	const doc = await PDFDocument.create();
	doc.setTitle(src.name);
	doc.setCreator('HexLore');
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const mm = 72 / 25.4;
	for (const page of pages) {
		const [w, h] = exportPixelSize(page.scene, scale);
		const surface = makeSurface(w, h);
		const c = ctx(surface);
		paintScene(c, painter, scene, page.scene, scale, o);
		c.setTransform(1, 0, 0, 1, 0, 0);
		const k = o.dpi / 96;
		drawScaleBarAt(c, src.mapScale, scale, 12 * k, h - 32 * k, k);
		const png = await doc.embedPng(await encode(surface));
		const p = doc.addPage([pageWidthMm(l) * mm, pageHeightMm(l) * mm]);
		const left = l.marginMm * mm, top = pageHeightMm(l) * mm - l.marginMm * mm;
		const mapW = mapWidthMm(l) * mm, mapH = mapHeightMm(l) * mm;
		p.drawImage(png, { x: left, y: top - mapH, width: mapW, height: mapH });
		const footY = top - mapH - 2 * mm - 7;
		const label = winAnsi(`${src.name}: page ${page.label} (column ${page.label.replace(/\d/g, '')} of ${cols}, row ${page.row + 1} of ${rows})`);
		p.drawText(label, { x: left, y: footY, size: 7, font, color: rgb(0, 0, 0) });
		// Credits, right-aligned, wrapped to 60 % of the width.
		const maxW = mapW * 0.6;
		const lines: string[] = [];
		let line = '';
		for (const word of credits.split(' ')) {
			const next = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(next, 6) > maxW && line) {
				lines.push(line);
				line = word;
			} else line = next;
		}
		if (line) lines.push(line);
		lines.forEach((t, i) => p.drawText(t, { x: left + mapW - font.widthOfTextAtSize(t, 6), y: footY - i * 7 + 1, size: 6, font, color: rgb(0.25, 0.25, 0.3) }));
	}
	return { bytes: await doc.save(), notes: [] };
}
