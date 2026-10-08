// Port of Flutter's lib/storage/player_filter.dart: THE single path to
// players (decision 4). The player view is MAP-ONLY: revealed hexes inside
// the grid window, rivers and roads as runs over revealed cells, the grid's
// extent. Nothing else — no regions, threads, notes, unknown keys — is ever
// served, and the payload is built from explicit keys only.
//
// Rules (see the Dart file for the full reasoning):
// - a hex is served when revealed AND inside the grid window (4b);
// - a hidden feature (4c), or one this build doesn't know, is withheld
//   TOGETHER WITH the hex's name;
// - a river or route anchor is served when any hex touching it is revealed;
//   runs shorter than two anchors are dropped;
// - borders not marked player-visible, and route kinds this build doesn't
//   know, are never served (fail closed).

import { cellInGrid } from './geometry';
import { Hex, displayIdFor, parseHexId } from './hex';
import type { MapModel } from './map';
import { anchorTouchingHexes, type Anchor } from './river';
import { hexIdFor } from './hex_data';
import { dbl, type JsonObject } from './json';
import { isKnownRouteKind } from './route';

export type AnchorJson = [string, number, number, number];

/** Runs of consecutive player-visible anchors. */
export function revealedRuns(nodes: Anchor[], visible: Set<string>): AnchorJson[][] {
	const runs: AnchorJson[][] = [];
	let current: AnchorJson[] = [];
	for (const n of nodes) {
		if (anchorTouchingHexes(n).some(([q, r]) => visible.has(hexIdFor(q, r)))) {
			current.push([n.kind, n.q, n.r, n.k]);
		} else {
			if (current.length >= 2) runs.push(current);
			current = [];
		}
	}
	if (current.length >= 2) runs.push(current);
	return runs;
}

export function filterCampaignForPlayer(m: MapModel): JsonObject {
	const grid = m.meta.grid;
	// A revealed cell with no record is still a revealed (empty) cell
	// (format-2 §3): Flutter materialises it on load, so it is served.
	const cells = new Map(m.hexes);
	for (const id of m.revealed) {
		if (cells.has(id)) continue;
		const qr = parseHexId(id);
		if (qr) cells.set(id, new Hex(qr[0], qr[1]));
	}
	const visible = new Set<string>();
	for (const [id, h] of cells) {
		if (m.revealed.has(id) && cellInGrid(h.q, h.r, grid)) visible.add(id);
	}
	const featureShown = (h: Hex) => !h.featureHidden && !h.hasUnknownFeature;

	const hexes: JsonObject[] = [];
	for (const [id, h] of cells) {
		if (!visible.has(id)) continue;
		const shown = featureShown(h);
		hexes.push({
			id,
			display_id: displayIdFor(h.q, h.r),
			q: h.q,
			r: h.r,
			// The name goes with a hidden feature: "Dragon's Lair" gives it away.
			name: shown ? h.name : null,
			terrain: h.terrain,
			terrain_variant: h.terrainVariant,
			feature: shown ? h.feature : null,
			feature_variant: shown ? h.featureVariant : 0,
			color: h.fillColor(),
			tags: [...h.tags],
		});
	}

	const rivers: JsonObject[] = [];
	for (const river of m.rivers.values()) {
		const segments = revealedRuns(river.nodes, visible);
		if (segments.length) rivers.push({ id: river.id, width: dbl(river.width), segments });
	}

	const routes: JsonObject[] = [];
	for (const route of m.routes.values()) {
		if (!route.playerVisible || !isKnownRouteKind(route.kind)) continue;
		const segments = revealedRuns(route.nodes, visible);
		if (segments.length) {
			routes.push({ id: route.id, kind: route.kind, color: route.color, width: dbl(route.width), segments });
		}
	}

	return {
		campaign_name: m.meta.name,
		hexes,
		rivers,
		routes,
		// Extent only: players vote on unexplored cells, so the lattice shows.
		grid: { min_q: grid.minQ, cols: grid.cols, rows: grid.rows, r_shift: grid.rShift },
	};
}
