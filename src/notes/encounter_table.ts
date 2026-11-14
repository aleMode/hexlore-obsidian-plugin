// A region note's encounter tables, read the way a GM writes them, and
// rolled (plugin only). Flutter's simpler reader is ported unchanged in
// core/region_encounters.ts for the conformance fixtures; this is what the
// map panel uses. Pure: no Obsidian.
//
// Read under every heading named "Encounter(s)…" (any level):
// - each deeper sub-heading is a table of its own ("### Day", "### Night"),
//   and so is each such heading ("## Encounters (night)");
// - a Markdown table whose first column is a die result (`3`, `4-6`,
//   `01-95`, `96-00`, `12+`), rolled with the die in its header (`2d6`,
//   `d100`, `d%`, `d66`); further columns are kept as text;
// - a list, optionally weighted (`- 3x Wolves`, `- 3: Wolves`), or with
//   ranges (`- 1-2: Wolves`); a numbered list counts like bullets; an
//   indented bullet is DETAIL of the entry above it, not an entry;
// - dice inside a result ("1d4+1 goblins", Dice Roller's `dice: 2d6`) are
//   rolled too.
// The encounter CHECK ("2 in 6") comes from the note's frontmatter,
// `encounter-chance`: a number (in 6) or "N in M".

export interface Dice {
	count: number;
	sides: number;
	mod: number;
	/** Two d6 read as tens and units (11–66). */
	d66: boolean;
}

