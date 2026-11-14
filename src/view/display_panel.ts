// The Display & overlays panel, opened from the top bar's sliders button: a
// port of Flutter's lib/app/overlay_panel.dart (decisions 27, 28, 30). It is
// the ONLY place these choices live — the map panel does not repeat them.
// Two halves, labelled by scope because they are remembered differently:
// what the GM-only overlays show (per MAP), then how this device draws every
// map (style, blend, thread style, GM fog, player badges).
//
// Overlay rows, most-used first: Threads and Regions, each with its own eye
// and expandable to its sub-groups (thread COLOURS, single regions), then
// Borders, the import underlay and the sketch overlay. Hiding a section keeps
// its sub-groups' switches, so showing it again brings back what was showing;
// while hidden its sub-rows are dimmed but still work.
//
// A popover of its own rather than an Obsidian Menu: a menu has only
// checkmarks, and a one-or-the-other choice reads as one only as pills.
// Thin like the top bar: it draws the host's state and reports every change.

import { SliderComponent, ToggleComponent, setIcon, setTooltip, type App } from 'obsidian';
import type { ColorGroup } from '../core/overlay_filter';
import { asButton } from './a11y';
import type { Display, OverlayState } from './map_view';
import type { SketchOverlay, SketchOverlayMode } from './sketch_mode';

export interface DisplayPanelState {
	display: Display;
	overlays: OverlayState;
	threadGroups: ColorGroup[];
	regions: { id: string; name: string; color: string }[];
	borders: number;
	/** The underlay's picture name, or null when the map has none. */
	underlay: string | null;
	sketchOverlay: SketchOverlay;
	sketchOverlayMode: SketchOverlayMode;
	/** The map is drawn as players see it (this view, until turned off). */
	previewPlayers: boolean;
}

export interface DisplayPanelHost {
	readonly app: App;
	displayState(): DisplayPanelState;
	setDisplay(change: Partial<Display>): void;
	setOverlays(change: Partial<OverlayState>): void;
	/** Show or hide the sketch over the hex view; the mode is kept while hidden. */
	showSketchOverlay(shown: boolean, mode?: SketchOverlayMode): void;
	removeUnderlay(): void;
	setPreviewPlayers(on: boolean): void;
}

type Section = 'threads' | 'regions';
const EXPANDED_KEY = 'hexlore-display-expanded';

export class DisplayPanel {
	private el: HTMLElement | null = null;
	private anchor: HTMLElement | null = null;
	private expanded: Set<Section>;
	private readonly onOutside = (e: PointerEvent) => {
		const t = e.target as Node;
		if (!this.el?.contains(t) && !this.anchor?.contains(t)) this.close();
	};
	private readonly onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	constructor(
		private readonly parent: HTMLElement,
		private readonly host: DisplayPanelHost,
	) {
		const stored = host.app.loadLocalStorage(EXPANDED_KEY) as unknown;
		this.expanded = new Set(Array.isArray(stored) ? stored.filter((s): s is Section => s === 'threads' || s === 'regions') : []);
	}

	get isOpen(): boolean {
		return !!this.el;
	}

	toggle(anchor: HTMLElement): void {
		if (this.el) this.close();
		else this.open(anchor);
	}

	open(anchor: HTMLElement): void {
		this.close();
		this.anchor = anchor;
		anchor.addClass('is-active');
		this.el = this.parent.createDiv({ cls: 'hexlore-display-panel' });
		// Under its button, right edges aligned.
		const right = this.parent.getBoundingClientRect().right - anchor.getBoundingClientRect().right;
		this.el.style.setProperty('--hexlore-panel-right', `${Math.max(0, right)}px`);
		const doc = this.parent.doc;
		doc.addEventListener('pointerdown', this.onOutside, true);
		doc.addEventListener('keydown', this.onKey, true);
		this.refresh();
	}

	close(): void {
		if (!this.el) return;
		const doc = this.parent.doc;
		doc.removeEventListener('pointerdown', this.onOutside, true);
		doc.removeEventListener('keydown', this.onKey, true);
		this.anchor?.removeClass('is-active');
		this.el.remove();
		this.el = null;
		this.anchor = null;
	}

