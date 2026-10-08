import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hex } from '../src/core/hex';
import { encodeCompact } from '../src/core/json';
import { MapModel } from '../src/core/map';
import { filterCampaignForPlayer } from '../src/core/player_filter';
import { MAX_VOTERS, VoteTally, sanitizeVoterName } from '../src/core/travel_votes';
import { PLAYER_ASSETS } from '../src/server/assets';
import { PORT_FIRST, PlayerServer, ServeRefused, textTag, type PlayerPayload } from '../src/server/player_server';

function model(): MapModel {
	const m = new MapModel();
	m.meta.name = 'Served';
	const shown = new Hex(0, 0);
	shown.name = 'Shown';
	shown.terrain = 'forest';
	m.hexes.set(shown.id, shown);
	const hidden = new Hex(1, 0);
	hidden.name = 'Hidden';
	m.hexes.set(hidden.id, hidden);
	m.revealed.add('q0_r0');
	return m;
}

describe('the player server, on a real socket', () => {
	let m: MapModel;
	let refuse = false;
	let votesChanged = 0;
	let server: PlayerServer;
	const payload = (): PlayerPayload => {
		if (refuse) throw new ServeRefused('newer format');
		const body = encodeCompact(filterCampaignForPlayer(m));
		return { body, tag: textTag(body), grid: { ...m.meta.grid } };
	};

	beforeEach(async () => {
		m = model();
		refuse = false;
		votesChanged = 0;
		server = new PlayerServer({ http, assets: PLAYER_ASSETS, payload, onVotesChanged: () => votesChanged++ });
		await server.start(false);
	});

	afterEach(async () => {
		await server.stop();
	});

	const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

	/** fetch, on a connection of its own: a pooled keep-alive one could
	 *  belong to the previous test's server on the same port. */
	const fetch = (target: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		new Promise<{ status: number; headers: Map<string, string>; text: () => Promise<string>; json: () => Promise<unknown> }>((resolve, reject) => {
			const req = http.request(target, { method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (c: string) => (body += c));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: new Map(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
						text: () => Promise.resolve(body),
						json: () => Promise.resolve(JSON.parse(body) as unknown),
					}),
				);
			});
			req.on('error', reject);
			req.end(init.body);
		});

	it('serves the page and every script it loads', async () => {
		const index = await fetch(url('/'));
		expect(index.status).toBe(200);
		const html = await index.text();
		for (const src of html.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)) {
			expect((await fetch(url(src[1]!))).status, src[1]).toBe(200);
		}
		expect((await fetch(url('/nope'))).status).toBe(404);
		expect((await fetch(url('/api/threads'))).status).toBe(404);
	});

	it('serves only revealed hexes, and 304 while nothing changed', async () => {
		const res = await fetch(url('/api/map'));
		const data = (await res.json()) as { hexes: { name?: string }[]; campaign_name: string };
		expect(data.campaign_name).toBe('Served');
		expect(data.hexes.map((h) => h.name)).toEqual(['Shown']);
		const tag = res.headers.get('etag')!;
		expect((await fetch(url('/api/map'), { headers: { 'If-None-Match': tag } })).status).toBe(304);
		m.revealed.add('q1_r0');
		const after = await fetch(url('/api/map'), { headers: { 'If-None-Match': tag } });
		expect(after.status).toBe(200);
		expect(((await after.json()) as { hexes: unknown[] }).hexes).toHaveLength(2);
	});

	it('refuses (503) a map it cannot filter safely', async () => {
		refuse = true;
		expect((await fetch(url('/api/map'))).status).toBe(503);
	});

	it('takes votes inside the grid, in memory only', async () => {
		const vote = (body: unknown) => fetch(url('/api/vote'), { method: 'POST', body: JSON.stringify(body) });
		const res = await vote({ voter: 'v1', name: '  Mara  ', q: 5, r: 1 });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ voters: 1, tally: [{ hex: 'q5_r1', count: 1, names: ['Mara'] }], your_hex: 'q5_r1' });
		expect(votesChanged).toBe(1);
		expect((await vote({ voter: 'v1', q: 9999, r: 0 })).status).toBe(400); // off the grid
		expect((await vote({ q: 1, r: 1 })).status).toBe(400); // no voter
		expect((await fetch(url('/api/vote'))).status).toBe(405);
		expect((await vote({ voter: 'v1' })).status).toBe(200); // withdrawn
		expect(server.votes.isEmpty).toBe(true);
		const big = await fetch(url('/api/vote'), { method: 'POST', body: JSON.stringify({ voter: 'x'.repeat(5000) }) });
		expect(big.status).toBe(413);
	});

	it('stopping empties the ballot box; a second server takes the next port', async () => {
		const other = new PlayerServer({ http, assets: PLAYER_ASSETS, payload });
		try {
			expect(await other.start(false)).toBe(server.port! + 1);
		} finally {
			await other.stop();
		}
		expect(server.port).toBe(PORT_FIRST);
		server.votes.cast('v', 'q0_r0', 'A');
		await server.stop();
		expect(server.votes.isEmpty).toBe(true);
	});
});

describe('travel votes (decision 17)', () => {
	it('one standing vote per voter, most-voted first, ties by who came first', () => {
		const t = new VoteTally();
		t.cast('a', 'q1_r0', 'Ann', 1);
		t.cast('b', 'q2_r0', 'Bob', 2);
		t.cast('c', 'q2_r0', 'Cy', 3);
		t.cast('a', 'q2_r0', undefined, 4); // changed her mind, keeps her name
		expect(t.results()).toEqual([{ hexId: 'q2_r0', voterNames: ['Bob', 'Cy', 'Ann'], firstAt: 2 }]);
		expect(t.toJson('zz')).toMatchObject({ voters: 3, your_hex: null });
	});

	it('caps voters and names', () => {
		const t = new VoteTally();
		for (let i = 0; i < MAX_VOTERS; i++) expect(t.cast(`v${i}`, 'q0_r0')).toBe(true);
		expect(t.cast('new', 'q0_r0')).toBe(false);
		expect(t.cast('v0', 'q1_r0')).toBe(true); // an existing voter may still change
		expect(sanitizeVoterName('a\n\tb')).toBe('a b');
		expect(sanitizeVoterName('x'.repeat(40))).toHaveLength(24);
		expect(sanitizeVoterName('   ')).toBeNull();
	});
});
