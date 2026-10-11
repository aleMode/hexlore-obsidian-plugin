// The renderer benchmark (item 2.0's harness, now driving the real renderer).
//
// Scripted, so runs compare: pan at fit and at zoom 1.0 (tiles), pan at zoom
// 1.0 rendering directly (a frame with no tiles, as after a change to threads
// or overlays; an edit to hexes redraws only the tiles it touches), wheel zoom
// one notch per frame then the settle, and a 300-hex brush stroke, in Clean,
// Illustrated and Illustrated + Blend. The view is pinned to 1920×1080 CSS px.
// Each style starts with no textures made, as a map just opened.

import { HEX_RADIUS as R, unstaggeredRow } from '../core/geometry';
import type { MapCanvas } from '../render/map_canvas';
import { MapScene, type MapData, type MapStyle, type SceneHex } from '../render/scene';

export const BENCH_W = 1920;
export const BENCH_H = 1080;

export interface Stats {
	n: number;
	median: number;
	p95: number;
	max: number;
}

export interface ScenarioResult {
	style: string;
	name: string;
	frame: Stats;
	interval: Stats;
	dropped: number;
	modes: string;
	tiles: number;
	textures: number;
}

export interface BenchReport {
	refreshMs: number;
	map: string;
	hexes: number;
	dpr: number;
	results: ScenarioResult[];
}

export function stats(xs: number[]): Stats {
	const s = [...xs].sort((a, b) => a - b);
	const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
	return { n: s.length, median: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0 };
}

/** [count] cells in a boustrophedon block around the map's centre. */
export function strokeCells(data: MapData, count = 300): [number, number][] {
	const qs = data.hexes.map((h) => h.q).sort((a, b) => a - b);
	const us = data.hexes.map((h) => unstaggeredRow(h.q, h.r)).sort((a, b) => a - b);
	const q0 = qs[Math.floor(qs.length / 2)] ?? 0, u0 = us[Math.floor(us.length / 2)] ?? 0;
	const cols = 20, rows = Math.ceil(count / cols);
	const out: [number, number][] = [];
	for (let i = 0; i < rows; i++) {
		for (let j = 0; j < cols && out.length < count; j++) {
			const q = q0 - cols / 2 + (i % 2 ? cols - 1 - j : j);
			const u = u0 - Math.floor(rows / 2) + i;
			out.push([q, u - Math.floor(q / 2)]);
		}
	}
	return out;
}

const BRUSH = ['forest', 'plains', 'hills', 'desert'] as const;

