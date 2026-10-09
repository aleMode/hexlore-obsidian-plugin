// Port of Flutter's lib/importer/import_session.dart: the import wizard's
// testable state — calibration, the recognised groups and the GM's decision
// per group, per-cell overrides, the rivers, the placement anchor — and the
// assembly of ImportCells for the import plan. The wizard UI only wires it.

import { PaintPick } from '../core/hex_paint';
import type { ImportCell, ImportRiver } from '../core/import_plan';
import type { Anchor } from '../core/river';
import { insertRiverNodeOnLink, moveRiverNode, removeRiverNodeAt } from '../core/river_edit';
import { RIVER_BASE_STROKE_PX, riverWidthMultiplier, snapScenePolyline, axialToPixelF, translateVertices } from '../core/river_snap';
import { DEFAULT_CASCADE, gatherEvidence, groupEvidence, type CascadeGroup, type CascadeOutcome, type CascadeParams, type CascadeResult, type HexEvidence } from './classifier_cascade';
import { SourceGrid, solveGrid, sourceCells } from './grid_calibration';
import { sampleHexes } from './hex_sampler';
import { buildInkMask, describeCell } from './ink_mask';
import { argbToLab } from './lab';
import type { ImportLibraries } from './libraries';
import type { Raster } from './raster';
import { BiomePrototype } from './stamp_recognizer';

export interface GroupDecision {
	pick: PaintPick;
	skip: boolean;
	tags: string[];
	/** An unknown icon's name, to learn it under. */
	iconName: string | null;
}

/** Recognise [image] on [grid]: sample, ink, evidence, groups. */
export function classifyImage(image: Raster, grid: SourceGrid, libraries: ImportLibraries, params: CascadeParams = DEFAULT_CASCADE): CascadeOutcome {
	return groupEvidence(gatherChunk(image, grid, sourceCells(grid, image.width, image.height), libraries, params), params);
}

/** The per-hex half for a slice of the cells (a worker's share). */
export function gatherChunk(image: Raster, grid: SourceGrid, cells: [number, number][], libraries: ImportLibraries, params: CascadeParams = DEFAULT_CASCADE): HexEvidence[] {
	const mask = buildInkMask(image, grid.radius);
	const inks = cells.map(([q, r]) => describeCell(mask, grid, q, r));
	return gatherEvidence(sampleHexes(image, grid, cells), libraries, params, inks);
}

/** Snap a polyline in IMAGE px (the source grid) to lattice anchors in
 *  source-axial space (Flutter's snapPolyline). */
export function snapPolyline(imagePoints: [number, number][], grid: SourceGrid): Anchor[] {
	if (imagePoints.length < 2) return [];
	return snapScenePolyline(imagePoints.map(([x, y]) => axialToPixelF(...grid.fractionalAxial(x, y))));
}

/** One river being edited in the river step (source-axial anchors). */
export class RiverDraft {
	constructor(
		public vertices: Anchor[],
		public width: number,
	) {}

	copy(): RiverDraft {
		return new RiverDraft([...this.vertices], this.width);
	}

	movePoint(index: number, vertex: Anchor): void {
		if (index < 0 || index >= this.vertices.length) return;
		this.vertices = moveRiverNode(this.vertices, index, vertex).nodes;
	}

	insertOnLink(index: number, vertex: Anchor): number {
		const edit = insertRiverNodeOnLink(this.vertices, index, vertex);
		if (edit.index < 0) return -1;
		this.vertices = edit.nodes;
		return edit.index;
	}

	/** Cut link [index]: two rivers mid-course, an end trimmed at the ends. */
	cutLink(index: number): RiverDraft[] {
		if (index < 0 || index + 1 >= this.vertices.length) return [this];
		return [this.vertices.slice(0, index + 1), this.vertices.slice(index + 1)].filter((p) => p.length >= 2).map((p) => new RiverDraft(p, this.width));
	}

	removePoint(index: number): void {
		this.vertices = removeRiverNodeAt(this.vertices, index);
	}
}

/** A river drawn by hand on the source image (decision 12h: the default). */
export function drawnRiver(imagePoints: [number, number][], grid: SourceGrid, widthPx = RIVER_BASE_STROKE_PX): RiverDraft | null {
	const vertices = snapPolyline(imagePoints, grid);
	return vertices.length < 2 ? null : new RiverDraft(vertices, riverWidthMultiplier(widthPx, grid.radius));
}

const decisionKey = (g: CascadeGroup) => `${g.layer}\u0000${g.source}\u0000${g.label}`;

export class ImportSession {
	grid: SourceGrid | null = null;
	/** The campaign cell the top-left source cell lands on. */
	anchor: [number, number] = [0, 0];
	biomeGroups: CascadeGroup[] = [];
	structureGroups: CascadeGroup[] = [];
	readonly decisions = new Map<string, GroupDecision>();
	/** Per-cell picks keyed "q,r" in SOURCE-axial space: beat both layers. */
	readonly overrides = new Map<string, PaintPick>();
	rivers: RiverDraft[] = [];

	constructor(readonly image: Raster) {}

	get groups(): CascadeGroup[] {
		return [...this.biomeGroups, ...this.structureGroups];
	}

	calibrate(a: [number, number], b: [number, number]): boolean {
		const solved = solveGrid(a, b);
		if (!solved) return false;
		this.grid = solved;
		return true;
	}

	get cellCount(): number {
		return this.grid ? sourceCells(this.grid, this.image.width, this.image.height).length : 0;
	}

