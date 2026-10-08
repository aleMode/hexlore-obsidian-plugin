// A headless stand-in for canvases: every 2D call is accepted and counted.
// Enough to run the renderer under node and assert on what it drew — not
// on pixels.

export type Counts = Map<string, number>;

export function recordingContext(counts: Counts): CanvasRenderingContext2D {
	const props: Record<string | symbol, unknown> = {};
	return new Proxy(props, {
		get(target, key) {
			if (key in target) return target[key];
			if (key === 'measureText') return (s: string) => ({ width: s.length * 6 });
			if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
			return () => {
				counts.set(String(key), (counts.get(String(key)) ?? 0) + 1);
			};
		},
		set(target, key, value) {
			target[key] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

export interface FakeSurface {
	width: number;
	height: number;
	getContext(kind: '2d'): CanvasRenderingContext2D;
}

export function fakeSurface(counts: Counts, w = 300, h = 150): FakeSurface {
	const ctx = recordingContext(counts);
	return { width: w, height: h, getContext: () => ctx };
}

export function installPath2D(): void {
	const g = globalThis as Record<string, unknown>;
	g.Path2D ??= class {
		addPath() {}
		moveTo() {}
		lineTo() {}
		closePath() {}
		bezierCurveTo() {}
		quadraticCurveTo() {}
		arc() {}
		ellipse() {}
		rect() {}
	};
}

/** A window with a hand-cranked clock and frame queue. */
export class FakeWindow {
	now = 0;
	devicePixelRatio = 1;
	private frames: (() => void)[] = [];
	private timers = new Map<number, { at: number; fn: () => void }>();
	private nextId = 1;
	performance = { now: () => this.now };
	requestAnimationFrame = (fn: () => void) => {
		this.frames.push(fn);
		return this.frames.length;
	};
	cancelAnimationFrame = () => {};
	setTimeout = (fn: () => void, ms: number) => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.now + ms, fn });
		return id;
	};
	clearTimeout = (id: number) => void this.timers.delete(id);
	/** Advance the clock, firing due timers. */
	advance(ms: number): void {
		this.now += ms;
		for (const [id, t] of [...this.timers]) {
			if (t.at <= this.now) {
				this.timers.delete(id);
				t.fn();
			}
		}
	}
	pendingFrames(): number {
		return this.frames.length;
	}
}

/** A host element with Obsidian's createEl, sized w × h. */
export function fakeHost(counts: Counts, w: number, h: number): HTMLElement {
	return {
		clientWidth: w,
		clientHeight: h,
		createEl: () => fakeSurface(counts),
	} as unknown as HTMLElement;
}