export async function runBench(
	win: Window,
	canvas: MapCanvas,
	host: HTMLElement,
	data: MapData,
	onProgress: (msg: string) => void,
): Promise<BenchReport> {
	const frame = () => new Promise<number>((res) => win.requestAnimationFrame(res));
	const idle: number[] = [];
	let t = await frame();
	for (let i = 0; i < 60; i++) {
		const now = await frame();
		idle.push(now - t);
		t = now;
	}
	const refreshMs = stats(idle).median;

	const saved = {
		style: canvas.style,
		blend: canvas.blend,
		camera: { ...canvas.camera },
		width: host.style.width,
		height: host.style.height,
		scene: canvas.getScene(),
	};
	host.style.width = `${BENCH_W}px`;
	host.style.height = `${BENCH_H}px`;
	canvas.resize();
	canvas.manual = true;
	const results: ScenarioResult[] = [];

	const measure = async (style: string, name: string, frames: number, step: (i: number) => void) => {
		onProgress(`${style}: ${name}…`);
		// Warm-up, as in use: tiles and textures for where the run starts.
		for (let i = 0; i < 3; i++) {
			await frame();
			canvas.frame();
		}
		const times: number[] = [], intervals: number[] = [], modes = new Map<string, number>();
		const idleWork = new Map<string, number>();
		let tiles = 0;
		const made = canvas.texturesMade;
		let last = await frame();
		for (let i = 0; i < frames; i++) {
			const now = await frame();
			intervals.push(now - last);
			last = now;
			step(i);
			const s = canvas.frame();
			times.push(s.ms);
			tiles += s.tilesRendered;
			modes.set(s.mode, (modes.get(s.mode) ?? 0) + 1);
			if (s.background) idleWork.set(s.background, (idleWork.get(s.background) ?? 0) + 1);
		}
		intervals.push((await frame()) - last);
		results.push({
			style,
			name,
			frame: stats(times),
			interval: stats(intervals),
			dropped: intervals.filter((d) => d > refreshMs * 1.5).length / intervals.length,
			modes:
				[...modes].map(([m, n]) => `${m} ${n}`).join(', ') +
				(idleWork.size ? ` (idle: ${[...idleWork].map(([m, n]) => `${m} ${n}`).join(', ')})` : ''),
			tiles,
			textures: canvas.texturesMade - made,
		});
	};

	try {
		const configs: { label: string; style: MapStyle; blend: boolean }[] = [
			{ label: 'Clean', style: 'clean', blend: false },
			{ label: 'Illustrated', style: 'illustrated', blend: false },
			{ label: 'Illustrated + Blend', style: 'illustrated', blend: true },
		];
		for (const cfg of configs) {
			canvas.setScene(new MapScene(data));
			canvas.dropRasters(); // each style starts cold, whatever was open before
			canvas.setStyle(cfg.style, cfg.blend);
			canvas.useTiles = true;
			const pan = (i: number) => canvas.panBy(i < 120 ? -6 : 6, i < 120 ? -2 : 2);
			const at = (scale: number) => {
				const [x, y] = canvas.centre();
				canvas.camera.scale = scale;
				canvas.centreOn(x, y);
			};
			canvas.fit();
			await measure(cfg.label, `pan at fit (scale ${canvas.camera.scale.toFixed(2)})`, 240, pan);
			at(1);
			await measure(cfg.label, 'pan at zoom 1.0', 240, pan);
			canvas.useTiles = false;
			await measure(cfg.label, 'pan at zoom 1.0, direct (no tiles)', 120, pan);
			canvas.useTiles = true;
			canvas.fit();
			await measure(cfg.label, 'wheel zoom 1 notch/frame, then settle', 70, (i) => {
				if (i < 20) canvas.zoomAt(BENCH_W / 2, BENCH_H / 2, 1.15);
				else if (i < 40) canvas.zoomAt(BENCH_W / 2, BENCH_H / 2, 1 / 1.15);
			});
			if (!cfg.blend) {
				const scene = new MapScene(data);
				canvas.setScene(scene);
				at(1);
				const cells = strokeCells(data);
				await measure(cfg.label, `brush stroke, ${cells.length} hexes`, cells.length, (i) => {
					const [q, r] = cells[i]!;
					const old = scene.hexAt(q, r);
					const h: SceneHex = {
						...(old ?? { q, r, name: null, feature: null, featureVariant: 0, featureHidden: false, colorOverride: null }),
						q,
						r,
						terrain: BRUSH[i % BRUSH.length]!,
						terrainVariant: 0,
						hasContent: true,
					};
					scene.setHex(h);
				});
			}
		}
	} finally {
		canvas.manual = false;
		host.style.width = saved.width;
		host.style.height = saved.height;
		canvas.setScene(saved.scene);
		canvas.setStyle(saved.style, saved.blend);
		canvas.useTiles = true;
		canvas.resize();
		canvas.camera = saved.camera;
		canvas.requestFrame();
	}
	return { refreshMs, map: data.name, hexes: data.hexes.length, dpr: win.devicePixelRatio, results };
}

const ms = (x: number) => x.toFixed(1);

export function reportMarkdown(r: BenchReport, env: Record<string, string>): string {
	const budget = 1000 / 60;
	const lines = [
		`# HexLore renderer benchmark — ${r.map}`,
		'',
		...Object.entries(env).map(([k, v]) => `- **${k}:** ${v}`),
		`- **Hexes:** ${r.hexes}`,
		`- **View:** ${BENCH_W}×${BENCH_H} CSS px at device pixel ratio ${r.dpr}`,
		`- **Display refresh:** ${ms(r.refreshMs)} ms per frame`,
		`- **Hex radius at zoom 1.0:** ${R} px`,
		'',
		'Times in ms. *frame* = time inside the frame (tiles drawn and any rendered);',
		'*interval* = between animation frames (includes raster). *dropped* = intervals',
		'over 1.5 refresh periods. *modes*: tiles / stretch (zoom preview) / direct, and',
		'the idle work done in those frames (prefetched tiles and their textures,',
		'overview bands). *textures made*: Illustrated textures and sprites drawn.',
		`Verdict: OK when frame p95 ≤ ${ms(budget)} ms and ≤ 5% of frames are dropped.`,
		'',
		'| Style | Scenario | frame median | frame p95 | frame max | interval p95 | dropped | tiles rendered | textures made | modes | verdict |',
		'|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
	];
	for (const x of r.results) {
		const ok = x.frame.p95 <= budget && x.dropped <= 0.05;
		lines.push(
			`| ${x.style} | ${x.name} | ${ms(x.frame.median)} | ${ms(x.frame.p95)} | ${ms(x.frame.max)} | ` +
				`${ms(x.interval.p95)} | ${(x.dropped * 100).toFixed(0)}% | ${x.tiles} | ${x.textures} | ${x.modes} | ${ok ? 'OK' : '**slow**'} |`,
		);
	}
	return lines.join('\n') + '\n';
}
