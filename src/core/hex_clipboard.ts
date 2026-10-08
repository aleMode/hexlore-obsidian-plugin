// Port of Flutter's lib/core/hex_clipboard.dart (decision 29): cut / copy /
// paste moves CONTENT; fog and the lattice stay put. In the plugin a hex's
// note list is one more field: the caller carries it beside the hexes.

import type { Hex } from './hex';
import { hexIdFor } from './hex_data';
import type { Thread } from './thread';

export class HexClipboard {
	readonly hexes: Hex[];

	constructor(
		readonly anchor: [number, number],
		hexes: Hex[],
		readonly isCut = false,
		readonly threads: Thread[] = [],
	) {
		this.hexes = hexes.map((h) => h.copy()).sort((a, b) => (a.q !== b.q ? a.q - b.q : a.r - b.r));
	}

	get length(): number {
		return this.hexes.length;
	}

	targetOf(h: { q: number; r: number }, q: number, r: number): [number, number] {
		return [q + h.q - this.anchor[0], r + h.r - this.anchor[1]];
	}

	idMapAt(q: number, r: number): Map<string, string> {
		return new Map(this.hexes.map((h) => [h.id, hexIdFor(...this.targetOf(h, q, r))]));
	}

	footprintAt(q: number, r: number): [number, number][] {
		return this.hexes.map((h) => this.targetOf(h, q, r));
	}
}

/** The top-left cell: least q, then least r. */
export function topLeftCell(cells: Iterable<[number, number]>): [number, number] {
	let best: [number, number] | null = null;
	for (const c of cells) if (!best || c[0] < best[0] || (c[0] === best[0] && c[1] < best[1])) best = c;
	if (!best) throw new Error('topLeftCell of no cells');
	return best;
}

export interface PasteFit {
	at: [number, number];
	footprint: [number, number][];
	/** Footprint cells outside the selection. */
	outside: [number, number][];
	/** Selection cells the paste leaves empty. */
	unfilled: [number, number][];
}

/** A paste lands at the selection's top-left cell. */
export function fitPaste(clip: { footprintAt(q: number, r: number): [number, number][] }, selection: [number, number][]): PasteFit {
	const at = topLeftCell(selection);
	const footprint = clip.footprintAt(at[0], at[1]);
	const key = ([q, r]: [number, number]) => `${q},${r}`;
	const sel = new Set(selection.map(key)), fp = new Set(footprint.map(key));
	return {
		at,
		footprint,
		outside: footprint.filter((c) => !sel.has(key(c))),
		unfilled: selection.filter((c) => !fp.has(key(c))),
	};
}

const SUFFIX = /^(.*\S) - (\d+)$/;

/** "Fort", then "Fort - 2", "Fort - 3"… for a name already taken. */
export function copyHexName(desired: string, taken: Set<string>): string {
	if (!taken.has(desired)) return desired;
	const m = SUFFIX.exec(desired);
	const base = m ? m[1]! : desired;
	let n = 2;
	while (taken.has(`${base} - ${n}`)) n++;
	return `${base} - ${n}`;
}

/** [src]'s content at (q, r): the TARGET keeps its own page links, NPCs,
 *  quests and fog; what this build does not understand travels with the
 *  content it belongs to. */
export function pastedHex(src: Hex, q: number, r: number, name: string | null, target?: Hex): Hex {
	const h = src.copyAt(q, r);
	h.name = name;
	h.pageFile = target?.pageFile ?? null;
	h.npcIds = [...(target?.npcIds ?? [])];
	h.questIds = [...(target?.questIds ?? [])];
	return h;
}
