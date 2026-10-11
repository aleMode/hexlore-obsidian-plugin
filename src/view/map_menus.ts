// The dialogs behind the top bar's menus (the Flutter title bar's entries,
// decision 30): new map, open map, quick jump, map scale, unassigned
// characters and quests, and the stylus diagnostics.

import { FuzzySuggestModal, Modal, Notice, Setting, SuggestModal, TFile, normalizePath, type App } from 'obsidian';
import { CampaignMeta } from '../core/campaign_meta';
import { MapScale, type DistanceUnit } from '../core/map_scale';
import { RIVER_WIDTH_MAX, RIVER_WIDTH_MIN } from '../core/river';
import { rankEntries, type JumpEntry } from '../core/quick_jump';
import { encodeJsonLines } from '../core/json';
import { safeNoteName } from '../notes/note_meta';
import { WheelClassifier } from './wheel_intent';

// ----- new map -------------------------------------------------------------------------

/** Create `<folder>/<name>.hexmap.md` and its data folder with a format-2
 *  `campaign.json`: an empty map the plugin (and the Flutter app) open. */
export async function createMap(app: App, folder: string, name: string, cols: number, rows: number): Promise<TFile> {
	const safe = safeNoteName(name);
	const dir = folder && folder !== '/' ? `${normalizePath(folder)}/` : '';
	let base = safe;
	for (let n = 2; app.vault.getAbstractFileByPath(`${dir}${base}.hexmap.md`) || app.vault.getAbstractFileByPath(`${dir}${base}.hexlore`); n++) base = `${safe} ${n}`;
	const meta = new CampaignMeta();
	meta.name = name.trim() || base;
	meta.gridCols = Math.max(1, Math.round(cols));
	meta.gridRows = Math.max(1, Math.round(rows));
	if (dir && !app.vault.getAbstractFileByPath(dir.slice(0, -1))) await app.vault.createFolder(dir.slice(0, -1)).catch(() => undefined);
	await app.vault.createFolder(`${dir}${base}.hexlore`).catch(() => undefined);
	await app.vault.create(`${dir}${base}.hexlore/campaign.json`, encodeJsonLines(meta.toJson()));
	const index = [
		'---',
		'hexlore-plugin: map',
		'hexlore-index: 1',
		`format: ${meta.format}`,
		`data: ${JSON.stringify(`${base}.hexlore`)}`,
		'---',
		'',
		`# ${meta.name}`,
		'',
		`A HexLore map. Open it with the HexLore plugin; its data is in \`${base}.hexlore/\`.`,
		'',
	].join('\n');
	return app.vault.create(`${dir}${base}.hexmap.md`, index);
}

