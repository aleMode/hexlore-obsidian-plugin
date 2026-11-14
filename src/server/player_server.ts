// The player server (plan item 2.6; Flutter's lib/server/player_server.dart).
// Node's `http`, handed in by the caller (loaded lazily, desktop only), so
// nothing here runs on mobile and the tests use a real socket.
//
// It serves the player page and `/api/map`: the ported player_filter's
// output, never anything else (decision 4). The one thing players may WRITE
// is a travel vote (decision 17), held in memory and gone when the server
// stops. Nothing here reads or writes the vault.

// Types only: the module itself is passed in (PlayerServerOptions.http).
type IncomingMessage = import('http').IncomingMessage;
type Server = import('http').Server;
type ServerResponse = import('http').ServerResponse;
import { cellInGrid, type GridWindow } from '../core/geometry';
import { hexIdFor } from '../core/hex_data';
import { MAX_VOTER_ID_LENGTH, VoteTally } from '../core/travel_votes';

/** Ports tried in order (the Flutter app's window). */
export const PORT_FIRST = 5174;
export const PORT_LAST = 5180;

/** Largest accepted vote body; a vote is ~100 bytes. */
const MAX_VOTE_BODY = 2048;

/** Voters one device (remote address) may hold: room for a table sharing a
 *  tablet, not enough to fill the tally (MAX_VOTERS) alone. */
export const MAX_VOTERS_PER_ADDRESS = 8;

/** A device that polled the map within this long counts as connected. */
export const CONNECTED_MS = 10_000;

/** Is [host] (a Host header's name, without the port) one this server may
 *  be reached by? An IP address, localhost, or one of [names] (this
 *  computer's own). Any other name is a web page's domain pointed at this
 *  computer (DNS rebinding): refused, so no page the GM visits can read the
 *  map or vote. */
export function hostAllowed(host: string, names: readonly string[] = []): boolean {
	const h = host.toLowerCase().replace(/\.$/, '');
	if (h === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\[[0-9a-f:.]+\]$/.test(h)) return true;
	return names.some((n) => n.toLowerCase() === h);
}

/** The name part of a Host header: `[::1]:5174` → `[::1]`, `pc:5174` → `pc`. */
function hostName(header: string): string {
	return header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.replace(/:\d+$/, '');
}

const STATIC: Record<string, [file: string, type: string]> = {
	'/': ['index.html', 'text/html; charset=utf-8'],
	'/static/player.css': ['player.css', 'text/css; charset=utf-8'],
	'/static/player.js': ['player.js', 'text/javascript; charset=utf-8'],
	'/static/render_spec.js': ['render_spec.js', 'text/javascript; charset=utf-8'],
	'/static/feature_glyphs.js': ['feature_glyphs.js', 'text/javascript; charset=utf-8'],
	'/static/terrain_glyphs.js': ['terrain_glyphs.js', 'text/javascript; charset=utf-8'],
	'/static/texture_tables.js': ['texture_tables.js', 'text/javascript; charset=utf-8'],
	'/static/texture_spec.js': ['texture_spec.js', 'text/javascript; charset=utf-8'],
	'/static/party.js': ['party.js', 'text/javascript; charset=utf-8'],
};

/** The map as players get it: the filtered JSON, a tag that changes when it
 *  does (the ETag), and the grid votes are checked against. */
export interface PlayerPayload {
	body: string;
	tag: string;
	grid: GridWindow;
}

/** The map cannot be served (a newer format: this build might not apply a
 *  rule about what players may see). `/api/map` answers 503. */
export class ServeRefused extends Error {}

