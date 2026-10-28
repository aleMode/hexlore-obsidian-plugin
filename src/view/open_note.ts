// How a note opened from a map shows (the "Open notes from the map"
// setting): in Page preview's floating window, editable in place, or in a
// pane beside the map. Ctrl/Cmd-click (a new tab) is the caller's to decide.

import { Platform, type App, type HoverParent } from 'obsidian';

/** The Page preview source the map's previews come from. */
export const HOVER_SOURCE = 'hexlore-map';

export type NoteOpening = 'popover' | 'pane';

/** Where the floating window belongs: it stays while the pointer is over
 *  [el] or the note is being edited. On an element taller than 300 px (the
 *  map) Page preview places it at the pointer, ([x], [y]) in client pixels;
 *  on a smaller one, beside the element. */
export interface NoteAnchor {
	parent: HoverParent;
	el: HTMLElement;
	x: number;
	y: number;
}

/** Is the core Page preview plugin on? (Private API; assumed on without it.) */
function pagePreviewOn(app: App): boolean {
	const ip = (app as App & { internalPlugins?: { getEnabledPluginById?: (id: string) => unknown } }).internalPlugins;
	return !ip?.getEnabledPluginById || !!ip.getEnabledPluginById('page-preview');
}

/** Open [linktext] (resolved from [sourcePath]) the way [how] says. The
 *  floating window needs an [anchor] and Page preview; without either, the
 *  note opens beside the map. */
export function openNote(app: App, how: NoteOpening, linktext: string, sourcePath: string, anchor?: NoteAnchor): void {
	if (how === 'popover' && anchor && pagePreviewOn(app)) {
		// Page preview ignores a second window for the same element while one
		// shows, and wants the Mod key for this source by default: close the
		// old one and hand it an event with Mod held.
		const old = anchor.parent.hoverPopover as unknown as { hide?: () => void } | null;
		old?.hide?.();
		const win = anchor.el.ownerDocument.defaultView ?? window;
		const event = new win.MouseEvent('mouseover', { clientX: anchor.x, clientY: anchor.y, ctrlKey: !Platform.isMacOS, metaKey: Platform.isMacOS });
		// `mode: 'source'` opens it straight in the editor.
		app.workspace.trigger('hover-link', { event, source: HOVER_SOURCE, hoverParent: anchor.parent, targetEl: anchor.el, linktext, sourcePath, state: { mode: 'source' } });
		return;
	}
	void app.workspace.openLinkText(linktext, sourcePath, 'split');
}
