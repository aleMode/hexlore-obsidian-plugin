import { describe, expect, it } from 'vitest';
import { MapScale } from '../src/core/map_scale';
import { Route, centreNode } from '../src/core/route';
import { defaultTravel, entryCost, formatHours, readTravel } from '../src/party/travel';
import { fixtureMap } from './helpers/fixture_map';

describe('travel time', () => {
	it('charges the terrain of the hex entered, at 3-mile hexes by default', () => {
		const m = fixtureMap();
		m.meta.scale = new MapScale(3, 'mi');
		const s = defaultTravel();
		expect(entryCost(m, 17, -3, s)).toEqual({ hours: 8, by: 'mountain' });
		expect(entryCost(m, 5, 5, s)).toEqual({ hours: 2, by: 'default' }); // unpainted
		expect(entryCost(m, -5, 4, s)).toEqual({ hours: null, by: 'lake' });
	});

	it('scales with the hex size: twice the miles, twice the time; km too', () => {
		const m = fixtureMap();
		m.meta.scale = new MapScale(6, 'mi');
		expect(entryCost(m, 17, -3, defaultTravel()).hours).toBe(16);
		m.meta.scale = new MapScale(4.828032, 'km'); // 3 miles
		expect(entryCost(m, 17, -3, defaultTravel()).hours).toBeCloseTo(8);
	});

	it('a road through the hex is faster; a trail only when set; a border never', () => {
		const m = fixtureMap();
		m.meta.scale = new MapScale(3, 'mi');
		const s = defaultTravel();
		// The fixture's trail runs through q0_r0 (forest) and q1_r0 (desert).
		expect(entryCost(m, 1, 0, s)).toEqual({ hours: 8, by: 'desert' });
		expect(entryCost(m, 1, 0, { ...s, trailHours: 3 })).toEqual({ hours: 3, by: 'trail' });
		const road = new Route('route_002');
		road.kind = 'road';
		road.nodes = [centreNode(17, -3), centreNode(18, -3)];
		m.routes.set(road.id, road);
		expect(entryCost(m, 17, -3, s)).toEqual({ hours: 1, by: 'road' });
		road.kind = 'border';
		expect(entryCost(m, 17, -3, s)).toEqual({ hours: 8, by: 'mountain' });
	});

	it('reads days and hours', () => {
		expect(formatHours(5, 8)).toBe('5 h');
		expect(formatHours(8, 8)).toBe('1 day');
		expect(formatHours(19, 8)).toBe('2 days 3 h');
		expect(formatHours(2.5, 8)).toBe('2.5 h');
		expect(formatHours(0, 8)).toBe('0 h');
	});

	it('reads settings tolerantly, keeping "impassable"', () => {
		const s = readTravel({ referenceMiles: 6, dayHours: -1, terrainHours: { forest: 5, sea: null, plains: 'x' }, roadHours: null, heights: { hills: 2, mountain: 99 } });
		expect(s.referenceMiles).toBe(6);
		expect(s.dayHours).toBe(8);
		expect(s.terrainHours.forest).toBe(5);
		expect(s.terrainHours.sea).toBeNull();
		expect(s.terrainHours.plains).toBe(2);
		expect(s.roadHours).toBeNull();
		expect(s.heights.hills).toBe(2);
		expect(s.heights.mountain).toBe(2); // out of range: the default
	});
});
