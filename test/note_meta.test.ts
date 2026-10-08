import { describe, expect, it } from 'vitest';
import { defaultKindFor, expandTemplate, hexesForNote, kindOf, locationLinks, safeNoteName, starterFrontmatter } from '../src/notes/note_meta';
import { readSections, sectionOf, sectionsFrontmatter } from '../src/storage/hexmap_index';

describe('note conventions', () => {
	it('reads the kind from `type:`, case-insensitively; anything else is a plain note', () => {
		expect(kindOf({ type: 'NPC' })).toBe('npc');
		expect(kindOf({ type: 'quest' })).toBe('quest');
		expect(kindOf({ type: 'place' })).toBe('place');
		expect(kindOf({ type: 'monster' })).toBe('note');
		expect(kindOf(null)).toBe('note');
	});

	it('reads `location` as one link or a list, bracketed or not, alias and heading dropped', () => {
		expect(locationLinks({ location: '[[Base Culto]]' })).toEqual(['Base Culto']);
		expect(locationLinks({ location: ['[[A|the a]]', 'B#Hall', '[[A]]', 3, ''] })).toEqual(['A', 'B']);
		expect(locationLinks({})).toEqual([]);
	});

	it('starts NPCs and quests with Flutter’s fields, pointing at the place', () => {
		expect(starterFrontmatter('note', 'X')).toBeNull();
		expect(starterFrontmatter('npc', 'Base Culto')).toEqual({ type: 'npc', role: '', attitude: 'unknown', location: '[[Base Culto]]', tags: [] });
		expect(starterFrontmatter('quest', null)).toMatchObject({ type: 'quest', status: 'seed', location: [] });
		expect(defaultKindFor('NPCs')).toBe('npc');
		expect(defaultKindFor('Places')).toBe('place');
		expect(defaultKindFor('GM notes')).toBe('note');
	});

	it('fills templates, leaving unknown placeholders alone', () => {
		const out = expandTemplate('# {{title}} ({{hex}}, {{map}}) {{date}} {{time:HH}} {{other}}', { title: 'Fort', hex: 'F3', map: 'purezza' }, (f) => `<${f}>`);
		expect(out).toBe('# Fort (F3, purezza) <YYYY-MM-DD> <HH> {{other}}');
	});

	it('makes safe file names', () => {
		expect(safeNoteName('Base: Culto / [bad]?')).toBe('Base Culto bad');
		expect(safeNoteName('  ')).toBe('Untitled');
	});

	it('a note stands for the hexes listing it and those listing its places', () => {
		const byNote = new Map([
			['Places/Base.md', new Set(['q1_r0', 'q2_r0'])],
			['NPCs/Hermit.md', new Set(['q5_r5'])],
		]);
		expect([...hexesForNote('NPCs/Hermit.md', ['Places/Base.md'], byNote)].sort()).toEqual(['q1_r0', 'q2_r0', 'q5_r5']);
		expect(hexesForNote('Other.md', [], byNote).size).toBe(0);
	});
});

describe('section templates', () => {
	it('round-trip through the frontmatter and find a path’s section', () => {
		const s = readSections({ sections: [{ name: 'NPCs', folder: 'NPCs', template: 'Templates/NPC.md' }, { name: 'Places', folder: 'Places' }] })!;
		expect(s[0]!.template).toBe('Templates/NPC.md');
		expect(sectionsFrontmatter(s)).toEqual([{ name: 'NPCs', folder: 'NPCs', template: 'Templates/NPC.md' }, { name: 'Places', folder: 'Places' }]);
		expect(sectionOf(s, 'Places/Town/Inn.md')?.name).toBe('Places');
		expect(sectionOf(s, 'Placesque/x.md')).toBeNull();
	});
});
