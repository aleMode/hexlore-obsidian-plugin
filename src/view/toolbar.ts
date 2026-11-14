// The map view's tool strip and paint palette (item 2.4).
//
// Eight exclusive tools with shortcuts 1–8 (decision 6; the ruler is 8,
// decision 18). The paint palette is the PaintPick chooser (decision 1c):
// biomes, features, their variants and the two erasers, all derived from the
// art registry — a new biome or variant appears here for free. Every choice
// is a named tile with a preview drawn by the renderer (pick_preview.ts):
// colour alone does not say which biome is which.

import { setIcon, setTooltip } from 'obsidian';
import type { Feature, Terrain } from '../core/hex_data';
import { PaintPick } from '../core/hex_paint';
import { ART } from '../render/art';
import { MOD, asButton } from './a11y';
import { pickPreview, titleCase, type PreviewOf } from './pick_preview';

export type ToolId = 'select' | 'paint' | 'river' | 'thread' | 'region' | 'route' | 'fog' | 'ruler';

export interface ToolInfo {
	id: ToolId;
	key: string;
	icon: string;
	label: string;
}

export const TOOLS: ToolInfo[] = [
	{ id: 'select', key: '1', icon: 'mouse-pointer-2', label: 'Select' },
	{ id: 'paint', key: '2', icon: 'paintbrush', label: 'Paint terrain and features' },
	{ id: 'river', key: '3', icon: 'waves', label: 'Rivers: click points, Enter saves' },
	{ id: 'thread', key: '4', icon: 'spline', label: 'Threads: click a hex, then another' },
	{ id: 'region', key: '5', icon: 'shapes', label: `Regions: drag paints the active region, ${MOD}-drag removes` },
	{ id: 'route', key: '6', icon: 'route', label: 'Roads and borders: click points, Enter saves' },
	{ id: 'fog', key: '7', icon: 'eye', label: `Player fog: drag reveals, ${MOD}-drag hides` },
	{ id: 'ruler', key: '8', icon: 'ruler', label: 'Ruler' },
];

export const MAX_BRUSH = 6;

/** The swatch's hex, in px: it sets the width of the whole strip. */
const SWATCH_PX = 40;

/** The palette shows one category at a time. */
type PaletteTab = 'biomes' | 'icons' | 'erase';
const PALETTE_TABS: [PaletteTab, string][] = [
	['biomes', 'Biomes'],
	['icons', 'Icons'],
	['erase', 'Erase'],
];

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

export interface ToolbarHost {
	tool(): ToolId;
	setTool(t: ToolId): void;
	pick(): PaintPick;
	setPick(p: PaintPick): void;
	brush(): number;
	setBrush(n: number): void;
	readOnly(): boolean;
	routeKind(): string;
	setRouteKind(k: string): void;
	routeColor(): string;
	setRouteColor(c: string): void;
}

