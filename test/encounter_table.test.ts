import { describe, expect, it } from 'vitest';
import {
	diceRange,
	expandDice,
	formatDice,
	parseDice,
	parseEncounterChance,
	parseEncounterTables,
	rollDice,
	rollEncounterCheck,
	rollEncounterTable,
	type EncounterTable,
} from '../src/notes/encounter_table';

/** A random() that returns [values] in turn (each in [0, 1)). */
const seq = (...values: number[]) => {
	let i = 0;
	return () => values[i++ % values.length]!;
};
/** random() giving face [face] of a d[sides]. */
const face = (face: number, sides: number) => (face - 1 + 0.5) / sides;

/** The share of each entry over every result of the table's die. */
function odds(t: EncounterTable): Map<string, number> {
	const d = t.die!;
	const out = new Map<string, number>();
	// Enumerate every combination of the dice.
	const combos = (n: number): number[][] => (n === 0 ? [[]] : combos(n - 1).flatMap((c) => Array.from({ length: d.sides }, (_, f) => [...c, f + 1])));
	const all = combos(d.count);
	for (const faces of all) {
		const r = rollEncounterTable(t, seq(...faces.map((f) => face(f, d.sides))));
		out.set(r.text, (out.get(r.text) ?? 0) + 1 / all.length);
	}
	return out;
}

describe('dice', () => {
	it('reads the usual notations', () => {
		expect(parseDice('2d6')).toEqual({ count: 2, sides: 6, mod: 0, d66: false });
		expect(parseDice('d8')).toEqual({ count: 1, sides: 8, mod: 0, d66: false });
		expect(parseDice('1d4+1')).toEqual({ count: 1, sides: 4, mod: 1, d66: false });
		expect(parseDice('D%')!.sides).toBe(100);
		expect(parseDice('d66')!.d66).toBe(true);
		expect(parseDice('Encounter')).toBeNull();
		expect(parseDice('d1')).toBeNull();
		expect(formatDice(parseDice('2d6-1')!)).toBe('2d6-1');
		expect(diceRange(parseDice('2d6')!)).toEqual([2, 12]);
		expect(diceRange(parseDice('d66')!)).toEqual([11, 66]);
	});

	it('rolls: d66 is tens and units', () => {
		expect(rollDice(parseDice('d66')!, seq(face(3, 6), face(5, 6)))).toBe(35);
		expect(rollDice(parseDice('2d6+1')!, seq(face(6, 6), face(6, 6)))).toBe(13);
	});
});