export class NewMapModal extends Modal {
	constructor(
		app: App,
		private readonly folder: string,
		private readonly done: (file: TFile) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('New map');
		let name = '';
		let folder = this.folder;
		let cols = 20, rows = 15;
		new Setting(this.contentEl).setName('Name').addText((t) => {
			t.setPlaceholder('My campaign').onChange((v) => (name = v));
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl)
			.setName('Folder')
			.setDesc('Where the map note and its data folder go (empty: the vault root).')
			.addText((t) => t.setValue(folder).onChange((v) => (folder = v.trim())));
		new Setting(this.contentEl)
			.setName('Grid')
			.setDesc('Columns × rows; it can be resized later.')
			.addText((t) => t.setValue(String(cols)).onChange((v) => (cols = Number(v) || cols)))
			.addText((t) => t.setValue(String(rows)).onChange((v) => (rows = Number(v) || rows)));
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('Create')
				.setCta()
				.onClick(async () => {
					if (!name.trim()) {
						new Notice('Give the map a name.');
						return;
					}
					try {
						const file = await createMap(this.app, folder, name, cols, rows);
						this.close();
						this.done(file);
					} catch (e) {
						new Notice(`Could not create the map: ${(e as Error).message}`);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ----- open map --------------------------------------------------------------------------

export class MapPicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly isMap: (f: TFile) => boolean,
		private readonly choose: (f: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('Open a map');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => this.isMap(f));
	}

	getItemText(f: TFile): string {
		return f.path.replace(/\.hexmap\.md$|\.md$/, '');
	}

	onChooseItem(f: TFile): void {
		this.choose(f);
	}
}

// ----- quick jump --------------------------------------------------------------------------

export interface JumpTarget extends JumpEntry {
	/** The hexes to show (empty for a note on no hex: it just opens). */
	hexes: Set<string>;
	file: TFile | null;
}

export class QuickJumpModal extends SuggestModal<JumpTarget> {
	constructor(
		app: App,
		private readonly entries: JumpTarget[],
		private readonly go: (t: JumpTarget) => void,
	) {
		super(app);
		this.setPlaceholder('Jump to a hex, a region, a place, a character, a quest…');
	}

	getSuggestions(query: string): JumpTarget[] {
		return rankEntries(query, this.entries);
	}

	renderSuggestion(t: JumpTarget, el: HTMLElement): void {
		el.createDiv({ text: t.label });
		el.createDiv({ cls: 'hexlore-jump-kind', text: KIND_LABEL[t.kind] ?? t.kind });
	}

	onChooseSuggestion(t: JumpTarget): void {
		this.go(t);
	}
}

const KIND_LABEL: Record<string, string> = {
	hex: 'Hex',
	region: 'Region',
	place: 'Place',
	npc: 'Character',
	quest: 'Quest',
	adventure: 'Adventure',
	note: 'Note',
};

// ----- map scale ----------------------------------------------------------------------------

export class ScaleModal extends Modal {
	constructor(
		app: App,
		private readonly current: MapScale,
		private readonly accept: (s: MapScale) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Map scale');
		this.contentEl.createEl('p', { cls: 'setting-item-description', text: 'What one hex measures, centre to centre: the ruler and the scale bar use it.' });
		let distance = this.current.hexDistance;
		let unit: DistanceUnit = this.current.unit;
		new Setting(this.contentEl)
			.setName('One hex')
			.addText((t) => t.setValue(String(distance)).onChange((v) => (distance = Number(v.replace(',', '.')))))
			.addDropdown((d) =>
				d
					.addOption('mi', 'Miles')
					.addOption('km', 'Kilometres')
					.setValue(unit)
					.onChange((v) => (unit = v === 'km' ? 'km' : 'mi')),
			);
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					if (!(distance > 0) || !Number.isFinite(distance)) {
						new Notice('The distance must be a positive number.');
						return;
					}
					this.close();
					this.accept(new MapScale(distance, unit));
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ----- river width -------------------------------------------------------------------

/** The river menu's width presets (River.width: 1 = the default stroke). */
export const RIVER_WIDTH_PRESETS: readonly [label: string, width: number][] = [
	['Stream', 0.5],
	['River', 1],
	['Wide river', 1.75],
	['Great river', 3],
];

/** Flutter's river width editor: − value +, 0.1 steps, applied live; one
 *  undo step for the whole session (sealed when it closes). */
export class RiverWidthModal extends Modal {
	constructor(
		app: App,
		private readonly width: () => number | null,
		private readonly apply: (w: number) => void,
		private readonly done: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('River width');
		const row = new Setting(this.contentEl).setName('Width').setDesc(`From ${RIVER_WIDTH_MIN} to ${RIVER_WIDTH_MAX}; 1 is a normal river.`);
		let value: HTMLElement;
		const show = () => value.setText((this.width() ?? 1).toFixed(1));
		const step = (d: number) => {
			const w = this.width();
			if (w === null) return this.close();
			this.apply(Math.min(RIVER_WIDTH_MAX, Math.max(RIVER_WIDTH_MIN, Math.round((w + d) * 10) / 10)));
			show();
		};
		row.addExtraButton((b) => b.setIcon('minus').setTooltip('Narrower').onClick(() => step(-0.1)));
		value = row.controlEl.createSpan({ cls: 'hexlore-river-width' });
		row.addExtraButton((b) => b.setIcon('plus').setTooltip('Wider').onClick(() => step(0.1)));
		show();
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Done').setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.done();
		this.contentEl.empty();
	}
}

// ----- unassigned characters and quests -------------------------------------------------------

export interface Unassigned {
	file: TFile;
	kind: 'npc' | 'quest';
}

/** Characters and quests that are on no hex: open one, or put it on the
 *  selected hex (Flutter's "Unassigned entities…"). */
export class UnassignedModal extends Modal {
	constructor(
		app: App,
		private readonly items: Unassigned[],
		private readonly selected: string | null,
		private readonly openNote: (f: TFile) => void,
		private readonly assign: (f: TFile) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Unassigned characters and quests');
		const el = this.contentEl;
		if (!this.items.length) {
			el.createEl('p', { text: 'Every character and quest is on a hex (directly, or through its place).' });
			return;
		}
		el.createEl('p', {
			cls: 'setting-item-description',
			text: this.selected ? `Put one on the selected hex (${this.selected}), or open it to set its place.` : 'Open one to set its place, or select a hex on the map first to put it there.',
		});
		for (const it of this.items) {
			const s = new Setting(el).setName(it.file.basename).setDesc(it.kind === 'npc' ? 'Character' : 'Quest');
			s.addButton((b) =>
				b.setButtonText('Open').onClick(() => {
					this.close();
					this.openNote(it.file);
				}),
			);
			if (this.selected) {
				s.addButton((b) =>
					b
						.setButtonText('Put on the selected hex')
						.setCta()
						.onClick(() => {
							this.assign(it.file);
							s.settingEl.remove();
						}),
				);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ----- stylus diagnostics ------------------------------------------------------------------------

/** What the pen reports (Flutter's stylus probe; plan §4 V8): draw here and
 *  read pressure, tilt and buttons live. */
export class StylusProbeModal extends Modal {
	onOpen(): void {
		this.setTitle('Pen and trackpad diagnostics');
		const el = this.contentEl;
		el.createEl('p', { cls: 'setting-item-description', text: 'Draw in the box with your pen. Pressure should change as you press; a pen that always reports 0.5 (or 0) has no pressure here — on Windows, turn on the ink setting in the tablet driver.' });
		const pad = el.createDiv({ cls: 'hexlore-stylus-pad' });
		const read = el.createDiv({ cls: 'hexlore-stylus-read', text: 'Waiting for the pen…' });
		const seen = new Set<number>();
		let min = 1, max = 0;
		const show = (e: PointerEvent) => {
			if (e.buttons) {
				seen.add(Math.round(e.pressure * 100));
				min = Math.min(min, e.pressure);
				max = Math.max(max, e.pressure);
			}
			read.setText(
				`Device: ${e.pointerType} · pressure ${e.pressure.toFixed(2)} (seen ${min <= max ? `${min.toFixed(2)}–${max.toFixed(2)}` : '—'}, ${seen.size} levels) · tilt ${e.tiltX}°, ${e.tiltY}° · buttons ${e.buttons}${e.button === 5 || (e.buttons & 32) !== 0 ? ' (eraser end)' : ''}`,
			);
		};
		pad.addEventListener('pointerdown', show);
		pad.addEventListener('pointermove', show);

		el.createEl('p', { cls: 'setting-item-description', text: 'Scroll with two fingers, pinch, or turn the mouse wheel in the box: each event, and what the map does with it.' });
		const wheelPad = el.createDiv({ cls: 'hexlore-stylus-pad is-wheel' });
		const wheelRead = el.createDiv({ cls: 'hexlore-stylus-read', text: 'Waiting for a scroll…' });
		const wheel = new WheelClassifier();
		const lines: string[] = [];
		wheelPad.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault();
				const intent = wheel.classify(e);
				lines.unshift(`${intent === 'pan' ? 'pan ' : 'zoom'} · dx ${e.deltaX} · dy ${e.deltaY} · mode ${e.deltaMode}${e.ctrlKey ? ' · ctrl (pinch)' : ''}`);
				lines.length = Math.min(lines.length, 8);
				wheelRead.setText(lines.join('\n'));
			},
			{ passive: false },
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
