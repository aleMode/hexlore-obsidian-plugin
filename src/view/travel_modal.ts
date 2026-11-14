// "Travel here" on a travel vote (map panel): the GM confirms, chooses how
// much the party sees on arrival, and the vote is settled — the hex
// revealed (alone or with line of sight), the votes cleared for the next
// one, a line added to the session note. Changing the fog is undoable.

import { Modal, Notice, Setting, type App, type TFile } from 'obsidian';
import { displayIdFor } from '../core/hex';
import type { HexVotes } from '../core/travel_votes';
import type { Cell, MapEditor } from '../edit/editor';
import { appendToSessionNote } from './encounter_roller';

export type TravelReveal = 'hex' | 'sight';

/** The last choice, per device: the default next time. */
const REVEAL_KEY = 'hexlore-travel-reveal';

export interface TravelDeps {
	app: App;
	index: TFile;
	editor: MapEditor;
	clearVotes: () => void;
}

/** The hex's name, else its display id ("F3"). */
export function placeName(editor: MapEditor, [q, r]: Cell): string {
	return editor.model.getHex(q, r)?.name || displayIdFor(q, r);
}

/** Settle the vote for [vote]: reveal, clear the votes, note it. Returns the
 *  number of hexes newly revealed. */
export async function travelTo(deps: TravelDeps, cell: Cell, vote: HexVotes, reveal: TravelReveal): Promise<number> {
	const { editor } = deps;
	const changed = reveal === 'sight' ? editor.revealWithSight([cell]).length : editor.setRevealed([cell], true).length;
	deps.clearVotes();
	const n = vote.voterNames.length;
	const what = `Travelled to ${placeName(editor, cell)} (${n} vote${n === 1 ? '' : 's'}: ${vote.voterNames.join(', ')})`;
	new Notice(`${what}. ${changed ? `Revealed ${changed} hex${changed === 1 ? '' : 'es'}` : 'Nothing new revealed'}.`, 5000);
	await appendToSessionNote(deps.app, deps.index, what);
	return changed;
}

export class TravelModal extends Modal {
	private reveal: TravelReveal;

	constructor(
		private readonly deps: TravelDeps,
		private readonly cell: Cell,
		private readonly vote: HexVotes,
	) {
		super(deps.app);
		this.reveal = deps.app.loadLocalStorage(REVEAL_KEY) === 'hex' ? 'hex' : 'sight';
	}

	onOpen(): void {
		const { contentEl: el, deps, cell, vote } = this;
		const name = placeName(deps.editor, cell);
		this.setTitle(`Travel to ${name}?`);
		const n = vote.voterNames.length;
		el.createEl('p', { text: `${n} vote${n === 1 ? '' : 's'}: ${vote.voterNames.join(', ')}. The votes are cleared and the trip is added to the session note.` });
		new Setting(el)
			.setName('On arrival, reveal')
			.setDesc('Players see it on their next poll. Undo takes it back.')
			.addDropdown((d) =>
				d
					.addOption('sight', 'The hex and what is in sight')
					.addOption('hex', 'The hex only')
					.setValue(this.reveal)
					.onChange((v) => (this.reveal = v === 'hex' ? 'hex' : 'sight')),
			);
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Travel')
					.setCta()
					.onClick(() => {
						this.app.saveLocalStorage(REVEAL_KEY, this.reveal);
						this.close();
						void travelTo(deps, cell, vote, this.reveal);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
