// The party travels to a hex: from a travel vote (map panel, "Travel here")
// or the hex menu ("Move the party here…"). The GM confirms, chooses how much
// the party sees on arrival and checks the time it takes (the entered hex's
// cost from the Travel settings, editable: a boat, a forced march); then the
// party moves, its travel time grows, the votes are cleared and one line goes
// to the session log. The reveal is undoable; the move is set back by moving
// or placing the party again.

import { Modal, Notice, Setting, type App, type TFile } from 'obsidian';
import { displayIdFor } from '../core/hex';
import { hexIdFor } from '../core/hex_data';
import type { HexVotes } from '../core/travel_votes';
import type { Cell, MapEditor } from '../edit/editor';
import type { PartyControl } from '../party/party_control';
import { entryCost, formatHours, hexMiles } from '../party/travel';
import { logEvent } from './session_note';

export type TravelReveal = 'hex' | 'sight' | 'none';

/** The last choice, per device: the default next time. */
const REVEAL_KEY = 'hexlore-travel-reveal';

export interface TravelDeps {
	app: App;
	index: TFile;
	editor: MapEditor;
	party: PartyControl;
	/** Clears the travel votes (a trip from a vote settles it). */
	clearVotes?: () => void;
}

/** The hex's display id and name: "F3 · Oakwood", or "F3". */
export function placeName(editor: MapEditor, [q, r]: Cell): string {
	const name = editor.model.getHex(q, r)?.name;
	return `${displayIdFor(q, r)}${name ? ` · ${name}` : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Move the party to [cell], taking [hours]; reveal, settle the vote, log
 *  it. Returns the number of hexes newly revealed. */
export function travelTo(deps: TravelDeps, cell: Cell, hours: number, reveal: TravelReveal, vote?: HexVotes): number {
	const { editor, party, index } = deps;
	const settings = party.travelSettings();
	// One log line says it all: the reveal is not logged on its own.
	const revealed = editor.quietFog(() => (reveal === 'sight' ? editor.revealWithSight([cell]) : reveal === 'hex' ? editor.setRevealed([cell], true) : [])).length;
	const after = party.travel(index, hexIdFor(cell[0], cell[1]), hours);
	if (vote) deps.clearVotes?.();
	const cost = entryCost(editor.model, cell[0], cell[1], settings);
	const why = cost.hours !== null && Math.abs(cost.hours - hours) < 1e-9 ? `, ${cost.by}` : '';
	const parts = [`${formatHours(hours, settings.dayHours)}${why}`, `${formatHours(after.hours, settings.dayHours)} travelled`];
	if (vote) parts.push(`${plural(vote.voterNames.length, 'vote')}: ${vote.voterNames.join(', ')}`);
	if (revealed) parts.push(`revealed ${plural(revealed, 'hex', 'hexes')}`);
	const line = `Travelled to ${placeName(editor, cell)} (${parts.join('; ')})`;
	void logEvent(deps.app, index, line);
	new Notice(`${line}.`, 6000);
	return revealed;
}

export class TravelModal extends Modal {
	private reveal: TravelReveal;
	private hours: number | null;

	constructor(
		private readonly deps: TravelDeps,
		private readonly cell: Cell,
		private readonly vote?: HexVotes,
	) {
		super(deps.app);
		const saved: unknown = deps.app.loadLocalStorage(REVEAL_KEY);
		this.reveal = saved === 'hex' || saved === 'none' ? saved : 'sight';
		this.hours = entryCost(deps.editor.model, cell[0], cell[1], deps.party.travelSettings()).hours;
	}

	onOpen(): void {
		const { contentEl: el, deps, cell, vote } = this;
		const { editor, party, index } = deps;
		const settings = party.travelSettings();
		this.setTitle(`Travel to ${placeName(editor, cell)}?`);
		const from = party.state(index);
		const lines: string[] = [];
		if (vote) lines.push(`${plural(vote.voterNames.length, 'vote')}: ${vote.voterNames.join(', ')}. The votes are cleared.`);
		const m = from.hex ? /^q(-?\d+)_r(-?\d+)$/.exec(from.hex) : null;
		lines.push(m ? `The party is at ${placeName(editor, [Number(m[1]), Number(m[2])])}.` : 'The party is not on the map yet: it starts here.');
		el.createEl('p', { text: lines.join(' ') });

		const cost = entryCost(editor.model, cell[0], cell[1], settings);
		const scale = editor.model.meta.scale;
		const miles = Math.round(hexMiles(scale) * 10) / 10;
		const costDesc =
			cost.hours === null
				? `${cost.by.charAt(0).toUpperCase()}${cost.by.slice(1)} cannot be entered on foot (Travel settings): give the time by hand.`
				: `Entering a ${cost.by === 'default' ? 'blank' : cost.by} hex of ${scale.formatDistance(scale.hexDistance)}${scale.unit === 'km' ? ` (${miles} mi)` : ''}: ${formatHours(cost.hours, settings.dayHours)}. Change it for a boat, a forced march…`;
		const total = el.createDiv({ cls: 'setting-item-description' });
		const showTotal = () => total.setText(this.hours === null ? '' : `Time travelled so far: ${formatHours(from.hours, settings.dayHours)} → ${formatHours(from.hours + this.hours, settings.dayHours)} (days of ${settings.dayHours} h).`);
		new Setting(el)
			.setName('Time, in hours')
			.setDesc(costDesc)
			.addText((t) => {
				t.setPlaceholder('Hours').setValue(this.hours === null ? '' : String(Math.round(this.hours * 100) / 100));
				t.onChange((v) => {
					const n = Number(v);
					this.hours = v.trim() && Number.isFinite(n) && n >= 0 ? n : null;
					showTotal();
				});
			});
		el.appendChild(total);
		showTotal();
		new Setting(el)
			.setName('On arrival, reveal')
			.setDesc('Players see it on their next poll. Undo takes it back.')
			.addDropdown((d) =>
				d
					.addOption('sight', 'The hex and what is in sight')
					.addOption('hex', 'The hex only')
					.addOption('none', 'Nothing')
					.setValue(this.reveal)
					.onChange((v) => (this.reveal = v === 'hex' || v === 'none' ? v : 'sight')),
			);
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Travel')
					.setCta()
					.onClick(() => {
						if (this.hours === null) {
							new Notice('Give the time the trip takes, in hours (0 for none).');
							return;
						}
						this.app.saveLocalStorage(REVEAL_KEY, this.reveal);
						this.close();
						travelTo(deps, cell, this.hours, this.reveal, vote);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
