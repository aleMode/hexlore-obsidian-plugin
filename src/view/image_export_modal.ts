// "Export image…" (plan item 2.10): the options dialog (Flutter's, §1.9) and
// saving the result into the vault beside the map, then opening it.

import { Modal, Notice, Setting, normalizePath, type App, type TFile } from 'obsidian';
import { EXPORT_MIN_PX_PER_HEX, PAPERS, printLayout, type Paper, type SceneRect } from '../core/export_layout';
import { exportPdf, exportPng, type ExportSource, type ImageExportOptions } from '../render/image_export';
import type { Surface, SurfaceFactory } from '../render/textures';

const OPTIONS_KEY = 'hexlore-image-export';

export interface ImageExportRequest {
	app: App;
	index: TFile;
	/** The source for each version (Players: from the filter payload only). */
	source: (version: 'players' | 'gm') => ExportSource;
	/** The current view's scene rect. */
	view: SceneRect;
	style: ImageExportOptions['style'];
	blend: boolean;
	revealed: number;
	makeSurface: SurfaceFactory;
}

/** PNG bytes of a canvas or an OffscreenCanvas. */
async function encodePng(s: Surface): Promise<Uint8Array> {
	if (typeof OffscreenCanvas !== 'undefined' && s instanceof OffscreenCanvas) {
		return new Uint8Array(await (await s.convertToBlob({ type: 'image/png' })).arrayBuffer());
	}
	const blob = await new Promise<Blob | null>((resolve) => (s as HTMLCanvasElement).toBlob(resolve, 'image/png'));
	if (!blob) throw new Error('the image could not be encoded');
	return new Uint8Array(await blob.arrayBuffer());
}

export class ImageExportModal extends Modal {
	private o: ImageExportOptions;
	private fitPages: boolean;

	constructor(private readonly req: ImageExportRequest) {
		super(req.app);
		const saved = (req.app.loadLocalStorage(OPTIONS_KEY) ?? {}) as Partial<ImageExportOptions>;
		this.o = {
			format: saved.format === 'pdf' ? 'pdf' : 'png',
			version: saved.version === 'gm' ? 'gm' : 'players',
			style: req.style,
			blend: req.blend,
			area: 'grid',
			pxPerHex: typeof saved.pxPerHex === 'number' ? saved.pxPerHex : 64,
			print: saved.print ? printLayout({ ...saved.print }) : printLayout({ hexWidthMm: 12 }),
			dpi: typeof saved.dpi === 'number' ? saved.dpi : 200,
		};
		this.fitPages = this.o.print.pagesWide !== null;
	}

