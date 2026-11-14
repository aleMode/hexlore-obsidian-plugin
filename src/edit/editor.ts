// The map editor: every change to a map goes through here (Flutter's
// AppController, the parts that apply to a map without notes). It edits the
// store's model, marks what changed dirty (the store saves it), records undo,
// and tells listeners which cells changed so the view redraws only those.
//
// No Obsidian import: unit-tested directly.

import { cellInGrid, cellsInRect, gridPixelBounds } from '../core/geometry';
import type { MapScale } from '../core/map_scale';
import { Hex } from '../core/hex';
import { hexIdFor } from '../core/hex_data';
import { encodeCompact } from '../core/json';
import type { PaintPick } from '../core/hex_paint';
import { heightOf, visibleFrom } from '../core/line_of_sight';
import type { MapModel } from '../core/map';
import { PAINT_DIR, chunkNameOf } from '../storage/map_codec';
import type { MapStore } from '../storage/map_store';
import { insertLinePoint, moveLinePoint } from '../core/line_edit';
import { Region } from '../core/region';
import { RIVER_WIDTH_MAX, RIVER_WIDTH_MIN, River, type Anchor } from '../core/river';
import { Route } from '../core/route';
import { Thread, type ThreadDirection, type ThreadStatus, type ThreadType } from '../core/thread';
import { LAYER_FILES } from '../storage/map_codec';
import { UndoStack } from './undo';
import { HexifyRecord, SketchDocument, SketchFill, type SketchItem, type Swatch } from '../core/sketch';
import type { ImportOutcome, ImportPlan } from '../core/import_plan';
import { HexClipboard, copyHexName, pastedHex } from '../core/hex_clipboard';
import { applyCellRemap, canMoveCells, explodeTransform, hexesOutsideAfter, moveTransform, populatedCentroid, requiredWindow, type CellTransform, type RemapResult } from '../core/remap';
import { cellInGrid as inWindow, type GridWindow } from '../core/geometry';

export type Cell = [number, number];

export type EditorEvent =
	/** These cells' hexes changed (created, repainted, renamed, removed). */
	| { kind: 'hexes'; cells: Cell[] }
	/** Player fog changed for these cells. */
	| { kind: 'revealed'; cells: Cell[] }
	/** Rivers or routes changed (created, edited, removed). */
	| { kind: 'lines' }
	/** Regions changed (cells, names, colours, existence). */
	| { kind: 'regions' }
	/** Threads changed. */
	| { kind: 'threads' }
	/** Everything may have moved (a remap, a resize): rebuild. */
	| { kind: 'all' }
	/** The hex → notes links changed. */
	| { kind: 'links' }
	/** Undo / redo availability changed. */
	| { kind: 'history' }
	/** The sketch changed (items, or its own history). */
	| { kind: 'sketch' };

export type LineKind = 'river' | 'route';

export interface ThreadSpec {
	type: ThreadType;
	label: string;
	direction: ThreadDirection;
	status: ThreadStatus;
	/** '' = by type. */
	color: string;
}

const chunkPath = (q: number, r: number) => `${PAINT_DIR}/${chunkNameOf(q, r)}`;

