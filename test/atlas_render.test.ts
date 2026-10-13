// "Show maps together" lays maps over one another, so a map must cover
// only its painted hexes: no background, no empty cells, no hexes holding
// only a name or notes. The map view keeps its opaque path.

import { beforeAll, describe, expect, it } from 'vitest';
import { syntheticMap } from '../src/dev/synthetic';
import { MapCanvas } from '../src/render/map_canvas';
import { MapPainter } from '../src/render/painter';
import { CANVAS_BG, EMPTY_FILL, MapScene, type MapData, type SceneHex } from '../src/render/scene';
import { TextureCache } from '../src/render/textures';
import { SPEC } from '../src/render/vendor';
import { FakeWindow, installPath2D } from './helpers/fake_canvas';

beforeAll(installPath2D);

interface Log {
	fills: string[];
	texts: string[];
	clears: number;
	opaque: number;
}

const newLog = (): Log => ({ fills: [], texts: [], clears: 0, opaque: 0 });

/** A context recording the style of every fill, the text drawn and clears. */
function recorder(log: Log): CanvasRenderingContext2D {
	const props: Record<string | symbol, unknown> = {};
	return new Proxy(props, {
		get(target, key) {
			if (key in target) return target[key];
			if (key === 'measureText') return (s: string) => ({ width: s.length * 6 });
			if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
			if (key === 'fill' || key === 'fillRect') return () => void log.fills.push(String(target.fillStyle));
			if (key === 'fillText') return (t: string) => void log.texts.push(t);
			if (key === 'clearRect') return () => void log.clears++;
			return () => {};
		},
		set(target, key, value) {
			target[key] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

function surface(log: Log, w = 300, h = 150) {
	const ctx = recorder(log);
	return {
		width: w,
		height: h,
		getContext: (_kind: string, opts?: { alpha?: boolean }) => {
			if (opts?.alpha === false) log.opaque++;
			return ctx;
		},
	};
}

/** Six by six: three hexes painted, one holding only a name, the rest empty. */
function sparse(): MapData {
	const data = syntheticMap(6, 6);
	const painted = data.hexes.filter((h) => h.terrain !== 'default').slice(0, 3);
	const named: SceneHex = { ...data.hexes[20]!, terrain: 'default', name: 'Only a name', feature: null, hasContent: false };
	return { ...data, hexes: [...painted.map((h) => ({ ...h, name: null })), named], rivers: [], routes: [], regions: [], threads: [] };
}

const painter = () => new MapPainter(new TextureCache(() => surface(newLog()), (h) => SPEC.parseHex(h)));
const all: [number, number, number, number] = [-1e4, -1e4, 1e4, 1e4];

describe('painted hexes only', () => {
	it('the map view fills empty cells and named ones (unchanged)', () => {
		const log = newLog();
		painter().paint(recorder(log), new MapScene(sparse()), { style: 'clean', blend: false, scale: 1, dpr: 1, rect: all });
		expect(log.fills).toContain(EMPTY_FILL);
		expect(log.texts).toContain('Only a name');
	});

	it('skips every cell with no terrain painted, at full detail', () => {
		const log = newLog();
		const scene = new MapScene(sparse());
		scene.paintedOnly = true;
		painter().paint(recorder(log), scene, { style: 'clean', blend: false, scale: 1, dpr: 1, rect: all });
		expect(log.fills).not.toContain(EMPTY_FILL);
		expect(log.texts).not.toContain('Only a name');
		expect(log.fills.length).toBeGreaterThanOrEqual(3);
	});

	it('and far out, where hexes are squares of their fill', () => {
		const log = newLog();
		const scene = new MapScene(sparse());
		scene.paintedOnly = true;
		painter().paint(recorder(log), scene, { style: 'clean', blend: false, scale: 0.05, dpr: 1, rect: all });
		expect(log.fills.length).toBe(3);
	});
});

describe('a transparent map canvas', () => {
	function frameOf(transparent: boolean): Log {
		const log = newLog();
		const win = new FakeWindow();
		const host = { clientWidth: 800, clientHeight: 600, createEl: () => surface(log) } as unknown as HTMLElement;
		const canvas = new MapCanvas(host, win as unknown as Window, (w, h) => surface(log, w, h), { transparent });
		const scene = new MapScene(sparse());
		scene.paintedOnly = transparent;
		canvas.setScene(scene);
		canvas.resize();
		canvas.camera = { scale: 1, ox: 0, oy: 0 };
		canvas.frame();
		return log;
	}

	it('the map view is opaque and starts from the background (unchanged)', () => {
		const log = frameOf(false);
		expect(log.opaque).toBeGreaterThan(0);
		expect(log.fills).toContain(CANVAS_BG);
	});

	it('clears instead, so the map below shows through', () => {
		const log = frameOf(true);
		expect(log.opaque).toBe(0);
		expect(log.fills).not.toContain(CANVAS_BG);
		expect(log.fills).not.toContain(EMPTY_FILL);
		expect(log.clears).toBeGreaterThan(0);
	});
});