export interface PlayerServerOptions {
	http: typeof import('http');
	/** File name → text: index.html, player.css, player.js and the tables. */
	assets: Readonly<Record<string, string>>;
	/** The current payload; throws ServeRefused to refuse. */
	payload: () => PlayerPayload;
	/** A vote was cast or withdrawn. */
	onVotesChanged?: () => void;
	/** The party's hex as players may see it: null unless placed on a
	 *  REVEALED hex (the plugin's own, design §1.12). */
	party?: () => string | null;
	/** This computer's names a player may use besides its IP addresses
	 *  (`os.hostname()`, its `.local` name). */
	hostnames?: readonly string[];
}

/** A short, stable tag for [text] (cyrb53): an ETag, not a security hash. */
export function textTag(text: string): string {
	let h1 = 0xdeadbeef,
		h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return `"${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-${text.length}"`;
}

export class PlayerServer {
	/** Party votes, for this server's lifetime only. */
	readonly votes = new VoteTally();
	private server: Server | null = null;
	private host: string | null = null;
	port: number | null = null;
	/** Voter id → the address that cast it (for the per-device cap). */
	private readonly voterAddress = new Map<string, string>();
	/** Remote address → when it last asked for the map. */
	private readonly lastPoll = new Map<string, number>();

	constructor(private readonly opts: PlayerServerOptions) {}

	get running(): boolean {
		return this.server !== null;
	}

	/** Bound to every interface (reachable from the LAN), or localhost only. */
	get lan(): boolean {
		return this.host === '0.0.0.0';
	}

