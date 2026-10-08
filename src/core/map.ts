// The map: everything in a campaign's data folder that the plugin edits.
// (Flutter's Campaign, minus what Obsidian notes replace: NPCs, quests,
// adventures, entries and pages.)
//
// Player fog is a SET of hex ids (player/revealed.json), not a hex flag:
// a revealed cell need not have a record (decision 5).

import { CampaignMeta } from './campaign_meta';
import { cellInGrid } from './geometry';
import { Hex } from './hex';
import { hexIdFor } from './hex_data';
import type { Region } from './region';
import type { HexifyRecord, SketchDocument } from './sketch';
import type { River } from './river';
import type { Route } from './route';
import type { Thread } from './thread';

export class MapModel {
	meta = new CampaignMeta();
	/** Keyed by hex id ("q0_r0"). */
	readonly hexes = new Map<string, Hex>();
	readonly rivers = new Map<string, River>();
	readonly routes = new Map<string, Route>();
	readonly regions = new Map<string, Region>();
	readonly threads = new Map<string, Thread>();
	/** Player fog: the revealed hex ids. */
	readonly revealed = new Set<string>();
	/** The sketch layer (GM-only) and what the last Hexify wrote; null when
	 *  the map has none. */
	sketch: SketchDocument | null = null;
	hexified: HexifyRecord | null = null;

	getHex(q: number, r: number): Hex | undefined {
		return this.hexes.get(hexIdFor(q, r));
	}

	getOrCreateHex(q: number, r: number): Hex {
		const id = hexIdFor(q, r);
		let h = this.hexes.get(id);
		if (!h) this.hexes.set(id, (h = new Hex(q, r)));
		return h;
	}

	inGrid(q: number, r: number): boolean {
		return cellInGrid(q, r, this.meta.grid);
	}

	nextId(prefix: 'river' | 'route' | 'region' | 'thread'): string {
		const existing = { river: this.rivers, route: this.routes, region: this.regions, thread: this.threads }[prefix];
		for (let n = 1; ; n++) {
			const id = `${prefix}_${String(n).padStart(3, '0')}`;
			if (!existing.has(id)) return id;
		}
	}

	/** [desired], or "desired 2", "desired 3"… if another hex has it (hex
	 *  names stay unique: in Flutter they are link targets). */
	uniqueHexName(desired: string, excludeHexId?: string): string {
		const taken = new Set<string>();
		for (const [id, h] of this.hexes) if (h.name && id !== excludeHexId) taken.add(h.name);
		if (!taken.has(desired)) return desired;
		let n = 2;
		while (taken.has(`${desired} ${n}`)) n++;
		return `${desired} ${n}`;
	}

	threadsForHex(hexId: string): Thread[] {
		return [...this.threads.values()].filter((t) => t.fromHex === hexId || t.toHex === hexId);
	}
}
