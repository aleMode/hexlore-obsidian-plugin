// Runs every case in vendor/conformance/ (generated from the Flutter app's
// Dart core) against the TypeScript core. The comparison rules are the ones
// in vendor/conformance/README.md.
//
// To port a function: implement it under src/core/, then add it to `ported`.
// A function with no entry is reported as a todo, so the suite stays green
// while the port is in progress and the todo list IS the remaining work.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Feature, Terrain } from '../src/core/hex_data';
import {
	axialToPixel,
	cellsInRect,
	fitGridWindow,
	nodePixel,
	pixelToAxial,
	unstaggeredRow,
	vertexPixel,
	type Cell,
} from '../src/core/geometry';
import { anchorNeighbors, nearestAnchor } from '../src/core/anchors';
import { copyHexName, fitPaste } from '../src/core/hex_clipboard';
import { visibleFrom } from '../src/core/line_of_sight';
import { explodeTransform } from '../src/core/remap';
import { filterCampaignForPlayer } from '../src/core/player_filter';
import { snapScenePolyline } from '../src/core/river_snap';
import { SketchDocument } from '../src/core/sketch';
import { bucketFill } from '../src/sketch/bucket_fill';
import { hexifySketch } from '../src/sketch/hexify';
import type { JsonObject } from '../src/core/json';
import { encodeAll } from '../src/storage/map_codec';
import { fixtureMap } from './helpers/fixture_map';
import { MapModel } from '../src/core/map';
import { Hex } from '../src/core/hex';
import { River, anchor } from '../src/core/river';
import { Route, centreNode } from '../src/core/route';
import { Thread } from '../src/core/thread';
import { parseJson, toPlain } from '../src/core/json';
import { HEX_RADIUS } from '../src/core/geometry';
import { SPEC } from '../src/render/vendor';
import { hash2 } from '../src/core/map_palette';
import { boundaryEdges } from '../src/core/region';
import { parseEncounters } from '../src/core/region_encounters';
import { canonicalVertex, type Anchor } from '../src/core/river';
import { canonicalEdge } from '../src/core/route';
import { layoutThreads, type ThreadStyle } from '../src/core/thread_geometry';
import { parseHexId } from '../src/core/hex';
import { chunkOf } from '../src/core/paint_chunks';
import { featureVariantIds, terrainVariantIds } from '../src/core/variant_ids';

type Case = { fn: string; in: unknown; out: unknown };

