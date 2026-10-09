// Port of Flutter's lib/importer/import_plan.dart (decision 12b): how
// recognised terrain (an image import, or Hexify) is merged into a map,
// decided as PURE DATA — what gets written, skipped, cleared, how big the
// grid ends up. The editor's applyImport only executes the plan.
//
// The modes govern the two PAINT layers (biome, feature) only; names, notes,
// tags, rivers, routes, regions and fog are never touched by any of them. A
// mode only decides what happens to paint the import DOESN'T supply.

import { cellInGrid, fitGridWindow, type GridWindow } from './geometry';
import type { PaintPick } from './hex_paint';
import { anchorTouchingHexes, type Anchor } from './river';

export interface ImportCell {
	q: number;
	r: number;
	pick: PaintPick;
	tags?: string[];
}

export interface ImportRiver {
	nodes: Anchor[];
	width: number;
}

export interface ImportRoute {
	kind: string;
	nodes: Anchor[];
	width: number;
}

export type ImportMode =
	/** Covered cells take what was recognised for them. */
	| 'overwrite'
	/** A cell holding a biome or a feature is left alone. */
	| 'skipOccupied'
	/** Strip biome + feature off every hex first, then drop the map in. */
	| 'replaceAll';

/** The padding auto-resize asks for: the content's extent plus 10 %. */
export const IMPORT_RESIZE_PAD = 0.1;

export interface ImportPlan {
	/** Cells receiving paint (+ tags), all inside [window]. */
	writes: ImportCell[];
	/** Cells losing biome and feature (replaceAll only); never in writes. */
	clears: [number, number][];
	/** replaceAll: written cells lose a feature / tint the import didn't supply. */
	clearFeatures: boolean;
	/** The window to adopt, or null to keep the map's. */
	window: GridWindow | null;
	skippedOutside: number;
	skippedOccupied: number;
	/** Created, additive in every mode (never clipped to the window). */
	rivers: ImportRiver[];
	routes: ImportRoute[];
	/** Deleted first: a re-hexify replacing the chains it made before. */
	removeRivers: string[];
	removeRoutes: string[];
}

export interface PlanImportInput {
	entries: ImportCell[];
	mode: ImportMode;
	autoResize: boolean;
	currentWindow: GridWindow;
	/** Every hex record: they join the resize union, so none is ever orphaned. */
	existingCells: Iterable<[number, number]>;
	/** Cells carrying a biome or a feature, as "q,r". */
	occupiedCells: ReadonlySet<string>;
	rivers?: ImportRiver[];
	routes?: ImportRoute[];
	removeRivers?: string[];
	removeRoutes?: string[];
}

const sameWindow = (a: GridWindow, b: GridWindow) => a.minQ === b.minQ && a.cols === b.cols && a.rows === b.rows && a.rShift === b.rShift;

export function planImport(input: PlanImportInput): ImportPlan {
	const rivers = input.rivers ?? [], routes = input.routes ?? [];
	// Resize first: the window decides what counts as "outside".
	let window: GridWindow | null = null;
	if (input.autoResize) {
		const cells: [number, number][] = [];
		for (const e of input.entries) if (!e.pick.isEmpty) cells.push([e.q, e.r]);
		for (const line of [...rivers, ...routes]) for (const n of line.nodes) cells.push(...anchorTouchingHexes(n));
		cells.push(...input.existingCells);
		const fitted = fitGridWindow(cells, IMPORT_RESIZE_PAD);
		if (fitted) {
			const w = { minQ: fitted[0], cols: fitted[1], rows: fitted[2], rShift: fitted[3] };
			if (!sameWindow(w, input.currentWindow)) window = w;
		}
	}
	const grid = window ?? input.currentWindow;
	const writes: ImportCell[] = [];
	const written = new Set<string>();
	let skippedOutside = 0, skippedOccupied = 0;
	for (const e of input.entries) {
		if (e.pick.isEmpty) continue;
		if (!cellInGrid(e.q, e.r, grid)) {
			skippedOutside++;
			continue;
		}
		if (input.mode === 'skipOccupied' && input.occupiedCells.has(`${e.q},${e.r}`)) {
			skippedOccupied++;
			continue;
		}
		writes.push(e);
		written.add(`${e.q},${e.r}`);
	}
	const clears: [number, number][] = [];
	if (input.mode === 'replaceAll') {
		for (const key of input.occupiedCells) if (!written.has(key)) clears.push(key.split(',').map(Number) as [number, number]);
		clears.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	}
	return {
		writes,
		clears,
		clearFeatures: input.mode === 'replaceAll',
		window,
		skippedOutside,
		skippedOccupied,
		rivers,
		routes,
		removeRivers: input.removeRivers ?? [],
		removeRoutes: input.removeRoutes ?? [],
	};
}

export interface ImportOutcome {
	applied: number;
	cleared: number;
	skippedOutside: number;
	skippedOccupied: number;
	resized: boolean;
	riversAdded: number;
	routesAdded: number;
}
