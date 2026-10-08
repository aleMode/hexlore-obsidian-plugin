import { describe, expect, it } from 'vitest';
import { DEFAULT_SECTIONS, REGIONS, parseHexList, parseLinks, readSections, remapHexLinks, sectionProblems, writeHexList, writeLinks } from '../src/storage/hexmap_index';

const INDEX = `---
hexlore-plugin: map
data: "purezza.hexlore"
---

# purezza

Notes the GM wrote by hand.

## Hexes

- q5_r-2 :: [[Base Culto]] · [[Places/Rovine|the ruins]]
- q0_r1 :: [[Forte Rasnov]]
- q5_r-2 :: [[Base Culto]] · [[Extra]]
- this line is broken
- q1_r1 :: [[A]] and some words

## Session log

Keep me.
`;

describe('the .hexmap.md index', () => {
	it('reads hex lines in order, keeping links exactly as written', () => {
		const p = parseHexList(INDEX);
		expect(p.hexes.get('q5_r-2')).toEqual(['Base Culto', 'Places/Rovine|the ruins', 'Extra']);
		expect(p.hexes.get('q0_r1')).toEqual(['Forte Rasnov']);
		expect(p.problems.map((x) => x.line)).toEqual([14, 15, 16]);
		expect(p.problems[0]!.reason).toMatch(/twice/);
	});

	it('rewrites only its section: entries sorted, bad lines kept, the rest untouched', () => {
		const p = parseHexList(INDEX);
		p.hexes.set('q2_r0', ['New']);
		const out = writeHexList(INDEX, p.hexes);
		expect(out).toBe(`---
hexlore-plugin: map
data: "purezza.hexlore"
---

# purezza

Notes the GM wrote by hand.

## Hexes

- q0_r1 :: [[Forte Rasnov]]
- q2_r0 :: [[New]]
- q5_r-2 :: [[Base Culto]] · [[Places/Rovine|the ruins]] · [[Extra]]
- this line is broken
- q1_r1 :: [[A]] and some words

## Session log

Keep me.
`);
		expect(writeHexList(out, parseHexList(out).hexes)).toBe(out); // stable
	});

	it('appends the section when there is none, and leaves a file alone with nothing to add', () => {
		const plain = '---\nhexlore-plugin: map\n---\n\n# Map\n';
		expect(writeHexList(plain, new Map())).toBe(plain);
		expect(writeHexList(plain, new Map([['q0_r0', ['Inn']]]))).toBe('---\nhexlore-plugin: map\n---\n\n# Map\n\n## Hexes\n\n- q0_r0 :: [[Inn]]\n');
	});

	it('moves note lists with remapped hexes', () => {
		const out = remapHexLinks(
			new Map([
				['q0_r0', ['A']],
				['q1_r0', ['B']],
			]),
			new Map([
				['q0_r0', 'q1_r0'],
				['q1_r0', 'q2_r0'],
			]),
		);
		expect([...out]).toEqual([
			['q1_r0', ['A']],
			['q2_r0', ['B']],
		]);
	});

	it('reads sections tolerantly and refuses nesting', () => {
		expect(readSections({ sections: ['Places', { name: 'GM notes', folder: '/Prep/' }, { bad: 1 }] })).toEqual([
			{ name: 'Places', folder: 'Places' },
			{ name: 'GM notes', folder: 'Prep' },
		]);
		expect(readSections({})).toBeNull();
		expect(sectionProblems([...DEFAULT_SECTIONS])).toEqual([]);
		expect(sectionProblems([{ name: 'A', folder: 'X' }, { name: 'B', folder: 'X/Y' }])[0]).toMatch(/nested/);
	});

	it('keeps region notes in their own section, beside the hexes', () => {
		const withRegions = writeLinks(INDEX, REGIONS, new Map([['region_002', ['Northern Wastes']], ['region_001', ['Coast']]]));
		expect(parseLinks(withRegions, REGIONS).links).toEqual(new Map([['region_001', ['Coast']], ['region_002', ['Northern Wastes']]]));
		expect(parseHexList(withRegions).hexes).toEqual(parseHexList(INDEX).hexes);
		expect(withRegions.endsWith('## Regions\n\n- region_001 :: [[Coast]]\n- region_002 :: [[Northern Wastes]]\n')).toBe(true);
	});
});
