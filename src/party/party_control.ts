// The party on each map, from Obsidian: placed and moved by the GM (the hex
// menu, Travel here on a vote), with the time spent travelling. Kept in
// data.json (party/party.ts); the map view draws the marker, the map panel
// shows the time, and the player view shows the marker on a revealed hex.

import type { App, TFile } from 'obsidian';
import { noParty, renamePartyBook, type PartyBook, type PartyState } from './party';
import type { TravelSettings } from './travel';

/** Broadcast when a party moves or its time changes. */
export const PARTY_EVENT = 'hexlore:party';

export interface PartyHost {
	book: () => PartyBook;
	setBook: (b: PartyBook) => void;
	travel: () => TravelSettings;
	save: () => Promise<void>;
}

export class PartyControl {
	constructor(
		private readonly app: App,
		private readonly host: PartyHost,
	) {}

	/** The party on [index]'s map (not placed: hex null). */
	state(index: TFile | string | null): PartyState {
		if (!index) return noParty();
		const path = typeof index === 'string' ? index : index.path;
		return { ...(this.host.book()[path] ?? noParty()) };
	}

	travelSettings(): TravelSettings {
		return this.host.travel();
	}

	/** Move the party to [hex], adding [hours] to its travel time. */
	travel(index: TFile, hex: string, hours: number): PartyState {
		const now = this.state(index);
		return this.set(index, { hex, hours: now.hours + Math.max(0, hours) });
	}

	/** Put the party on [hex] (null: take it off the map), time unchanged. */
	place(index: TFile, hex: string | null): PartyState {
		return this.set(index, { ...this.state(index), hex });
	}

	setHours(index: TFile, hours: number): PartyState {
		return this.set(index, { ...this.state(index), hours: Math.max(0, hours) });
	}

	/** A map (or a folder above it) was renamed: its party follows. */
	renamed(from: string, to: string): void {
		const next = renamePartyBook(this.host.book(), from, to);
		if (!next) return;
		this.host.setBook(next);
		void this.host.save();
	}

	private set(index: TFile, s: PartyState): PartyState {
		this.host.setBook({ ...this.host.book(), [index.path]: s });
		void this.host.save();
		this.app.workspace.trigger(PARTY_EVENT, index);
		return { ...s };
	}
}
