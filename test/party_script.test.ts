import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { PARTY_JS, withPartyScript } from '../src/server/party_script';

/** What the stand-in page puts on its window. */
interface PageWindow {
	calls: string[];
	go(): void;
}

/** A stand-in for player.js: classic-script globals as the real page has
 *  them (a function the frame calls by name, consts and lets). */
const PAGE = `
const R = 48;
let view = { scale: 1, ox: 0, oy: 0 };
const calls = [];
const ctx = new Proxy({}, { get: (_, k) => (typeof k === 'string' && ['save','restore','beginPath','arc','fill','stroke','moveTo','lineTo'].includes(k) ? (...a) => calls.push(k) : undefined), set: () => true });
function axialToPixel(q, r) { return { x: q * 10, y: r * 10 }; }
function worldToScreen(x, y) { return { x, y }; }
function drawVoteMarkers() { calls.push('votes'); }
function renderNow() { drawVoteMarkers(); }
function render() { renderNow(); }
window.calls = calls;
`;

describe('the party script on the player page', () => {
	it('is added after the page’s own scripts', () => {
		const html = withPartyScript('<html><body><script src="/static/player.js"></script>\n</body></html>');
		expect(html.indexOf('party.js')).toBeGreaterThan(html.indexOf('player.js'));
	});

	it('draws the party after the vote markers once /api/party names a hex', async () => {
		// Real <script> tags: classic scripts share their top-level lets and consts.
		const fetchStub = `window.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ hex: 'q1_r2' }) });`;
		const scripts = [fetchStub, PAGE, PARTY_JS].map((src) => `<script>${src}</script>`).join('');
		const dom = new JSDOM(`<!doctype html><body>${scripts}<script>window.go = () => renderNow();</script></body>`, { runScripts: 'dangerously' });
		const w = dom.window as unknown as PageWindow;
		await new Promise((r) => setTimeout(r, 20));
		w.calls.length = 0;
		w.go();
		expect(w.calls[0]).toBe('votes');
		expect(w.calls).toContain('arc');
		dom.window.close();
	});
});
