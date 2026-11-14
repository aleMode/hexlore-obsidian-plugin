// The player view, from Obsidian (plan item 2.6, §1.8): opt-in, off by
// default, desktop only, Node's `http` loaded only when it starts. One map is
// served at a time — the one the GM starts it from. The payload is the
// ported player_filter over the map's LIVE model (what the GM sees, saved or
// about to be), so a reveal reaches players on their next poll.

import { Notice, TFile, type App } from 'obsidian';
import { nodeModule } from '../desktop';
import { FORMAT_VERSION } from '../core/campaign_meta';
import { encodeCompact } from '../core/json';
import { pickLanAddress } from '../core/lan_address';
import { filterCampaignForPlayer } from '../core/player_filter';
import { editorFor } from '../edit/editors';
import type { PartyControl } from '../party/party_control';
import type { MapStore } from '../storage/map_store';
import type { StoreRegistry } from '../storage/store_registry';
import { dataFolderOf } from '../view/map_view';
import { PLAYER_ASSETS } from './assets';
import { PlayerServer, ServeRefused, textTag, type PlayerPayload } from './player_server';
import { announcePlayerView } from './started_modal';

/** Broadcast when the served map, the server's state or the votes change. */
export const PLAYERS_EVENT = 'hexlore:players';

export interface PlayerSettings {
	/** Reachable from the local network (0.0.0.0), not just this computer. */
	playerLan: boolean;
}

export class PlayerControl {
	private server: PlayerServer | null = null;
	private store: MapStore | null = null;
	private dir: string | null = null;
	private unsub: (() => void)[] = [];
	private revision = 0;
	private cache: { revision: number; payload: PlayerPayload } | null = null;
	private statusEl: HTMLElement | null = null;
	/** Start and stop run one at a time: two quick starts (the file menu on a
	 *  map still opening, then again) would otherwise bind two servers and
	 *  orphan the first, listening until Obsidian quits. */
	private queue: Promise<void> = Promise.resolve();
	/** Redraws the status bar's connected count while serving. */
	private ticker = 0;
	/** The index of the map being served. */
	file: TFile | null = null;
	url: string | null = null;

	constructor(
		private readonly app: App,
		private readonly stores: StoreRegistry,
		private readonly settings: () => PlayerSettings,
		private readonly saveSettings: () => Promise<void>,
		private readonly party?: PartyControl,
	) {}

	get running(): boolean {
		return !!this.server?.running;
	}

	/** Is [file]'s map the one being served? */
	serves(file: TFile | null): boolean {
		return this.running && !!file && file === this.file;
	}

	/** Vote counts per hex for [file]'s map (empty unless it is served). */
	voteCounts(file: TFile | null): Map<string, number> {
		return this.serves(file) && this.server ? this.server.votes.counts() : new Map<string, number>();
	}

	votes(): ReturnType<PlayerServer['votes']['results']> {
		return this.server?.votes.results() ?? [];
	}

	clearVotes(): void {
		this.server?.votes.clear();
		this.changed();
	}

	attachStatusBar(el: HTMLElement): void {
		this.statusEl = el;
		el.addClass('mod-clickable', 'hexlore-status-players');
		el.addEventListener('click', () => {
			if (this.url) void navigator.clipboard.writeText(this.url).then(() => new Notice(`Copied ${this.url}`));
		});
		this.renderStatus();
	}

	/** Serve [file]'s map (stopping any other). Never throws: a failure is
	 *  told to the GM, not left in a promise nobody awaits. */
	start(file: TFile): Promise<void> {
		return this.serial(() => this.doStart(file));
	}

	stop(notify = true): Promise<void> {
		return this.serial(() => this.doStop(notify));
	}

