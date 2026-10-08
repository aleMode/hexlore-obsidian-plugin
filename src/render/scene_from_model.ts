// The renderer's view of the map model: plain records, so the renderer never
// depends on storage, and the model never on the renderer.

import type { MapModel } from '../core/map';
import type { Hex } from '../core/hex';
import type { Anchor as ModelAnchor } from '../core/river';
import type { Region } from '../core/region';
import type { Thread } from '../core/thread';
import type { Anchor, MapData, SceneHex, SceneRegion, SceneRiver, SceneRoute, SceneThread } from './scene';

const anchor = (n: ModelAnchor): Anchor => [n.kind, n.q, n.r, n.k];

export const sceneRegionOf = (g: Region): SceneRegion => ({ id: g.id, name: g.name, color: g.color, zOrder: g.zOrder, cells: g.cells.map(([q, r]) => [q, r]) });

export const sceneThreadOf = (t: Thread): SceneThread => ({
	id: t.id,
	from: t.fromHex,
	to: t.toHex,
	label: t.label,
	color: t.effectiveColor(),
	colorKey: t.colorKey,
	status: t.status,
	direction: t.direction,
});

export const sceneRiversOf = (m: MapModel): SceneRiver[] => [...m.rivers.values()].map((r) => ({ id: r.id, width: r.width, anchors: r.nodes.map(anchor) }));

export const sceneRoutesOf = (m: MapModel): SceneRoute[] =>
	[...m.routes.values()].map((r) => ({ id: r.id, kind: r.kind, color: r.color, width: r.width, playerVisible: r.playerVisible, anchors: r.nodes.map(anchor) }));

/** [linked]: hex ids with notes in the index — content, as a page is. */
export function sceneHexOf(h: Hex, linked: ReadonlySet<string> = new Set()): SceneHex {
	return {
		q: h.q,
		r: h.r,
		name: h.name,
		terrain: h.terrain,
		terrainVariant: h.terrainVariant,
		feature: h.feature,
		featureVariant: h.featureVariant,
		featureHidden: h.featureHidden,
		colorOverride: h.colorOverride,
		hasContent: h.computeState() === 'populated' || h.hasUnknownFeature || linked.has(h.id),
	};
}

export function sceneDataFromModel(m: MapModel, linked: ReadonlySet<string> = new Set()): MapData {
	return {
		name: m.meta.name,
		format: m.meta.format,
		grid: m.meta.grid,
		hexes: [...m.hexes.values()].map((h) => sceneHexOf(h, linked)),
		rivers: sceneRiversOf(m),
		routes: sceneRoutesOf(m),
		revealed: [...m.revealed],
		regions: [...m.regions.values()].map(sceneRegionOf),
		threads: [...m.threads.values()].map(sceneThreadOf),
	};
}
