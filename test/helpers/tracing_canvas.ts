// A headless canvas that TRACES what could reach its pixels, so two renders
// can be compared without a real rasteriser: same trace ⇒ same pixels.
//
// Every draw call is recorded in DEVICE space (the transform applied, rounded
// to 1/100 px) with the state it draws with (style, line width, alpha, clip),
// and only the subpaths whose conservative bounds touch the surface. A
// subpath that misses the surface adds no winding inside it, so leaving it
// out cannot hide a pixel change; it only stops a call that lands outside
// (a cell in the painter's cull pad, a hatch path spanning the map) from
// looking like a change. Bounds are conservative: curves by their control
// points, arcs by their full circle, strokes padded by the miter limit.

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];

const mul = (m: M, n: M): M => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r2 = (v: number) => Math.round(v * 100) / 100;

export function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(16);
}

/** One subpath: its commands and points (user space for a Path2D, device
 *  space for the context's own path). */
interface Sub {
	cmds: string;
	pts: number[];
}

/** Points of a subpath under [m], as a record and a device bounding box. */
function project(s: Sub, m: M, clampTo: [number, number] | null): { rec: string; box: [number, number, number, number] } {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	const out: number[] = [];
	for (let i = 0; i < s.pts.length; i += 2) {
		const [x, y] = apply(m, s.pts[i]!, s.pts[i + 1]!);
		out.push(r2(clampTo ? Math.min(Math.max(x, 0), clampTo[0]) : x), r2(clampTo ? Math.min(Math.max(y, 0), clampTo[1]) : y));
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	return { rec: `${s.cmds}:${out.join(',')}`, box: [x0, y0, x1, y1] };
}

/** Builds subpaths; shared by Path2D and the context's current path. */
class PathBuilder {
	subs: Sub[] = [];
	private cur: Sub | null = null;
	private cx = 0;
	private cy = 0;
	private sx = 0;
	private sy = 0;
	/** Maps user points as they are added (identity for a Path2D). */
	constructor(private readonly at: () => M = () => ID) {}

	private push(cmd: string, ...xy: number[]): void {
		if (!this.cur) {
			this.cur = { cmds: '', pts: [] };
			this.subs.push(this.cur);
		}
		this.cur.cmds += cmd;
		const m = this.at();
		for (let i = 0; i < xy.length; i += 2) this.cur.pts.push(...apply(m, xy[i]!, xy[i + 1]!));
	}

	/** Drop every subpath (beginPath). */
	reset(): void {
		this.subs = [];
		this.cur = null;
	}

	moveTo(x: number, y: number): void {
		this.cur = null;
		this.push('M', x, y);
		this.cx = this.sx = x;
		this.cy = this.sy = y;
	}
	lineTo(x: number, y: number): void {
		this.push('L', x, y);
		this.cx = x;
		this.cy = y;
	}
	bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void {
		this.push('C', a, b, c, d, x, y);
		this.cx = x;
		this.cy = y;
	}
	quadraticCurveTo(a: number, b: number, x: number, y: number): void {
		this.push('Q', a, b, x, y);
		this.cx = x;
		this.cy = y;
	}
	closePath(): void {
		this.push('Z');
		this.cx = this.sx;
		this.cy = this.sy;
	}
	rect(x: number, y: number, w: number, h: number): void {
		this.cur = null;
		this.push('R', x, y, x + w, y, x + w, y + h, x, y + h);
		this.cur = null;
		this.cx = this.sx = x;
		this.cy = this.sy = y;
	}
	roundRect(x: number, y: number, w: number, h: number): void {
		this.rect(x, y, w, h);
	}
	arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
		this.ellipse(x, y, r, r, 0, a0, a1, ccw);
	}
	ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
		const r = Math.max(rx, ry);
		const pt = (a: number): [number, number] => [
			x + rx * Math.cos(a) * Math.cos(rot) - ry * Math.sin(a) * Math.sin(rot),
			y + rx * Math.cos(a) * Math.sin(rot) + ry * Math.sin(a) * Math.cos(rot),
		];
		const [ex, ey] = pt(a1);
		this.push(`E${ccw ? 1 : 0}`, x - r, y - r, x + r, y + r, ...pt(a0), ex, ey);
		this.cx = ex;
		this.cy = ey;
	}
	arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
		this.push('T', x1 - r, y1 - r, x1 + r, y1 + r, x2, y2);
		this.cx = x2;
		this.cy = y2;
	}
	addPath(p: TracingPath2D, m?: { a: number; b: number; c: number; d: number; e: number; f: number }): void {
		const t: M = m ? [m.a, m.b, m.c, m.d, m.e, m.f] : ID;
		for (const s of p.builder.subs) {
			const pts: number[] = [];
			for (let i = 0; i < s.pts.length; i += 2) pts.push(...apply(t, s.pts[i]!, s.pts[i + 1]!));
			this.subs.push({ cmds: s.cmds, pts });
		}
		this.cur = null;
	}

	/** An SVG path's data (every command, absolute and relative). */
	svg(d: string): void {
		// Commands are letters; numbers are kept as written, so packed arc
		// flags ("01") can be split.
		const tok = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
		const items: { cmd?: string; raw?: string }[] = [];
		for (let m; (m = tok.exec(d)); ) items.push(m[1] ? { cmd: m[1] } : { raw: m[2]! });
		let i = 0, cmd = 'M', px = 0, py = 0; // last control point, for S / T
		const num = () => {
			const v = items[i++];
			if (v?.raw === undefined) throw new Error(`bad SVG path near ${i}: ${d.slice(0, 60)}`);
			return Number(v.raw);
		};
		const flag = () => {
			const v = items[i];
			if (v?.raw !== undefined && v.raw.length > 1 && (v.raw[0] === '0' || v.raw[0] === '1')) {
				items[i] = { raw: v.raw.slice(1) };
				return Number(v.raw[0]);
			}
			return num();
		};
		while (i < items.length) {
			if (items[i]!.cmd) cmd = items[i++]!.cmd!;
			const rel = cmd === cmd.toLowerCase();
			const ox = rel ? this.cx : 0, oy = rel ? this.cy : 0;
			switch (cmd.toUpperCase()) {
				case 'M': {
					const x = num() + ox, y = num() + oy;
					this.moveTo(x, y);
					cmd = rel ? 'l' : 'L'; // following pairs are lines
					px = x;
					py = y;
					break;
				}
				case 'L': {
					const x = num() + ox, y = num() + oy;
					this.lineTo(x, y);
					px = x;
					py = y;
					break;
				}
				case 'H': {
					const x = num() + ox;
					this.lineTo(x, this.cy);
					px = x;
					py = this.cy;
					break;
				}
				case 'V': {
					const y = num() + oy;
					this.lineTo(this.cx, y);
					px = this.cx;
					py = y;
					break;
				}
				case 'C': {
					const a = num() + ox, b = num() + oy, c = num() + ox, e = num() + oy, x = num() + ox, y = num() + oy;
					this.bezierCurveTo(a, b, c, e, x, y);
					px = c;
					py = e;
					break;
				}
				case 'S': {
					const a = 2 * this.cx - px, b = 2 * this.cy - py;
					const c = num() + ox, e = num() + oy, x = num() + ox, y = num() + oy;
					this.bezierCurveTo(a, b, c, e, x, y);
					px = c;
					py = e;
					break;
				}
				case 'Q': {
					const a = num() + ox, b = num() + oy, x = num() + ox, y = num() + oy;
					this.quadraticCurveTo(a, b, x, y);
					px = a;
					py = b;
					break;
				}
				case 'T': {
					const a = 2 * this.cx - px, b = 2 * this.cy - py, x = num() + ox, y = num() + oy;
					this.quadraticCurveTo(a, b, x, y);
					px = a;
					py = b;
					break;
				}
				case 'A': {
					const rx = Math.abs(num()), ry = Math.abs(num());
					num(); // rotation
					const large = flag(), sweep = flag();
					const x = num() + ox, y = num() + oy;
					// The arc stays within its radius of the chord's ends.
					const r = Math.max(rx, ry);
					this.push(`A${large}${sweep}`, Math.min(this.cx, x) - r, Math.min(this.cy, y) - r, Math.max(this.cx, x) + r, Math.max(this.cy, y) + r, x, y);
					this.cx = px = x;
					this.cy = py = y;
					break;
				}
				case 'Z':
					this.closePath();
					px = this.cx;
					py = this.cy;
					break;
				default:
					throw new Error(`SVG command ${cmd}`);
			}
		}
	}
}

