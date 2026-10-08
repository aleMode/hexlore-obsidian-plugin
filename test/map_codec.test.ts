import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MapModel } from '../src/core/map';
import { fixtureMap } from './helpers/fixture_map';
import { applyFile, encodeAll, encodeChunk, fileKeyOf, LAYER_FILES } from '../src/storage/map_codec';

describe('the format-2 codec', () => {
	it('writes the files Flutter writes, byte for byte (format2_files.json)', () => {
		const fixture = JSON.parse(readFileSync(new URL('../vendor/conformance/format2_files.json', import.meta.url), 'utf8')) as {
			cases: { out: Record<string, string> }[];
		};
		const written = encodeAll(fixtureMap());
		for (const [path, text] of Object.entries(fixture.cases[0]!.out)) expect(written.get(path), path).toBe(text);
	});

	it('round-trips what it does not understand, untouched', () => {
		const text =
			'[\n  {"q":0,"r":0,"terrain":"glacier","terrain_variant":"glacier/blue","feature":"obelisk","zz":6.0,"yy":{"a":[1,2.5]}},\n' +
			'  {"q":1,"r":0,"terrain":"forest","terrain_variant":"forest/#7"}\n]\n';
		const m = new MapModel();
		applyFile(m, { chunk: 'c_0_0.json' }, text, 'X');
		expect(m.getHex(0, 0)!.terrain).toBe('default'); // drawn with the fallback
		expect(encodeChunk(m, 'c_0_0.json')).toBe(text);
	});

	it('repaints an unknown terrain when the GM paints over it', () => {
		const m = new MapModel();
		applyFile(m, { chunk: 'c_0_0.json' }, '[\n  {"q":0,"r":0,"terrain":"glacier","terrain_variant":"glacier/blue"}\n]\n', 'X');
		m.getHex(0, 0)!.terrain = 'forest';
		expect(encodeChunk(m, 'c_0_0.json')).toBe('[\n  {"q":0,"r":0,"terrain":"forest"}\n]\n');
	});

	it('drops a hex with nothing worth a record, and an empty chunk', () => {
		const m = new MapModel();
		m.getOrCreateHex(3, 3);
		expect(encodeChunk(m, 'c_0_0.json')).toBeNull();
		expect(encodeAll(m).has('paint/c_0_0.json')).toBe(false);
	});

	it('reloads one chunk without touching the others', () => {
		const m = fixtureMap();
		applyFile(m, { chunk: 'c_0_0.json' }, '[\n  {"q":2,"r":0,"terrain":"sea"}\n]\n', 'X');
		expect(m.getHex(0, 0)).toBeUndefined();
		expect(m.getHex(2, 0)!.terrain).toBe('sea');
		expect(m.getHex(17, -3)!.terrain).toBe('mountain');
	});

	it('knows which files it owns', () => {
		expect(fileKeyOf('paint/c_-1_0.json')).toEqual({ chunk: 'c_-1_0.json' });
		expect(fileKeyOf(LAYER_FILES.threads)).toEqual({ layer: 'threads' });
		expect(fileKeyOf('import/underlay.json')).toBeNull();
		expect(fileKeyOf('paint/notes.txt')).toBeNull();
	});

	it('keeps campaign.json keys it does not know, after its own', () => {
		const m = new MapModel();
		applyFile(m, { layer: 'meta' }, '{"format":2,"name":"A","zz_new":[1.0]}', 'X');
		expect(encodeAll(m).get('campaign.json')).toContain('"distance_unit": "mi",\n  "zz_new": [\n    1.0\n  ]\n}');
	});
});
