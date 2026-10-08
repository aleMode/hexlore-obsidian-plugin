import { describe, expect, it } from 'vitest';
import { JsonDouble, compareIds, dartDouble, dbl, encodeJsonLines, parseJson } from '../src/core/json';

describe('campaign JSON', () => {
	it('writes doubles as Dart does', () => {
		expect([6, 0.5, -0, 1e21, 1e-7, 123456.789].map(dartDouble)).toEqual(['6.0', '0.5', '-0.0', '1e+21', '1e-7', '123456.789']);
	});

	it('keeps a number written as a double a double', () => {
		const v = parseJson('{"a":6.0,"b":6,"c":1e3,"d":2.5}') as Record<string, unknown>;
		expect(v.a).toBeInstanceOf(JsonDouble);
		expect(v.b).toBe(6);
		expect(v.c).toBeInstanceOf(JsonDouble);
		expect(v.d).toBe(2.5);
		expect(encodeJsonLines(v)).toBe('{\n  "a": 6.0,\n  "b": 6,\n  "c": 1000.0,\n  "d": 2.5\n}\n');
	});

	it('writes one record per line, deeper levels compact', () => {
		expect(encodeJsonLines([{ id: 'a', v: [1, dbl(2)] }, { id: 'b' }])).toBe('[\n  {"id":"a","v":[1,2.0]},\n  {"id":"b"}\n]\n');
		expect(encodeJsonLines({ revealed: ['q0_r0', 'q1_r0'], n: 1, e: [], o: {} })).toBe(
			'{\n  "revealed": [\n    "q0_r0",\n    "q1_r0"\n  ],\n  "n": 1,\n  "e": [],\n  "o": {}\n}\n',
		);
		expect(encodeJsonLines([])).toBe('[]\n');
		expect(encodeJsonLines({ cells: { a: [1, 2] } })).toBe('{\n  "cells": {\n    "a": [1,2]\n  }\n}\n');
	});

	it('escapes strings as Dart does, non-ASCII left as is', () => {
		expect(encodeJsonLines(['Città "x"\n\u0001'])).toBe('[\n  "Città \\"x\\"\\n\\u0001"\n]\n');
	});

	it('orders ids numerically within a prefix', () => {
		expect(['route_10', 'route_2', 'river_001', 'a'].sort(compareIds)).toEqual(['a', 'river_001', 'route_2', 'route_10']);
	});
});