const DICE = /^\s*(\d*)\s*d\s*(%|\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** `2d6`, `d8`, `1d4+1`, `d%`, `d100`, `d66`; null for anything else. */
export function parseDice(text: string): Dice | null {
	const m = DICE.exec(text);
	if (!m) return null;
	const count = m[1] ? Number(m[1]) : 1;
	const sides = m[2] === '%' ? 100 : Number(m[2]);
	if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
	const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
	return { count, sides, mod, d66: count === 1 && sides === 66 };
}

export function formatDice(d: Dice): string {
	const base = d.d66 ? 'd66' : `${d.count > 1 ? d.count : ''}d${d.sides}`;
	return d.mod ? `${base}${d.mod > 0 ? '+' : ''}${d.mod}` : base;
}

/** The lowest and highest result. */
export function diceRange(d: Dice): [number, number] {
	if (d.d66) return [11, 66];
	return [d.count + d.mod, d.count * d.sides + d.mod];
}

const die = (sides: number, random: () => number) => 1 + Math.floor(random() * sides);

export function rollDice(d: Dice, random: () => number = Math.random): number {
	if (d.d66) return die(6, random) * 10 + die(6, random);
	let total = d.mod;
	for (let i = 0; i < d.count; i++) total += die(d.sides, random);
	return total;
}

export interface EncounterRow {
	/** The die results it covers; null for a list entry (weighted). */
	lo: number | null;
	hi: number | null;
	weight: number;
	text: string;
	/** Indented bullets under the entry. */
	detail: string[];
}

export interface EncounterTable {
	/** '' for the only (or first, unnamed) table. */
	name: string;
	/** From the table's header; null when it names none. */
	die: Dice | null;
	rows: EncounterRow[];
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ENC_HEADING = /^encounters?\b\s*(.*)$/i;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;
const RANGE = /^\s*(\d+)\s*(?:[-–—]\s*(\d+)|(\+))?\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const LIST_RANGE = /^(\d+)\s*[-–—]\s*(\d+)\s*[:.)]\s*(.+)$/;
const LIST_WEIGHT = /^(\d+)\s*(?:[x×]\s+|:\s*)(.+)$/i;

/** A table row's cells, `\|` kept as a pipe inside a cell. */
function cellsOf(inner: string): string[] {
	return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** Fix the percentile habits: `00` is 100, `96-00` ends at 100. */
function percentile(lo: number, hi: number, die: Dice | null): [number, number] {
	const pct = !die || (die.sides === 100 && die.count === 1);
	if (!pct) return [lo, hi];
	if (lo === 0 && hi === 0) return [100, 100];
	if (hi === 0 && lo > 0) return [lo, 100];
	return [lo, hi];
}

function cleanName(text: string): string {
	return text.replace(/^[\s(:–—-]+|[\s):]+$/g, '').trim();
}

class TableBuilder {
	die: Dice | null = null;
	rows: EncounterRow[] = [];
	private listIndent = -1;
	constructor(readonly name: string) {}

	line(line: string): void {
		const row = TABLE_ROW.exec(line);
		if (row) return this.tableRow(cellsOf(row[1]!));
		const item = LIST_ITEM.exec(line);
		if (!item) return;
		const indent = item[1]!.replace(/\t/g, '    ').length;
		const body = item[2]!;
		const last = this.rows[this.rows.length - 1];
		if (last && this.listIndent >= 0 && indent > this.listIndent) {
			last.detail.push(body);
			return;
		}
		this.listIndent = indent;
		const range = LIST_RANGE.exec(body);
		if (range) {
			const [lo, hi] = [Number(range[1]), Number(range[2])];
			this.rows.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi), weight: Math.abs(hi - lo) + 1, text: range[3]!.trim(), detail: [] });
			return;
		}
		const w = LIST_WEIGHT.exec(body);
		this.rows.push(w ? { lo: null, hi: null, weight: Math.max(1, Number(w[1])), text: w[2]!.trim(), detail: [] } : { lo: null, hi: null, weight: 1, text: body, detail: [] });
	}

	private tableRow(cells: string[]): void {
		this.listIndent = -1;
		if (cells.length < 2 || cells.every((c) => SEPARATOR_CELL.test(c) || !c)) return;
		const rng = RANGE.exec(cells[0]!);
		if (!rng) {
			// The header: its first cell may name the die.
			this.die ??= parseDice(cells[0]!);
			return;
		}
		const text = cells.slice(1).filter((c) => c).join(' — ');
		if (!text) return;
		let lo = Number(rng[1]);
		let hi = rng[3] ? Number.POSITIVE_INFINITY : rng[2] !== undefined ? Number(rng[2]) : lo;
		if (Number.isFinite(hi)) [lo, hi] = percentile(lo, hi, this.die);
		if (Number.isFinite(hi) && hi < lo) [lo, hi] = [hi, lo];
		const max = this.die ? diceRange(this.die)[1] : hi;
		const top = Number.isFinite(hi) ? hi : Math.max(lo, max);
		this.rows.push({ lo, hi, weight: Math.max(1, top - lo + 1), text, detail: [] });
	}
}

/** Every encounter table in a note's text, in order. */
export function parseEncounterTables(body: string): EncounterTable[] {
	const out: TableBuilder[] = [];
	let level = 0; // the "Encounters" heading being read; 0: none
	let base = '';
	let current: TableBuilder | null = null;
	const start = (name: string) => {
		current = new TableBuilder(name);
		out.push(current);
	};
	for (const line of body.split(/\r?\n/)) {
		const h = HEADING.exec(line);
		if (h) {
			const l = h[1]!.length;
			const enc = ENC_HEADING.exec(h[2]!);
			if (enc && (level === 0 || l <= level)) {
				level = l;
				base = cleanName(enc[1]!);
				start(base);
				continue;
			}
			if (level && l > level) {
				const sub = cleanName(h[2]!);
				start(base && sub ? `${base} · ${sub}` : sub || base);
				continue;
			}
			level = 0;
			current = null;
			continue;
		}
		if (current) (current as TableBuilder).line(line);
	}
	return out.filter((t) => t.rows.length).map((t) => ({ name: t.name, die: t.die, rows: t.rows }));
}

export interface EncounterRoll {
	table: string;
	/** The die result, for a table rolled on its ranges. */
	roll: number | null;
	/** The die rolled, as written (`2d6`), when there was one. */
	dice: string | null;
	text: string;
	detail: string[];
}

