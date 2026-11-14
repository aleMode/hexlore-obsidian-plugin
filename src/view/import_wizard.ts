// "Import map image…" (plan item 2.9, decision 12): the importer's wizard.
// Thin wiring over src/importer/ (all the deciding is there and tested).
// Five steps, as in the Flutter app: pick an image from the vault, calibrate
// the grid from two clicks, review the recognised groups (with a per-hex fix
// brush), draw or trace rivers, place the result and apply it — ONE undo
// step. Confirmed groups teach the libraries; the picture can stay as the
// map's underlay.

import { FuzzySuggestModal, Modal, Notice, Setting, TFile, normalizePath, type App } from 'obsidian';
import { HEX_RADIUS, axialToPixel, cellsInRect, gridPixelBounds, hexCorners, hexesWithin, nodePixel, pixelToAxial } from '../core/geometry';
import { FEATURES, TERRAINS, terrainColors, type Feature, type Terrain } from '../core/hex_data';
import { PaintPick } from '../core/hex_paint';
import { planImport, type ImportMode, type ImportPlan } from '../core/import_plan';
import { nearestAnchorAxial, pixelToAxialF, riverWidthMultiplier } from '../core/river_snap';
import type { MapEditor } from '../edit/editor';
import { DEFAULT_CASCADE, gatherEvidence, groupEvidence, type CascadeGroup, type HexEvidence } from '../importer/classifier_cascade';
import { sourceCells, type SourceGrid } from '../importer/grid_calibration';
import { sampleHexes } from '../importer/hex_sampler';
import { ImportSession, RiverDraft, drawnRiver, snapPolyline } from '../importer/import_session';
import { buildInkMask, describeCell } from '../importer/ink_mask';
import { ImportLibraries } from '../importer/libraries';
import { PNG_PATCHES } from '../importer/png_codec';
import type { Raster } from '../importer/raster';
import { RIVER_DEBUG_STAGES, renderRiverDebugStage, type RiverDebugStage } from '../importer/river_debug';
import { DEFAULT_TRACE, suggestRiverSeeds, traceRiversDebug, type RiverTraceParams } from '../importer/river_tracer';
import { UnderlayConfig } from '../importer/underlay';
import { ART } from '../render/art';
import type { Anchor } from '../core/river';
import { MOD } from './a11y';

type Step = 'pick' | 'calibrate' | 'review' | 'rivers' | 'place';
const STEPS: { id: Step; label: string }[] = [
	{ id: 'pick', label: 'Image' },
	{ id: 'calibrate', label: 'Grid' },
	{ id: 'review', label: 'Terrain' },
	{ id: 'rivers', label: 'Rivers' },
	{ id: 'place', label: 'Place' },
];

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
export const UNDERLAY_CONFIG = 'import/underlay.json';
const LIBRARIES_FILE = 'import-libraries.json';

export interface ImportTarget {
	app: App;
	editor: MapEditor;
	index: TFile;
	dataDir: string;
	/** The plugin's folder (for the libraries file). */
	pluginDir: string;
	/** The map's underlay changed (shown in the map view). */
	underlayChanged: () => void;
}

/** Load a vault image into an element and an RGBA raster. */
async function loadRaster(app: App, file: TFile): Promise<{ img: HTMLImageElement; raster: Raster }> {
	const img = new Image();
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('the image could not be read'));
		img.src = app.vault.getResourcePath(file);
	});
	const c = createEl('canvas');
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	ctx.drawImage(img, 0, 0);
	const data = ctx.getImageData(0, 0, c.width, c.height);
	return { img, raster: { width: data.width, height: data.height, data: data.data } };
}

const rasterCanvas = (r: Raster): HTMLCanvasElement => {
	const c = createEl('canvas');
	c.width = r.width;
	c.height = r.height;
	c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
	return c;
};

const yieldFrame = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** Read / write the libraries in the plugin's folder (Flutter's format). */
async function loadLibraries(app: App, pluginDir: string): Promise<ImportLibraries> {
	const path = normalizePath(`${pluginDir}/${LIBRARIES_FILE}`);
	try {
		if (!(await app.vault.adapter.exists(path))) return new ImportLibraries();
		const lib = ImportLibraries.fromJson(JSON.parse(await app.vault.adapter.read(path)), PNG_PATCHES);
		lib.pruneConflicts();
		return lib;
	} catch {
		return new ImportLibraries();
	}
}

async function saveLibraries(app: App, pluginDir: string, lib: ImportLibraries): Promise<void> {
	await app.vault.adapter.write(normalizePath(`${pluginDir}/${LIBRARIES_FILE}`), JSON.stringify(lib.toJson(PNG_PATCHES), null, 2));
}

// ----- a pan / zoom stage over the source image ------------------------------------

interface StageHooks {
	draw(c: CanvasRenderingContext2D, k: number): void;
	/** Primary-button press in IMAGE px; return true to own the drag. */
	down?(x: number, y: number, e: PointerEvent): boolean;
	move?(x: number, y: number, e: PointerEvent): void;
	up?(x: number, y: number, e: PointerEvent): void;
	hover?(x: number, y: number): void;
}

class ImageStage {
	readonly el: HTMLElement;
	private readonly cnv: HTMLCanvasElement;
	scale = 1;
	ox = 0;
	oy = 0;
	private pan: { x: number; y: number } | null = null;
	private owned = false;
	private frame = 0;
	hooks: StageHooks | null = null;