export class TracingPath2D {
	readonly builder = new PathBuilder();
	constructor(from?: string | TracingPath2D) {
		if (typeof from === 'string') this.builder.svg(from);
		else if (from instanceof TracingPath2D) this.builder.addPath(from);
	}
}
for (const name of ['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'closePath', 'rect', 'roundRect', 'arc', 'ellipse', 'arcTo', 'addPath']) {
	(TracingPath2D.prototype as unknown as Record<string, unknown>)[name] = function (this: TracingPath2D, ...a: unknown[]) {
		(this.builder as unknown as Record<string, (...x: unknown[]) => void>)[name]!(...a);
	};
}

interface Gradient {
	trace(m: M): string;
}

interface State {
	m: M;
	fillStyle: unknown;
	strokeStyle: unknown;
	lineWidth: number;
	lineCap: string;
	lineJoin: string;
	miterLimit: number;
	globalAlpha: number;
	globalCompositeOperation: string;
	font: string;
	textAlign: string;
	textBaseline: string;
	dash: string;
	/** Records of the clips in force (empty = the clip shuts out the surface). */
	clips: string[];
	/** The bounds of the clip in force, recorded coordinates (null: none). */
	clipBox: Box | null;
}

type Box = [number, number, number, number];

const intersect = (a: Box | null, b: Box): Box => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b);