	/** Bind the first free port in the window. [lan]: 0.0.0.0 instead of
	 *  127.0.0.1. Returns the port. */
	async start(lan: boolean): Promise<number> {
		await this.stop();
		const host = lan ? '0.0.0.0' : '127.0.0.1';
		let last: unknown = null;
		for (let p = PORT_FIRST; p <= PORT_LAST; p++) {
			const server = this.opts.http.createServer((req, res) => void this.handle(req, res));
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen(p, host, () => {
						server.off('error', reject);
						resolve();
					});
				});
				server.on('error', () => undefined);
				this.server = server;
				this.host = host;
				this.port = p;
				return p;
			} catch (e) {
				last = e;
				server.close();
			}
		}
		throw new Error(`no free port in ${PORT_FIRST}–${PORT_LAST}: ${(last as Error | null)?.message ?? ''}`);
	}

	/** Devices (remote addresses) that polled the map in the last
	 *  CONNECTED_MS before [now]. Players on this computer count as one. */
	connectedCount(now = Date.now()): number {
		let n = 0;
		for (const [addr, at] of this.lastPoll) {
			if (now - at > CONNECTED_MS) this.lastPoll.delete(addr);
			else n++;
		}
		return n;
	}

	/** Stop serving; the ballot box goes with it. */
	async stop(): Promise<void> {
		const s = this.server;
		this.server = null;
		this.host = null;
		this.port = null;
		this.votes.clear();
		this.voterAddress.clear();
		this.lastPoll.clear();
		if (!s) return;
		await new Promise<void>((resolve) => {
			s.close(() => resolve());
			// Polling players keep connections alive; don't wait on them.
			(s as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
		});
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			const url = new URL(req.url ?? '/', 'http://player.local');
			res.setHeader('X-Content-Type-Options', 'nosniff');
			if (!hostAllowed(hostName(req.headers.host ?? ''), this.opts.hostnames)) return this.status(res, 421);
			const asset = STATIC[url.pathname];
			if (asset) return this.serveAsset(res, ...asset);
			switch (url.pathname) {
				case '/api/map':
					return this.serveMap(req, res);
				case '/api/party':
					return this.json(res, { hex: this.partyHex() });
				case '/api/votes':
					return this.json(res, this.votes.toJson(url.searchParams.get('voter')));
				case '/api/vote':
					return await this.vote(req, res);
				default:
					return this.status(res, 404);
			}
		} catch {
			try {
				this.status(res, 500);
			} catch {
				/* the client went away */
			}
		}
	}

	private partyHex(): string | null {
		try {
			return this.opts.party?.() ?? null;
		} catch {
			return null;
		}
	}

	private serveAsset(res: ServerResponse, name: string, type: string): void {
		const body = this.opts.assets[name];
		if (body === undefined) return this.status(res, 404);
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
		res.end(body);
	}

	private serveMap(req: IncomingMessage, res: ServerResponse): void {
		this.lastPoll.set(addressOf(req), Date.now());
		let p: PlayerPayload;
		try {
			p = this.opts.payload();
		} catch (e) {
			if (e instanceof ServeRefused) {
				res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(e.message);
				return;
			}
			throw e;
		}
		// A poll carrying the tag back gets 304 while nothing changed.
		if (req.headers['if-none-match'] === p.tag) {
			res.writeHead(304, { ETag: p.tag, 'Cache-Control': 'no-cache' });
			res.end();
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ETag: p.tag, 'Cache-Control': 'no-cache' });
		res.end(p.body);
	}

	/** `POST /api/vote` {voter, name, q, r} casts; without q/r withdraws. The
	 *  cell is checked against the served GRID, not the revealed set: the
	 *  party may point at somewhere unseen. */
	private async vote(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== 'POST') return this.status(res, 405);
		// A page from elsewhere may post here (a form or fetch needs no CORS to
		// send): only the player page's own origin votes.
		const origin = req.headers.origin;
		if (origin !== undefined && !sameOrigin(origin, req.headers.host ?? '')) return this.status(res, 403);
		if (Number(req.headers['content-length'] ?? 0) > MAX_VOTE_BODY) return this.status(res, 413);
		const text = await readBody(req, MAX_VOTE_BODY);
		if (text === null) return this.status(res, 413);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return this.status(res, 400);
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) return this.status(res, 400);
		const b = body as Record<string, unknown>;
		const voter = b.voter;
		if (typeof voter !== 'string' || !voter || voter.length > MAX_VOTER_ID_LENGTH) return this.status(res, 400);
		let accepted: boolean;
		if (Number.isInteger(b.q) && Number.isInteger(b.r)) {
			let grid: GridWindow;
			try {
				grid = this.opts.payload().grid;
			} catch {
				return this.status(res, 503);
			}
			const q = b.q as number, r = b.r as number;
			if (!cellInGrid(q, r, grid)) return this.status(res, 400);
			const addr = addressOf(req);
			const known = !!this.votes.voteOf(voter);
			const held = [...this.voterAddress].filter(([id, a]) => a === addr && id !== voter && this.votes.voteOf(id)).length;
			if (!known && held >= MAX_VOTERS_PER_ADDRESS) accepted = false;
			else {
				accepted = this.votes.cast(voter, hexIdFor(q, r), b.name);
				if (accepted) this.voterAddress.set(voter, addr);
			}
		} else {
			accepted = this.votes.clearVoter(voter);
		}
		if (accepted) this.opts.onVotesChanged?.();
		this.json(res, this.votes.toJson(voter));
	}

	private json(res: ServerResponse, payload: unknown): void {
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(payload));
	}

	private status(res: ServerResponse, code: number): void {
		res.writeHead(code);
		res.end();
	}
}

/** The remote address, IPv4-mapped IPv6 written as IPv4. */
function addressOf(req: IncomingMessage): string {
	return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** Does the Origin header name the host the request was sent to? */
function sameOrigin(origin: string, host: string): boolean {
	try {
		return new URL(origin).host.toLowerCase() === host.toLowerCase();
	} catch {
		return false;
	}
}

/** The request body as text, or null when it grows past [max] bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		req.on('data', (c: Uint8Array) => {
			size += c.length;
			if (size > max) {
				resolve(null);
				req.destroy();
			} else chunks.push(c);
		});
		req.on('end', () => {
			const all = new Uint8Array(size);
			let at = 0;
			for (const c of chunks) {
				all.set(c, at);
				at += c.length;
			}
			resolve(new TextDecoder().decode(all));
		});
		req.on('error', reject);
	});
}
