// Keyboard access for the plugin's own controls, and shortcut names as the
// platform spells them. Obsidian's `clickable-icon` is a plain div: without
// a role and a tabindex, Tab never reaches it and a screen reader does not
// call it a button.

import { Platform } from 'obsidian';

/** The command key as this platform names it: "Cmd" on macOS, else "Ctrl".
 *  The map reads Ctrl or Cmd alike (`ctrlKey || metaKey`). */
export const MOD = Platform.isMacOS ? 'Cmd' : 'Ctrl';

/** [label] with "Mod" spelled as this platform does: `keys('Mod+Z')`. */
export function keys(label: string): string {
	return label.replace(/\bMod\b/g, MOD);
}

/** Make [el] a button for the keyboard: focusable, announced as a button,
 *  and Enter / Space click it. The click is dispatched at the element's
 *  bottom-left corner, so a menu opened from it appears under it. */
export function asButton(el: HTMLElement): HTMLElement {
	el.setAttribute('role', 'button');
	el.tabIndex = 0;
	el.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		if (e.target !== el) return;
		e.preventDefault();
		e.stopPropagation();
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
	});
	return el;
}

/** Show [el] as disabled, to the eye and to assistive technology. */
export function setDisabled(el: HTMLElement, disabled: boolean): void {
	el.toggleClass('is-disabled', disabled);
	el.setAttribute('aria-disabled', String(disabled));
}
