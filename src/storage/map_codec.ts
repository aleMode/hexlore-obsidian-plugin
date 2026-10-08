// The format-2 map files ↔ the map model (docs/format-2.md), with no I/O.
//
// One FILE per layer, plus the paint layer cut into 16×16 chunks. Each file
// is decoded on its own, so an external change reloads only what changed
// (plan 2.2) and a file that fails to parse is reported and LEFT ALONE —
// never overwritten by a save (a file the app cannot load is never written,
// and one it could not read is never replaced).

import { CampaignMeta, FORMAT_VERSION } from '../core/campaign_meta';
import { Hex } from '../core/hex';
import { compareCells, compareIds, encodeJsonLines, isObject, parseJson, type Json, type JsonObject } from '../core/json';
import type { MapModel } from '../core/map';
import { chunkOf } from '../core/paint_chunks';
import { Region } from '../core/region';
import { River } from '../core/river';
import { Route } from '../core/route';
import { HexifyRecord, SketchDocument } from '../core/sketch';
import { Thread } from '../core/thread';

/** The layers, by their file under the data folder. */
export const LAYER_FILES = {
	meta: 'campaign.json',
	rivers: 'rivers/rivers.json',
	routes: 'routes/routes.json',
	regions: 'regions/regions.json',
	threads: 'threads/threads.json',
	revealed: 'player/revealed.json',
	sketch: 'sketch/sketch.json',
	hexified: 'sketch/hexified.json',
} as const;
export type LayerName = keyof typeof LAYER_FILES;
export const LAYERS = Object.keys(LAYER_FILES) as LayerName[];

export const PAINT_DIR = 'paint';
const CHUNK_FILE = /^c_(-?\d+)_(-?\d+)\.json$/;

/** A layer, or one paint chunk ("c_<cx>_<cy>.json"). */
export type FileKey = { layer: LayerName } | { chunk: string };

/** The file a data-folder-relative path is, or null for one we don't own
 *  (an underlay, a trace image, a file of a newer app): those are never
 *  touched. */
export function fileKeyOf(rel: string): FileKey | null {
	for (const layer of LAYERS) if (LAYER_FILES[layer] === rel) return { layer };
	if (rel.startsWith(`${PAINT_DIR}/`)) {
		const name = rel.slice(PAINT_DIR.length + 1);
		if (CHUNK_FILE.test(name)) return { chunk: name };
	}
	return null;
}

export const pathOf = (k: FileKey) => ('layer' in k ? LAYER_FILES[k.layer] : `${PAINT_DIR}/${k.chunk}`);
export const chunkNameOf = (q: number, r: number) => chunkOf(q, r)[2];

export class DecodeError extends Error {}

function parse(text: string, path: string): Json {
	try {
		return parseJson(text);
	} catch (e) {
		throw new DecodeError(`${path}: not valid JSON (${(e as Error).message})`);
	}
}

const objects = (v: Json, path: string): JsonObject[] => {
	if (!Array.isArray(v)) throw new DecodeError(`${path}: expected a list`);
	return v.filter(isObject);
};

function byId<T>(list: (T | null)[], id: (t: T) => string): Map<string, T> {
	const out = new Map<string, T>();
	for (const t of list) if (t) out.set(id(t), t);
	return out;
}

// ----- decoding --------------------------------------------------------------

export function decodeMeta(text: string, fallbackName: string): CampaignMeta {
	const v = parse(text, LAYER_FILES.meta);
	if (!isObject(v)) throw new DecodeError(`${LAYER_FILES.meta}: expected an object`);
	return CampaignMeta.fromJson(v, fallbackName);
}

/** The hexes of one chunk. A record in the wrong chunk is still read (the
 *  next save writes it where it belongs). */
export function decodeChunk(text: string, name: string): Hex[] {
	if (!text.trim()) return [];
	return objects(parse(text, `${PAINT_DIR}/${name}`), `${PAINT_DIR}/${name}`)
		.map((o) => Hex.fromJson(o))
		.filter((h): h is Hex => h !== null);
}

export const decodeRivers = (text: string) => byId(objects(parse(text, LAYER_FILES.rivers), LAYER_FILES.rivers).map((o) => River.fromJson(o)), (r) => r.id);
export const decodeRoutes = (text: string) => byId(objects(parse(text, LAYER_FILES.routes), LAYER_FILES.routes).map((o) => Route.fromJson(o)), (r) => r.id);
export const decodeRegions = (text: string) => byId(objects(parse(text, LAYER_FILES.regions), LAYER_FILES.regions).map((o) => Region.fromJson(o)), (r) => r.id);
export const decodeThreads = (text: string) => byId(objects(parse(text, LAYER_FILES.threads), LAYER_FILES.threads).map((o) => Thread.fromJson(o)), (t) => t.id);

