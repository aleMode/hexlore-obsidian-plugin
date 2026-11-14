// "Hexify the sketch" (decision 19; Flutter's app/hexify_dialog.dart): the
// sketch → per-cell paint + rivers + routes, merged through the import plan
// (one undo step), with a live tally of what Apply will do.

import { Modal, Notice, Setting, type App } from 'obsidian';
import { planImport, type ImportMode, type ImportPlan } from '../core/import_plan';
import { HexifyRecord } from '../core/sketch';
import type { MapEditor } from '../edit/editor';
import { MOD } from './a11y';
import { hexifySketch, protectHandEdits, type HexifyResult, type ProtectedHexify } from '../sketch/hexify';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class HexifyModal extends Modal {
	private mode: ImportMode = 'overwrite';
	private coverage = 0.5;
	private fillSea = false;
	private autoResize = true;
	private keepHandEdits = true;
	private replaceOwnLines = true;
	private result: HexifyResult | null = null;
	private protectedRes: ProtectedHexify | null = null;
	private plan: ImportPlan | null = null;
	private tally!: HTMLElement;

	constructor(
		app: App,
		private readonly editor: MapEditor,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Hexify the sketch');
		const el = this.contentEl;
		el.createEl('p', { cls: 'setting-item-description', text: 'Biome swatches paint the hexes they cover; river, road and trail strokes become lines along the hex edges. Ink and labels are notes only.' });
		new Setting(el).setName('Hexes already painted').addDropdown((d) =>
			d
				.addOption('overwrite', 'Overwrite: covered hexes take the sketch')
				.addOption('skipOccupied', 'Fill gaps only: painted hexes stay')
				.addOption('replaceAll', 'Replace everything: clear the map first')
				.setValue(this.mode)
				.onChange((v) => {
					this.mode = v as ImportMode;
					this.replan();
				}),
		);
		const cov = new Setting(el).setName('Coverage needed').setDesc(`${Math.round(this.coverage * 100)} % of a hex`);
		cov.addSlider((s) =>
			s
				.setLimits(0.2, 0.9, 0.05)
				.setValue(this.coverage)
				.onChange((v) => {
					this.coverage = v;
					cov.setDesc(`${Math.round(v * 100)} % of a hex`);
					this.recompute();
				}),
		);
		new Setting(el).setName('Undrawn hexes inside the sketch become sea').addToggle((t) =>
			t.setValue(this.fillSea).onChange((v) => {
				this.fillSea = v;
				this.recompute();
			}),
		);
		if (this.editor.model.hexified && !this.editor.model.hexified.isEmpty) {
			new Setting(el).setName('Keep hexes edited by hand since the last run').addToggle((t) =>
				t.setValue(this.keepHandEdits).onChange((v) => {
					this.keepHandEdits = v;
					this.replan();
				}),
			);
			new Setting(el).setName('Replace the rivers and roads the last run made').addToggle((t) =>
				t.setValue(this.replaceOwnLines).onChange((v) => {
					this.replaceOwnLines = v;
					this.replan();
				}),
			);
		}
		new Setting(el).setName('Grow the grid to fit').addToggle((t) =>
			t.setValue(this.autoResize).onChange((v) => {
				this.autoResize = v;
				this.replan();
			}),
		);
		this.tally = el.createDiv({ cls: 'hexlore-hexify-tally' });
		new Setting(el)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Hexify')
					.setCta()
					.onClick(() => this.apply()),
			);
		this.recompute();
	}

	private recompute(): void {
		this.result = hexifySketch(this.editor.sketch, { minCoverage: this.coverage, fillSea: this.fillSea });
		this.replan();
	}

	private replan(): void {
		const r = this.result;
		if (!r) return;
		const m = this.editor.model;
		const p = protectHandEdits(r, m.hexified ?? new HexifyRecord(), (q, rr) => m.getHex(q, rr), m.rivers.keys(), m.routes.keys(), this.keepHandEdits, this.replaceOwnLines);
		this.protectedRes = p;
		const hexes = [...m.hexes.values()];
		this.plan = planImport({
			entries: p.cells,
			mode: this.mode,
			autoResize: this.autoResize,
			currentWindow: m.meta.grid,
			existingCells: hexes.map((h): [number, number] => [h.q, h.r]),
			occupiedCells: new Set(hexes.filter((h) => h.terrain !== 'default' || h.feature !== null).map((h) => `${h.q},${h.r}`)),
			rivers: r.rivers,
			routes: r.routes,
			removeRivers: p.removeRivers,
			removeRoutes: p.removeRoutes,
		});
		const plan = this.plan;
		const empty = !r.cells.length && !r.rivers.length && !r.routes.length;
		this.tally.setText(
			empty
				? 'Nothing to hexify: draw with a biome, river or road swatch (ink is annotation only).'
				: [
						`${plural(plan.writes.length, 'hex', 'hexes')} painted`,
						plan.rivers.length ? plural(plan.rivers.length, 'river') : '',
						plan.routes.length ? plural(plan.routes.length, 'route') : '',
						plan.clears.length ? `${plan.clears.length} cleared` : '',
						plan.skippedOccupied ? `${plan.skippedOccupied} left as painted` : '',
						plan.skippedOutside ? `${plan.skippedOutside} outside the grid` : '',
						p.protectedCells ? `${p.protectedCells} kept as hand-edited` : '',
						plan.removeRivers.length + plan.removeRoutes.length ? `${plan.removeRivers.length + plan.removeRoutes.length} earlier lines replaced` : '',
						plan.window ? 'grid resized' : '',
					]
						.filter((x) => x)
						.join(' · '),
		);
		this.tally.toggleClass('mod-warning', empty);
	}

	private apply(): void {
		const plan = this.plan;
		if (!plan || (!plan.writes.length && !plan.clears.length && !plan.rivers.length && !plan.routes.length && !plan.removeRivers.length && !plan.removeRoutes.length && !plan.window)) {
			new Notice('Nothing to hexify.');
			return;
		}
		const out = this.editor.applyImport(plan, true);
		new Notice(`Hexify: ${plural(out.applied, 'hex', 'hexes')} painted${out.riversAdded ? `, ${plural(out.riversAdded, 'river')}` : ''}${out.routesAdded ? `, ${plural(out.routesAdded, 'route')}` : ''}. Undo with ${MOD}+Z in the hex view.`, 6000);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