	/** Redraw from the host's state (a no-op while closed). */
	refresh(): void {
		const el = this.el;
		if (!el) return;
		const scroll = el.scrollTop;
		el.empty();
		const s = this.host.displayState();
		const preview = row(el, { label: 'Preview as players', bold: true });
		setTooltip(preview, 'Draw the map as players see it: only what is revealed, without secret features, threads, regions or borders. You can keep revealing while it is on.');
		toggle(preview, s.previewPlayers, (on) => this.host.setPreviewPlayers(on));
		el.createDiv({ cls: 'hexlore-display-divider' });
		this.renderOverlays(el.createDiv({ cls: 'hexlore-display-overlays' }), s);
		el.createDiv({ cls: 'hexlore-display-divider' });
		this.renderDisplay(el, s);
		el.scrollTop = scroll;
	}

	// ----- overlays · this map ----------------------------------------------------------

	private renderOverlays(el: HTMLElement, s: DisplayPanelState): void {
		const h = this.host;
		const o = s.overlays;
		heading(el, 'Overlays · this map');
		this.section(el, 'threads', 'Threads', o.threads, (v) => h.setOverlays({ threads: v }), s.threadGroups.map((g) => ({
			swatch: g.key,
			label: describe(g.names),
			shown: !o.hiddenThreadColors.includes(g.key),
			onShown: (v: boolean) => h.setOverlays({ hiddenThreadColors: without(o.hiddenThreadColors, g.key, v) }),
		})), s.threadGroups.reduce((n, g) => n + g.count, 0));
		this.section(el, 'regions', 'Regions', o.regions, (v) => h.setOverlays({ regions: v }), s.regions.map((r) => ({
			swatch: r.color,
			label: r.name || 'Untitled',
			shown: !o.hiddenRegions.includes(r.id),
			onShown: (v: boolean) => h.setOverlays({ hiddenRegions: without(o.hiddenRegions, r.id, v) }),
		})));
		el.createDiv({ cls: 'hexlore-display-divider' });
		row(el, { label: 'Borders', count: s.borders, shown: o.borders, onShown: s.borders ? (v) => h.setOverlays({ borders: v }) : null });
		const underlay = row(el, {
			label: s.underlay ? 'Imported map underlay' : 'Underlay (none)',
			shown: !!s.underlay && o.underlay,
			onShown: s.underlay ? (v) => h.setOverlays({ underlay: v }) : null,
		});
		if (s.underlay) {
			setTooltip(underlay, s.underlay);
			iconButton(underlay, 'trash-2', 'Stop using it as the underlay (the picture stays in the vault)', () => h.removeUnderlay());
			if (o.underlay) {
				const sub = el.createDiv({ cls: 'hexlore-display-row is-sub' });
				sub.createSpan({ cls: 'hexlore-display-label', text: 'Opacity' });
				new SliderComponent(sub).setLimits(0.05, 1, 0.05).setValue(s.display.underlayOpacity).onChange((v) => h.setDisplay({ underlayOpacity: v }));
			}
		}
		const sketchShown = s.sketchOverlay !== 'none';
		const sketch = row(el, { label: 'Sketch overlay', shown: sketchShown, onShown: (v) => h.showSketchOverlay(v) });
		const labels = s.sketchOverlayMode === 'labels';
		const chip = asButton(sketch.createDiv({ cls: 'hexlore-display-chip', text: 'Labels only' }));
		chip.toggleClass('is-active', labels);
		setTooltip(chip, 'Show only the sketch labels, at full strength');
		chip.addEventListener('click', () => h.showSketchOverlay(sketchShown, labels ? 'full' : 'labels'));
	}

	/** A section row (expander, eye, bold label, count) and, open, its sub-rows. */
	private section(
		el: HTMLElement,
		id: Section,
		label: string,
		shown: boolean,
		onShown: (v: boolean) => void,
		subs: { swatch: string; label: string; shown: boolean; onShown: (v: boolean) => void }[],
		count = subs.length,
	): void {
		const open = this.expanded.has(id);
		const r = row(el, { label, count, shown, onShown: count ? onShown : null, bold: true });
		r.addClass('is-section');
		const expander = iconButton(r, open ? 'chevron-down' : 'chevron-right', open ? 'Collapse' : 'Expand', () => {
			if (open) this.expanded.delete(id);
			else this.expanded.add(id);
			this.host.app.saveLocalStorage(EXPANDED_KEY, [...this.expanded]);
			this.refresh();
		});
		expander.toggleClass('is-disabled', !subs.length);
		r.prepend(expander);
		if (!open) return;
		for (const sub of subs) {
			const sr = row(el, { label: sub.label, shown: sub.shown, onShown: sub.onShown, swatch: sub.swatch });
			sr.addClass('is-sub');
			sr.toggleClass('is-dimmed', !shown);
		}
	}