describe('encounter tables', () => {
	it('rolls a 2d6 table on the dice, not on the width of each range', () => {
		const [t] = parseEncounterTables(
			['## Encounters', '| 2d6 | Encounter |', '|---|---|', '| 2 | Dragon |', '| 3-5 | Wolves |', '| 6-8 | Nothing |', '| 9-11 | Bandits |', '| 12 | Lich |'].join('\n'),
		);
		expect(t!.die).toEqual(parseDice('2d6'));
		const o = odds(t!);
		expect(o.get('Dragon')).toBeCloseTo(1 / 36);
		expect(o.get('Nothing')).toBeCloseTo(16 / 36);
		expect(rollEncounterTable(t!, seq(face(4, 6), face(3, 6)))).toMatchObject({ roll: 7, dice: '2d6', text: 'Nothing' });
	});

	it('reads percentile habits: 01-95, 96-00', () => {
		const [t] = parseEncounterTables('## Encounters\n| d100 | E |\n|--|--|\n| 01-95 | Nothing |\n| 96-00 | Dragon |');
		expect(t!.rows.map((r) => [r.lo, r.hi])).toEqual([
			[1, 95],
			[96, 100],
		]);
		expect(rollEncounterTable(t!, () => 0.999).text).toBe('Dragon');
	});

	it('reads 12+ as up to the die’s highest, and says when a roll has no entry', () => {
		const [t] = parseEncounterTables('## Encounters\n| 2d6 | E |\n|-|-|\n| 2-6 | Quiet |\n| 10+ | Giant |');
		expect(rollEncounterTable(t!, seq(face(6, 6), face(6, 6))).text).toBe('Giant');
		expect(rollEncounterTable(t!, seq(face(4, 6), face(4, 6))).text).toBe('no entry for 8');
	});

	it('keeps further columns, links with an alias, and escaped pipes', () => {
		const [t] = parseEncounterTables('## Encounters\n| d6 | E | Notes |\n|--|--|--|\n| 1-3 | [[Goblin warband\\|goblins]] | lair p.3 |\n| 4-6 | Wolves | |');
		expect(t!.rows[0]!.text).toBe('[[Goblin warband|goblins]] — lair p.3');
		expect(t!.rows[1]!.text).toBe('Wolves');
	});

	it('reads lists: weights only as "3x " or "3:", numbered lists, ranges, nested detail', () => {
		const [t] = parseEncounterTables(['## Encounters', '- 3 xorn', '- 2x Xvarts on patrol', '- 4: Wolves', '  - hungry, 1d4+1 of them', '- 1-2: Bears'].join('\n'));
		expect(t!.rows.map((r) => [r.weight, r.text])).toEqual([
			[1, '3 xorn'],
			[2, 'Xvarts on patrol'],
			[4, 'Wolves'],
			[2, 'Bears'],
		]);
		expect(t!.rows[2]!.detail).toEqual(['hungry, 1d4+1 of them']);
		const [n] = parseEncounterTables('## Encounters\n1. Wolves\n2. Bandits');
		expect(n!.rows.map((r) => r.text)).toEqual(['Wolves', 'Bandits']);
	});

	it('makes a table of each sub-heading, and of each "Encounters (…)" heading', () => {
		const sub = parseEncounterTables('# Woods\n## Encounters\n### Day\n- Wolves\n### Night\n- Ghouls\n## Treasure\n- Gold');
		expect(sub.map((t) => [t.name, t.rows.map((r) => r.text)])).toEqual([
			['Day', ['Wolves']],
			['Night', ['Ghouls']],
		]);
		const two = parseEncounterTables('## Encounters (day)\n- Wolves\n## Encounters (night)\n- Ghouls');
		expect(two.map((t) => t.name)).toEqual(['day', 'night']);
		expect(parseEncounterTables('## Notes\n- not a table')).toEqual([]);
	});

	it('rolls dice inside a result, but not inside links', () => {
		expect(expandDice('1d4+1 goblins', seq(face(2, 4)))).toBe('3 (1d4+1) goblins');
		expect(expandDice('`dice: 2d6` bandits', seq(face(1, 6), face(2, 6)))).toBe('3 (2d6) bandits');
		expect(expandDice('see [[d6 table]] and Ed5')).toBe('see [[d6 table]] and Ed5');
		const [t] = parseEncounterTables('## Encounters\n- 1d6 wolves');
		expect(rollEncounterTable(t!, seq(0, face(5, 6))).text).toBe('5 (1d6) wolves');
	});
});

describe('the encounter check', () => {
	it('reads "N in M" in its usual spellings', () => {
		expect(parseEncounterChance(2)).toEqual({ hits: 2, of: 6 });
		expect(parseEncounterChance('1 in 8')).toEqual({ hits: 1, of: 8 });
		expect(parseEncounterChance('2-in-6')).toEqual({ hits: 2, of: 6 });
		expect(parseEncounterChance('1/10')).toEqual({ hits: 1, of: 10 });
		expect(parseEncounterChance('often')).toBeNull();
		expect(parseEncounterChance(undefined)).toBeNull();
	});

	it('hits on the chance or less', () => {
		expect(rollEncounterCheck({ hits: 2, of: 6 }, () => face(2, 6))).toEqual({ roll: 2, hit: true });
		expect(rollEncounterCheck({ hits: 2, of: 6 }, () => face(3, 6))).toEqual({ roll: 3, hit: false });
	});
});