export class Toolbar {
	readonly el: HTMLElement;
	private readonly buttons = new Map<ToolId, HTMLElement>();
	private readonly brushRow: HTMLElement;
	private readonly brushValue: HTMLElement;
	private readonly swatch: HTMLElement;
	private readonly routeRow: HTMLElement;
	private readonly routeButtons = new Map<string, HTMLElement>();
	private readonly routeColor: HTMLInputElement;
	private palette: HTMLElement | null = null;
	private tab: PaletteTab = 'biomes';

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
			const b = asButton(tools.createDiv({ cls: 'clickable-icon hexlore-tool', attr: { 'data-tool': t.id } }));
			setIcon(b, t.icon);
			setTooltip(b, `${t.label} (${t.key})`, { placement: 'right' });
			b.addEventListener('click', () => host.setTool(t.id));
			this.buttons.set(t.id, b);
		}
		this.brushRow = this.el.createDiv({ cls: 'hexlore-toolbar-group hexlore-brush' });
		this.swatch = asButton(this.brushRow.createDiv({ cls: 'hexlore-pick-swatch clickable-icon' }));
		setTooltip(this.swatch, 'What to paint', { placement: 'right' });
		this.swatch.addEventListener('click', (e) => {
			e.stopPropagation();
			this.togglePalette();
		});
		const minus = asButton(this.brushRow.createDiv({ cls: 'clickable-icon' }));
		setIcon(minus, 'minus');
		setTooltip(minus, 'Smaller brush ([)', { placement: 'right' });
		minus.addEventListener('click', () => host.setBrush(host.brush() - 1));
		this.brushValue = this.brushRow.createDiv({ cls: 'hexlore-brush-value' });
		setTooltip(this.brushValue, 'Brush radius, in hexes', { placement: 'right' });
		const plus = asButton(this.brushRow.createDiv({ cls: 'clickable-icon' }));
		setIcon(plus, 'plus');
		setTooltip(plus, 'Bigger brush (])', { placement: 'right' });
		plus.addEventListener('click', () => host.setBrush(host.brush() + 1));

		this.routeRow = this.el.createDiv({ cls: 'hexlore-toolbar-group' });
		for (const r of ROUTE_KINDS) {
			const b = asButton(this.routeRow.createDiv({ cls: 'clickable-icon' }));
			setIcon(b, r.icon);
			setTooltip(b, r.label, { placement: 'right' });
			b.addEventListener('click', () => host.setRouteKind(r.kind));
			this.routeButtons.set(r.kind, b);
		}
		this.routeColor = this.routeRow.createEl('input', { type: 'color', cls: 'hexlore-route-color' });
		setTooltip(this.routeColor, 'Colour of new roads', { placement: 'right' });
		this.routeColor.addEventListener('change', () => host.setRouteColor(this.routeColor.value.toUpperCase()));
		// Undo and redo are in the top bar only (one place per action).
		this.refresh();
	}

	refresh(): void {
		const tool = this.host.tool();
		for (const [id, b] of this.buttons) {
			b.toggleClass('is-active', id === tool);
			b.setAttribute('aria-pressed', String(id === tool));
		}
		this.brushRow.toggle(tool === 'paint' || tool === 'fog');
		this.swatch.toggle(tool === 'paint');
		this.brushValue.setText(String(this.host.brush()));
		this.routeRow.toggle(tool === 'route');
		for (const [k, b] of this.routeButtons) b.toggleClass('is-active', k === this.host.routeKind());
		this.routeColor.value = this.host.routeColor().toLowerCase();
		this.renderSwatch();
		this.el.toggleClass('is-read-only', this.host.readOnly());
	}

	private renderSwatch(): void {
		const p = this.host.pick();
		this.swatch.empty();
		if (p.terrain === 'default' || (p.clearsFeature && !p.feature && !p.terrain)) {
			const chip = this.swatch.createDiv({ cls: 'hexlore-chip is-empty' });
			chip.style.width = chip.style.height = `${SWATCH_PX}px`;
			setIcon(chip, 'eraser');
		} else pickPreview(this.swatch, p, SWATCH_PX);
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
		// It opens on the tab of what is picked.
		const p = this.host.pick();
		this.tab = p.feature ? 'icons' : p.terrain === 'default' || p.clearsFeature ? 'erase' : 'biomes';
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
		const tabs = pal.createDiv({ cls: 'hexlore-palette-tabs', attr: { role: 'tablist' } });
		for (const [id, label] of PALETTE_TABS) {
			const t = asButton(tabs.createDiv({ cls: 'hexlore-palette-tab', text: label }));
			t.setAttribute('role', 'tab');
			t.setAttribute('aria-selected', String(id === this.tab));
			t.toggleClass('is-active', id === this.tab);
			t.addEventListener('click', () => {
				this.tab = id;
				this.renderPalette();
			});
		}
		const grid = pal.createDiv({ cls: 'hexlore-palette-grid' });
		/** A named tile: a preview (or an icon) over its label. */
		const tile = (grid: HTMLElement, label: string, active: boolean, pick: () => PaintPick, preview: PreviewOf | string) => {
			const t = asButton(grid.createDiv({ cls: 'hexlore-palette-item' }));
			t.toggleClass('is-active', active);
			t.setAttribute('aria-pressed', String(active));
			if (typeof preview === 'string') setIcon(t.createDiv({ cls: 'hexlore-palette-icon' }), preview);
			else pickPreview(t, preview, 36);
			t.createDiv({ cls: 'hexlore-palette-label', text: label });
			setTooltip(t, label, { placement: 'top' });
			t.addEventListener('click', () => choose(pick()));
		};

		const { feature, terrain } = current;
		if (this.tab === 'biomes') {
			for (const b of ART.allBiomes()) {
				if (b.terrain === 'default') continue;
				tile(grid, titleCase(b.terrain), terrain === b.terrain && !feature, () => PaintPick.biome(b.terrain), { terrain: b.terrain });
			}
		} else if (this.tab === 'icons') {
			for (const f of ART.allFeatures()) {
				tile(grid, titleCase(f.feature), feature === f.feature, () => PaintPick.featureOnly(f.feature), { feature: f.feature });
			}
		} else {
			grid.addClass('is-erase');
			tile(grid, 'Biome', terrain === 'default', () => PaintPick.biome('default'), 'eraser');
			tile(grid, 'Icon', current.clearsFeature && !feature, () => PaintPick.featureEraser(), 'eraser');
		}

		// The variants of what is picked, each drawn, under the grid of its own tab only.
		const art = feature ? (this.tab === 'icons' ? ART.feature(feature) : undefined) : terrain && terrain !== 'default' && this.tab === 'biomes' ? ART.biome(terrain) : undefined;
		if (art && art.variants.length > 1) {
			pal.createDiv({ cls: 'hexlore-palette-title', text: `${titleCase(feature ?? terrain!)} variants` });
			const vgrid = pal.createDiv({ cls: 'hexlore-palette-grid is-variants' });
			art.variants.forEach((v, i) => {
				if (feature) tile(vgrid, v.label, current.featureVariant === i, () => PaintPick.featureOnly(feature, i), { feature, featureVariant: i });
				else tile(vgrid, v.label, current.terrainVariant === i, () => PaintPick.biome(terrain!, i), { terrain, terrainVariant: i });
			});
		}
	}
}