	constructor(
		parent: HTMLElement,
		private readonly img: CanvasImageSource & { width: number; height: number },
	) {
		this.el = parent.createDiv({ cls: 'hexlore-import-stage' });
		this.cnv = this.el.createEl('canvas');
		const local = (e: MouseEvent): [number, number] => {
			const r = this.cnv.getBoundingClientRect();
			return [(e.clientX - r.left - this.ox) / this.scale, (e.clientY - r.top - this.oy) / this.scale];
		};
		this.cnv.addEventListener('pointerdown', (e) => {
			this.cnv.setPointerCapture(e.pointerId);
			if (e.button === 0 && !e.shiftKey && this.hooks?.down?.(...local(e), e)) {
				this.owned = true;
				return;
			}
			if (e.button === 0 || e.button === 1 || e.button === 2) this.pan = { x: e.clientX, y: e.clientY };
		});
		this.cnv.addEventListener('pointermove', (e) => {
			if (this.owned) this.hooks?.move?.(...local(e), e);
			else if (this.pan) {
				this.ox += e.clientX - this.pan.x;
				this.oy += e.clientY - this.pan.y;
				this.pan = { x: e.clientX, y: e.clientY };
				this.redraw();
			} else this.hooks?.hover?.(...local(e));
		});
		const end = (e: PointerEvent) => {
			if (this.owned) this.hooks?.up?.(...local(e), e);
			this.owned = false;
			this.pan = null;
		};
		this.cnv.addEventListener('pointerup', end);
		this.cnv.addEventListener('pointercancel', end);
		this.cnv.addEventListener('contextmenu', (e) => e.preventDefault());
		this.cnv.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault();
				const r = this.cnv.getBoundingClientRect();
				const sx = e.clientX - r.left, sy = e.clientY - r.top;
				const f = Math.pow(1.15, -e.deltaY / 100);
				const next = Math.min(16, Math.max(0.02, this.scale * f));
				this.ox = sx - ((sx - this.ox) * next) / this.scale;
				this.oy = sy - ((sy - this.oy) * next) / this.scale;
				this.scale = next;
				this.redraw();
			},
			{ passive: false },
		);
		new ResizeObserver(() => this.redraw()).observe(this.el);
	}

	fit(): void {
		const r = this.el.getBoundingClientRect();
		if (!r.width || !r.height) return;
		this.scale = Math.min(r.width / this.img.width, r.height / this.img.height) * 0.95;
		this.ox = (r.width - this.img.width * this.scale) / 2;
		this.oy = (r.height - this.img.height * this.scale) / 2;
		this.redraw();
	}

	redraw(): void {
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			const r = this.el.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			this.cnv.width = Math.max(1, Math.round(r.width * dpr));
			this.cnv.height = Math.max(1, Math.round(r.height * dpr));
			const c = this.cnv.getContext('2d')!;
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.fillStyle = '#1A1A2E';
			c.fillRect(0, 0, this.cnv.width, this.cnv.height);
			c.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, this.ox * dpr, this.oy * dpr);
			c.imageSmoothingEnabled = this.scale < 2;
			c.drawImage(this.img, 0, 0);
			this.hooks?.draw(c, 1 / this.scale);
		});
	}
}

/** A hex outline in image px. */
function hexOutline(c: CanvasRenderingContext2D, grid: SourceGrid, q: number, r: number): void {
	const [cx, cy] = grid.centerOf(q, r);
	const flat = grid.orientation === 'flat';
	for (let i = 0; i < 6; i++) {
		const a = ((flat ? 0 : 30) + 60 * i) * (Math.PI / 180);
		const x = cx + grid.radius * Math.cos(a), y = cy + grid.radius * Math.sin(a);
		if (i) c.lineTo(x, y);
		else c.moveTo(x, y);
	}
	c.closePath();
}

/** An anchor (source-axial, scene geometry) → image px on [grid]. */
function anchorOnImage(grid: SourceGrid, a: Anchor): [number, number] {
	const [x, y] = nodePixel(a.kind, a.q, a.r, a.k);
	return grid.centerOfF(...pixelToAxialF(x, y));
}

// ----- the wizard ----------------------------------------------------------------------

export class ImportWizard extends Modal {
	private step: Step = 'pick';
	private file: TFile | null = null;
	private img: HTMLImageElement | null = null;
	private session: ImportSession | null = null;
	private libraries: ImportLibraries | null = null;
	private stage: ImageStage | null = null;
	private clicks: [number, number][] = [];
	private body!: HTMLElement;
	private side!: HTMLElement;
	private nav!: HTMLElement;
	private busy = '';
	// Review
	private order: CascadeGroup[] = [];
	private selected: CascadeGroup | null = null;
	private touched = new Set<CascadeGroup>();
	private sensitivity = DEFAULT_CASCADE.structureConfirm;
	private brush: { on: boolean; pick: PaintPick; radius: number } = { on: false, pick: PaintPick.biome('forest'), radius: 0 };
	// Rivers
	private riverMode: 'draw' | 'edit' = 'draw';
	private drawWidthPx = 6;
	private stroke: [number, number][] | null = null;
	private seeds: number[] = [];
	private seedsGuessed = true;
	private eyedropper = false;
	private trace: RiverTraceParams = DEFAULT_TRACE;
	private debugStage: RiverDebugStage = 'none';
	private debugImage: HTMLCanvasElement | null = null;
	private dragPoint: { river: RiverDraft; index: number } | null = null;
	// Place
	private mode: ImportMode = 'overwrite';
	private autoResize = true;
	private keepUnderlay = true;

	constructor(private readonly target: ImportTarget) {
		super(target.app);
	}