	/** Adopt recognised groups: every biome group starts with its proposal;
	 *  a structure group only when confident. */
	adoptGroups(outcome: CascadeOutcome, params: CascadeParams = DEFAULT_CASCADE): void {
		this.biomeGroups = outcome.biomes;
		this.structureGroups = outcome.structures;
		this.decisions.clear();
		for (const g of this.biomeGroups) this.decisions.set(decisionKey(g), { pick: g.pick, skip: false, tags: [...g.tags], iconName: null });
		for (const g of this.structureGroups) this.decisions.set(decisionKey(g), { pick: g.confidence >= params.structureConfirm ? g.pick : PaintPick.nothing, skip: false, tags: [...g.tags], iconName: null });
	}

	decisionOf(g: CascadeGroup): GroupDecision {
		return this.decisions.get(decisionKey(g))!;
	}

	/** Every biome group decided (painted or skipped). */
	get ready(): boolean {
		return this.biomeGroups.length > 0 && this.biomeGroups.every((g) => {
			const d = this.decisionOf(g);
			return d.skip || !d.pick.isEmpty;
		});
	}

	get minSourceCell(): [number, number] | null {
		if (!this.groups.length) return null;
		let minQ = Infinity, minR = Infinity;
		for (const g of this.groups) for (const m of g.members) {
			minQ = Math.min(minQ, m.sample.q);
			minR = Math.min(minR, m.sample.r);
		}
		return [minQ, minR];
	}

	get cellOffset(): [number, number] {
		const min = this.minSourceCell;
		return min ? [this.anchor[0] - min[0], this.anchor[1] - min[1]] : [...this.anchor];
	}

	buildRivers(): ImportRiver[] {
		const [dq, dr] = this.cellOffset;
		return this.rivers.filter((d) => d.vertices.length >= 2).map((d) => ({ nodes: translateVertices(d.vertices, dq, dr), width: d.width }));
	}

	/** One entry per cell: both layers composed (decision 1c), overrides on top. */
	buildEntries(): ImportCell[] {
		if (!this.minSourceCell) return [];
		const [dq, dr] = this.cellOffset;
		const picks = new Map<string, PaintPick>();
		const tags = new Map<string, string[]>();
		for (const g of this.groups) {
			const d = this.decisionOf(g);
			if (d.skip || d.pick.isEmpty) continue;
			const biome = g.layer === 'biome';
			for (const m of g.members) {
				const key = `${m.sample.q},${m.sample.r}`;
				const cur = picks.get(key) ?? PaintPick.nothing;
				picks.set(key, biome ? cur.withBiome(d.pick.terrain, d.pick.terrainVariant) : cur.withFeature(d.pick.feature, d.pick.featureVariant));
				if (d.tags.length) {
					const list = tags.get(key) ?? [];
					for (const t of d.tags) if (!list.includes(t)) list.push(t);
					tags.set(key, list);
				}
			}
		}
		for (const [key, pick] of this.overrides) {
			picks.set(key, pick);
			if (!tags.has(key)) tags.set(key, []);
		}
		const out: ImportCell[] = [];
		for (const [key, pick] of picks) {
			if (pick.isEmpty) continue;
			const [q, r] = key.split(',').map(Number) as [number, number];
			out.push({ q: q + dq, r: r + dr, pick, tags: [...(tags.get(key) ?? [])] });
		}
		return out;
	}

	/** Teach the library what was confirmed (decision 12i: correctively). */
	learnConfirmed(libraries: ImportLibraries): void {
		for (const g of this.groups) {
			const d = this.decisionOf(g);
			if (d.skip || !g.members.length) continue;
			const pick = d.pick;
			switch (g.source) {
				case 'unsorted': {
					const name = d.iconName?.trim() ?? '';
					if (name && (!pick.isEmpty || d.tags.length)) libraries.learnIcon(g.members[0]!.sample.crop, name, pick.withBiome(null), d.tags);
					break;
				}
				case 'newCluster':
					if (pick.paintsBiome) libraries.learnColor(meanBiomeColor(g.members), pick.terrain!, pick.terrainVariant);
					break;
				case 'knownColor':
					if (pick.paintsBiome && (pick.terrain !== g.pick.terrain || pick.terrainVariant !== g.pick.terrainVariant)) libraries.learnColor(meanBiomeColor(g.members), pick.terrain!, pick.terrainVariant);
					break;
				case 'stamp':
					if (pick.paintsBiome) {
						libraries.learnColor(meanBiomeColor(g.members), pick.terrain!, pick.terrainVariant);
						for (const m of g.members) {
							if (!m.ink) continue;
							libraries.learnStamp(new BiomePrototype(pick.terrain!, m.ink.shape, argbToLab(m.sample.biomeArgb), m.ink.orientation, m.ink.blobCount, m.ink.medianBlobArea, pick.terrainVariant));
						}
					}
					break;
				case 'icon':
					break; // already in the library
			}
		}
	}
}

function meanBiomeColor(members: CascadeResult[]): number {
	let r = 0, g = 0, b = 0;
	for (const m of members) {
		r += (m.sample.biomeArgb >> 16) & 0xff;
		g += (m.sample.biomeArgb >> 8) & 0xff;
		b += m.sample.biomeArgb & 0xff;
	}
	const n = members.length;
	return (0xff000000 | (Math.floor(r / n) << 16) | (Math.floor(g / n) << 8) | Math.floor(b / n)) >>> 0;
}
