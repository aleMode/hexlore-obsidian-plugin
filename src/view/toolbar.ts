// The map view's tool strip and paint palette (item 2.4).
//
// Eight exclusive tools with shortcuts 1–8 (decision 6; the ruler is 8,
// decision 18). The paint palette is the PaintPick chooser (decision 1c):
// biomes, features, their variants and the two erasers, all derived from the
// art registry — a new biome or variant appears here for free.

import { setIcon, setTooltip } from 'obsidian';
import { terrainColors, type Feature, type Terrain } from '../core/hex_data';
import { PaintPick } from '../core/hex_paint';
import { ART } from '../render/art';

export type ToolId = 'select' | 'paint' | 'river' | 'thread' | 'region' | 'route' | 'fog' | 'ruler';

export interface ToolInfo {
	id: ToolId;
	key: string;
	icon: string;
	label: string;
	/** Not built yet (item 2.4, stage B): shown, disabled. */
	later?: boolean;
}

export const TOOLS: ToolInfo[] = [
	{ id: 'select', key: '1', icon: 'mouse-pointer-2', label: 'Select' },
	{ id: 'paint', key: '2', icon: 'paintbrush', label: 'Paint terrain and features' },
	{ id: 'river', key: '3', icon: 'waves', label: 'Rivers: click points, Enter saves' },
	{ id: 'thread', key: '4', icon: 'spline', label: 'Threads: click a hex, then another' },
	{ id: 'region', key: '5', icon: 'shapes', label: 'Regions: drag paints the active region, Ctrl-drag removes' },
	{ id: 'route', key: '6', icon: 'route', label: 'Roads and borders: click points, Enter saves' },
	{ id: 'fog', key: '7', icon: 'eye', label: 'Player fog: drag reveals, Ctrl-drag hides' },
	{ id: 'ruler', key: '8', icon: 'ruler', label: 'Ruler' },
];

export const MAX_BRUSH = 6;

export const ROUTE_KINDS: { kind: string; icon: string; label: string }[] = [
	{ kind: 'highway', icon: 'milestone', label: 'Highway' },
	{ kind: 'road', icon: 'route', label: 'Road' },
	{ kind: 'trail', icon: 'footprints', label: 'Trail' },
	{ kind: 'border', icon: 'flag', label: 'Border (hidden from players)' },
];

/** A pick as stored per device. */
export interface StoredPick {
	terrain: Terrain | null;
	terrainVariant: number;
	feature: Feature | null;
	featureVariant: number;
	clearsFeature: boolean;
}

export const pickToStored = (p: PaintPick): StoredPick => ({
	terrain: p.terrain,
	terrainVariant: p.terrainVariant,
	feature: p.feature,
	featureVariant: p.featureVariant,
	clearsFeature: p.clearsFeature,
});

export function pickFromStored(s: Partial<StoredPick> | null | undefined): PaintPick {
	if (!s) return PaintPick.biome('forest');
	const terrain = s.terrain && ART.biome(s.terrain) ? s.terrain : null;
	const feature = s.feature && ART.feature(s.feature) ? s.feature : null;
	try {
		const p = new PaintPick(terrain, s.terrainVariant ?? 0, feature, s.featureVariant ?? 0, !feature && !!s.clearsFeature);
		return p.isEmpty ? PaintPick.biome('forest') : p;
	} catch {
		return PaintPick.biome('forest');
	}
}

/** A feature's glyph as a small SVG. */
function glyphIcon(parent: HTMLElement, feature: Feature, variant: number): void {
	const art = ART.featureGlyph(feature, variant);
	if (!art) return;
	const g = art.glyph;
	const svg = parent.createSvg('svg', {
		attr: { viewBox: `${g.left} ${g.top} ${g.right - g.left} ${g.bottom - g.top}`, width: '20', height: '20' },
	});
	svg.createSvg('path', { attr: { d: g.path, fill: 'currentColor' } });
}

export interface ToolbarHost {
	tool(): ToolId;
	setTool(t: ToolId): void;
	pick(): PaintPick;
	setPick(p: PaintPick): void;
	brush(): number;
	setBrush(n: number): void;
	undo(): void;
	redo(): void;
	canUndo(): boolean;
	canRedo(): boolean;
	readOnly(): boolean;
	routeKind(): string;
	setRouteKind(k: string): void;
	routeColor(): string;
	setRouteColor(c: string): void;
}