	onOpen(): void {
		this.setTitle('Export image');
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const o = this.o;
		const set = (change: Partial<ImageExportOptions>) => {
			this.o = { ...this.o, ...change };
			this.render();
		};
		const print = (change: Partial<ImageExportOptions['print']>) => {
			const p = { ...o.print, ...change };
			set({ print: printLayout(this.fitPages ? { ...p, hexWidthMm: null, pagesWide: p.pagesWide ?? 2 } : { ...p, pagesWide: null, hexWidthMm: p.hexWidthMm ?? 12 }) });
		};
		new Setting(el).setName('Format').addDropdown((d) =>
			d
				.addOption('png', 'PNG image')
				.addOption('pdf', 'PDF, split across pages')
				.setValue(o.format)
				.onChange((v) => set({ format: v === 'pdf' ? 'pdf' : 'png' })),
		);
		new Setting(el)
			.setName('Version')
			.setDesc(
				o.version === 'players'
					? 'Players: exactly what the player view serves — fog, hidden features and every GM layer stay out.'
					: 'GM: the map as it is on screen, with the display and overlay switches as they are now.',
			)
			.addDropdown((d) =>
				d
					.addOption('players', 'Players')
					.addOption('gm', 'GM')
					.setValue(o.version)
					.onChange((v) => set({ version: v === 'gm' ? 'gm' : 'players' })),
			);
		if (o.version === 'players' && this.req.revealed === 0) {
			el.createDiv({ cls: 'hexlore-warning mod-warning', text: 'Nothing is revealed to players yet, so the Players version is an empty grid. Choose GM for the whole map, or reveal hexes with the fog tool first.' });
		}
		new Setting(el).setName('Style').addDropdown((d) =>
			d
				.addOption('clean', 'Clean')
				.addOption('illustrated', 'Illustrated')
				.setValue(o.style)
				.onChange((v) => set({ style: v === 'illustrated' ? 'illustrated' : 'clean' })),
		);
		new Setting(el).setName('Blend biome borders').addToggle((t) => t.setValue(o.blend).onChange((v) => set({ blend: v })));
		new Setting(el).setName('Area').addDropdown((d) =>
			d
				.addOption('grid', 'Whole grid')
				.addOption('view', 'Current view')
				.setValue(o.area)
				.onChange((v) => set({ area: v === 'view' ? 'view' : 'grid' })),
		);
		if (o.format === 'png') {
			new Setting(el)
				.setName('Pixels per hex')
				.setDesc(String(Math.round(o.pxPerHex)))
				.addSlider((s) => s.setLimits(EXPORT_MIN_PX_PER_HEX, 256, 4).setValue(o.pxPerHex).onChange((v) => set({ pxPerHex: v })));
		} else {
			new Setting(el).setName('Paper').addDropdown((d) => {
				for (const [k, p] of Object.entries(PAPERS)) d.addOption(k, p.label);
				d.setValue(o.print.paper).onChange((v) => print({ paper: v as Paper }));
			});
			new Setting(el).setName('Orientation').addDropdown((d) =>
				d
					.addOption('portrait', 'Portrait')
					.addOption('landscape', 'Landscape')
					.setValue(o.print.landscape ? 'landscape' : 'portrait')
					.onChange((v) => print({ landscape: v === 'landscape' })),
			);
			new Setting(el).setName('Scale').addDropdown((d) =>
				d
					.addOption('hex', 'Hex width')
					.addOption('fit', 'Fit pages wide')
					.setValue(this.fitPages ? 'fit' : 'hex')
					.onChange((v) => {
						this.fitPages = v === 'fit';
						print({});
					}),
			);
			if (this.fitPages) {
				new Setting(el)
					.setName('Pages wide')
					.setDesc(String(o.print.pagesWide ?? 2))
					.addSlider((s) => s.setLimits(1, 8, 1).setValue(o.print.pagesWide ?? 2).onChange((v) => print({ pagesWide: v })));
			} else {
				new Setting(el)
					.setName('Hex width (mm)')
					.setDesc(`${Math.round(o.print.hexWidthMm ?? 12)} mm`)
					.addSlider((s) => s.setLimits(5, 40, 1).setValue(o.print.hexWidthMm ?? 12).onChange((v) => print({ hexWidthMm: v })));
			}
			new Setting(el)
				.setName('Overlap (mm)')
				.setDesc(`${Math.round(o.print.overlapMm)} mm, shared by neighbouring pages for assembly`)
				.addSlider((s) => s.setLimits(0, 20, 1).setValue(o.print.overlapMm).onChange((v) => print({ overlapMm: v })));
		}
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Export')
				.setCta()
				.onClick(async () => {
					b.setDisabled(true);
					b.setButtonText('Rendering…');
					try {
						await this.run();
						this.close();
					} catch (e) {
						new Notice(`Export failed: ${(e as Error).message}`);
						b.setDisabled(false);
						b.setButtonText('Export');
					}
				}),
		);
	}

	private async run(): Promise<void> {
		const { app, index } = this.req;
		const o = this.o;
		app.saveLocalStorage(OPTIONS_KEY, { format: o.format, version: o.version, pxPerHex: o.pxPerHex, print: o.print, dpi: o.dpi });
		const src = this.req.source(o.version);
		const res = o.format === 'png' ? await exportPng(src, o, this.req.makeSurface, encodePng, this.req.view) : await exportPdf(src, o, this.req.makeSurface, encodePng, this.req.view);
		const folder = index.parent && !index.parent.isRoot() ? `${index.parent.path}/` : '';
		const base = normalizePath(`${folder}${index.basename.replace(/\.hexmap$/, '')} ${o.version === 'gm' ? 'GM' : 'players'}`);
		let path = `${base}.${o.format}`;
		for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.${o.format}`;
		const file = await app.vault.createBinary(path, res.bytes.slice().buffer);
		for (const n of res.notes) new Notice(n);
		new Notice(`Exported ${path}`);
		await app.workspace.getLeaf('tab').openFile(file);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