/** Roll [table]: on its die and ranges when it has them, else weighted.
 *  Dice in the result are rolled too. */
export function rollEncounterTable(table: EncounterTable, random: () => number = Math.random): EncounterRoll {
	const ranged = table.rows.every((r) => r.lo !== null);
	let row: EncounterRow | undefined;
	let roll: number | null = null;
	let dice: string | null = null;
	if (ranged) {
		const d = table.die;
		if (!d) {
			// No die in the header: one die from the lowest to the highest entry.
			const lo = Math.min(...table.rows.map((r) => r.lo!));
			const hi = Math.max(...table.rows.map((r) => (Number.isFinite(r.hi!) ? r.hi! : r.lo!)));
			roll = lo + Math.floor(random() * (hi - lo + 1));
		} else {
			roll = rollDice(d, random);
			dice = formatDice(d);
		}
		row = table.rows.find((r) => roll! >= r.lo! && roll! <= r.hi!);
		if (!row) return { table: table.name, roll, dice, text: `no entry for ${roll}`, detail: [] };
	} else {
		const total = table.rows.reduce((a, r) => a + r.weight, 0);
		let pick = Math.floor(random() * total);
		row = table.rows.find((r) => (pick -= r.weight) < 0) ?? table.rows[table.rows.length - 1]!;
	}
	return { table: table.name, roll, dice, text: expandDice(row.text, random), detail: row.detail.map((d) => expandDice(d, random)) };
}

/** Dice Roller's `dice: 2d6`, or bare dice in the text: one pass, so a
 *  result is never rolled again. */
const INLINE_DICE = /`dice:\s*([^`]+?)\s*`|(?<![\w[#|^/])(\d*d(?:\d+|%)(?:\s*[+-]\s*\d+)?)(?![\w\]])/gi;

/** "3 (1d4+1)": the total, then the dice as written; null if not dice. */
function rolled(expr: string, random: () => number): string | null {
	const d = parseDice(expr);
	return d ? `${rollDice(d, random)} (${expr.replace(/\s+/g, '')})` : null;
}

/** [text] with every dice expression rolled: "1d4+1 goblins" → "3 (1d4+1)
 *  goblins". Text inside [[links]] is left alone. */
export function expandDice(text: string, random: () => number = Math.random): string {
	return text
		.split(/(\[\[[^\]]*\]\])/)
		.map((part, i) => {
			if (i % 2) return part; // a link
			return part.replace(INLINE_DICE, (all, tagged: string | undefined, bare: string | undefined) => rolled(tagged ?? bare ?? '', random) ?? all);
		})
		.join('');
}

export interface EncounterChance {
	/** An encounter on a roll of [hits] or less… */
	hits: number;
	/** …on a d[of]. */
	of: number;
}

/** The `encounter-chance` frontmatter value: `2` (2 in 6), "2 in 6",
 *  "2-in-6", "1/8". Null when absent or unreadable. */
export function parseEncounterChance(value: unknown): EncounterChance | null {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) return { hits: value, of: 6 };
	if (typeof value !== 'string') return null;
	const m = /^\s*(\d+)\s*(?:-?\s*in\s*-?|\/)\s*(\d+)\s*$/i.exec(value) ?? /^\s*(\d+)\s*$/.exec(value);
	if (!m) return null;
	const hits = Number(m[1]), of = m[2] !== undefined ? Number(m[2]) : 6;
	return of >= 2 && hits <= of ? { hits, of } : null;
}

export function formatChance(c: EncounterChance): string {
	return `${c.hits} in ${c.of}`;
}

/** Roll the check: [hit] when the roll is [hits] or less. */
export function rollEncounterCheck(c: EncounterChance, random: () => number = Math.random): { roll: number; hit: boolean } {
	const roll = die(c.of, random);
	return { roll, hit: roll <= c.hits };
}
