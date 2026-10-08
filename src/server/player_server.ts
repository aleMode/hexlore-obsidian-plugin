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

const STATIC: Record<string, [file: string, type: string]> = {
	'/': ['index.html', 'text/html; charset=utf-8'],
	'/static/player.css': ['player.css', 'text/css; charset=utf-8'],
	'/static/player.js': ['player.js', 'text/javascript; charset=utf-8'],
	'/static/render_spec.js': ['render_spec.js', 'text/javascript; charset=utf-8'],
	'/static/feature_glyphs.js': ['feature_glyphs.js', 'text/javascript; charset=utf-8'],
	'/static/terrain_glyphs.js': ['terrain_glyphs.js', 'text/javascript; charset=utf-8'],
	'/static/texture_tables.js': ['texture_tables.js', 'text/javascript; charset=utf-8'],
	'/static/texture_spec.js': ['texture_spec.js', 'text/javascript; charset=utf-8'],
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

	/** Stop serving; the ballot box goes with it. */
	async stop(): Promise<void> {
		const s = this.server;
		this.server = null;
		this.host = null;
		this.port = null;
		this.votes.clear();
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
			const asset = STATIC[url.pathname];
			if (asset) return this.serveAsset(res, ...asset);
			switch (url.pathname) {
				case '/api/map':
					return this.serveMap(req, res);
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

	private serveAsset(res: ServerResponse, name: string, type: string): void {
		const body = this.opts.assets[name];
		if (body === undefined) return this.status(res, 404);
		res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
		res.end(body);
	}

	private serveMap(req: IncomingMessage, res: ServerResponse): void {
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
			accepted = this.votes.cast(voter, hexIdFor(q, r), b.name);
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
