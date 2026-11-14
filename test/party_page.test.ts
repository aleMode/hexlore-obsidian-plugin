import http from 'http';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';
import { Hex } from '../src/core/hex';
import { encodeCompact } from '../src/core/json';
import { MapModel } from '../src/core/map';
import { filterCampaignForPlayer } from '../src/core/player_filter';
import { PLAYER_ASSETS } from '../src/server/assets';
import { PlayerServer, textTag } from '../src/server/player_server';

const GOLD = '#D4A84A';

/** Canvas stand-ins: jsdom has no 2D context. Every call is a no-op; the
 *  fill colours set are recorded. */
function fakeCanvas(w: Window & typeof globalThis, fills: string[]): void {
	const made: Record<string, () => unknown> = {
		measureText: () => ({ width: 10 }),
		createLinearGradient: () => ({ addColorStop() {} }),
		createRadialGradient: () => ({ addColorStop() {} }),
		createPattern: () => ({}),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		createImageData: () => ({ data: new Uint8ClampedArray(4) }),
	};
	const state: Record<string, unknown> = {};
	const ctx = new Proxy(state, {
		get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : (made[k] ?? (() => undefined))),
		set: (t, k, v) => {
			if (k === 'fillStyle') fills.push(String(v));
			if (typeof k === 'string') t[k] = v;
			return true;
		},
	});
	Object.assign(w, {
		Path2D: class {
			moveTo() {}
			lineTo() {}
			closePath() {}
			arc() {}
			bezierCurveTo() {}
			quadraticCurveTo() {}
			rect() {}
			ellipse() {}
			addPath() {}
		},
	});
	Object.assign(w.HTMLCanvasElement.prototype, { getContext: () => ctx });
}

it('the real player page draws the party, served by the plugin, and drops it when told', async () => {
	const m = new MapModel();
	const forest = new Hex(1, 1);
	forest.terrain = 'forest';
	m.hexes.set(forest.id, forest);
	m.revealed.add('q1_r1');
	let partyHex: string | null = 'q1_r1';
	const payload = () => {
		const body = encodeCompact(filterCampaignForPlayer(m));
		return { body, tag: textTag(body), grid: { ...m.meta.grid } };
	};
	const server = new PlayerServer({ http, assets: PLAYER_ASSETS, payload, party: () => partyHex });
	await server.start(false);
	const base = `http://127.0.0.1:${server.port}`;
	// The served page, its scripts inline (jsdom loads no external scripts here).
	const html = PLAYER_ASSETS['index.html']!.replace(
		/<script src="\/static\/([\w.]+)"><\/script>/g,
		(_, f: string) => `<script>${PLAYER_ASSETS[f]}</script>`,
	);
	const fills: string[] = [];
	const errors: string[] = [];
	const dom = new JSDOM(html, {
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		url: `${base}/`,
		beforeParse(w) {
			w.fetch = ((u: string, o?: RequestInit) => globalThis.fetch(new URL(u, base), o)) as typeof w.fetch;
			w.addEventListener('error', (e) => errors.push(e.message));
			fakeCanvas(w, fills);
		},
	});
	const page = dom.window as unknown as { renderNow(): void };
	const until = async (ok: () => boolean, ms: number) => {
		for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
	};
	try {
		await until(() => fills.includes(GOLD), 3000);
		expect(errors).toEqual([]);
		expect(fills).toContain(GOLD);
		partyHex = null; // the party leaves the revealed ground: the next poll drops it
		await new Promise((r) => setTimeout(r, 3300));
		fills.length = 0;
		page.renderNow();
		expect(fills.length).toBeGreaterThan(0);
		expect(fills).not.toContain(GOLD);
		expect(errors).toEqual([]);
	} finally {
		dom.window.close();
		await server.stop();
	}
}, 20_000);
