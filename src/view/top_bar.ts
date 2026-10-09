// The map view's top bar, mirroring the Flutter app's title bar (decision
// 30): grouped by WHAT a control is about. Left = the map (its menu,
// labelled with its name; quick jump; adventures; session notes). Centre =
// the view switch (Hex | Sketch). Right = this session (undo / redo, reset
// view, Display & overlays, the players split button). The tool strip stays
// on the left of the map. Thin wiring: every action is the host's.

import { setIcon, setTooltip } from 'obsidian';

export interface TopBarHost {
	mapName(): string;
	hasEditor(): boolean;
	sketching(): boolean;
	setSketching(on: boolean): void;
	canUndo(): boolean;
	canRedo(): boolean;
	undoLabel(): string | null;
	redoLabel(): string | null;
	undo(): void;
	redo(): void;
	resetView(): void;
	playersRunning(): boolean;
	playersUrl(): string | null;
	togglePlayers(): void;
	/** The menus, shown under their button. */
	mapMenu(e: MouseEvent): void;
	quickJump(): void;
	adventuresMenu(e: MouseEvent): void;
	notesMenu(e: MouseEvent): void;
	playersMenu(e: MouseEvent): void;
	/** The Display & overlays panel, opened under its button. */
	toggleDisplay(button: HTMLElement): void;
}

export class TopBar {
	readonly el: HTMLElement;
	private readonly name: HTMLElement;
	private readonly hexBtn: HTMLElement;
	private readonly sketchBtn: HTMLElement;
	private readonly undoBtn: HTMLElement;
	private readonly redoBtn: HTMLElement;
	private readonly playersBtn: HTMLElement;
	private readonly needsEditor: HTMLElement[] = [];

	constructor(
		parent: HTMLElement,
		private readonly host: TopBarHost,
	) {
		this.el = parent.createDiv({ cls: 'hexlore-topbar' });
		const left = this.el.createDiv({ cls: 'hexlore-topbar-group' });
		const centre = this.el.createDiv({ cls: 'hexlore-topbar-group is-centre' });
		const right = this.el.createDiv({ cls: 'hexlore-topbar-group is-right' });

		// Left: the map.
		const mapBtn = left.createDiv({ cls: 'hexlore-topbar-button hexlore-topbar-map' });
		setIcon(mapBtn.createSpan({ cls: 'hexlore-topbar-icon' }), 'folder');
		this.name = mapBtn.createSpan({ cls: 'hexlore-topbar-name' });
		setIcon(mapBtn.createSpan({ cls: 'hexlore-topbar-caret' }), 'chevron-down');
		setTooltip(mapBtn, 'Map: new, open, map settings, import, export');
		mapBtn.addEventListener('click', (e) => host.mapMenu(e));
		this.divider(left);
		this.icon(left, 'search', 'Quick jump (Ctrl+K)', () => host.quickJump());
		this.needsEditor.push(this.icon(left, 'book-open', 'Adventures', (e) => host.adventuresMenu(e)));
		this.needsEditor.push(this.icon(left, 'sticky-note', 'Session notes', (e) => host.notesMenu(e)));

		// Centre: which view.
		const sw = centre.createDiv({ cls: 'hexlore-segments' });
		this.hexBtn = sw.createDiv({ cls: 'hexlore-segment', text: 'Hex' });
		setTooltip(this.hexBtn, 'The hex map');
		this.hexBtn.addEventListener('click', () => host.setSketching(false));
		this.sketchBtn = sw.createDiv({ cls: 'hexlore-segment', text: 'Sketch' });
		setTooltip(this.sketchBtn, 'Draw freely over the lattice, then hexify');
		this.sketchBtn.addEventListener('click', () => host.setSketching(true));
		this.needsEditor.push(this.sketchBtn);

		// Right: this session.
		this.undoBtn = this.icon(right, 'undo-2', 'Undo (Ctrl+Z)', () => host.undo());
		this.redoBtn = this.icon(right, 'redo-2', 'Redo (Ctrl+Shift+Z)', () => host.redo());
		this.divider(right);
		this.icon(right, 'locate-fixed', 'Reset view (fit the map)', () => host.resetView());
		const display = this.icon(right, 'sliders-horizontal', 'Display and overlays', () => host.toggleDisplay(display));
		this.divider(right);
		const players = right.createDiv({ cls: 'hexlore-topbar-split' });
		this.playersBtn = this.icon(players, 'cast', '', () => host.togglePlayers());
		this.icon(players, 'chevron-down', 'Player options', (e) => host.playersMenu(e)).addClass('is-caret');

		// The bar sits over the map: its clicks must not reach the canvas.
		for (const type of ['pointerdown', 'pointerup', 'contextmenu', 'wheel'] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
		this.refresh();
	}

	private icon(parent: HTMLElement, icon: string, tip: string, click: (e: MouseEvent) => void): HTMLElement {
		const b = parent.createDiv({ cls: 'clickable-icon hexlore-topbar-icon-button' });
		setIcon(b, icon);
		if (tip) setTooltip(b, tip);
		b.addEventListener('click', (e) => {
			if (!b.hasClass('is-disabled')) click(e);
		});
		return b;
	}

	private divider(parent: HTMLElement): void {
		parent.createDiv({ cls: 'hexlore-topbar-divider' });
	}

	refresh(): void {
		const h = this.host;
		this.name.setText(h.mapName() || 'Map');
		const sketching = h.sketching();
		this.hexBtn.toggleClass('is-active', !sketching);
		this.sketchBtn.toggleClass('is-active', sketching);
		for (const b of this.needsEditor) b.toggleClass('is-disabled', !h.hasEditor());
		this.undoBtn.toggleClass('is-disabled', !h.canUndo());
		this.redoBtn.toggleClass('is-disabled', !h.canRedo());
		setTooltip(this.undoBtn, h.undoLabel() ? `Undo ${h.undoLabel()} (Ctrl+Z)` : 'Nothing to undo');
		setTooltip(this.redoBtn, h.redoLabel() ? `Redo ${h.redoLabel()} (Ctrl+Shift+Z)` : 'Nothing to redo');
		const running = h.playersRunning();
		this.playersBtn.toggleClass('is-active', running);
		setIcon(this.playersBtn, running ? 'radio' : 'cast');
		setTooltip(this.playersBtn, running ? `Stop the player view (${h.playersUrl() ?? ''})` : 'Start the player view');
	}
}
