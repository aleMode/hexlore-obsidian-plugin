// What the GM is told when the player view starts: where it is, who can open
// it, and how players come to see anything. Shown on every start until the GM
// turns it off; a short notice with the link replaces it from then on.

import { Modal, Notice, Setting, type App } from 'obsidian';
import { qrSvg } from './qr';

const SHOW_KEY = 'hexlore-players-instructions';

/** Tell the GM the player view of [mapName] is up at [url]. */
export function announcePlayerView(app: App, mapName: string, url: string, lan: boolean): void {
	if (app.loadLocalStorage(SHOW_KEY) === false) {
		new Notice(`Player view of “${mapName}”: ${url}`, 8000);
		return;
	}
	new PlayerViewStartedModal(app, mapName, url, lan).open();
}

class PlayerViewStartedModal extends Modal {
	constructor(
		app: App,
		private readonly mapName: string,
		private readonly url: string,
		private readonly lan: boolean,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl: el, url } = this;
		this.setTitle(`Players can now see “${this.mapName}”`);
		el.addClass('hexlore-players-started');

		new Setting(el)
			.setName('The player view is at')
			.setDesc(url)
			.addButton((b) => b.setButtonText('Copy link').setCta().onClick(() => void navigator.clipboard.writeText(url).then(() => new Notice(`Copied ${url}`))))
			.addButton((b) => b.setButtonText('Open in browser').onClick(() => window.open(url)))
			.settingEl.addClass('hexlore-players-link');
		// Phones join by scanning it (only a LAN link is reachable from one).
		if (this.lan) {
			const qr = el.createDiv({ cls: 'hexlore-players-qr' });
			qr.appendChild(qrSvg(el.doc, url, 180)).setAttribute('aria-label', `QR code of ${url}`);
			qr.createDiv({ cls: 'setting-item-description', text: 'Players can scan this with a phone camera.' });
		}

		const steps = el.createEl('ol', { cls: 'hexlore-players-steps' });
		steps.createEl('li', {
			text: this.lan
				? 'Send players the link. They open it in any browser, no Obsidian needed, from a device on the same network as this computer. On Windows, allow Obsidian through the firewall if asked (private networks).'
				: 'Only this computer can open the link for now: good for a second screen or a shared monitor. For phones and laptops, turn on “Serve on the local network” in the players menu (the arrow beside the players button).',
		});
		steps.createEl('li', { text: 'Players see only the hexes you reveal: drag with the fog tool (7), or right-click a hex and reveal it. The players menu can reveal them all at once.' });
		steps.createEl('li', { text: 'Their page follows your edits by itself. A player who clicks a hex votes for where the party goes next: votes show on your map and in the map panel.' });
		steps.createEl('li', { text: 'While the view runs, the players button in the top bar is lit and the status bar shows the link and how many devices are connected (click it to copy the link). Click the players button for the link again, or to stop.' });

		new Setting(el)
			.setName('Show these instructions each time')
			.setDesc('Off: a short notice with the link instead.')
			.addToggle((t) => t.setValue(true).onChange((v) => this.app.saveLocalStorage(SHOW_KEY, v)))
			.addButton((b) => b.setButtonText('Got it').onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