const fresh = (): State => ({
	m: ID,
	fillStyle: '#000000',
	strokeStyle: '#000000',
	lineWidth: 1,
	lineCap: 'butt',
	lineJoin: 'miter',
	miterLimit: 10,
	globalAlpha: 1,
	globalCompositeOperation: 'source-over',
	font: '10px sans-serif',
	textAlign: 'start',
	textBaseline: 'alphabetic',
	dash: '',
	clips: [],
	clipBox: null,
});

export interface TracingSurface {
	width: number;
	height: number;
	/** What reached the surface, one draw call per entry. */
	ops: string[];
	/** Where each op can have drawn (its bounds, clipped), as [x0, y0, x1, y1]. */
	boxes: Box[];
	getContext(kind: '2d'): CanvasRenderingContext2D;
	/** Content hash, as an image drawn into another surface. */
	trace(): string;
	/** Content hash of the rect [x, y, w, h] only: what a drawImage from a
	 *  part of the surface (an atlas entry) reads. */
	traceRegion(x: number, y: number, w: number, h: number): string;
}

export interface TraceOptions {
	/** Record only what reaches this device rect [x, y, w, h] of the surface,
	 *  in its coordinates: a block painted at once, seen as one of its tiles. */
	window?: [number, number, number, number];
	/** Clamp recorded points to the window, so the same geometry reaching
	 *  past it compares equal however far it reaches (a full-surface rect, a
	 *  clip padded past the painted rect). Only for comparing two renders of
	 *  the SAME scene: it can hide a change to geometry outside the window. */
	clamp?: boolean;
}