export function decodeRevealed(text: string): Set<string> {
	const v = parse(text, LAYER_FILES.revealed);
	if (!isObject(v)) throw new DecodeError(`${LAYER_FILES.revealed}: expected an object`);
	return new Set((Array.isArray(v.revealed) ? v.revealed : []).filter((x): x is string => typeof x === 'string'));
}

export function decodeSketch(text: string): SketchDocument {
	const v = parse(text, LAYER_FILES.sketch);
	if (!isObject(v)) throw new DecodeError(`${LAYER_FILES.sketch}: expected an object`);
	return SketchDocument.fromJson(v);
}

export function decodeHexified(text: string): HexifyRecord {
	const v = parse(text, LAYER_FILES.hexified);
	if (!isObject(v)) throw new DecodeError(`${LAYER_FILES.hexified}: expected an object`);
	return HexifyRecord.fromJson(v);
}

/** Load one file's content into the model, replacing what that file held. */
export function applyFile(m: MapModel, key: FileKey, text: string | null, fallbackName: string): void {
	if ('chunk' in key) {
		// Drop the hexes this chunk held, then add what it holds now.
		for (const [id, h] of m.hexes) if (chunkNameOf(h.q, h.r) === key.chunk) m.hexes.delete(id);
		for (const h of text === null ? [] : decodeChunk(text, key.chunk)) m.hexes.set(h.id, h);
		return;
	}
	const replace = <T>(target: Map<string, T>, next: Map<string, T>) => {
		target.clear();
		for (const [k, v] of next) target.set(k, v);
	};
	switch (key.layer) {
		case 'meta':
			if (text === null) throw new DecodeError(`${LAYER_FILES.meta} is missing`);
			m.meta = decodeMeta(text, fallbackName);
			return;
		case 'rivers':
			return replace(m.rivers, text === null ? new Map<string, River>() : decodeRivers(text));
		case 'routes':
			return replace(m.routes, text === null ? new Map<string, Route>() : decodeRoutes(text));
		case 'regions':
			return replace(m.regions, text === null ? new Map<string, Region>() : decodeRegions(text));
		case 'threads':
			return replace(m.threads, text === null ? new Map<string, Thread>() : decodeThreads(text));
		case 'revealed': {
			m.revealed.clear();
			for (const id of text === null ? [] : decodeRevealed(text)) m.revealed.add(id);
			return;
		}
		case 'sketch':
			m.sketch = text === null ? null : decodeSketch(text);
			return;
		case 'hexified':
			m.hexified = text === null ? null : decodeHexified(text);
			return;
	}
}

// ----- encoding --------------------------------------------------------------

const sortedById = <T>(m: Map<string, T>) => [...m.keys()].sort(compareIds).map((k) => m.get(k)!);

/** A layer's file text; null when the file should not exist. */
export function encodeLayer(m: MapModel, layer: LayerName): string | null {
	switch (layer) {
		case 'meta':
			return encodeJsonLines(m.meta.toJson());
		case 'rivers':
			return encodeJsonLines(sortedById(m.rivers).map((r) => r.toJson()));
		case 'routes':
			return encodeJsonLines(sortedById(m.routes).map((r) => r.toJson()));
		case 'regions':
			return encodeJsonLines(sortedById(m.regions).map((r) => r.toJson()));
		case 'threads':
			return encodeJsonLines(sortedById(m.threads).map((t) => t.toJson()));
		case 'revealed':
			return encodeJsonLines({ revealed: [...m.revealed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) });
		case 'sketch':
			return m.sketch ? encodeJsonLines(m.sketch.toJson()) : null;
		case 'hexified':
			return m.hexified ? encodeJsonLines(m.hexified.toJson()) : null;
	}
}

/** A chunk's text from the live hexes; null when it holds nothing worth a
 *  record (an empty chunk is deleted, not written — decision 2b). */
export function encodeChunk(m: MapModel, name: string): string | null {
	const records = [...m.hexes.values()]
		.filter((h) => chunkNameOf(h.q, h.r) === name && h.hasPersistentContent)
		.sort((a, b) => compareCells([a.q, a.r], [b.q, b.r]))
		.map((h) => h.toJson());
	return records.length ? encodeJsonLines(records) : null;
}

/** The chunk files the live hexes need. */
export function liveChunks(m: MapModel): Set<string> {
	const out = new Set<string>();
	for (const h of m.hexes.values()) if (h.hasPersistentContent) out.add(chunkNameOf(h.q, h.r));
	return out;
}

/** Every file of a whole-map save (Flutter's saveCampaign): path → text. */
export function encodeAll(m: MapModel): Map<string, string> {
	const out = new Map<string, string>();
	for (const layer of LAYERS) {
		const text = encodeLayer(m, layer);
		if (text !== null) out.set(LAYER_FILES[layer], text);
	}
	for (const name of liveChunks(m)) out.set(`${PAINT_DIR}/${name}`, encodeChunk(m, name)!);
	return out;
}

export { FORMAT_VERSION };
