// Port of Flutter's lib/core/region_encounters.dart: a region note's
// `## Encounters` table, as weighted entries, and a roll.
//
// Two shapes are read under the first heading named "Encounter(s)":
// - a table whose first column is a die range (`3`, `4-6`, `4–6`); the
//   weight is the range's width;
// - a list, optionally weighted (`- 3: Wolves`, `- 3x Wolves`).

export interface Encounter {
	weight: number;
	text: string;
}

const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const ENC_HEADING = /^\s{0,3}#{1,6}\s+encounters?\b/i;
const LIST_ITEM = /^\s*[-*]\s+(.*\S)\s*$/;
const WEIGHTED = /^(\d+)\s*[:x]\s*(.+)$/i;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const RANGE = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/;

function encountersSection(body: string): string[] {
	const out: string[] = [];
	let collecting = false;
	for (const line of body.split(/\r?\n/)) {
		if (ENC_HEADING.test(line)) {
			collecting = true;
			continue;
		}
		if (collecting && HEADING.test(line)) break;
		if (collecting) out.push(line);
	}
	return out;
}

export function parseEncounters(body: string): Encounter[] {
	const out: Encounter[] = [];
	for (const line of encountersSection(body)) {
		const row = TABLE_ROW.exec(line);
		if (row) {
			const cells = row[1]!.split('|').map((c) => c.trim());
			if (cells.length < 2) continue;
			const rng = RANGE.exec(cells[0]!);
			if (!rng) continue; // the header or the separator row
			const lo = Number(rng[1]), hi = rng[2] !== undefined ? Number(rng[2]) : lo;
			const text = cells[1]!.trim();
			if (text) out.push({ weight: Math.max(1, hi - lo + 1), text });
			continue;
		}
		const item = LIST_ITEM.exec(line);
		if (item) {
			const body = item[1]!.trim();
			const w = WEIGHTED.exec(body);
			out.push(w ? { weight: Math.max(1, Number(w[1])), text: w[2]!.trim() } : { weight: 1, text: body });
		}
	}
	return out;
}

/** A weighted pick; null when there is nothing to roll. */
export function rollEncounter(encounters: Encounter[], random: () => number = Math.random): string | null {
	if (!encounters.length) return null;
	const total = encounters.reduce((a, e) => a + e.weight, 0);
	const pick = Math.floor(random() * total) + 1;
	let acc = 0;
	for (const e of encounters) {
		acc += e.weight;
		if (pick <= acc) return e.text;
	}
	return encounters[encounters.length - 1]!.text;
}