export function tracingSurface(w: number, h: number, opts: TraceOptions = {}): TracingSurface {
	const ops: string[] = [];
	const boxes: Box[] = [];
	let memo: { n: number; s: string } | null = null;
	const regions = new Map<string, string>();
	const surface: TracingSurface = {
		width: w,
		height: h,
		ops,
		boxes,
		getContext: () => ctx,
		trace: () => {
			if (memo?.n !== ops.length) memo = { n: ops.length, s: `S{${w}x${h}:${fnv(ops.join('\n'))}}` };
			return memo.s;
		},
		traceRegion: (x, y, rw, rh) => {
			const key = `${ops.length}:${x},${y},${rw},${rh}`;
			let s = regions.get(key);
			if (s === undefined) {
				const inside = ops.filter((_, i) => {
					const b = boxes[i]!;
					return b[0] < x + rw && b[2] > x && b[1] < y + rh && b[3] > y;
				});
				s = `R{${rw}x${rh}:${fnv(inside.join('\n'))}}`;
				regions.set(key, s);
			}
			return s;
		},
	};
	const ctx = tracingContext(surface, opts);
	return surface;
}

function tracingContext(surface: TracingSurface, opts: TraceOptions): CanvasRenderingContext2D {
	let st = fresh();
	const stack: State[] = [];
	const [wx, wy, ww, wh] = opts.window ?? [0, 0, surface.width, surface.height];
	const view: M = [1, 0, 0, 1, -wx, -wy];
	/** The transform to recorded (window) coordinates. */
	const vm = () => mul(view, st.m);
	const path = new PathBuilder(vm);
	const touches = (b: [number, number, number, number], pad: number) => b[0] - pad < ww && b[2] + pad > 0 && b[1] - pad < wh && b[3] + pad > 0;
	const style = (s: unknown): string =>
		s && typeof s === 'object' && 'trace' in s ? (s as Gradient).trace(vm()) : String(s);
	const scaleOf = () => Math.max(Math.hypot(st.m[0], st.m[1]), Math.hypot(st.m[2], st.m[3]));

	/** The subpaths of [subs] (under [m]) that can reach the surface, and
	 *  the bounds of all of them (padded by [pad]). */
	let lastBox: Box | null = null;
	const visible = (subs: Sub[], m: M, pad: number) => {
		const shown = subs.map((s) => project(s, m, opts.clamp ? [ww, wh] : null)).filter((p) => touches(p.box, pad));
		lastBox = null;
		for (const p of shown) {
			const b: Box = [p.box[0] - pad, p.box[1] - pad, p.box[2] + pad, p.box[3] + pad];
			lastBox = lastBox ? [Math.min(lastBox[0], b[0]), Math.min(lastBox[1], b[1]), Math.max(lastBox[2], b[2]), Math.max(lastBox[3], b[3])] : b;
		}
		return shown.map((p) => p.rec);
	};

	/** Record a draw call; it can have drawn within the last visible() bounds. */
	const record = (what: string, extra: string) => {
		if (st.clips.includes('')) return; // clipped away entirely
		surface.ops.push(`${what} a${r2(st.globalAlpha)} ${st.globalCompositeOperation} clip[${st.clips.join('|')}] ${extra}`);
		surface.boxes.push(intersect(st.clipBox, lastBox ?? [-Infinity, -Infinity, Infinity, Infinity]));
	};

	const pathOf = (p: unknown): { subs: Sub[]; m: M } =>
		p instanceof TracingPath2D ? { subs: p.builder.subs, m: vm() } : { subs: path.subs, m: ID };

	const strokePad = () => {
		const half = (st.lineWidth * scaleOf()) / 2;
		return st.lineJoin === 'miter' ? half * Math.max(1, st.miterLimit) : half + 1;
	};

	const api: Record<string, (...a: never[]) => unknown> = {
		save: () => void stack.push({ ...st, clips: [...st.clips] }),
		restore: () => void (st = stack.pop() ?? st),
		setTransform: (...a: unknown[]) => {
			if (a.length === 1) {
				const t = a[0] as { a: number; b: number; c: number; d: number; e: number; f: number };
				st.m = [t.a, t.b, t.c, t.d, t.e, t.f];
			} else st.m = a as unknown as M;
		},
		resetTransform: () => void (st.m = ID),
		transform: (...a: number[]) => void (st.m = mul(st.m, a as unknown as M)),
		translate: (x: number, y: number) => void (st.m = mul(st.m, [1, 0, 0, 1, x, y])),
		scale: (x: number, y: number) => void (st.m = mul(st.m, [x, 0, 0, y, 0, 0])),
		rotate: (t: number) => void (st.m = mul(st.m, [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0])),
		setLineDash: (d: number[]) => void (st.dash = d.join(',')),
		getLineDash: () => (st.dash ? st.dash.split(',').map(Number) : []),
		beginPath: () => path.reset(),
		measureText: (s: string) => ({ width: s.length * 6 }),
		createLinearGradient: (...a: number[]) => gradient('L', a),
		createRadialGradient: (...a: number[]) => gradient('R', a),
		fill: (p?: unknown, rule?: string) => {
			const { subs, m } = pathOf(typeof p === 'string' ? undefined : p);
			const vis = visible(subs, m, 1);
			if (vis.length) record('fill', `${typeof p === 'string' ? p : (rule ?? 'nonzero')} ${style(st.fillStyle)} ${vis.join(' ')}`);
		},
		stroke: (p?: unknown) => {
			const { subs, m } = pathOf(p);
			const vis = visible(subs, m, strokePad());
			if (vis.length) {
				record('stroke', `${style(st.strokeStyle)} w${r2(st.lineWidth * scaleOf())} ${st.lineCap} ${st.lineJoin} d${st.dash} ${vis.join(' ')}`);
			}
		},
		clip: (p?: unknown, rule?: string) => {
			const { subs, m } = pathOf(typeof p === 'string' ? undefined : p);
			const vis = visible(subs, m, 1);
			st.clips = [...st.clips, vis.length ? `${typeof p === 'string' ? p : (rule ?? 'nonzero')} ${vis.join(' ')}` : ''];
			if (lastBox) st.clipBox = intersect(st.clipBox, lastBox);
		},
		fillRect: (x: number, y: number, w: number, h: number) => {
			const vis = visible([{ cmds: 'R', pts: [x, y, x + w, y, x + w, y + h, x, y + h] }], vm(), 1);
			if (vis.length) record('fillRect', `${style(st.fillStyle)} ${vis[0]}`);
		},
		clearRect: (x: number, y: number, w: number, h: number) => {
			const vis = visible([{ cmds: 'R', pts: [x, y, x + w, y, x + w, y + h, x, y + h] }], vm(), 1);
			if (vis.length) record('clearRect', vis[0]!);
		},
		drawImage: (img: unknown, ...a: number[]) => {
			const src = img as TracingSurface;
			// (dx, dy), (dx, dy, dw, dh) or (sx, sy, sw, sh, dx, dy, dw, dh).
			const [sx, sy, sw, sh, dx, dy, dw, dh] =
				a.length === 2
					? [0, 0, src.width, src.height, a[0]!, a[1]!, src.width, src.height]
					: a.length === 4
						? [0, 0, src.width, src.height, a[0]!, a[1]!, a[2]!, a[3]!]
						: a;
			const vis = visible([{ cmds: 'I', pts: [dx!, dy!, dx! + dw!, dy!, dx! + dw!, dy! + dh!, dx!, dy! + dh!] }], vm(), 1);
			const content = a.length === 8 && src.traceRegion ? src.traceRegion(sx!, sy!, sw!, sh!) : src.trace();
			if (vis.length) record('drawImage', `${content} src${[sx, sy, sw, sh].map((v) => r2(v!)).join(',')} ${vis[0]}`);
		},
		// Pixels read: what was drawn into the rect since it was last cleared
		// whole (a scratch canvas reused for every raster); written back:
		// that content at a device rect, past any transform or clip.
		getImageData: (x: number, y: number, w: number, h: number) => {
			let from = 0;
			for (let i = surface.ops.length - 1; i >= 0; i--) {
				const b = surface.boxes[i]!;
				if (surface.ops[i]!.startsWith('clearRect') && b[0] <= x && b[1] <= y && b[2] >= x + w && b[3] >= y + h) {
					from = i + 1;
					break;
				}
			}
			const inside = surface.ops.filter((_, i) => {
				const b = surface.boxes[i]!;
				return i >= from && b[0] < x + w && b[2] > x && b[1] < y + h && b[3] > y;
			});
			return { width: w, height: h, data: `P{${w}x${h}:${fnv(inside.join('\n'))}}` };
		},
		putImageData: (img: unknown, dx: number, dy: number) => {
			const im = img as { width: number; height: number; data: string };
			const b: Box = [dx - wx, dy - wy, dx - wx + im.width, dy - wy + im.height];
			if (b[0] >= ww || b[2] <= 0 || b[1] >= wh || b[3] <= 0) return;
			surface.ops.push(`putImageData ${im.data} at${r2(b[0])},${r2(b[1])}`);
			surface.boxes.push(b);
		},
		fillText: (s: string, x: number, y: number) => text('fillText', s, x, y, style(st.fillStyle)),
		strokeText: (s: string, x: number, y: number) => text('strokeText', s, x, y, `${style(st.strokeStyle)} w${r2(st.lineWidth * scaleOf())}`),
	};

	function gradient(kind: string, args: number[]): Gradient {
		const stops: string[] = [];
		return Object.assign(
			{
				addColorStop: (o: number, c: string) => void stops.push(`${r2(o)}:${c}`),
			},
			{
				// A gradient lies in the user space it is drawn under.
				trace: (m: M) => {
					const pts: number[] = [];
					if (kind === 'L') for (let i = 0; i < 4; i += 2) pts.push(...apply(m, args[i]!, args[i + 1]!).map(r2));
					else pts.push(...apply(m, args[0]!, args[1]!).map(r2), r2(args[2]! * Math.hypot(m[0], m[1])), ...apply(m, args[3]!, args[4]!).map(r2), r2(args[5]! * Math.hypot(m[0], m[1])));
					return `G${kind}(${pts.join(',')})[${stops.join(',')}]`;
				},
			},
		);
	}

	function text(kind: string, s: string, x: number, y: number, ink: string) {
		// A glyph run stays within a font size per character and two lines.
		const size = Number(/(\d+(?:\.\d+)?)px/.exec(st.font)?.[1] ?? 10);
		const w = s.length * size, h = 2 * size;
		const vis = visible([{ cmds: 'X', pts: [x - w, y - h, x + w, y - h, x + w, y + h, x - w, y + h] }], vm(), strokePad());
		if (vis.length) {
			const [tx, ty] = apply(vm(), x, y);
			record(kind, `${ink} ${st.font} ${st.textAlign} ${st.textBaseline} "${s}" at ${r2(tx)},${r2(ty)} m${st.m.slice(0, 4).map(r2).join(',')}`);
		}
	}

	return new Proxy(api, {
		get(target, key) {
			if (typeof key === 'symbol') return undefined;
			if (key in target) return target[key];
			if (typeof key === 'string' && key in st) return (st as unknown as Record<string, unknown>)[key];
			if (typeof key === 'string' && key in path) {
				const fn = (path as unknown as Record<string, unknown>)[key];
				if (typeof fn === 'function') return (fn as (...a: unknown[]) => unknown).bind(path);
			}
			throw new Error(`tracing canvas: ${String(key)} is not supported`);
		},
		set(_target, key, value) {
			if (typeof key === 'string' && key in st && key !== 'm' && key !== 'clips' && key !== 'clipBox' && key !== 'dash') {
				(st as unknown as Record<string, unknown>)[key] = value;
				return true;
			}
			throw new Error(`tracing canvas: setting ${String(key)} is not supported`);
		},
	}) as unknown as CanvasRenderingContext2D;
}
