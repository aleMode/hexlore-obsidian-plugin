// The PLAYERS' map as render data, rebuilt from the player filter's payload
// (Flutter's lib/convert/players_map.dart, decision 32, item 2.10). The
// image exporter's Players version is drawn from THIS, never from the GM
// model: what the filter did not serve cannot be drawn. No region, thread,
// border, note or badge exists here to leak.

import { isFeature, isTerrain, terrainColors } from '../core/hex_data';
import type { JsonObject } from '../core/json';
import type { Anchor, MapData, SceneHex } from './scene';

// The payload goes through toPlain first: numbers are numbers.
const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** [payload] (the `/api/map` body, as filterCampaignForPlayer builds it,
 *  through toPlain). */
export function playersSceneData(payload: JsonObject, format: number): MapData {
	const grid = payload.grid as JsonObject;
	const hexes: SceneHex[] = [];
	for (const raw of payload.hexes as JsonObject[]) {
		const terrain = isTerrain(raw.terrain) ? raw.terrain : 'default';
		const color = typeof raw.color === 'string' ? raw.color : null;
		hexes.push({
			q: num(raw.q),
			r: num(raw.r),
			name: typeof raw.name === 'string' ? raw.name : null,
			terrain,
			terrainVariant: num(raw.terrain_variant),
			feature: isFeature(raw.feature) ? raw.feature : null,
			featureVariant: num(raw.feature_variant),
			featureHidden: false,
			// The payload serves the EFFECTIVE fill; only a fill that differs
			// from the biome's is an override.
			colorOverride: color && color !== terrainColors[terrain] ? color : null,
			hasContent: true,
		});
	}
	const runs = (list: unknown, f: (o: JsonObject, i: number, anchors: Anchor[]) => void) => {
		for (const o of list as JsonObject[]) (o.segments as Anchor[][]).forEach((seg, i) => f(o, i, seg.map((a) => [a[0], a[1], a[2], a[3]] as Anchor)));
	};
	const rivers: MapData['rivers'] = [];
	runs(payload.rivers, (o, i, anchors) => rivers.push({ id: `${text(o.id)}#${i}`, width: num(o.width, 1), anchors }));
	const routes: MapData['routes'] = [];
	runs(payload.routes, (o, i, anchors) =>
		routes.push({ id: `${text(o.id)}#${i}`, kind: text(o.kind), color: text(o.color), width: num(o.width, 1), playerVisible: true, anchors }),
	);
	return {
		name: typeof payload.campaign_name === 'string' ? payload.campaign_name : '',
		format,
		grid: { minQ: num(grid.min_q), cols: num(grid.cols), rows: num(grid.rows), rShift: num(grid.r_shift) },
		hexes,
		rivers,
		routes,
		revealed: [],
		regions: [],
		threads: [],
	};
}