export class Toolbar {
	readonly el: HTMLElement;
	private readonly buttons = new Map<ToolId, HTMLElement>();
	private readonly undoBtn: HTMLElement;
	private readonly redoBtn: HTMLElement;
	private readonly brushRow: HTMLElement;
	private readonly brushValue: HTMLElement;
	private readonly swatch: HTMLElement;
	private readonly routeRow: HTMLElement;
	private readonly routeButtons = new Map<string, HTMLElement>();
	private readonly routeColor: HTMLInputElement;
	private palette: HTMLElement | null = null;

	constructor(
		parent: HTMLElement,
		private readonly host: ToolbarHost,
	) {
		this.el = parent.createDiv({ cls: 'hexlore-toolbar' });
		// The strip sits on the map: its clicks must not reach the map.
		for (const type of ['pointerdown', 'pointerup', 'contextmenu', 'wheel'] as const) {
			this.el.addEventListener(type, (e) => e.stopPropagation());
		}
		const tools = this.el.createDiv({ cls: 'hexlore-toolbar-group' });
		for (const t of TOOLS) {
			const b = tools.createDiv({ cls: 'clickable-icon hexlore-tool', attr: { 'data-tool': t.id } });
			setIcon(b, t.icon);
			setTooltip(b, `${t.label} (${t.key})${t.later ? ' — coming next' : ''}`, { placement: 'right' });
			if (t.later) b.addClass('is-disabled');
			else b.addEventListener('click', () => host.setTool(t.id));
			this.buttons.set(t.id, b);
		}
		this.brushRow = this.el.createDiv({ cls: 'hexlore-toolbar-group hexlore-brush' });
		this.swatch = this.brushRow.createDiv({ cls: 'hexlore-pick-swatch clickable-icon' });
		setTooltip(this.swatch, 'What to paint', { placement: 'right' });
		this.swatch.addEventListener('click', (e) => {
			e.stopPropagation();
			this.togglePalette();
		});
		const minus = this.brushRow.createDiv({ cls: 'clickable-icon' });
		setIcon(minus, 'minus');
		setTooltip(minus, 'Smaller brush ([)', { placement: 'right' });
		minus.addEventListener('click', () => host.setBrush(host.brush() - 1));
		this.brushValue = this.brushRow.createDiv({ cls: 'hexlore-brush-value' });
		setTooltip(this.brushValue, 'Brush radius, in hexes', { placement: 'right' });
		const plus = this.brushRow.createDiv({ cls: 'clickable-icon' });
		setIcon(plus, 'plus');
		setTooltip(plus, 'Bigger brush (])', { placement: 'right' });
		plus.addEventListener('click', () => host.setBrush(host.brush() + 1));

		this.routeRow = this.el.createDiv({ cls: 'hexlore-toolbar-group' });
		for (const r of ROUTE_KINDS) {
			const b = this.routeRow.createDiv({ cls: 'clickable-icon' });
			setIcon(b, r.icon);
			setTooltip(b, r.label, { placement: 'right' });
			b.addEventListener('click', () => host.setRouteKind(r.kind));
			this.routeButtons.set(r.kind, b);
		}
		this.routeColor = this.routeRow.createEl('input', { type: 'color', cls: 'hexlore-route-color' });
		setTooltip(this.routeColor, 'Colour of new roads', { placement: 'right' });
		this.routeColor.addEventListener('change', () => host.setRouteColor(this.routeColor.value.toUpperCase()));

		const history = this.el.createDiv({ cls: 'hexlore-toolbar-group' });
		this.undoBtn = history.createDiv({ cls: 'clickable-icon' });
		setIcon(this.undoBtn, 'undo-2');
		this.undoBtn.addEventListener('click', () => host.undo());
		this.redoBtn = history.createDiv({ cls: 'clickable-icon' });
		setIcon(this.redoBtn, 'redo-2');
		this.redoBtn.addEventListener('click', () => host.redo());
		this.refresh();
	}