const ported: Record<string, (input: never) => unknown> = {
	hash2: ([q, r, salt]: [number, number, number]) => hash2(q, r, salt),
	terrainVariantIds: (t: Terrain) => terrainVariantIds(t),
	featureVariantIds: (f: Feature) => featureVariantIds(f),
	axialToPixel: ([q, r]: [number, number]) => axialToPixel(q, r),
	vertexPixel: ([q, r, c]: [number, number, number]) => vertexPixel(q, r, c),
	nodePixel: ([kind, q, r, k]: [string, number, number, number]) => nodePixel(kind, q, r, k),
	pixelToAxial: ([x, y]: [number, number]) => pixelToAxial(x, y),
	unstaggeredRow: ([q, r]: [number, number]) => unstaggeredRow(q, r),
	fitGridWindow: (cells: Cell[]) => fitGridWindow(cells),
	cellsInRect: ([l, t, r, b, minQ, cols, rows, rShift]: number[]) => [
		...cellsInRect(l!, t!, r!, b!, { minQ: minQ!, cols: cols!, rows: rows!, rShift: rShift! }),
	],
	chunkOf: ([q, r]: [number, number]) => chunkOf(q, r),
	canonicalVertex: ([q, r, c]: [number, number, number]) => canonicalVertex(q, r, c),
	canonicalEdge: ([q, r, k]: [number, number, number]) => canonicalEdge(q, r, k),
	anchorNeighbors: ([kind, q, r, k]: [string, number, number, number]) =>
		anchorNeighbors({ kind, q, r, k }).map((a: Anchor) => [a.kind, a.q, a.r, a.k]),
	nearestAnchor: ([x, y]: [number, number]) => {
		const a = nearestAnchor(x, y);
		return [a.kind, a.q, a.r, a.k];
	},
	boundaryEdges: (cells: [number, number][]) => boundaryEdges(cells),
	'sampleSmoothCourse+splitCourseAtWater': ({ course, step }: { course: [number, number][]; step: number }) => {
		const samples = SPEC.sampleSmoothCourse(course, step);
		const split = SPEC.splitCourseAtWater(samples, (x, y) => pixelToAxial(x, y)[0] >= 3, HEX_RADIUS)!;
		return {
			samples: samples.length,
			runs: split.runs.map((r) => {
				const run = r as unknown as { points: [number, number][]; shoreAtStart: boolean; shoreAtEnd: boolean };
				return { points: run.points.length, first: run.points[0], last: run.points[run.points.length - 1], shoreAtStart: run.shoreAtStart, shoreAtEnd: run.shoreAtEnd };
			}),
			mouths: split.mouths.map((m) => ({ shore: m.spine[m.spine.length - 1], into: m.into })),
		};
	},
	// The campaign test/conformance_test.dart builds for this fixture.
	filterCampaignForPlayer: ({ revealed }: { revealed: string[] }) => {
		const m = new MapModel();
		m.meta.name = 'Fixture';
		m.meta.gridCols = 6;
		m.meta.gridRows = 6;
		const a = m.getOrCreateHex(0, 0);
		a.name = 'Shown';
		a.terrain = 'forest';
		a.terrainVariant = 1;
		a.feature = 'city';
		const b = m.getOrCreateHex(1, 0);
		b.name = "Dragon's Lair";
		b.terrain = 'mountain';
		b.feature = 'dungeon';
		b.featureHidden = true;
		const c = m.getOrCreateHex(2, 0);
		c.name = 'Unrevealed';
		c.terrain = 'plains';
		m.getOrCreateHex(40, 0).name = 'Outside the window';
		const unknown = Hex.fromJson(parseJson('{"q":0,"r":1,"name":"Strange","terrain":"hills","feature":"obelisk","zz_future":true}') as never)!;
		m.hexes.set(unknown.id, unknown);
		const road = new Route('route_001');
		road.nodes = [centreNode(0, 0), centreNode(1, 0)];
		m.routes.set(road.id, road);
		const border = new Route('route_002');
		border.kind = 'border';
		border.playerVisible = false;
		border.nodes = [centreNode(0, 0), centreNode(0, 1)];
		m.routes.set(border.id, border);
		const river = new River('river_001');
		river.nodes = [anchor('v', 0, 0, 0), anchor('v', 0, 0, 1)];
		m.rivers.set(river.id, river);
		m.threads.set('thread_001', new Thread('thread_001', 'q0_r0', 'q1_r0'));
		for (const id of revealed) m.revealed.add(id);
		return toPlain(filterCampaignForPlayer(m));
	},
	snapScenePolyline: (line: [number, number][]) => snapScenePolyline(line).map((a) => [a.kind, a.q, a.r, a.k]),
	bucketFill: ({ doc, at, params }: { doc: unknown; at: [number, number]; params: number[] }) => {
		const [left, top, right, bottom, step, gapPx, simplifyPx] = params as [number, number, number, number, number, number, number];
		const res = bucketFill(SketchDocument.fromJson(parseJson(JSON.stringify(doc)) as JsonObject), at[0], at[1], { left, top, right, bottom, step, gapPx, simplifyPx });
		return { failure: res.failure, polygon: res.polygon ?? [] };
	},
	hexifySketch: (doc: unknown) => {
		const res = hexifySketch(SketchDocument.fromJson(parseJson(JSON.stringify(doc)) as JsonObject));
		return {
			cells: [...res.cells].sort((a, b) => a.q - b.q || a.r - b.r).map((c) => [c.q, c.r, c.pick.terrain, c.pick.terrainVariant]),
			rivers: res.rivers.map((r) => ({ nodes: r.nodes.map((n) => [n.kind, n.q, n.r, n.k]), width: r.width })),
		};
	},
	jitterFill: ([hex, q, r]: [string, number, number]) => SPEC.jitterFill(hex, q, r),
	// The campaign test/conformance_test.dart saves; the fixture lists 7 of its files.
	'FileManager.saveCampaign': () => {
		const files = encodeAll(fixtureMap());
		const wanted = ['campaign.json', 'paint/c_0_0.json', 'paint/c_1_0.json', 'paint/c_-1_0.json', 'rivers/rivers.json', 'routes/routes.json', 'player/revealed.json'];
		return Object.fromEntries(wanted.map((p) => [p, files.get(p)]));
	},
	copyHexName: ([name, taken]: [string, string[]]) => copyHexName(name, new Set(taken)),
	fitPaste: ({ anchor, hexes, selection }: { anchor: [number, number]; hexes: [number, number][]; selection: [number, number][] }) => {
		const clip = { footprintAt: (q: number, r: number) => hexes.map(([hq, hr]): [number, number] => [q + hq - anchor[0], r + hr - anchor[1]]) };
		const fit = fitPaste(clip, selection);
		return { at: fit.at, footprint: sortCells(fit.footprint) };
	},
	explodeTransform: ({ anchor, k, cell }: { anchor: [number, number]; k: number; cell: [number, number] }) =>
		explodeTransform(anchor, k)(cell[0], cell[1]),
	visibleFrom: ({ origin, heights, minRadius }: { origin: [number, number]; heights: Record<string, number>; minRadius: number }) =>
		sortCells(visibleFrom(origin[0], origin[1], (q, r) => heights[`${q}_${r}`] ?? 0, minRadius)),
	parseEncounters: (body: string) => parseEncounters(body).map((e) => [e.weight, e.text]),
	layoutThreads: ({ style, links }: { style: ThreadStyle; links: { id: string; from: string; to: string }[] }) => {
		const centre = (id: string): [number, number] => {
			const [q, r] = parseHexId(id)!;
			return axialToPixel(q, r);
		};
		const shapes = layoutThreads(links.map((l) => ({ ...l, a: centre(l.from), b: centre(l.to) })), style);
		return Object.fromEntries([...shapes].map(([id, s]) => [id, { p0: s.p0, p1: s.p1, p2: s.p2, t0: s.t0, t1: s.t1 }]));
	},
};

