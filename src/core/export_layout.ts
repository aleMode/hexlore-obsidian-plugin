// Port of Flutter's lib/core/export_layout.dart (decision 32, item 2.10):
// the image exporter's arithmetic — how big a PNG is and how it is cut into
// render tiles, and how a print is cut into overlapping pages. A hex is
// measured CORNER TO CORNER (flat-top: 2 · HEX_RADIUS scene px).

import { HEX_RADIUS } from './geometry';

/** (left, top, width, height) in scene px. */
export type SceneRect = [number, number, number, number];

/** The largest square tile rendered in one go (well under GPU limits). */
export const EXPORT_TILE_MAX_PX = 2048;

/** Below this many output px across a hex, detail drops out. */
export const EXPORT_MIN_PX_PER_HEX = 28;

/** Output px per scene px for [pxPerHex] output px across one hex. */
export const exportScaleForHex = (pxPerHex: number) => pxPerHex / (2 * HEX_RADIUS);

/** Output size in whole px of [scene] at [scale]. */
export const exportPixelSize = (scene: SceneRect, scale: number): [number, number] => [
	Math.max(1, Math.ceil(scene[2] * scale)),
	Math.max(1, Math.ceil(scene[3] * scale)),
];

export interface ExportTile {
	x: number;
	y: number;
	w: number;
	h: number;
	scene: SceneRect;
}

/** [scene] at [scale] cut into tiles of at most [maxPx] square, row by row. */
export function exportTiles(scene: SceneRect, scale: number, maxPx = EXPORT_TILE_MAX_PX): ExportTile[] {
	const [w, h] = exportPixelSize(scene, scale);
	const out: ExportTile[] = [];
	for (let y = 0; y < h; y += maxPx) {
		for (let x = 0; x < w; x += maxPx) {
			const tw = Math.min(maxPx, w - x), th = Math.min(maxPx, h - y);
			out.push({ x, y, w: tw, h: th, scene: [scene[0] + x / scale, scene[1] + y / scale, tw / scale, th / scale] });
		}
	}
	return out;
}

// ----- print -------------------------------------------------------------------------

export const PAPERS = {
	a4: { label: 'A4', widthMm: 210, heightMm: 297 },
	a3: { label: 'A3', widthMm: 297, heightMm: 420 },
	letter: { label: 'Letter', widthMm: 215.9, heightMm: 279.4 },
} as const;
export type Paper = keyof typeof PAPERS;

/** How a print is laid out: [hexWidthMm] (a fixed scale) or [pagesWide]
 *  (fit the map across that many pages) decides the scale. */
export interface PrintLayout {
	paper: Paper;
	landscape: boolean;
	hexWidthMm: number | null;
	pagesWide: number | null;
	/** Shared by neighbouring pages, for trimming and assembly. */
	overlapMm: number;
	marginMm: number;
	/** A strip at the bottom of each page for its label and the credits. */
	footerMm: number;
}

export function printLayout(p: Partial<PrintLayout> = {}): PrintLayout {
	const l: PrintLayout = { paper: 'a4', landscape: false, hexWidthMm: null, pagesWide: null, overlapMm: 10, marginMm: 8, footerMm: 7, ...p };
	if ((l.hexWidthMm === null) === (l.pagesWide === null)) throw new Error('a print layout needs a hex width OR a page count');
	return l;
}

export const pageWidthMm = (l: PrintLayout) => (l.landscape ? PAPERS[l.paper].heightMm : PAPERS[l.paper].widthMm);
export const pageHeightMm = (l: PrintLayout) => (l.landscape ? PAPERS[l.paper].widthMm : PAPERS[l.paper].heightMm);
export const mapWidthMm = (l: PrintLayout) => pageWidthMm(l) - 2 * l.marginMm;
export const mapHeightMm = (l: PrintLayout) => pageHeightMm(l) - 2 * l.marginMm - l.footerMm;

export interface PrintPage {
	row: number;
	col: number;
	scene: SceneRect;
	/** "B2": column letter, row number. */
	label: string;
}

/** The scale of a print, in scene px per mm. */
export function printScenePxPerMm(scene: SceneRect, l: PrintLayout): number {
	if (l.hexWidthMm !== null) return (2 * HEX_RADIUS) / l.hexWidthMm;
	const n = l.pagesWide!;
	// n pages side by side cover n·W − (n−1)·overlap mm.
	const coveredMm = n * mapWidthMm(l) - (n - 1) * l.overlapMm;
	return scene[2] / Math.max(coveredMm, 1e-6);
}

/** [scene] cut into pages: as few as cover it, overlapping by the layout's
 *  overlap, row by row from the top-left. */
export function printPages(scene: SceneRect, l: PrintLayout): PrintPage[] {
	const pxPerMm = printScenePxPerMm(scene, l);
	const pageW = mapWidthMm(l) * pxPerMm, pageH = mapHeightMm(l) * pxPerMm;
	const stepW = (mapWidthMm(l) - l.overlapMm) * pxPerMm;
	const stepH = (mapHeightMm(l) - l.overlapMm) * pxPerMm;
	const count = (extent: number, page: number, step: number) => (extent <= page ? 1 : 1 + Math.ceil((extent - page) / step - 1e-9));
	const cols = count(scene[2], pageW, stepW), rows = count(scene[3], pageH, stepH);
	const out: PrintPage[] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) out.push({ row: r, col: c, scene: [scene[0] + c * stepW, scene[1] + r * stepH, pageW, pageH], label: `${colLetters(c)}${r + 1}` });
	}
	return out;
}

function colLetters(c: number): string {
	let n = c + 1, s = '';
	while (n > 0) {
		const m = (n - 1) % 26;
		s = String.fromCharCode(65 + m) + s;
		n = Math.floor((n - 1) / 26);
	}
	return s;
}