function cellOfId(id: string): Cell | null {
	const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
	return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The hex clipboard entry. [bare]: hexes that hold only notes (no map
 *  record): pasting one adds its notes and leaves the target's map content. */
export interface ClipboardEntry {
	clip: HexClipboard;
	notes: Map<string, string[]>;
	bare: Set<string>;
}

export class MapEditor {
	readonly undo = new UndoStack();
	/** The sketch's OWN history (decision 19): Ctrl+Z in the sketch never
	 *  undoes a map edit nobody can see, and the reverse. */
	readonly sketchUndo = new UndoStack();
	private readonly listeners = new Set<(e: EditorEvent) => void>();
	/** The stroke in progress: cell key → [the hex before its first change,
	 *  the hex now] (null: no record). Whole-hex snapshots, so undo restores
	 *  unknown values too. */
	private stroke = new Map<string, [Hex | null, Hex | null]>();

	/** Hex id → its notes, as last read from the index (the view keeps it
	 *  current). Edits that move hexes move their notes. */
	links = new Map<string, string[]>();
	/** Writes changes to the index: id → the new list, or null to unlink. The
	 *  view wires it to `vault.process`, applying them to the file as it is
	 *  then (so a link Obsidian is renaming meanwhile is not lost). */
	linkWriter: ((changes: Map<string, string[] | null>) => Promise<void> | void) | null = null;
	/** Brings a kept link text up to date (a note renamed since an undo
	 *  snapshot took it); null leaves link texts as they are. */
	fixLink: ((link: string) => string) | null = null;
	/** A link write failed (the index is gone, locked…): the view says so and
	 *  reads the index again, which drops the change from [links]. */
	linkWriteFailed: ((error: unknown) => void) | null = null;
	/** Link changes written but not yet seen back in the index: a read of the
	 *  index in between must not undo them. */
	private pendingLinks: Map<string, string[] | null>[] = [];
	/** The hex clipboard (session only, decision 29): a cut pastes once. */
	clipboard: ClipboardEntry | null = null;

	constructor(readonly store: MapStore) {}

	/** The index was read: its lists, with the writes still in flight on top. */
	linksFromIndex(hexes: Map<string, string[]>): void {
		this.links = new Map([...hexes].map(([id, l]) => [id, [...l]]));
		for (const changes of this.pendingLinks) {
			for (const [id, list] of changes) {
				if (list && list.length) this.links.set(id, [...list]);
				else this.links.delete(id);
			}
		}
	}

	/** Apply link changes here and in the index. */
	private changeLinks(given: Map<string, string[] | null>): void {
		if (!given.size) return;
		const fix = this.fixLink;
		const changes = fix ? new Map([...given].map(([id, list]) => [id, list && list.map(fix)] as const)) : given;
		for (const [id, list] of changes) {
			if (list && list.length) this.links.set(id, [...list]);
			else this.links.delete(id);
		}
		const written = this.linkWriter?.(changes);
		if (written) {
			const entry = new Map(changes);
			this.pendingLinks.push(entry);
			const done = () => (this.pendingLinks = this.pendingLinks.filter((e) => e !== entry));
			written.then(done, (e: unknown) => {
				done();
				this.linkWriteFailed?.(e);
			});
		}
		this.emit({ kind: 'links' });
	}

	get model(): MapModel {
		return this.store.model;
	}

	get readOnly(): boolean {
		return this.store.readOnly;
	}

	on(l: (e: EditorEvent) => void): () => void {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}

	private emit(e: EditorEvent): void {
		for (const l of this.listeners) l(e);
	}

	private hexesChanged(cells: Cell[]): void {
		for (const [q, r] of cells) this.store.markHex(q, r);
		this.emit({ kind: 'hexes', cells });
	}

	private pushed(): void {
		this.emit({ kind: 'history' });
	}

	inGrid(q: number, r: number): boolean {
		return cellInGrid(q, r, this.model.meta.grid);
	}

	// ----- paint ----------------------------------------------------------------

	/** Put a snapshot back: null means "no record". */
	private restore(q: number, r: number, snapshot: Hex | null): void {
		if (snapshot) this.model.hexes.set(snapshot.id, snapshot.copy());
		else this.model.hexes.delete(hexIdFor(q, r));
	}

	/** Apply [pick] to [cells] as part of the current stroke. Each layer the
	 *  pick has an opinion on is written; the other is left alone (decision
	 *  1c). A biome clears the legacy colour override; erasing never leaves an
	 *  empty record behind. Returns the cells that changed. */
	paint(cells: Cell[], pick: PaintPick): Cell[] {
		if (this.readOnly || pick.isEmpty) return [];
		const changed: Cell[] = [];
		for (const [q, r] of cells) {
			if (!this.inGrid(q, r)) continue;
			const existing = this.model.getHex(q, r);
			const before = existing ? existing.copy() : null;
			const h = existing ?? new Hex(q, r);
			if (pick.terrain !== null) {
				h.terrain = pick.terrain; // drops an unknown terrain: a repaint replaces it
				h.terrainVariant = pick.terrainVariant;
				h.colorOverride = null;
			}
			if (pick.feature !== null) {
				h.feature = pick.feature;
				h.featureVariant = pick.featureVariant;
			} else if (pick.clearsFeature) {
				h.feature = null;
				h.featureVariant = 0;
			}
			const after = h.hasPersistentContent ? h : null;
			if (encode(before) === encode(after)) continue;
			if (after) this.model.hexes.set(after.id, after);
			else this.model.hexes.delete(h.id);
			const key = `${q},${r}`;
			const first = this.stroke.get(key);
			this.stroke.set(key, [first ? first[0] : before, after ? after.copy() : null]);
			changed.push([q, r]);
		}
		if (changed.length) this.hexesChanged(changed);
		return changed;
	}

	/** Close the stroke: ONE undo entry for everything it painted. */
	endStroke(): void {
		if (!this.stroke.size) return;
		const changes = [...this.stroke].map(([k, [before, after]]) => {
			const [q, r] = k.split(',').map(Number) as Cell;
			return { q, r, before, after };
		});
		this.stroke = new Map();
		const cells = changes.map((c): Cell => [c.q, c.r]);
		this.undo.push({
			label: `Paint (${changes.length} hex${changes.length === 1 ? '' : 'es'})`,
			touches: new Set(cells.map(([q, r]) => chunkPath(q, r))),
			run: () => {
				for (const c of changes) this.restore(c.q, c.r, c.after);
				this.hexesChanged(cells);
			},
			undo: () => {
				for (const c of changes) this.restore(c.q, c.r, c.before);
				this.hexesChanged(cells);
			},
		});
		this.pushed();
	}

	// ----- names ----------------------------------------------------------------

	/** Name (or rename) the hex at (q, r); an empty name clears it. Names stay
	 *  unique ("Fort 2"). One undo entry. Returns the name given. */
	renameHex(q: number, r: number, raw: string): string | null {
		if (this.readOnly || !this.inGrid(q, r)) return null;
		const wanted = raw.trim();
		const existing = this.model.getHex(q, r);
		const oldName = existing?.name ?? null;
		const name = wanted ? this.model.uniqueHexName(wanted, hexIdFor(q, r)) : null;
		if (name === oldName) return name;
			const apply = (n: string | null) => {
			const h = this.model.getOrCreateHex(q, r);
			h.name = n;
			if (!h.hasPersistentContent) this.model.hexes.delete(h.id);
			this.hexesChanged([[q, r]]);
		};
		apply(name);
		this.undo.push({
			label: name === null ? 'Clear hex name' : oldName === null ? `Name hex "${name}"` : `Rename hex to "${name}"`,
			touches: new Set([chunkPath(q, r)]),
			run: () => apply(name),
			undo: () => apply(oldName),
		});
		this.pushed();
		return name;
	}

	// ----- player fog (undoable in the plugin; Flutter's decision 9 is not) ----------

	isRevealed(q: number, r: number): boolean {
		return this.model.revealed.has(hexIdFor(q, r));
	}

	/** True when every cell is revealed (an empty list is not). */
	allRevealed(cells: Cell[]): boolean {
		return cells.length > 0 && cells.every(([q, r]) => this.isRevealed(q, r));
	}

	/** Reveal or hide [cells] to players, clamped to the grid: ONE undo entry
	 *  (the plugin makes fog undoable, unlike Flutter's decision 9: a slip
	 *  reaches players within a poll). Returns the cells that changed. */
	setRevealed(cells: Cell[], reveal: boolean, label?: string): Cell[] {
		const changed = this.applyRevealed(cells, reveal);
		if (changed.length) this.pushFog(changed, reveal, label);
		return changed;
	}

	/** Reveal or hide [cells] as part of a fog-brush drag; [endFogStroke]
	 *  seals the drag as one undo entry. */
	paintFog(cells: Cell[], reveal: boolean): Cell[] {
		if (this.fogStroke && this.fogStroke.reveal !== reveal) this.endFogStroke();
		const changed = this.applyRevealed(cells, reveal);
		if (changed.length) {
			this.fogStroke ??= { reveal, cells: new Map() };
			for (const c of changed) this.fogStroke.cells.set(`${c[0]},${c[1]}`, c);
		}
		return changed;
	}

	endFogStroke(): void {
		const s = this.fogStroke;
		this.fogStroke = null;
		if (s?.cells.size) this.pushFog([...s.cells.values()], s.reveal);
	}

	private fogStroke: { reveal: boolean; cells: Map<string, Cell> } | null = null;

	private pushFog(changed: Cell[], reveal: boolean, label?: string): void {
		const cells = changed.map(([q, r]): Cell => [q, r]);
		const n = cells.length;
		this.undo.push({
			label: label ?? `${reveal ? 'Reveal' : 'Hide'} ${n} hex${n === 1 ? '' : 'es'}`,
			touches: new Set([LAYER_FILES.revealed]),
			run: () => void this.applyRevealed(cells, reveal),
			undo: () => void this.applyRevealed(cells, !reveal),
		});
		this.pushed();
	}

	private applyRevealed(cells: Cell[], reveal: boolean): Cell[] {
		if (this.readOnly) return [];
		const changed: Cell[] = [];
		for (const [q, r] of cells) {
			if (reveal && !this.inGrid(q, r)) continue;
			const id = hexIdFor(q, r);
			if (this.model.revealed.has(id) === reveal) continue;
			if (reveal) this.model.revealed.add(id);
			else this.model.revealed.delete(id);
			changed.push([q, r]);
		}
		if (changed.length) {
			this.store.markLayer('revealed');
			this.emit({ kind: 'revealed', cells: changed });
		}
		return changed;
	}

	/** The cells [origins] can see, by terrain height (decision 5b). Each origin
	 *  projects sight once (no cascade); clamped to the grid. */
	sightFrom(origins: Cell[]): Cell[] {
		const heightAt = (q: number, r: number) => {
			const h = this.model.getHex(q, r);
			// No record: unpainted ground, which is flat.
			return h ? heightOf(h.terrain) : 0;
		};
		const seen = new Map<string, Cell>();
		for (const [q, r] of origins) {
			for (const c of visibleFrom(q, r, heightAt)) if (this.inGrid(c[0], c[1])) seen.set(`${c[0]},${c[1]}`, c);
		}
		return [...seen.values()];
	}

	revealWithSight(origins: Cell[]): Cell[] {
		return this.setRevealed(this.sightFrom(origins), true);
	}

	// ----- feature visibility (decision 4c) ---------------------------------------

	anyFeature(cells: Cell[]): boolean {
		return cells.some(([q, r]) => this.model.getHex(q, r)?.feature != null);
	}

	allFeaturesHidden(cells: Cell[]): boolean {
		let any = false;
		for (const [q, r] of cells) {
			const h = this.model.getHex(q, r);
			if (!h || h.feature === null) continue;
			any = true;
			if (!h.featureHidden) return false;
		}
		return any;
	}

	/** Hide or show the feature (and with it the name) of each cell to players. */
	setFeatureHidden(cells: Cell[], hidden: boolean): Cell[] {
		if (this.readOnly) return [];
		const changed: Cell[] = [];
		for (const [q, r] of cells) {
			const h = this.model.getHex(q, r);
			if (!h || h.feature === null || h.featureHidden === hidden) continue;
			h.featureHidden = hidden;
			changed.push([q, r]);
		}
		if (changed.length) this.hexesChanged(changed);
		return changed;
	}

	// ----- rivers and routes (decisions 8, 8b, 8c) --------------------------------

	private lines(kind: LineKind): Map<string, River | Route> {
		return kind === 'river' ? this.model.rivers : this.model.routes;
	}

	private linesChanged(kind: LineKind): void {
		this.store.markLayer(kind === 'river' ? 'rivers' : 'routes');
		this.emit({ kind: 'lines' });
	}

	private lineTouches(kind: LineKind): Set<string> {
		return new Set([kind === 'river' ? LAYER_FILES.rivers : LAYER_FILES.routes]);
	}

	/** Put a line back as it was (null: absent). */
	private restoreLine(kind: LineKind, id: string, line: River | Route | null): void {
		if (line) this.lines(kind).set(id, line.copy());
		else this.lines(kind).delete(id);
		this.linesChanged(kind);
	}

	/** Record "line [id] went from [before] to [after]" as one undo entry,
	 *  the change being already applied. */
	private pushLine(kind: LineKind, id: string, label: string, before: River | Route | null, after: River | Route | null, mergeId?: string): void {
		const b = before?.copy() ?? null, a = after?.copy() ?? null;
		this.undo.push({
			label,
			touches: this.lineTouches(kind),
			run: () => this.restoreLine(kind, id, a),
			undo: () => this.restoreLine(kind, id, b),
			mergeId: mergeId ?? null,
		});
		this.pushed();
	}

	createRiver(nodes: Anchor[], width = 1): River | null {
		if (this.readOnly || nodes.length < 2) return null;
		const r = new River(this.model.nextId('river'));
		r.nodes = nodes.map((n) => ({ ...n }));
		r.width = width;
		this.model.rivers.set(r.id, r);
		this.linesChanged('river');
		this.pushLine('river', r.id, 'Draw river', null, r);
		return r;
	}

	/** A border is created hidden from players (decision 8). */
	createRoute(nodes: Anchor[], kind: string, color: string): Route | null {
		if (this.readOnly || nodes.length < 2) return null;
		const r = new Route(this.model.nextId('route'));
		r.nodes = nodes.map((n) => ({ ...n }));
		r.kind = kind;
		r.color = color;
		r.playerVisible = kind !== 'border';
		this.model.routes.set(r.id, r);
		this.linesChanged('route');
		this.pushLine('route', r.id, `Draw ${kind}`, null, r);
		return r;
	}

	removeLine(kind: LineKind, id: string): void {
		const line = this.lines(kind).get(id);
		if (this.readOnly || !line) return;
		this.lines(kind).delete(id);
		this.linesChanged(kind);
		this.pushLine(kind, id, `Delete ${kind === 'river' ? 'river' : (line as Route).kind}`, line, null);
	}

	/** Set a line's points WITHOUT undo: the live frames of a drag. */
	setLineNodesLive(kind: LineKind, id: string, nodes: Anchor[]): void {
		const line = this.lines(kind).get(id);
		if (this.readOnly || !line || nodes.length < 2) return;
		line.nodes = nodes.map((n) => ({ ...n }));
		this.linesChanged(kind);
	}

	/** Seal a drag: ONE undo entry from the points at pointer-down. */
	pushLineNodesChange(kind: LineKind, id: string, before: Anchor[]): void {
		const line = this.lines(kind).get(id);
		if (!line || sameNodes(before, line.nodes)) return;
		const old = line.copy();
		old.nodes = before.map((n) => ({ ...n }));
		this.pushLine(kind, id, `Move ${kind === 'river' ? 'river' : 'route'} point`, old, line);
	}

	/** Move point [index] to [target] from [from] (the points at pointer-down,
	 *  so a frame that merged two points is not fossilised). Live, no undo.
	 *  Returns the point's new index, or null when refused. */
	moveLinePointLive(kind: LineKind, id: string, from: Anchor[], index: number, target: Anchor): number | null {
		const edit = moveLinePoint(from, index, target);
		if (!edit) return null;
		this.setLineNodesLive(kind, id, edit.nodes);
		return edit.index;
	}

	/** Add a point on link [segment]: one undo entry. Returns its index. */
	insertLinePoint(kind: LineKind, id: string, segment: number, node: Anchor): number | null {
		const line = this.lines(kind).get(id);
		if (this.readOnly || !line) return null;
		const edit = insertLinePoint(line.nodes, segment, node);
		if (!edit) return null;
		if (sameNodes(edit.nodes, line.nodes)) return edit.index;
		const before = line.copy();
		line.nodes = edit.nodes;
		this.linesChanged(kind);
		this.pushLine(kind, id, `Add ${kind === 'river' ? 'river' : 'route'} point`, before, line);
		return edit.index;
	}

	/** Delete point [index]; a line left with one point is deleted whole.
	 *  Returns false when the line is gone. */
	removeLinePoint(kind: LineKind, id: string, index: number): boolean {
		const line = this.lines(kind).get(id);
		if (this.readOnly || !line || index < 0 || index >= line.nodes.length) return !!line;
		if (line.nodes.length <= 2) {
			this.removeLine(kind, id);
			return false;
		}
		const before = line.copy();
		line.nodes = line.nodes.filter((_, i) => i !== index);
		this.linesChanged(kind);
		this.pushLine(kind, id, `Delete ${kind === 'river' ? 'river' : 'route'} point`, before, line);
		return true;
	}

	/** River width, clamped; consecutive changes merge into one undo entry. */
	setRiverWidth(id: string, width: number): void {
		const r = this.model.rivers.get(id);
		if (this.readOnly || !r) return;
		const w = Math.round(Math.min(RIVER_WIDTH_MAX, Math.max(RIVER_WIDTH_MIN, width)) * 100) / 100;
		if (w === r.width) return;
		const before = r.copy();
		r.width = w;
		this.linesChanged('river');
		this.pushLine('river', id, 'River width', before, r, `width:${id}`);
	}

	/** Route kind / colour / player visibility: one undo entry. */
	updateRoute(id: string, change: { kind?: string; color?: string; playerVisible?: boolean }): void {
		const r = this.model.routes.get(id);
		if (this.readOnly || !r) return;
		const before = r.copy();
		if (change.kind !== undefined) r.kind = change.kind;
		if (change.color !== undefined) r.color = change.color;
		if (change.playerVisible !== undefined) r.playerVisible = change.playerVisible;
		this.linesChanged('route');
		this.pushLine('route', id, 'Edit route', before, r, change.color !== undefined ? `color:${id}` : undefined);
	}

	// ----- regions (decision 7) -----------------------------------------------------

	/** The cells of the region stroke in progress, before it began. */
	private regionStroke: { id: string; before: [number, number][] } | null = null;

	private regionsChanged(): void {
		this.store.markLayer('regions');
		this.emit({ kind: 'regions' });
	}

	/** Region names stay unique: they are link targets in Flutter. */
	uniqueRegionName(desired: string, excludeId?: string): string {
		const taken = new Set([...this.model.regions.values()].filter((g) => g.name && g.id !== excludeId).map((g) => g.name));
		if (!taken.has(desired)) return desired;
		let n = 2;
		while (taken.has(`${desired} ${n}`)) n++;
		return `${desired} ${n}`;
	}

	/** Create a region (structural, not undoable — decision 9). */
	createRegion(name: string, color = '#B0603A'): Region | null {
		if (this.readOnly) return null;
		const g = new Region(this.model.nextId('region'));
		g.name = this.uniqueRegionName(name.trim() || 'Region');
		g.color = color;
		g.zOrder = Math.max(0, ...[...this.model.regions.values()].map((x) => x.zOrder + 1));
		this.model.regions.set(g.id, g);
		this.regionsChanged();
		return g;
	}

	/** Delete a region (structural, not undoable; the view asks first). The
	 *  undo entries that painted it would now be meaningless: dropped. */
	removeRegion(id: string): void {
		if (this.readOnly || !this.model.regions.delete(id)) return;
		this.regionsChanged();
		if (this.undo.dropTouching([`region:${id}`])) this.pushed();
	}

	renameRegion(id: string, name: string): string | null {
		const g = this.model.regions.get(id);
		if (this.readOnly || !g || !name.trim()) return null;
		g.name = this.uniqueRegionName(name.trim(), id);
		this.regionsChanged();
		return g.name;
	}

	setRegionColor(id: string, color: string): void {
		const g = this.model.regions.get(id);
		if (this.readOnly || !g || g.color === color) return;
		g.color = color;
		this.regionsChanged();
	}

	/** Add (or remove) cells to a region during a drag. */
	paintRegion(id: string, cells: Cell[], add: boolean): boolean {
		const g = this.model.regions.get(id);
		if (this.readOnly || !g) return false;
		if (!this.regionStroke || this.regionStroke.id !== id) {
			this.endRegionStroke();
			this.regionStroke = { id, before: g.cells.map(([q, r]) => [q, r]) };
		}
		const set = g.cellSet();
		let changed = false;
		for (const [q, r] of cells) {
			const k = `${q},${r}`;
			if (add && !set.has(k) && this.inGrid(q, r)) {
				set.add(k);
				changed = true;
			} else if (!add && set.has(k)) {
				set.delete(k);
				changed = true;
			}
		}
		if (!changed) return false;
		g.cells = sortCells([...set].map((k) => k.split(',').map(Number) as Cell));
		this.regionsChanged();
		return true;
	}

	/** Seal the region drag: one undo entry. */
	endRegionStroke(): void {
		const stroke = this.regionStroke;
		this.regionStroke = null;
		const g = stroke && this.model.regions.get(stroke.id);
		if (!stroke || !g) return;
		const before = stroke.before, after = g.cells.map(([q, r]) => [q, r] as Cell);
		if (sameCells(before, after)) return;
		this.pushRegionCells(stroke.id, before, after, 'Paint region');
	}

	/** Remove [cells] from a region: one undo entry. Returns how many. */
	removeRegionCells(id: string, cells: Cell[]): number {
		const g = this.model.regions.get(id);
		if (this.readOnly || !g) return 0;
		const drop = new Set(cells.map(([q, r]) => `${q},${r}`));
		const before = g.cells.map(([q, r]) => [q, r] as Cell);
		g.cells = g.cells.filter(([q, r]) => !drop.has(`${q},${r}`));
		const n = before.length - g.cells.length;
		if (!n) return 0;
		this.regionsChanged();
		this.pushRegionCells(id, before, g.cells, 'Remove hexes from region');
		return n;
	}

	regionsContaining(cells: Cell[]): Region[] {
		const keys = new Set(cells.map(([q, r]) => `${q},${r}`));
		return [...this.model.regions.values()].filter((g) => g.cells.some(([q, r]) => keys.has(`${q},${r}`)));
	}

	private pushRegionCells(id: string, before: Cell[], after: Cell[], label: string): void {
		const set = (cells: Cell[]) => {
			const g = this.model.regions.get(id);
			if (!g) return;
			g.cells = cells.map(([q, r]) => [q, r]);
			this.regionsChanged();
		};
		const b = before.map(([q, r]) => [q, r] as Cell), a = after.map(([q, r]) => [q, r] as Cell);
		this.undo.push({ label, touches: new Set([LAYER_FILES.regions, `region:${id}`]), run: () => set(a), undo: () => set(b) });
		this.pushed();
	}

	// ----- threads (decision 27) -------------------------------------------------------

	private threadsChanged(): void {
		this.store.markLayer('threads');
		this.emit({ kind: 'threads' });
	}

	private pushThread(id: string, label: string, before: Thread | null, after: Thread | null): void {
		const snap = (t: Thread | null) => (t ? t.copy() : null);
		const b = snap(before), a = snap(after);
		const restore = (t: Thread | null) => {
			if (t) this.model.threads.set(id, t.copy());
			else this.model.threads.delete(id);
			this.threadsChanged();
		};
		this.undo.push({ label, touches: new Set([LAYER_FILES.threads]), run: () => restore(a), undo: () => restore(b) });
		this.pushed();
	}

	private applySpec(t: Thread, spec: ThreadSpec): void {
		t.type = spec.type;
		t.label = spec.label.trim();
		t.direction = spec.direction;
		t.status = spec.status;
		t.color = spec.color;
	}

	createThread(fromHex: string, toHex: string, spec: ThreadSpec): Thread | null {
		if (this.readOnly || fromHex === toHex) return null;
		const t = new Thread(this.model.nextId('thread'), fromHex, toHex);
		this.applySpec(t, spec);
		this.model.threads.set(t.id, t);
		this.threadsChanged();
		this.pushThread(t.id, 'Draw thread', null, t);
		return t;
	}

	updateThread(id: string, spec: ThreadSpec): void {
		const t = this.model.threads.get(id);
		if (this.readOnly || !t) return;
		const before = t.copy();
		this.applySpec(t, spec);
		this.threadsChanged();
		this.pushThread(id, 'Edit thread', before, t);
	}

	removeThread(id: string): void {
		const t = this.model.threads.get(id);
		if (this.readOnly || !t) return;
		this.model.threads.delete(id);
		this.threadsChanged();
		this.pushThread(id, 'Delete thread', t, null);
	}

	// ----- a hex's notes (plan §1.3, item 2.5) -----------------------------------------

	/** The notes linked to a hex, principal first. */
	hexNotes(hexId: string): string[] {
		return [...(this.links.get(hexId) ?? [])];
	}

	/** Set a hex's note list (link, unlink, reorder): one undo entry. Notes
	 *  themselves are never touched. */
	setHexNotes(hexId: string, notes: string[], label: string): void {
		if (this.readOnly) return;
		const before = this.hexNotes(hexId);
		const after = notes.filter((n, i) => notes.indexOf(n) === i);
		if (before.length === after.length && before.every((n, i) => n === after[i])) return;
		const set = (list: string[]) => this.changeLinks(new Map([[hexId, list.length ? [...list] : null]]));
		set(after);
		this.undo.push({ label, touches: new Set(), run: () => set(after), undo: () => set(before) });
		this.pushed();
	}

	// ----- hexes: delete, cut / copy / paste (decision 29) ------------------------------

	/** Delete the hexes at [cells]: their records, the threads touching them,
	 *  and their note LINKS (never the notes). One undo entry. Player fog
	 *  stays with the cell. Returns how many hexes went. */
	deleteHexes(cells: Cell[]): number {
		if (this.readOnly) return 0;
		const snaps = cells.map(([q, r]) => this.model.getHex(q, r)).filter((h): h is Hex => !!h).map((h) => h.copy());
		const ids = new Set(snaps.map((h) => h.id));
		// A hex holding only notes is deleted by unlinking them.
		const linked = new Map<string, string[] | null>(
			cells.map(([q, r]) => hexIdFor(q, r)).filter((id) => this.links.get(id)?.length).map((id): [string, string[]] => [id, [...this.links.get(id)!]]),
		);
		if (!snaps.length && !linked.size) return 0;
		const threads = [...this.model.threads.values()].filter((t) => ids.has(t.fromHex) || ids.has(t.toHex)).map((t) => t.copy());
		const doDelete = () => {
			for (const h of snaps) this.model.hexes.delete(h.id);
			for (const t of threads) this.model.threads.delete(t.id);
			this.hexesChanged(snaps.map((h) => [h.q, h.r]));
			if (threads.length) this.threadsChanged();
			this.changeLinks(new Map([...linked.keys()].map((id) => [id, null])));
		};
		const undoDelete = () => {
			for (const h of snaps) this.model.hexes.set(h.id, h.copy());
			for (const t of threads) this.model.threads.set(t.id, t.copy());
			this.hexesChanged(snaps.map((h) => [h.q, h.r]));
			if (threads.length) this.threadsChanged();
			this.changeLinks(new Map(linked));
		};
		doDelete();
		const n = new Set([...ids, ...linked.keys()]).size;
		this.undo.push({
			label: `Delete ${n} hex${n === 1 ? '' : 'es'}`,
			touches: new Set([...snaps.map((h) => chunkPath(h.q, h.r)), LAYER_FILES.threads]),
			run: doDelete,
			undo: undoDelete,
		});
		this.pushed();
		return n;
	}

	private notesOf(ids: Iterable<string>): Map<string, string[]> {
		const out = new Map<string, string[]>();
		for (const id of ids) {
			const l = this.links.get(id);
			if (l?.length) out.set(id, [...l]);
		}
		return out;
	}

	/** The hexes at [cells] that carry something: each map record, and a
	 *  bare hex for a cell that holds only notes (a note list is one more
	 *  field, plan §1.3). Copies. */
	private carried(cells: Cell[]): { hexes: Hex[]; bare: Set<string> } {
		const hexes: Hex[] = [];
		const bare = new Set<string>();
		for (const [q, r] of cells) {
			const h = this.model.getHex(q, r);
			if (h) hexes.push(h.copy());
			else if (this.links.get(hexIdFor(q, r))?.length) {
				hexes.push(new Hex(q, r));
				bare.add(hexIdFor(q, r));
			}
		}
		return { hexes, bare };
	}

	/** Copy the hexes at [cells] (anchored at [anchor], the selection's top
	 *  left), notes-only hexes included. Changes nothing. Returns how many. */
	copyHexes(cells: Cell[], anchor: Cell): number {
		const { hexes, bare } = this.carried(cells);
		if (!hexes.length) return 0;
		this.clipboard = { clip: new HexClipboard(anchor, hexes), notes: this.notesOf(hexes.map((h) => h.id)), bare };
		return hexes.length;
	}

	/** Cut: the hexes go to the clipboard WITH their threads and notes, and
	 *  leave the map (fog stays with the cell). One undo entry; undoing it
	 *  empties the clipboard, or a paste would duplicate them. */
	cutHexes(cells: Cell[], anchor: Cell): number {
		if (this.readOnly) return 0;
		const { hexes, bare } = this.carried(cells);
		if (!hexes.length) return 0;
		const ids = new Set(hexes.map((h) => h.id));
		const records = hexes.filter((h) => !bare.has(h.id));
		const threads = [...this.model.threads.values()].filter((t) => ids.has(t.fromHex) || ids.has(t.toHex)).map((t) => t.copy());
		const notes = this.notesOf(ids);
		const entry: ClipboardEntry = { clip: new HexClipboard(anchor, hexes, true, threads), notes, bare };
		const doCut = () => {
			for (const h of hexes) this.model.hexes.delete(h.id);
			for (const t of threads) this.model.threads.delete(t.id);
			this.hexesChanged(hexes.map((h) => [h.q, h.r]));
			if (threads.length) this.threadsChanged();
			this.changeLinks(new Map([...notes.keys()].map((id) => [id, null])));
			this.clipboard = entry;
		};
		const undoCut = () => {
			for (const h of records) this.model.hexes.set(h.id, h.copy());
			for (const t of threads) this.model.threads.set(t.id, t.copy());
			this.hexesChanged(hexes.map((h) => [h.q, h.r]));
			if (threads.length) this.threadsChanged();
			this.changeLinks(new Map(notes));
			if (this.clipboard === entry) this.clipboard = null;
		};
		doCut();
		this.undo.push({
			label: `Cut ${hexes.length} hex${hexes.length === 1 ? '' : 'es'}`,
			touches: new Set([...hexes.map((h) => chunkPath(h.q, h.r)), LAYER_FILES.threads]),
			run: doCut,
			undo: undoCut,
		});
		this.pushed();
		return hexes.length;
	}

	/** Why a paste at (q, r) is refused, or null: all-or-nothing, so one
	 *  cell off the grid refuses it. */
	pastePrecheck(q: number, r: number): string | null {
		const c = this.clipboard?.clip;
		if (!c) return 'Nothing to paste';
		const outside = c.footprintAt(q, r).filter(([tq, tr]) => !this.inGrid(tq, tr)).length;
		if (!outside) return null;
		return c.length === 1 ? 'Paste refused: that hex is outside the map' : `Paste refused: ${outside} of ${c.length} hexes would land outside the map`;
	}

	/** Paste the clipboard with its top-left at (q, r). Content overrides the
	 *  target (names made unique, "Fort - 2"); the target keeps its fog. Notes:
	 *  the target keeps its own and the pasted ones are added after. A cut's
	 *  threads come back at the new ids. One undo entry. */
	pasteHexes(q: number, r: number): { hexes: number; threads: number; threadsDropped: number } | null {
		const entry = this.clipboard;
		if (this.readOnly || !entry || this.pastePrecheck(q, r)) return null;
		const clip = entry.clip;
		const idMap = clip.idMapAt(q, r);
		const targetIds = new Set(idMap.values());
		const before = new Map([...targetIds].map((id) => [id, this.model.hexes.get(id)?.copy() ?? null] as const));
		const linksBefore = new Map([...targetIds].map((id) => [id, this.links.get(id) ? [...this.links.get(id)!] : null] as const));
		const taken = new Set([...this.model.hexes.values()].filter((h) => !targetIds.has(h.id) && h.name).map((h) => h.name!));
		const built: Hex[] = [];
		const linksAfter = new Map<string, string[] | null>();
		for (const src of clip.hexes) {
			const [tq, tr] = clip.targetOf(src, q, r);
			if (!entry.bare.has(src.id)) {
				let name: string | null = null;
				if (src.name) {
					name = copyHexName(src.name, taken);
					taken.add(name);
				}
				const target = this.model.getHex(tq, tr);
				built.push(pastedHex(src, tq, tr, name, target));
			}
			const pasted = entry.notes.get(src.id) ?? [];
			const own = this.links.get(hexIdFor(tq, tr)) ?? [];
			const merged = [...own, ...pasted.filter((l) => !own.includes(l))];
			if (pasted.length) linksAfter.set(hexIdFor(tq, tr), merged);
		}
		const threads: Thread[] = [];
		let dropped = 0;
		if (clip.isCut) {
			const exists = (id: string) => targetIds.has(id) || this.model.hexes.has(id);
			const used = new Set(this.model.threads.keys());
			for (const t of clip.threads) {
				const from = idMap.get(t.fromHex) ?? t.fromHex, to = idMap.get(t.toHex) ?? t.toHex;
				if (from === to || !exists(from) || !exists(to)) {
					dropped++;
					continue;
				}
				let id = t.id;
				for (let n = 1; used.has(id); n++) id = `thread_${String(n).padStart(3, '0')}`;
				used.add(id);
				const copy = Thread.fromJson({ ...t.toJson(), id, from_hex: from, to_hex: to })!;
				copy.color = t.color;
				threads.push(copy);
			}
		}
		const cells = built.map((h): Cell => [h.q, h.r]);
		const count = clip.length;
		const doPaste = () => {
			for (const h of built) {
				if (h.hasPersistentContent) this.model.hexes.set(h.id, h.copy());
				else this.model.hexes.delete(h.id);
			}
			for (const t of threads) this.model.threads.set(t.id, t.copy());
			this.hexesChanged(cells);
			if (threads.length) this.threadsChanged();
			this.changeLinks(linksAfter);
			if (clip.isCut && this.clipboard === entry) this.clipboard = null;
		};
		const undoPaste = () => {
			for (const [id, h] of before) {
				if (h) this.model.hexes.set(id, h.copy());
				else this.model.hexes.delete(id);
			}
			for (const t of threads) this.model.threads.delete(t.id);
			this.hexesChanged(cells);
			if (threads.length) this.threadsChanged();
			this.changeLinks(new Map([...linksAfter.keys()].map((id) => [id, linksBefore.get(id) ?? null])));
			// The cut is not on the map: back on the clipboard, even over a later copy.
			if (clip.isCut) this.clipboard = entry;
		};
		doPaste();
		this.undo.push({
			label: `Paste ${count} hex${count === 1 ? '' : 'es'}`,
			touches: new Set([...cells.map(([cq, cr]) => chunkPath(cq, cr)), LAYER_FILES.threads]),
			run: doPaste,
			undo: undoPaste,
		});
		this.pushed();
		return { hexes: count, threads: threads.length, threadsDropped: dropped };
	}

	// ----- the whole map: move selection, explode, resize (decision 11) -------------------

	canMoveSelection(cells: Cell[], dq: number, dr: number): boolean {
		// A notes-only hex must land on the grid too; landing on another
		// notes-only hex merges the lists.
		const bareOff = cells.some(([q, r]) => !this.model.getHex(q, r) && this.links.get(hexIdFor(q, r))?.length && !this.inGrid(q + dq, r + dr));
		return !bareOff && canMoveCells(this.model, new Set(cells.map(([q, r]) => `${q},${r}`)), dq, dr);
	}

	/** Move [cells] by (dq, dr): one undoable remap. False when blocked. */
	moveSelection(cells: Cell[], dq: number, dr: number): boolean {
		if (this.readOnly || !cells.length || (dq === 0 && dr === 0) || !this.canMoveSelection(cells, dq, dr)) return false;
		const n = cells.filter(([q, r]) => this.model.getHex(q, r) || this.links.get(hexIdFor(q, r))?.length).length;
		this.pushRemap(n ? `Move ${n} hex${n === 1 ? '' : 'es'}` : 'Move selection', moveTransform(new Set(cells.map(([q, r]) => `${q},${r}`)), dq, dr));
		return true;
	}

	/** Why "Explode ×[factor]" is refused, or null. Never resizes on its own. */
	explodePrecheck(factor: number): string | null {
		if (!this.model.hexes.size) return 'Nothing to explode: the map is empty.';
		const t = explodeTransform(populatedCentroid(this.model), factor);
		const bare = this.bareCells();
		const outside = [...hexesOutsideAfter(this.model, t), ...bare.filter(([q, r]) => !this.inGrid(...t(q, r)))];
		if (!outside.length) return null;
		const [cols, rows] = requiredWindow([...[...this.model.hexes.values()].map((h): Cell => [h.q, h.r]), ...bare].map(([q, r]) => t(q, r)));
		return `${outside.length} hex${outside.length === 1 ? '' : 'es'} would land outside the current ${this.model.meta.gridCols} × ${this.model.meta.gridRows} grid. Enlarge the grid to at least ${cols} × ${rows} first.`;
	}

	/** Spread the map ×[factor] about its populated centre: one undoable remap. */
	explodeMap(factor: number): string | null {
		if (this.readOnly) return 'This map is read-only.';
		const err = this.explodePrecheck(factor);
		if (err) return err;
		this.pushRemap(`Explode map ×${factor}`, explodeTransform(populatedCentroid(this.model), factor));
		return null;
	}

	private pushRemap(label: string, t: CellTransform): void {
		let res: RemapResult;
		let linkMoves = new Map<string, string[] | null>();
		let linkBack = new Map<string, string[] | null>();
		const apply = () => {
			// Notes-only hexes have no record for the remap to move: their
			// cells go through the same transform here.
			const bare = this.bareCells();
			res = applyCellRemap(this.model, t);
			const moves = new Map(res.hexIds);
			for (const [q, r] of bare) {
				const to = hexIdFor(...t(q, r));
				if (to !== hexIdFor(q, r)) moves.set(hexIdFor(q, r), to);
			}
			// Notes follow their hexes; a hex landing on a notes-only hex that
			// stays put adds its notes after that hex's own.
			const after = new Map<string, string[]>();
			for (const from of moves.keys()) after.set(from, []);
			for (const [from, to] of moves) {
				if (!after.has(to)) after.set(to, [...(this.links.get(to) ?? [])]);
				const list = after.get(to)!;
				for (const n of this.links.get(from) ?? []) if (!list.includes(n)) list.push(n);
			}
			linkBack = new Map([...after.keys()].map((id) => [id, this.links.get(id) ? [...this.links.get(id)!] : null]));
			linkMoves = new Map([...after].map(([id, l]) => [id, l.length ? l : null]));
			moved = moves.size;
			this.remapped(res);
			this.changeLinks(linkMoves);
		};
		let moved = 0;
		apply();
		if (!res!.changedAnything && !moved) return;
		// Every file the remap wrote: its chunks (old and new cells) and layers.
		const touches = new Set<string>();
		for (const h of res!.hexesBefore) touches.add(chunkPath(h.q, h.r));
		for (const id of res!.hexIds.values()) {
			const h = this.model.hexes.get(id);
			if (h) touches.add(chunkPath(h.q, h.r));
		}
		if (res!.threadsBefore.length) touches.add(LAYER_FILES.threads);
		if (res!.riversBefore.length) touches.add(LAYER_FILES.rivers);
		if (res!.routesBefore.length) touches.add(LAYER_FILES.routes);
		if (res!.regionCellsBefore.size) touches.add(LAYER_FILES.regions);
		if (res!.revealedBefore) touches.add(LAYER_FILES.revealed);
		this.undo.push({
			label,
			touches,
			run: apply, // recomputes res; a later undo restores that state
			undo: () => {
				this.unremap(res);
				this.changeLinks(linkBack);
			},
		});
		this.pushed();
	}

	/** Mark everything a remap touched, and tell the view to rebuild. */
	private remapped(res: RemapResult): void {
		for (const h of res.hexesBefore) this.store.markHex(h.q, h.r);
		for (const id of res.hexIds.values()) {
			const h = this.model.hexes.get(id);
			if (h) this.store.markHex(h.q, h.r);
		}
		if (res.threadsBefore.length) this.store.markLayer('threads');
		if (res.riversBefore.length) this.store.markLayer('rivers');
		if (res.routesBefore.length) this.store.markLayer('routes');
		if (res.regionCellsBefore.size) this.store.markLayer('regions');
		if (res.revealedBefore) this.store.markLayer('revealed');
		this.emit({ kind: 'all' });
	}

	private unremap(res: RemapResult): void {
		for (const id of res.hexIds.values()) {
			const h = this.model.hexes.get(id);
			if (h) this.store.markHex(h.q, h.r);
			this.model.hexes.delete(id);
		}
		for (const h of res.hexesBefore) this.model.hexes.set(h.id, h.copy());
		for (const t of res.threadsBefore) this.model.threads.set(t.id, t.copy());
		for (const r of res.riversBefore) this.model.rivers.set(r.id, r.copy());
		for (const r of res.routesBefore) this.model.routes.set(r.id, r.copy());
		for (const [id, cells] of res.regionCellsBefore) {
			const g = this.model.regions.get(id);
			if (g) g.cells = cells.map(([q, r]) => [q, r]);
		}
		if (res.revealedBefore) {
			this.model.revealed.clear();
			for (const id of res.revealedBefore) this.model.revealed.add(id);
		}
		this.remapped(res);
	}

	/** The window a resize to (cols, rows) gives: it grows and shrinks about
	 *  the centre (Flutter's computeResizeBounds). */
	resizeBounds(cols: number, rows: number): GridWindow {
		const m = this.model.meta;
		const half = (n: number) => Math.trunc(n / 2);
		return {
			minQ: cols >= m.gridCols ? m.gridMinQ - half(cols - m.gridCols) : m.gridMinQ + half(m.gridCols - cols),
			cols,
			rows,
			rShift: rows >= m.gridRows ? m.gridRShift - half(rows - m.gridRows) : m.gridRShift + half(m.gridRows - rows),
		};
	}

	/** The hexes a resize to (cols, rows) would drop, notes-only ones
	 *  included (as bare hexes). */
	outsideAfterResize(cols: number, rows: number): Hex[] {
		const g = this.resizeBounds(cols, rows);
		return [...this.model.hexes.values(), ...this.bareCells().map(([q, r]) => new Hex(q, r))].filter((h) => !inWindow(h.q, h.r, g));
	}

	/** The cells of hexes that hold only notes. */
	private bareCells(): Cell[] {
		const out: Cell[] = [];
		for (const [id, l] of this.links) {
			const c = l.length && !this.model.hexes.has(id) ? cellOfId(id) : null;
			if (c) out.push(c);
		}
		return out;
	}

	/** Resize the grid. DESTRUCTIVE: hexes outside go, with their threads,
	 *  fog and note links; not undoable, and it clears the history (stale
	 *  cells must not come back through it) — the view asks first. */
	resizeGrid(cols: number, rows: number): number {
		if (this.readOnly || cols < 1 || rows < 1) return 0;
		const g = this.resizeBounds(cols, rows);
		const gone = this.outsideAfterResize(cols, rows);
		const ids = new Set(gone.map((h) => h.id));
		for (const h of gone) {
			if (!this.model.hexes.delete(h.id)) continue; // notes only
			this.store.markHex(h.q, h.r);
		}
		let threads = false;
		for (const t of [...this.model.threads.values()]) {
			if (ids.has(t.fromHex) || ids.has(t.toHex)) {
				this.model.threads.delete(t.id);
				threads = true;
			}
		}
		if (threads) this.store.markLayer('threads');
		let fog = false;
		for (const id of [...this.model.revealed]) {
			const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
			if (m && !inWindow(Number(m[1]), Number(m[2]), g)) {
				this.model.revealed.delete(id);
				fog = true;
			}
		}
		if (fog) this.store.markLayer('revealed');
		const meta = this.model.meta;
		meta.gridMinQ = g.minQ;
		meta.gridCols = g.cols;
		meta.gridRows = g.rows;
		meta.gridRShift = g.rShift;
		this.store.markLayer('meta');
		this.changeLinks(new Map([...ids].filter((id) => this.links.has(id)).map((id) => [id, null])));
		this.undo.clear();
		this.emit({ kind: 'all' });
		this.pushed();
		return gone.length;
	}

	// ----- history ----------------------------------------------------------------

	// ----- map metadata -----------------------------------------------------------------------

	/** What one hex measures (decision 18): one undo step. */
	setScale(scale: MapScale): void {
		if (this.readOnly) return;
		const before = this.model.meta.scale;
		if (before.hexDistance === scale.hexDistance && before.unit === scale.unit) return;
		const set = (s: MapScale) => {
			this.model.meta.scale = s;
			this.store.markLayer('meta');
			this.emit({ kind: 'all' });
		};
		set(scale);
		this.undo.push({ label: 'Map scale', touches: new Set([LAYER_FILES.meta]), run: () => set(scale), undo: () => set(before) });
		this.pushed();
	}

	/** Every cell of the grid revealed to players, or hidden (Flutter's
	 *  reveal all / hide all; fog is not undoable, decision 9). */
	setAllRevealed(reveal: boolean): number {
		if (this.readOnly) return 0;
		const g = this.model.meta.grid;
		const [x, y, w, h] = gridPixelBounds(g);
		const cells = [...cellsInRect(x, y, x + w, y + h, g)] as Cell[];
		return this.setRevealed(cells, reveal, reveal ? 'Reveal all hexes' : 'Hide all hexes').length;
	}

	// ----- import / hexify (decisions 12b, 19) ------------------------------------------------

	/** Execute an import plan: ONE undo entry for paint, tags, lines, the grid
	 *  window and (Hexify) the record of what it wrote. */
	applyImport(plan: ImportPlan, recordHexify = false): ImportOutcome {
		const outcome: ImportOutcome = { applied: 0, cleared: 0, skippedOutside: plan.skippedOutside, skippedOccupied: plan.skippedOccupied, resized: !!plan.window, riversAdded: 0, routesAdded: 0 };
		if (this.readOnly) return outcome;
		const m = this.model;
		const ids = new Set<string>([...plan.clears.map(([q, r]) => hexIdFor(q, r)), ...plan.writes.map((c) => hexIdFor(c.q, c.r))]);
		const before = new Map([...ids].map((id) => [id, m.hexes.get(id)?.copy() ?? null] as const));
		const gridBefore = { ...m.meta.grid };
		const recordBefore = m.hexified ? HexifyRecord.fromJson(m.hexified.toJson()) : null;
		for (const [q, r] of plan.clears) {
			const h = m.getHex(q, r);
			if (!h || (h.terrain === 'default' && !h.feature && !h.colorOverride && !h.hasUnknownFeature)) continue;
			h.terrain = 'default';
			h.terrainVariant = 0;
			h.feature = null;
			h.featureVariant = 0;
			h.colorOverride = null;
			outcome.cleared++;
		}
		const record = new HexifyRecord();
		for (const cell of plan.writes) {
			const h = m.getHex(cell.q, cell.r)?.copy() ?? new Hex(cell.q, cell.r);
			const pick = cell.pick;
			const keepsFeature = !pick.paintsFeature && !plan.clearFeatures;
			if (pick.terrain !== null) {
				h.terrain = pick.terrain;
				h.terrainVariant = pick.terrainVariant;
			}
			if (!keepsFeature) {
				h.feature = pick.feature;
				h.featureVariant = pick.feature ? pick.featureVariant : 0;
			}
			if (pick.paintsBiome || plan.clearFeatures) h.colorOverride = null;
			h.tags = [...new Set([...h.tags, ...(cell.tags ?? [])])];
			const old = m.hexes.get(h.id);
			if (old && encodeCompact(old.toJson()) === encodeCompact(h.toJson())) {
				if (pick.terrain !== null) record.cells.set(`${h.q},${h.r}`, [h.terrain, h.terrainVariant]);
				continue;
			}
			if (h.hasPersistentContent) m.hexes.set(h.id, h);
			outcome.applied++;
			if (pick.terrain !== null) record.cells.set(`${h.q},${h.r}`, [h.terrain, h.terrainVariant]);
		}
		// A re-hexify first removes the chains ITS previous run made.
		const removedRivers = plan.removeRivers.map((id) => m.rivers.get(id)).filter((r): r is River => !!r).map((r) => r.copy());
		const removedRoutes = plan.removeRoutes.map((id) => m.routes.get(id)).filter((r): r is Route => !!r).map((r) => r.copy());
		for (const r of removedRivers) m.rivers.delete(r.id);
		for (const r of removedRoutes) m.routes.delete(r.id);
		const createdRivers: River[] = [];
		for (const line of plan.rivers) {
			if (line.nodes.length < 2) continue;
			const r = new River(m.nextId('river'));
			r.nodes = line.nodes.map((n) => ({ ...n }));
			r.width = line.width;
			m.rivers.set(r.id, r);
			createdRivers.push(r.copy());
		}
		const createdRoutes: Route[] = [];
		for (const line of plan.routes) {
			if (line.nodes.length < 2) continue;
			const r = new Route(m.nextId('route'));
			r.nodes = line.nodes.map((n) => ({ ...n }));
			r.kind = line.kind;
			r.width = line.width;
			r.playerVisible = line.kind !== 'border';
			m.routes.set(r.id, r);
			createdRoutes.push(r.copy());
		}
		outcome.riversAdded = createdRivers.length;
		outcome.routesAdded = createdRoutes.length;
		if (plan.window) {
			Object.assign(m.meta, { gridMinQ: plan.window.minQ, gridCols: plan.window.cols, gridRows: plan.window.rows, gridRShift: plan.window.rShift });
		}
		if (recordHexify) {
			record.rivers = createdRivers.map((r) => r.id);
			record.routes = createdRoutes.map((r) => r.id);
			m.hexified = record;
		}
		const after = new Map([...ids].map((id) => [id, m.hexes.get(id)?.copy() ?? null] as const));
		const gridAfter = { ...m.meta.grid };
		const recordAfter = m.hexified ? HexifyRecord.fromJson(m.hexified.toJson()) : null;
		const cells = [...ids].map((id) => {
			const mm = /^q(-?\d+)_r(-?\d+)$/.exec(id)!;
			return [Number(mm[1]), Number(mm[2])] as Cell;
		});
		const restore = (hexes: Map<string, Hex | null>, removeRivers: River[], addRivers: River[], removeRoutes: Route[], addRoutes: Route[], grid: typeof gridBefore, rec: HexifyRecord | null) => {
			for (const [id, h] of hexes) {
				if (h) m.hexes.set(id, h.copy());
				else m.hexes.delete(id);
			}
			// Removals before creations (and undo the reverse): a replaced
			// river and its replacement can share an id.
			for (const r of removeRivers) m.rivers.delete(r.id);
			for (const r of removeRoutes) m.routes.delete(r.id);
			for (const r of addRivers) m.rivers.set(r.id, r.copy());
			for (const r of addRoutes) m.routes.set(r.id, r.copy());
			Object.assign(m.meta, { gridMinQ: grid.minQ, gridCols: grid.cols, gridRows: grid.rows, gridRShift: grid.rShift });
			if (recordHexify) m.hexified = rec ? HexifyRecord.fromJson(rec.toJson()) : null;
			this.importChanged(cells, recordHexify);
		};
		this.importChanged(cells, recordHexify);
		const touches = new Set<string>([...cells.map(([q, r]) => chunkPath(q, r)), LAYER_FILES.rivers, LAYER_FILES.routes, LAYER_FILES.meta, ...(recordHexify ? [LAYER_FILES.hexified] : [])]);
		this.undo.push({
			label: recordHexify ? 'Hexify' : 'Import',
			touches,
			run: () => restore(after, removedRivers, createdRivers, removedRoutes, createdRoutes, gridAfter, recordAfter),
			undo: () => restore(before, createdRivers, removedRivers, createdRoutes, removedRoutes, gridBefore, recordBefore),
		});
		this.pushed();
		return outcome;
	}

	private importChanged(cells: Cell[], record: boolean): void {
		for (const [q, r] of cells) this.store.markHex(q, r);
		this.store.markLayer('rivers');
		this.store.markLayer('routes');
		this.store.markLayer('meta');
		if (record) this.store.markLayer('hexified');
		this.emit({ kind: 'all' });
	}

	// ----- the sketch (decision 19), with its own history -----------------------------------

	/** The sketch document, made on first use. */
	get sketch(): SketchDocument {
		if (!this.model.sketch) this.model.sketch = new SketchDocument();
		return this.model.sketch;
	}

	private sketchChanged(): void {
		this.store.markLayer('sketch');
		this.emit({ kind: 'sketch' });
	}

	/** Put [items] at [positions] (or remove them): the primitive every
	 *  sketch command and its undo is made of. */
	private pushSketch(label: string, apply: () => void, revert: () => void): void {
		apply();
		this.sketchChanged();
		this.sketchUndo.push({
			label,
			touches: new Set([LAYER_FILES.sketch]),
			run: () => {
				apply();
				this.sketchChanged();
			},
			undo: () => {
				revert();
				this.sketchChanged();
			},
		});
		this.emit({ kind: 'history' });
	}

	/** Add an item on top. */
	addSketchItem(item: SketchItem): void {
		if (this.readOnly) return;
		const items = this.sketch.items;
		this.pushSketch(
			'Draw',
			() => items.push(item),
			() => {
				const i = items.indexOf(item);
				if (i >= 0) items.splice(i, 1);
			},
		);
	}

	/** A bucket fill goes BELOW every non-fill and above older fills: the
	 *  outlines stay visible, and the newer fill wins for Hexify. */
	addSketchFill(fill: SketchFill): void {
		if (this.readOnly) return;
		const items = this.sketch.items;
		this.pushSketch(
			'Fill',
			() => {
				let at = 0;
				while (at < items.length && items[at] instanceof SketchFill) at++;
				items.splice(at, 0, fill);
			},
			() => {
				const i = items.indexOf(fill);
				if (i >= 0) items.splice(i, 1);
			},
		);
	}

	removeSketchItem(id: string): SketchItem | null {
		if (this.readOnly) return null;
		const items = this.sketch.items;
		const item = items.find((it) => it.id === id);
		if (!item) return null;
		let at = items.indexOf(item);
		this.pushSketch(
			'Erase',
			() => {
				at = items.indexOf(item);
				if (at >= 0) items.splice(at, 1);
			},
			() => items.splice(Math.min(at, items.length), 0, item),
		);
		return item;
	}

	/** Replace an item in place (a label's text): [next] takes its slot. */
	replaceSketchItem(id: string, next: SketchItem, label = 'Edit label'): void {
		if (this.readOnly) return;
		const items = this.sketch.items;
		const old = items.find((it) => it.id === id);
		if (!old) return;
		const swap = (from: SketchItem, to: SketchItem) => {
			const i = items.indexOf(from);
			if (i >= 0) items[i] = to;
		};
		this.pushSketch(label, () => swap(old, next), () => swap(next, old));
	}

	/** Replace the swatch palette (the swatch editor): one sketch undo step.
	 *  [swatches] are new objects; the old ones come back on undo. */
	setSketchSwatches(swatches: Swatch[], label = 'Edit colours'): void {
		if (this.readOnly) return;
		const list = this.sketch.swatches;
		const before = [...list];
		this.pushSketch(
			label,
			() => list.splice(0, list.length, ...swatches),
			() => list.splice(0, list.length, ...before),
		);
	}

	clearSketch(): void {
		if (this.readOnly || !this.sketch.items.length) return;
		const items = this.sketch.items;
		const all = [...items];
		this.pushSketch(
			'Clear sketch',
			() => items.splice(0, items.length),
			() => items.splice(0, items.length, ...all),
		);
	}

	sketchUndoLast(): string | null {
		const label = this.sketchUndo.undo();
		if (label) this.emit({ kind: 'history' });
		return label;
	}

	sketchRedoLast(): string | null {
		const label = this.sketchUndo.redo();
		if (label) this.emit({ kind: 'history' });
		return label;
	}

	undoLast(): string | null {
		const label = this.undo.undo();
		if (label) this.pushed();
		return label;
	}

	redoLast(): string | null {
		const label = this.undo.redo();
		if (label) this.pushed();
		return label;
	}

	/** Files changed on disk under us: drop the undo entries touching them. */
	reloaded(paths: string[]): number {
		const n = this.undo.dropTouching(paths);
		if (n) this.pushed();
		return n;
	}
}

const sameNodes = (a: Anchor[], b: Anchor[]) =>
	a.length === b.length && a.every((n, i) => n.kind === b[i]!.kind && n.q === b[i]!.q && n.r === b[i]!.r && n.k === b[i]!.k);
const sortCells = (cells: Cell[]) => cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const sameCells = (a: Cell[], b: Cell[]) => a.length === b.length && a.every((c, i) => c[0] === b[i]![0] && c[1] === b[i]![1]);

/** A hex as it would be saved (null: no record), for change detection. */
const encode = (h: Hex | null) => (h ? encodeCompact(h.toJson()) : null);

