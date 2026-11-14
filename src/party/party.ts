// Where the party is on each map, and how long it has travelled: plugin
// session-keeping, kept in the plugin's data.json by index path (like the
// "Show maps together" layout), never in the map files or the index, so the
// shared format does not change. Pure.

export interface PartyState {
	/** The party's hex ("q5_r-2"), or null when not placed. */
	hex: string | null;
	/** Time spent travelling, in hours (see party/travel.ts). */
	hours: number;
}

/** Index path → the party on that map. */
export type PartyBook = Record<string, PartyState>;

export const noParty = (): PartyState => ({ hex: null, hours: 0 });

export function readPartyBook(raw: unknown): PartyBook {
	const out: PartyBook = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [path, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== 'object') continue;
		const o = v as Record<string, unknown>;
		const hex = typeof o.hex === 'string' && /^q-?\d+_r-?\d+$/.test(o.hex) ? o.hex : null;
		const hours = typeof o.hours === 'number' && Number.isFinite(o.hours) && o.hours >= 0 ? o.hours : 0;
		out[path] = { hex, hours };
	}
	return out;
}

/** [book] after [from] (a map index or a folder above it) became [to];
 *  null when nothing moved. */
export function renamePartyBook(book: PartyBook, from: string, to: string): PartyBook | null {
	let changed = false;
	const out: PartyBook = {};
	for (const [p, v] of Object.entries(book)) {
		const n = p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p;
		if (n !== p) changed = true;
		out[n] = v;
	}
	return changed ? out : null;
}
