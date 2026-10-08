import { MapModel } from '../../src/core/map';
import { River, anchor } from '../../src/core/river';
import { Route, centreNode } from '../../src/core/route';

/** The campaign test/conformance_test.dart saves for format2_files.json. */
export function fixtureMap(): MapModel {
	const m = new MapModel();
	m.meta.name = 'Fixture';
	m.meta.gridCols = 40;
	m.meta.gridRows = 30;
	for (const [q, r, t, v] of [
		[0, 0, 'forest', 2],
		[1, 0, 'desert', 2],
		[17, -3, 'mountain', 1],
		[-5, 4, 'lake', 0],
	] as const) {
		const h = m.getOrCreateHex(q, r);
		h.terrain = t;
		h.terrainVariant = v;
	}
	const well = m.getOrCreateHex(1, 0);
	well.feature = 'well';
	well.featureVariant = 1;
	well.featureHidden = true;
	well.tags = ['oasis'];
	m.revealed.add('q0_r0');
	const river = new River('river_001');
	river.nodes = [anchor('v', 0, 0, 0), anchor('e', 0, 0, 1)];
	m.rivers.set(river.id, river);
	const route = new Route('route_001');
	route.kind = 'trail';
	route.nodes = [centreNode(0, 0), centreNode(1, 0)];
	m.routes.set(route.id, route);
	return m;
}