	// ----- display · this device ------------------------------------------------------------

	private renderDisplay(el: HTMLElement, s: DisplayPanelState): void {
		const h = this.host;
		const d = s.display;
		heading(el, 'Display · this device');
		segments(row(el, { label: 'Map style' }), [['clean', 'Clean'], ['illustrated', 'Illustrated']], d.style, (style) => h.setDisplay({ style }));
		toggle(row(el, { label: 'Blend biome edges' }), d.blend, (blend) => h.setDisplay({ blend }));
		segments(row(el, { label: 'Threads' }), [['arc', 'Arcs'], ['ribbon', 'Ribbons']], d.threadStyle, (threadStyle) => h.setDisplay({ threadStyle }));
		const fog = row(el, { label: 'GM fog on unwritten hexes' });
		setTooltip(fog, 'Hatch the hexes you have not written anything for yet. GM-only: players never see it.');
		toggle(fog, d.gmFog, (gmFog) => h.setDisplay({ gmFog }));
		const badges = row(el, { label: 'Player badges' });
		setTooltip(badges, 'An eye on revealed hexes, a slashed ring on secret features.');
		toggle(badges, d.badges, (b) => h.setDisplay({ badges: b }));
	}
}

// ----- the panel's pieces --------------------------------------------------------------

function heading(el: HTMLElement, text: string): void {
	el.createDiv({ cls: 'hexlore-display-heading', text });
}

/** A row: [eye] [swatch] label [count] … controls appended after it. */
function row(el: HTMLElement, o: { label: string; shown?: boolean; onShown?: ((v: boolean) => void) | null; count?: number; bold?: boolean; swatch?: string }): HTMLElement {
	const r = el.createDiv({ cls: 'hexlore-display-row' });
	if (o.shown !== undefined) {
		const onShown = o.onShown;
		const eye = iconButton(r, o.shown ? 'eye' : 'eye-off', `${o.shown ? 'Hide' : 'Show'} ${o.label}`, () => onShown?.(!o.shown));
		eye.toggleClass('is-disabled', !onShown);
		r.toggleClass('is-off', !o.shown);
	}
	if (o.swatch) r.createDiv({ cls: 'hexlore-swatch is-small' }).style.setProperty('--chip', o.swatch);
	const label = r.createSpan({ cls: 'hexlore-display-label', text: o.label });
	label.toggleClass('is-bold', !!o.bold);
	if (o.count !== undefined) r.createSpan({ cls: 'hexlore-display-count', text: String(o.count) });
	return r;
}

function iconButton(el: HTMLElement, icon: string, tip: string, click: () => void): HTMLElement {
	const b = asButton(el.createDiv({ cls: 'clickable-icon hexlore-display-icon' }));
	setIcon(b, icon);
	setTooltip(b, tip);
	b.addEventListener('click', () => {
		if (!b.hasClass('is-disabled')) click();
	});
	return b;
}

/** One-or-the-other as pills (Flutter's SegmentedButton). */
function segments<T extends string>(el: HTMLElement, options: [T, string][], selected: T, on: (v: T) => void): void {
	const group = el.createDiv({ cls: 'hexlore-segments' });
	for (const [value, label] of options) {
		const seg = asButton(group.createDiv({ cls: 'hexlore-segment', text: label }));
		seg.toggleClass('is-active', value === selected);
		seg.setAttribute('aria-pressed', String(value === selected));
		seg.addEventListener('click', () => {
			if (value !== selected) on(value);
		});
	}
}

function toggle(el: HTMLElement, value: boolean, on: (v: boolean) => void): void {
	new ToggleComponent(el).setValue(value).onChange(on);
}

/** `list` with `key` shown (removed) or hidden (added). */
function without(list: string[], key: string, shown: boolean): string[] {
	const set = new Set(list);
	if (shown) set.delete(key);
	else set.add(key);
	return [...set];
}

/** A colour group's names, at most three (Flutter's `_describe`). */
function describe(names: string[]): string {
	const more = names.length > 3 ? ` +${names.length - 3}` : '';
	return names.slice(0, 3).join(', ') + more;
}