const dir = new URL('../vendor/conformance/', import.meta.url);

/** Set-valued results are listed sorted (fixtures README). */
const sortCells = (cells: [number, number][]) => [...cells].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

/** Exact for everything but non-integer numbers: 1e-9 relative, absolute near 0. */
function conforms(actual: unknown, expected: unknown, path = '$'): string | null {
	if (typeof expected === 'number' && typeof actual === 'number') {
		if (Number.isInteger(expected) && Number.isInteger(actual)) {
			return actual === expected ? null : `${path}: ${actual} != ${expected}`;
		}
		const tol = 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected));
		return Math.abs(actual - expected) <= tol ? null : `${path}: ${actual} != ${expected}`;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return `${path}: expected an array`;
		if (actual.length !== expected.length) {
			return `${path}: length ${actual.length} != ${expected.length}`;
		}
		for (let i = 0; i < expected.length; i++) {
			const d = conforms(actual[i], expected[i], `${path}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	if (expected !== null && typeof expected === 'object') {
		if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
			return `${path}: expected an object`;
		}
		const a = actual as Record<string, unknown>;
		const e = expected as Record<string, unknown>;
		const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
		for (const k of [...keys].sort()) {
			if (!(k in a)) return `${path}.${k}: missing`;
			if (!(k in e)) return `${path}.${k}: unexpected`;
			const d = conforms(a[k], e[k], `${path}.${k}`);
			if (d) return d;
		}
		return null;
	}
	return actual === expected ? null : `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

it('finds the vendored fixtures (run `npm run vendor`)', () => {
	expect(files.length).toBeGreaterThan(0);
});

for (const file of files) {
	const { about, cases } = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as {
		about: string;
		cases: Case[];
	};
	describe(`${file}: ${about}`, () => {
		const byFn = new Map<string, Case[]>();
		for (const c of cases) byFn.set(c.fn, [...(byFn.get(c.fn) ?? []), c]);
		for (const [fn, list] of byFn) {
			const impl = ported[fn];
			if (!impl) {
				it.todo(`${fn} (${list.length} cases)`);
				continue;
			}
			list.forEach((c, i) => {
				it(`${fn} #${i} ${JSON.stringify(c.in).slice(0, 60)}`, () => {
					const diff = conforms(impl(c.in as never), c.out);
					expect(diff, diff ?? '').toBeNull();
				});
			});
		}
	});
}
