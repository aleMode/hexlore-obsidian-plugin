// Port of Flutter's lib/app/quick_jump.dart ranking (Ctrl+K): search over
// everything nameable. Exact match first, then prefix, then a word's start,
// then plain substring; alphabetical within a tier. Pure.

export const MAX_JUMP_RESULTS = 50;

export interface JumpEntry {
	label: string;
	/** "hex", "region", "place", "npc", "quest", "adventure", "note". */
	kind: string;
}

export function rankEntries<T extends JumpEntry>(query: string, entries: T[]): T[] {
	const q = query.trim().toLowerCase();
	const alpha = (a: T, b: T) => {
		const x = a.label.toLowerCase(), y = b.label.toLowerCase();
		return x < y ? -1 : x > y ? 1 : 0;
	};
	if (!q) return [...entries].sort(alpha).slice(0, MAX_JUMP_RESULTS);
	const tier = (label: string): number | null => {
		const low = label.toLowerCase();
		if (low === q) return 0;
		if (low.startsWith(q)) return 1;
		if (low.split(/\s+/).some((w) => w.startsWith(q))) return 2;
		if (low.includes(q)) return 3;
		return null;
	};
	return entries
		.map((e) => [tier(e.label), e] as const)
		.filter((x): x is readonly [number, T] => x[0] !== null)
		.sort((a, b) => a[0] - b[0] || alpha(a[1], b[1]))
		.slice(0, MAX_JUMP_RESULTS)
		.map(([, e]) => e);
}

// ----- coordinates (the plugin's own; Flutter's quick jump has none) -------------

/** Inverse of columnLabel in core/hex.ts: A → 0, Z → 25, AA → 26, -A → -1. */
function columnOf(label: string): number {
	if (label.startsWith('-')) return -columnOf(label.slice(1)) - 1;
	let n = 0;
	for (const ch of label) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** The cell a query names, if it is a coordinate: a display id ("F3",
 *  "aa12", as `displayIdFor` writes them) or an axial id ("q5_r-2",
 *  "q5 r-2"). Whether the cell is on the map is the caller's question. */
export function parseJumpCoords(query: string): [number, number] | null {
	const t = query.trim();
	const axial = /^q\s*(-?\d+)[\s_,]*r\s*(-?\d+)$/i.exec(t);
	if (axial) return [Number(axial[1]), Number(axial[2])];
	const display = /^(-?[A-Za-z]{1,3})(-?\d+)$/.exec(t);
	if (display) return [columnOf(display[1]!.toUpperCase()), Number(display[2]) - 1];
	return null;
}