	refresh(undoLabel?: string | null, redoLabel?: string | null): void {
		const tool = this.host.tool();
		for (const [id, b] of this.buttons) b.toggleClass('is-active', id === tool);
		this.brushRow.toggle(tool === 'paint' || tool === 'fog');
		this.swatch.toggle(tool === 'paint');
		this.brushValue.setText(String(this.host.brush()));
		this.routeRow.toggle(tool === 'route');
		for (const [k, b] of this.routeButtons) b.toggleClass('is-active', k === this.host.routeKind());
		this.routeColor.value = this.host.routeColor().toLowerCase();
		this.renderSwatch();
		this.undoBtn.toggleClass('is-disabled', !this.host.canUndo());
		this.redoBtn.toggleClass('is-disabled', !this.host.canRedo());
		setTooltip(this.undoBtn, undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo', { placement: 'right' });
		setTooltip(this.redoBtn, redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo', { placement: 'right' });
		this.el.toggleClass('is-read-only', this.host.readOnly());
	}

	private renderSwatch(): void {
		const p = this.host.pick();
		this.swatch.empty();
		const chip = this.swatch.createDiv({ cls: 'hexlore-chip' });
		if (p.terrain && p.terrain !== 'default') chip.style.setProperty('--chip', terrainColors[p.terrain]);
		else chip.addClass('is-empty');
		if (p.feature) glyphIcon(chip, p.feature, p.featureVariant);
		else if (p.clearsFeature) setIcon(chip, 'eraser');
		else if (p.terrain === 'default') setIcon(chip, 'eraser');
		setTooltip(this.swatch, `Painting: ${p.describe()}`, { placement: 'right' });
	}

	closePalette(): void {
		this.palette?.remove();
		this.palette = null;
	}

	private togglePalette(): void {
		if (this.palette) {
			this.closePalette();
			return;
		}
		this.palette = this.el.createDiv({ cls: 'hexlore-palette' });
		this.palette.addEventListener('pointerdown', (e) => e.stopPropagation());
		this.renderPalette();
	}

	private renderPalette(): void {
		const pal = this.palette;
		if (!pal) return;
		pal.empty();
		const current = this.host.pick();
		const choose = (p: PaintPick) => {
			this.host.setPick(p);
			this.renderPalette();
		};

		pal.createDiv({ cls: 'hexlore-palette-title', text: 'Biomes' });
		const biomes = pal.createDiv({ cls: 'hexlore-palette-grid' });
		for (const b of ART.allBiomes()) {
			if (b.terrain === 'default') continue;
			const cell = biomes.createDiv({ cls: 'hexlore-palette-item' });
			cell.style.setProperty('--chip', terrainColors[b.terrain]);
			cell.toggleClass('is-active', current.terrain === b.terrain && !current.feature && !current.clearsFeature);
			setTooltip(cell, b.terrain[0]!.toUpperCase() + b.terrain.slice(1));
			cell.addEventListener('click', () => choose(PaintPick.biome(b.terrain)));
		}
		pal.createDiv({ cls: 'hexlore-palette-title', text: 'Features' });
		const features = pal.createDiv({ cls: 'hexlore-palette-grid' });
		for (const f of ART.allFeatures()) {
			const cell = features.createDiv({ cls: 'hexlore-palette-item is-feature' });
			glyphIcon(cell, f.feature, 0);
			cell.toggleClass('is-active', current.feature === f.feature);
			setTooltip(cell, f.feature[0]!.toUpperCase() + f.feature.slice(1));
			cell.addEventListener('click', () => choose(PaintPick.featureOnly(f.feature)));
		}

		// Variants of what is picked.
		const variants = current.feature
			? ART.feature(current.feature)?.variants
			: current.terrain && current.terrain !== 'default'
				? ART.biome(current.terrain)?.variants
				: undefined;
		if (variants && variants.length > 1) {
			pal.createDiv({ cls: 'hexlore-palette-title', text: 'Variant' });
			const row = pal.createDiv({ cls: 'hexlore-palette-variants' });
			variants.forEach((v, i) => {
				const active = current.feature ? current.featureVariant === i : current.terrainVariant === i;
				const b = row.createEl('button', { text: v.label, cls: active ? 'mod-cta' : '' });
				b.addEventListener('click', () =>
					choose(current.feature ? PaintPick.featureOnly(current.feature, i) : PaintPick.biome(current.terrain!, i)),
				);
			});
		}

		const erase = pal.createDiv({ cls: 'hexlore-palette-variants' });
		const et = erase.createEl('button', { text: 'Erase terrain', cls: current.terrain === 'default' ? 'mod-cta' : '' });
		et.addEventListener('click', () => choose(PaintPick.biome('default')));
		const ef = erase.createEl('button', { text: 'Erase icon', cls: current.clearsFeature ? 'mod-cta' : '' });
		ef.addEventListener('click', () => choose(PaintPick.featureEraser()));
	}
}