	private serial(run: () => Promise<void>): Promise<void> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => {});
		return next;
	}

	private async doStart(file: TFile): Promise<void> {
		const http = await nodeModule('http');
		if (!http) {
			new Notice('The player view needs Obsidian on a computer: phones and tablets cannot run a server.');
			return;
		}
		try {
			await this.doStop(false);
			const dir = dataFolderOf(this.app, file);
			const store = await this.stores.acquire(dir, file.basename.replace(/\.hexmap$/, ''));
			this.store = store;
			this.dir = dir;
			this.file = file;
			// Any edit or reload may change what players see.
			const bump = () => this.revision++;
			this.unsub.push(store.on((e) => e.kind === 'reloaded' && bump()));
			this.unsub.push(editorFor(store).on((e) => e.kind !== 'history' && e.kind !== 'links' && bump()));
			const server = new PlayerServer({
				http,
				assets: PLAYER_ASSETS,
				payload: () => this.payload(),
				onVotesChanged: () => this.changed(),
				hostnames: await hostnames(),
				// Players see where they are, but only on a hex they have seen:
				// a party moved into the dark shows nothing until it is revealed.
				party: () => {
					const hex = this.party?.state(this.file).hex ?? null;
					return hex && this.store?.model.revealed.has(hex) ? hex : null;
				},
			});
			const lan = this.settings().playerLan;
			const port = await server.start(lan);
			this.server = server;
			this.url = `http://${lan ? await lanAddress() : '127.0.0.1'}:${port}`;
			announcePlayerView(this.app, file.basename.replace(/\.hexmap$/, ''), this.url, lan);
			this.ticker = window.setInterval(() => this.renderStatus(), 5000);
		} catch (e) {
			await this.doStop(false);
			console.error('HexLore: the player view did not start', e);
			new Notice(`Could not start the player view: ${(e as Error).message}`);
		}
		this.changed();
	}

	private async doStop(notify: boolean): Promise<void> {
		const was = this.running;
		window.clearInterval(this.ticker);
		this.ticker = 0;
		await this.server?.stop();
		this.server = null;
		for (const u of this.unsub) u();
		this.unsub = [];
		this.cache = null;
		this.url = null;
		this.file = null;
		this.store = null;
		if (this.dir) {
			const dir = this.dir;
			this.dir = null;
			await this.stores.release(dir);
		}
		if (was && notify) new Notice('Player view stopped.');
		this.changed();
	}

	/** Restart on the same map (the LAN setting changed). */
	private async restart(): Promise<void> {
		const f = this.file;
		if (this.running && f) await this.start(f);
	}

	private payload(): PlayerPayload {
		const store = this.store;
		if (!store) throw new ServeRefused('no map is served');
		// A newer HexLore may have added a rule about what players may see
		// that this build would not apply: refuse rather than leak.
		if (store.model.meta.format > FORMAT_VERSION) throw new ServeRefused(`the map was saved by a newer HexLore (format ${store.model.meta.format})`);
		if (this.cache?.revision === this.revision) return this.cache.payload;
		const body = encodeCompact(filterCampaignForPlayer(store.model));
		const payload = { body, tag: textTag(body), grid: { ...store.model.meta.grid } };
		this.cache = { revision: this.revision, payload };
		return payload;
	}

	private changed(): void {
		this.renderStatus();
		this.app.workspace.trigger(PLAYERS_EVENT);
	}

	private renderStatus(): void {
		const el = this.statusEl;
		if (!el) return;
		if (!this.running || !this.url) {
			el.hide();
			return;
		}
		el.show();
		const n = this.server?.votes.voterCount ?? 0;
		const devices = this.server?.connectedCount() ?? 0;
		el.setText(`Players: ${this.url.replace(/^http:\/\//, '')} · ${devices} connected${n ? ` · ${n} vote${n === 1 ? '' : 's'}` : ''}`);
		el.setAttr('aria-label', `Serving “${this.file?.basename.replace(/\.hexmap$/, '') ?? ''}” to players. Click to copy the link.`);
	}

	/** The LAN setting changed: a running server rebinds. */
	async lanChanged(): Promise<void> {
		await this.saveSettings();
		await this.restart();
	}
}

/** This computer's names a player may type instead of its address. */
async function hostnames(): Promise<string[]> {
	const os = await nodeModule('os');
	const name = os?.hostname();
	return name ? [name, `${name}.local`] : [];
}

/** Best-effort LAN address: the IPv4 one players on the same network can
 *  most likely reach (a physical adapter's private address over a VPN or a
 *  virtual switch; `core/lan_address.ts`). */
async function lanAddress(): Promise<string> {
	const os = await nodeModule('os');
	const candidates: [string, string][] = [];
	for (const [name, list] of Object.entries(os?.networkInterfaces() ?? {})) {
		for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) candidates.push([name, a.address]);
	}
	return pickLanAddress(candidates) ?? '127.0.0.1';
}