	onOpen(): void {
		this.modalEl.addClass('hexlore-import-modal');
		this.setTitle('Import map image');
		const el = this.contentEl;
		el.addClass('hexlore-import');
		this.nav = el.createDiv({ cls: 'hexlore-import-steps' });
		const main = el.createDiv({ cls: 'hexlore-import-main' });
		this.body = main.createDiv({ cls: 'hexlore-import-body' });
		this.side = main.createDiv({ cls: 'hexlore-import-side' });
		void loadLibraries(this.app, this.target.pluginDir).then((l) => (this.libraries = l));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private go(step: Step): void {
		this.step = step;
		this.render();
	}

	private renderNav(): void {
		this.nav.empty();
		STEPS.forEach((s, i) => {
			const b = this.nav.createDiv({ cls: 'hexlore-import-step', text: `${i + 1}. ${s.label}` });
			b.toggleClass('is-active', s.id === this.step);
		});
		if (this.busy) this.nav.createDiv({ cls: 'hexlore-import-busy', text: this.busy });
	}

	private render(): void {
		this.renderNav();
		this.side.empty();
		if (this.step === 'pick') return this.renderPick();
		if (this.stage) {
			this.stage.hooks = null;
			if (!this.body.contains(this.stage.el)) {
				this.body.empty();
				this.body.appendChild(this.stage.el);
			}
		}
		if (this.step === 'calibrate') this.renderCalibrate();
		else if (this.step === 'review') this.renderReview();
		else if (this.step === 'rivers') this.renderRivers();
		else this.renderPlace();
		this.stage?.redraw();
	}

	// ----- 1. pick ---------------------------------------------------------------------

	private renderPick(): void {
		this.body.empty();
		this.body.createDiv({ cls: 'hexlore-import-intro', text: 'Turn a picture of a hex map into terrain. Put the image in the vault first; it can stay as the map’s underlay after.' });
		const fm = this.app.metadataCache.getFileCache(this.target.index)?.frontmatter;
		const link = typeof fm?.underlay === 'string' ? fm.underlay.replace(/^!?\[\[|\]\]$/g, '') : '';
		const current = link ? this.app.metadataCache.getFirstLinkpathDest(link, this.target.index.path) : null;
		const s = new Setting(this.side).setName('The image');
		s.addButton((b) => b.setButtonText('Pick an image…').setCta().onClick(() => new ImageFilePicker(this.app, (f) => void this.load(f)).open()));
		if (current) s.addButton((b) => b.setButtonText(`Use the underlay (${current.name})`).onClick(() => void this.load(current)));
	}

	private async load(file: TFile): Promise<void> {
		this.busy = 'Reading the image…';
		this.renderNav();
		try {
			const { img, raster } = await loadRaster(this.app, file);
			this.file = file;
			this.img = img;
			this.session = new ImportSession(raster);
			this.clicks = [];
			this.body.empty();
			this.stage = new ImageStage(this.body, img);
			this.busy = '';
			this.go('calibrate');
			window.setTimeout(() => this.stage?.fit(), 50);
		} catch (e) {
			this.busy = '';
			new Notice(`Could not read ${file.name}: ${(e as Error).message}`);
			this.renderNav();
		}
	}

	// ----- 2. calibrate -------------------------------------------------------------------

	private renderCalibrate(): void {
		const session = this.session!;
		const stage = this.stage!;
		this.side.createEl('p', { text: 'Click the centres of two neighbouring hexes. The grid appears over the picture: check it lines up across the whole map before going on. Drag or right-drag to pan, wheel to zoom.' });
		const status = this.side.createDiv({ cls: 'setting-item-description' });
		const update = () => {
			const g = session.grid;
			status.setText(g ? `${g.orientation === 'flat' ? 'Flat-top' : 'Pointy-top'} hexes, ${g.radius.toFixed(1)} px radius: ${session.cellCount} hexes on the image.` : `${this.clicks.length} of 2 clicks.`);
		};
		update();
		stage.hooks = {
			down: (x, y) => {
				if (this.clicks.length >= 2) this.clicks = [];
				this.clicks.push([x, y]);
				if (this.clicks.length === 2) session.calibrate(this.clicks[0]!, this.clicks[1]!);
				else session.grid = null;
				update();
				stage.redraw();
				this.renderNav();
				return true;
			},
			draw: (c, k) => {
				const g = session.grid;
				if (g) {
					c.beginPath();
					for (const [q, r] of sourceCells(g, session.image.width, session.image.height)) hexOutline(c, g, q, r);
					c.strokeStyle = 'rgba(255,224,138,0.75)';
					c.lineWidth = 1.2 * k;
					c.stroke();
				}
				for (const [x, y] of this.clicks) {
					c.beginPath();
					c.arc(x, y, 5 * k, 0, Math.PI * 2);
					c.fillStyle = '#E05555';
					c.fill();
				}
			},
		};
		if (session.grid) {
			new Setting(this.side).setName('Fine-tune the size').addSlider((s) =>
				s.setLimits(-5, 5, 0.1).setValue(0).onChange((v) => {
					const base = this.clicks.length === 2 ? Math.hypot(this.clicks[1]![0] - this.clicks[0]![0], this.clicks[1]![1] - this.clicks[0]![1]) / Math.sqrt(3) : session.grid!.radius;
					session.grid = session.grid!.with({ radius: base * (1 + v / 100) });
					update();
					stage.redraw();
				}),
			);
		}
		new Setting(this.side)
			.addButton((b) => b.setButtonText('Back').onClick(() => this.go('pick')))
			.addButton((b) =>
				b
					.setButtonText('Recognise the terrain')
					.setCta()
					.setDisabled(!session.grid || session.cellCount < 2)
					.onClick(() => void this.classify()),
			);
	}

	private async classify(): Promise<void> {
		const session = this.session!;
		const grid = session.grid!;
		const lib = this.libraries ?? new ImportLibraries();
		this.libraries = lib;
		this.busy = 'Reading the ink…';
		this.renderNav();
		await yieldFrame();
		const cells = sourceCells(grid, session.image.width, session.image.height);
		const mask = buildInkMask(session.image, grid.radius);
		const evidence: HexEvidence[] = [];
		for (let i = 0; i < cells.length; i += 150) {
			const chunk = cells.slice(i, i + 150);
			this.busy = `Recognising… ${Math.round((i / cells.length) * 100)} %`;
			this.renderNav();
			await yieldFrame();
			evidence.push(...gatherEvidence(sampleHexes(session.image, grid, chunk), lib, DEFAULT_CASCADE, chunk.map(([q, r]) => describeCell(mask, grid, q, r))));
		}
		session.adoptGroups(groupEvidence(evidence, DEFAULT_CASCADE), { ...DEFAULT_CASCADE, structureConfirm: this.sensitivity });
		// Undecided first, then largest — computed ONCE (rows that reshuffle as
		// you answer them are worse than rows in a stale order).
		const undecided = (g: CascadeGroup) => session.decisionOf(g).pick.isEmpty;
		this.order = [...session.biomeGroups, ...session.structureGroups].sort((a, b) => Number(undecided(b)) - Number(undecided(a)) || b.members.length - a.members.length);
		this.selected = this.order[0] ?? null;
		this.touched.clear();
		this.busy = '';
		this.go('review');
	}

	// ----- 3. review ---------------------------------------------------------------------

	private renderReview(): void {
		const session = this.session!;
		const grid = session.grid!;
		const stage = this.stage!;
		const memberCells = (g: CascadeGroup) => g.members.map((m) => [m.sample.q, m.sample.r] as const);
		const paint = (q: number, r: number, add: boolean) => {
			for (const [cq, cr] of hexesWithin(q, r, this.brush.radius)) {
				if (add) session.overrides.set(`${cq},${cr}`, this.brush.pick);
				else session.overrides.delete(`${cq},${cr}`);
			}
			stage.redraw();
		};
		stage.hooks = {
			down: (x, y, e) => {
				const [q, r] = grid.cellAt(x, y);
				if (this.brush.on) {
					paint(q, r, e.button !== 2 && !e.ctrlKey);
					return true;
				}
				// A click selects the group of the hex under it.
				const hit = this.order.find((g) => g.members.some((m) => m.sample.q === q && m.sample.r === r));
				if (hit) {
					this.selected = hit;
					this.render();
				}
				return true;
			},
			move: (x, y, e) => {
				if (!this.brush.on) return;
				const [q, r] = grid.cellAt(x, y);
				paint(q, r, !e.ctrlKey && (e.buttons & 2) === 0);
			},
			draw: (c, k) => {
				// Each cell as what it will become (biome fill), the selected group outlined.
				for (const g of session.biomeGroups) {
					const d = session.decisionOf(g);
					if (d.skip || !d.pick.terrain) continue;
					c.beginPath();
					for (const [q, r] of memberCells(g)) hexOutline(c, grid, q, r);
					c.globalAlpha = 0.45;
					c.fillStyle = terrainColors[d.pick.terrain];
					c.fill();
					c.globalAlpha = 1;
				}
				for (const [key, pick] of session.overrides) {
					const [q, r] = key.split(',').map(Number) as [number, number];
					c.beginPath();
					hexOutline(c, grid, q, r);
					c.globalAlpha = 0.75;
					c.fillStyle = pick.terrain ? terrainColors[pick.terrain] : '#E8E4D8';
					c.fill();
					c.globalAlpha = 1;
					c.strokeStyle = '#FFFFFF';
					c.lineWidth = 1.5 * k;
					c.stroke();
				}
				if (this.selected) {
					c.beginPath();
					for (const [q, r] of memberCells(this.selected)) hexOutline(c, grid, q, r);
					c.strokeStyle = '#B08CF0';
					c.lineWidth = 2.5 * k;
					c.stroke();
				}
			},
		};

		const lib = this.libraries;
		const head = this.side.createDiv({ cls: 'setting-item-description' });
		head.setText(`${session.biomeGroups.length} terrain groups, ${session.structureGroups.length} icon groups. Decide each terrain group (or skip it); icons are optional. Click a hex to find its group.`);
		new Setting(this.side)
			.setName('Icon sensitivity')
			.setDesc('Higher: only confident icon matches start accepted.')
			.addSlider((s) =>
				s.setLimits(0.5, 0.95, 0.05).setValue(this.sensitivity).onChange((v) => {
					this.sensitivity = v;
					for (const g of session.structureGroups) {
						if (this.touched.has(g)) continue;
						session.decisionOf(g).pick = g.confidence >= v ? g.pick : PaintPick.nothing;
					}
					this.render();
				}),
			);
		if (lib && lib.colors.length) {
			new Setting(this.side)
				.setName(`${lib.colors.length} learned colours in use`)
				.setDesc('If a whole map comes back wrong, a bad lesson may be to blame.')
				.addButton((b) =>
					b.setButtonText('Forget them').onClick(async () => {
						lib.colors.splice(0);
						await saveLibraries(this.app, this.target.pluginDir, lib);
						new Notice('Learned colours forgotten. Recognising again…');
						void this.classify();
					}),
				);
		}
		// The brush.
		const brush = new Setting(this.side).setName('Fix hexes with a brush').addToggle((t) =>
			t.setValue(this.brush.on).onChange((v) => {
				this.brush.on = v;
				this.render();
			}),
		);
		brush.setDesc(this.brush.on ? 'Drag to paint, right-drag to clear. It beats the groups for those hexes.' : 'For the few hexes a group gets wrong.');
		if (this.brush.on) {
			new Setting(this.side)
				.addDropdown((d) => {
					for (const t of TERRAINS) if (t !== 'default') d.addOption(t, t);
					d.setValue(this.brush.pick.terrain ?? 'forest').onChange((v) => (this.brush.pick = PaintPick.biome(v as Terrain)));
				})
				.addDropdown((d) =>
					d
						.addOption('0', 'One hex')
						.addOption('1', 'A hex and its ring')
						.addOption('2', 'Two rings')
						.setValue(String(this.brush.radius))
						.onChange((v) => (this.brush.radius = Number(v))),
				);
		}

		const list = this.side.createDiv({ cls: 'hexlore-import-groups' });
		for (const g of this.order) this.groupRow(list, g);

		new Setting(this.side)
			.addButton((b) => b.setButtonText('Back').onClick(() => this.go('calibrate')))
			.addButton((b) =>
				b
					.setButtonText('Rivers')
					.setCta()
					.setDisabled(!session.ready)
					.setTooltip(session.ready ? '' : 'Decide every terrain group first (paint or skip).')
					.onClick(() => {
						if (!this.seeds.length) {
							this.seeds = suggestRiverSeeds(session.image, waterHints(session));
							this.seedsGuessed = true;
						}
						this.go('rivers');
					}),
			);
	}

	private groupRow(parent: HTMLElement, g: CascadeGroup): void {
		const session = this.session!;
		const d = session.decisionOf(g);
		const row = parent.createDiv({ cls: 'hexlore-import-group' });
		row.toggleClass('is-selected', g === this.selected);
		row.toggleClass('is-done', d.skip || !d.pick.isEmpty);
		const thumb = row.createDiv({ cls: 'hexlore-import-thumb' });
		const crop = g.members[0]?.sample.crop;
		if (crop && crop.width && crop.height) thumb.appendChild(rasterCanvas(crop));
		const info = row.createDiv({ cls: 'hexlore-import-group-info' });
		const kind = g.layer === 'biome' ? 'Terrain' : 'Icon';
		info.createDiv({ cls: 'hexlore-import-group-name', text: `${kind}: ${g.label}${g.guessedBiome ? ' (a guess)' : ''}` });
		info.createDiv({ cls: 'setting-item-description', text: `${g.members.length} hex${g.members.length === 1 ? '' : 'es'}${g.confidence ? ` · ${Math.round(g.confidence * 100)} %` : ''}` });
		row.addEventListener('click', () => {
			if (this.selected === g) return;
			this.selected = g;
			this.render();
		});
		if (g !== this.selected) return;
		const touch = () => {
			this.touched.add(g);
			this.stage?.redraw();
			row.toggleClass('is-done', d.skip || !d.pick.isEmpty);
		};
		const ctl = info.createDiv({ cls: 'hexlore-import-group-controls' });
		if (g.layer === 'biome') {
			new Setting(ctl).setName('Becomes').addDropdown((dd) => {
				dd.addOption('', '— decide —');
				for (const t of TERRAINS) {
					if (t === 'default') continue;
					const variants = ART.biome(t)?.variants ?? [];
					if (variants.length <= 1) dd.addOption(`${t}:0`, t);
					else for (const [i, v] of variants.entries()) dd.addOption(`${t}:${i}`, `${t} · ${v.label}`);
				}
				dd.setValue(d.pick.terrain ? `${d.pick.terrain}:${d.pick.terrainVariant}` : '').onChange((v) => {
					const [t, i] = v.split(':');
					d.pick = t ? PaintPick.biome(t as Terrain, Number(i)) : PaintPick.nothing;
					d.skip = false;
					touch();
					this.render();
				});
			});
		} else {
			new Setting(ctl).setName('Icon').addDropdown((dd) => {
				dd.addOption('', 'No icon');
				for (const f of FEATURES) dd.addOption(f, f);
				dd.setValue(d.pick.feature ?? '').onChange((v) => {
					d.pick = v ? PaintPick.featureOnly(v as Feature) : PaintPick.nothing;
					touch();
				});
			});
			new Setting(ctl).setName('Tags').addText((t) =>
				t.setValue(d.tags.join(', ')).onChange((v) => {
					d.tags = v.split(',').map((x) => x.trim()).filter((x) => x);
					touch();
				}),
			);
			if (g.source === 'unsorted') {
				new Setting(ctl)
					.setName('Remember it as')
					.setDesc('A name teaches it: the next map recognises this icon.')
					.addText((t) =>
						t.setValue(d.iconName ?? '').onChange((v) => {
							d.iconName = v;
							touch();
						}),
					);
			}
		}
		new Setting(ctl).setName('Skip this group').addToggle((t) =>
			t.setValue(d.skip).onChange((v) => {
				d.skip = v;
				touch();
				this.render();
			}),
		);
	}

	// ----- 4. rivers ---------------------------------------------------------------------------

	private renderRivers(): void {
		const session = this.session!;
		const grid = session.grid!;
		const stage = this.stage!;
		const riverPts = (d: RiverDraft) => d.vertices.map((v) => anchorOnImage(grid, v));
		const nearestHandle = (x: number, y: number): { river: RiverDraft; index: number } | null => {
			let best: { river: RiverDraft; index: number } | null = null, bestD = (10 / stage.scale) ** 2;
			for (const r of session.rivers) riverPts(r).forEach(([px, py], i) => {
				const d2 = (px - x) ** 2 + (py - y) ** 2;
				if (d2 < bestD) {
					bestD = d2;
					best = { river: r, index: i };
				}
			});
			return best;
		};
		const nearestLink = (x: number, y: number): { river: RiverDraft; index: number } | null => {
			let best: { river: RiverDraft; index: number } | null = null, bestD = 8 / stage.scale;
			for (const r of session.rivers) {
				const pts = riverPts(r);
				for (let i = 1; i < pts.length; i++) {
					const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!;
					const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
					const t = len2 ? Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
					const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
					if (d < bestD) {
						bestD = d;
						best = { river: r, index: i - 1 };
					}
				}
			}
			return best;
		};
		stage.hooks = {
			down: (x, y) => {
				if (this.eyedropper) {
					const xi = Math.floor(x), yi = Math.floor(y);
					if (xi >= 0 && yi >= 0 && xi < session.image.width && yi < session.image.height) {
						const i = (yi * session.image.width + xi) * 4;
						const argb = (0xff000000 | (session.image.data[i]! << 16) | (session.image.data[i + 1]! << 8) | session.image.data[i + 2]!) >>> 0;
						if (this.seedsGuessed) this.seeds = [];
						this.seedsGuessed = false;
						if (!this.seeds.includes(argb)) this.seeds.push(argb);
					}
					this.eyedropper = false;
					this.render();
					return true;
				}
				if (this.riverMode === 'draw') {
					this.stroke = [[x, y]];
					return true;
				}
				// Edit: a handle drags; a link is cut (decision 12l, tap a link to delete it).
				const h = nearestHandle(x, y);
				if (h) {
					this.dragPoint = h;
					return true;
				}
				const link = nearestLink(x, y);
				if (link) {
					const i = session.rivers.indexOf(link.river);
					session.rivers.splice(i, 1, ...link.river.cutLink(link.index));
					stage.redraw();
					return true;
				}
				return false;
			},
			move: (x, y) => {
				if (this.stroke) {
					this.stroke.push([x, y]);
					stage.redraw();
				} else if (this.dragPoint) {
					this.dragPoint.river.movePoint(this.dragPoint.index, nearestAnchorAxial(...grid.fractionalAxial(x, y)));
					stage.redraw();
				}
			},
			up: () => {
				if (this.stroke) {
					const d = drawnRiver(this.stroke, grid, this.drawWidthPx);
					if (d) session.rivers.push(d);
					this.stroke = null;
					this.render();
				}
				this.dragPoint = null;
			},
			draw: (c, k) => {
				if (this.debugImage) {
					c.globalAlpha = 0.85;
					c.drawImage(this.debugImage, 0, 0, session.image.width, session.image.height);
					c.globalAlpha = 1;
				}
				for (const r of session.rivers) {
					const pts = riverPts(r);
					c.beginPath();
					pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
					c.strokeStyle = '#3A7DBF';
					c.lineWidth = Math.max(2 * k, (r.width * 5 * grid.radius) / HEX_RADIUS);
					c.lineCap = 'round';
					c.stroke();
					if (this.riverMode === 'edit') for (const [x, y] of pts) {
						c.beginPath();
						c.arc(x, y, 3.5 * k, 0, Math.PI * 2);
						c.fillStyle = '#FFFFFF';
						c.fill();
					}
				}
				if (this.stroke) {
					c.beginPath();
					this.stroke.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
					c.strokeStyle = 'rgba(224,85,85,0.9)';
					c.lineWidth = 2 * k;
					c.stroke();
				}
			},
		};
		this.side.createEl('p', { text: 'Draw each river along the picture (the pen snaps it to the hex edges), or let the tracer find them. Rivers are optional.' });
		new Setting(this.side).setName('Tool').addDropdown((d) =>
			d
				.addOption('draw', 'Pen: draw a river')
				.addOption('edit', 'Edit: drag a point, click a link to cut it')
				.setValue(this.riverMode)
				.onChange((v) => {
					this.riverMode = v === 'edit' ? 'edit' : 'draw';
					this.render();
				}),
		);
		if (this.riverMode === 'draw') {
			new Setting(this.side)
				.setName('Width of what you draw')
				.setDesc(`${this.drawWidthPx} px on the picture → width ${riverWidthMultiplier(this.drawWidthPx, grid.radius).toFixed(2)}`)
				.addSlider((s) => s.setLimits(2, 30, 1).setValue(this.drawWidthPx).onChange((v) => (this.drawWidthPx = v)));
		}
		new Setting(this.side).setName(`${session.rivers.length} river${session.rivers.length === 1 ? '' : 's'}`).addButton((b) =>
			b
				.setButtonText('Remove all')
				.setDisabled(!session.rivers.length)
				.onClick(() => {
					session.rivers = [];
					this.render();
				}),
		);
		const auto = this.side.createEl('details', { cls: 'hexlore-panel-secondary' });
		auto.createEl('summary', { text: 'Trace automatically' });
		const seeds = new Setting(auto).setName('Water colours').setDesc(this.seeds.length ? (this.seedsGuessed ? 'A guess: pick the river colour instead.' : 'Picked from the picture.') : 'None yet.');
		for (const s of this.seeds) {
			const chip = seeds.controlEl.createDiv({ cls: 'hexlore-swatch is-small' });
			chip.style.setProperty('--chip', `#${(s & 0xffffff).toString(16).padStart(6, '0')}`);
		}
		seeds.addButton((b) =>
			b.setButtonText(this.eyedropper ? 'Click the picture…' : 'Pick a colour').onClick(() => {
				this.eyedropper = true;
				this.render();
			}),
		);
		new Setting(auto).setName('Colour tolerance').addSlider((s) => s.setLimits(5, 50, 1).setValue(this.trace.tolerance).onChange((v) => (this.trace = { ...this.trace, tolerance: v })));
		new Setting(auto)
			.setName('Shortest river')
			.setDesc('In hexes: shorter strokes are icon ink, not rivers.')
			.addSlider((s) => s.setLimits(1, 8, 0.2).setValue(this.trace.minLengthFactor).onChange((v) => (this.trace = { ...this.trace, minLengthFactor: v })));
		new Setting(auto).setName('Show a stage').addDropdown((d) => {
			for (const st of RIVER_DEBUG_STAGES) d.addOption(st.id, st.label);
			d.setValue(this.debugStage).onChange((v) => {
				this.debugStage = v as RiverDebugStage;
				this.debugImage = null;
				this.render();
			});
		});
		auto.createDiv({ cls: 'setting-item-description', text: RIVER_DEBUG_STAGES.find((s) => s.id === this.debugStage)!.hint });
		new Setting(auto).addButton((b) =>
			b
				.setButtonText('Trace (replaces the list)')
				.setDisabled(!this.seeds.length)
				.onClick(async () => {
					this.busy = 'Tracing rivers…';
					this.renderNav();
					await yieldFrame();
					const trace = traceRiversDebug(session.image, grid, this.seeds, this.trace);
					session.rivers = trace.rivers
						.map((t) => {
							const v = snapPolyline(t.points, grid);
							return v.length >= 2 ? new RiverDraft(v, riverWidthMultiplier(t.widthPx, grid.radius)) : null;
						})
						.filter((d): d is RiverDraft => !!d);
					const overlay = renderRiverDebugStage(trace, this.debugStage);
					this.debugImage = overlay ? rasterCanvas(overlay) : null;
					this.busy = '';
					new Notice(trace.rivers.length ? `Found ${trace.rivers.length} river${trace.rivers.length === 1 ? '' : 's'}.` : 'No rivers found: pick the river colour, raise the tolerance, or draw them by hand.');
					this.render();
				}),
		);
		new Setting(this.side)
			.addButton((b) => b.setButtonText('Back').onClick(() => this.go('review')))
			.addButton((b) => b.setButtonText('Place it').setCta().onClick(() => this.go('place')));
	}

	// ----- 5. place --------------------------------------------------------------------------

	private plan(): ImportPlan {
		const session = this.session!;
		const m = this.target.editor.model;
		const hexes = [...m.hexes.values()];
		return planImport({
			entries: session.buildEntries(),
			mode: this.mode,
			autoResize: this.autoResize,
			currentWindow: m.meta.grid,
			existingCells: hexes.map((h): [number, number] => [h.q, h.r]),
			occupiedCells: new Set(hexes.filter((h) => h.terrain !== 'default' || h.feature !== null).map((h) => `${h.q},${h.r}`)),
			rivers: session.buildRivers(),
		});
	}

	private renderPlace(): void {
		const session = this.session!;
		const m = this.target.editor.model;
		// The default anchor centres the footprint on the map (a PIXEL delta,
		// rounded back through pixelToAxial: the nearest lattice translation).
		if (!this.placed) {
			// Centre the footprint on the map: a PIXEL delta, rounded back
			// through pixelToAxial to the nearest lattice translation.
			const min = session.minSourceCell!;
			const [gx, gy, gw, gh] = gridPixelBounds(m.meta.grid);
			let sx = 0, sy = 0, n = 0;
			for (const g of session.biomeGroups) for (const mem of g.members) {
				const [x, y] = axialToPixel(mem.sample.q, mem.sample.r);
				sx += x;
				sy += y;
				n++;
			}
			const [dq, dr] = pixelToAxial(gx + gw / 2 - sx / Math.max(1, n), gy + gh / 2 - sy / Math.max(1, n));
			session.anchor = [min[0] + dq, min[1] + dr];
			this.placed = true;
		}
		this.body.empty();
		const host = this.body.createDiv({ cls: 'hexlore-import-stage' });
		const cnv = host.createEl('canvas');
		let drag: { x: number; y: number; anchor: [number, number] } | null = null;
		const view = { k: 1, ox: 0, oy: 0 };
		const draw = () => {
			const r = host.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			cnv.width = Math.max(1, Math.round(r.width * dpr));
			cnv.height = Math.max(1, Math.round(r.height * dpr));
			const c = cnv.getContext('2d')!;
			c.setTransform(1, 0, 0, 1, 0, 0);
			c.fillStyle = '#1A1A2E';
			c.fillRect(0, 0, cnv.width, cnv.height);
			const entries = session.buildEntries();
			const g = this.plan().window ?? m.meta.grid;
			// Fit the union of the grid window and the ghost.
			const [bx, by, bw, bh] = gridPixelBounds(g);
			const pts: [number, number][] = [
				[bx, by],
				[bx + bw, by + bh],
			];
			for (const e of entries) pts.push(axialToPixel(e.q, e.r));
			const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
			const [x0, x1, y0, y1] = [Math.min(...xs) - HEX_RADIUS, Math.max(...xs) + HEX_RADIUS, Math.min(...ys) - HEX_RADIUS, Math.max(...ys) + HEX_RADIUS];
			view.k = Math.min(r.width / (x1 - x0), r.height / (y1 - y0)) * 0.95;
			view.ox = (r.width - (x1 - x0) * view.k) / 2 - x0 * view.k;
			view.oy = (r.height - (y1 - y0) * view.k) / 2 - y0 * view.k;
			c.setTransform(view.k * dpr, 0, 0, view.k * dpr, view.ox * dpr, view.oy * dpr);
			const cell = (q: number, r2: number, fill: string, alpha: number) => {
				const [cx, cy] = axialToPixel(q, r2);
				c.beginPath();
				hexCorners(cx, cy).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				c.closePath();
				c.globalAlpha = alpha;
				c.fillStyle = fill;
				c.fill();
				c.globalAlpha = 1;
			};
			c.beginPath();
			for (const [q, r2] of cellsInRect(bx, by, bx + bw, by + bh, g)) {
				const [cx, cy] = axialToPixel(q, r2);
				hexCorners(cx, cy).forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
				c.closePath();
			}
			c.strokeStyle = 'rgba(255,255,255,0.12)';
			c.lineWidth = 1 / view.k;
			c.stroke();
			for (const h of m.hexes.values()) if (h.terrain !== 'default') cell(h.q, h.r, terrainColors[h.terrain], 0.8);
			for (const e of entries) cell(e.q, e.r, e.pick.terrain ? terrainColors[e.pick.terrain] : '#E8E4D8', 0.55);
		};
		cnv.addEventListener('pointerdown', (e) => {
			cnv.setPointerCapture(e.pointerId);
			drag = { x: e.clientX, y: e.clientY, anchor: [...session.anchor] };
		});
		cnv.addEventListener('pointermove', (e) => {
			if (!drag) return;
			// Grid-snapped: the pointer's scene delta, rounded to a lattice translation.
			const [dq, dr] = pixelToAxial((e.clientX - drag.x) / view.k, (e.clientY - drag.y) / view.k);
			const next: [number, number] = [drag.anchor[0] + dq, drag.anchor[1] + dr];
			if (next[0] !== session.anchor[0] || next[1] !== session.anchor[1]) {
				session.anchor = next;
				draw();
				tally();
			}
		});
		cnv.addEventListener('pointerup', () => (drag = null));
		new ResizeObserver(draw).observe(host);

		this.side.createEl('p', { text: 'Drag the import over the map to place it.' });
		new Setting(this.side).setName('Hexes already painted').addDropdown((d) =>
			d
				.addOption('overwrite', 'Overwrite: covered hexes take the import')
				.addOption('skipOccupied', 'Fill gaps only')
				.addOption('replaceAll', 'Replace everything')
				.setValue(this.mode)
				.onChange((v) => {
					this.mode = v as ImportMode;
					tally();
				}),
		);
		new Setting(this.side).setName('Grow the grid to fit').addToggle((t) =>
			t.setValue(this.autoResize).onChange((v) => {
				this.autoResize = v;
				draw();
				tally();
			}),
		);
		new Setting(this.side).setName('Keep the picture as the map’s underlay').addToggle((t) => t.setValue(this.keepUnderlay).onChange((v) => (this.keepUnderlay = v)));
		const tallyEl = this.side.createDiv({ cls: 'hexlore-hexify-tally' });
		const tally = () => {
			const p = this.plan();
			tallyEl.setText(
				[`${p.writes.length} hexes painted`, p.rivers.length ? `${p.rivers.length} rivers` : '', p.clears.length ? `${p.clears.length} cleared` : '', p.skippedOccupied ? `${p.skippedOccupied} left as painted` : '', p.skippedOutside ? `${p.skippedOutside} outside the grid` : '', p.window ? 'grid resized' : '']
					.filter((x) => x)
					.join(' · '),
			);
		};
		tally();
		new Setting(this.side)
			.addButton((b) => b.setButtonText('Back').onClick(() => this.go('rivers')))
			.addButton((b) =>
				b
					.setButtonText('Import')
					.setCta()
					.onClick(() => void this.apply()),
			);
	}

	private placed = false;

	private async apply(): Promise<void> {
		const session = this.session!;
		const editor = this.target.editor;
		const out = editor.applyImport(this.plan());
		if (this.libraries) {
			session.learnConfirmed(this.libraries);
			await saveLibraries(this.app, this.target.pluginDir, this.libraries).catch(() => undefined);
		}
		if (this.keepUnderlay && this.file) {
			const cfg = new UnderlayConfig(session.grid!, session.anchor, session.minSourceCell!);
			await this.app.vault.adapter.write(normalizePath(`${this.target.dataDir}/${UNDERLAY_CONFIG}`), `${JSON.stringify(cfg.toJson(), null, 2)}\n`);
			const file = this.file;
			await this.app.fileManager.processFrontMatter(this.target.index, (fm: Record<string, unknown>) => {
				fm.underlay = `[[${this.app.metadataCache.fileToLinktext(file, this.target.index.path, false)}]]`;
			});
			this.target.underlayChanged();
		}
		new Notice(`Imported: ${out.applied} hexes painted${out.riversAdded ? `, ${out.riversAdded} rivers` : ''}${out.resized ? ', grid resized' : ''}. One ${MOD}+Z undoes it.`, 8000);
		this.close();
	}
}

/** The confirmed water groups' colours: the tracer's best seed hint. */
function waterHints(session: ImportSession): number[] {
	const hints: number[] = [];
	for (const g of session.groups) {
		const d = session.decisionOf(g);
		if (d.skip || (d.pick.terrain !== 'sea' && d.pick.terrain !== 'lake')) continue;
		const m = g.members[0];
		if (m) hints.push(m.sample.dominantArgb);
	}
	return hints;
}

class ImageFilePicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly accept: (f: TFile) => void,
	) {
		super(app);
		this.setPlaceholder('A picture of a hex map, from the vault');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.has(f.extension.toLowerCase()));
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.accept(f);
	}
}

/** For the view smoke tests. */
export const __testing = { ImageStage };
