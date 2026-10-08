// The procedural biome stamps: lake, hills, tundra and desert have no glyph
// (no good vendored icon, or the GM preferred the drawn look). Ported from
// player.js's TERRAIN table, itself a mirror of _terrainDrawers in Flutter's
// app/stamps.dart — keep the three in step. Each draws around (0, 0) at size
// [s], with the stroke and fill already set to the ink.

export type ProceduralStamp = (c: CanvasRenderingContext2D, s: number) => void;

function line(c: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
	c.beginPath();
	c.moveTo(x1, y1);
	c.lineTo(x2, y2);
	c.stroke();
}

/** Upper half-ellipse in the rect (l, t, w, h), opening downward (Dart _topArc). */
function rectArc(c: CanvasRenderingContext2D, l: number, t: number, w: number, h: number) {
	c.beginPath();
	c.ellipse(l + w / 2, t + h / 2, w / 2, h / 2, 0, Math.PI, Math.PI * 2);
	c.stroke();
}

function oval(c: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: boolean) {
	c.beginPath();
	c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
	if (fill) c.fill();
	else c.stroke();
}

function dot(c: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
	c.beginPath();
	c.arc(cx, cy, r, 0, Math.PI * 2);
	c.fill();
}

/** One "~" wavelet (Dart _wave). */
function wave(c: CanvasRenderingContext2D, x0: number, y: number, w: number, a: number) {
	c.beginPath();
	c.moveTo(x0, y);
	c.quadraticCurveTo(x0 + w * 0.25, y - a, x0 + w * 0.5, y);
	c.quadraticCurveTo(x0 + w * 0.75, y + a, x0 + w, y);
	c.stroke();
}

function polyline(c: CanvasRenderingContext2D, pts: [number, number][]) {
	c.beginPath();
	pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.stroke();
}

const hills: ProceduralStamp = (c, s) => {
	rectArc(c, -0.7 * s, -0.1 * s, 0.8 * s, 0.8 * s);
	rectArc(c, -0.1 * s, -0.25 * s, 0.8 * s, 0.8 * s);
};

/** Index-aligned with each biome's variant ids. */
export const PROCEDURAL_STAMPS: Record<string, ProceduralStamp[]> = {
	lake: [
		(c, s) => {
			oval(c, 0, 0.05 * s, 0.35 * s, 0.22 * s, true);
			rectArc(c, -0.55 * s, -0.25 * s, 1.1 * s, 0.55 * s);
		},
	],
	hills: [
		hills,
		(c, s) => {
			// rocky
			hills(c, s);
			for (const [dx, dy] of [
				[-0.35, 0.55],
				[0, 0.6],
				[0.35, 0.55],
			] as const) {
				dot(c, dx * s, dy * s, 0.07 * s);
			}
		},
	],
	tundra: [
		(c, s) => {
			for (let angle = 0; angle < 180; angle += 30) {
				const rad = (angle * Math.PI) / 180;
				const dx = Math.cos(rad) * 0.55 * s, dy = Math.sin(rad) * 0.55 * s;
				line(c, -dx, -dy, dx, dy);
			}
		},
		(c, s) => {
			// cracked ice
			line(c, -0.6 * s, 0, 0.6 * s, 0);
			polyline(c, [
				[-0.35 * s, 0],
				[-0.2 * s, -0.28 * s],
				[0, -0.18 * s],
				[0.18 * s, -0.42 * s],
			]);
			polyline(c, [
				[0.1 * s, 0],
				[0.02 * s, 0.25 * s],
				[0.28 * s, 0.4 * s],
			]);
		},
	],
	desert: [
		(c, s) => {
			// dunes: three receding ridges
			rectArc(c, -0.75 * s, 0.05 * s, 0.85 * s, 0.55 * s);
			rectArc(c, -0.15 * s, -0.05 * s, 0.75 * s, 0.5 * s);
			rectArc(c, 0.15 * s, -0.15 * s, 0.6 * s, 0.42 * s);
		},
		(c, s) => {
			// cracked ground, radiating from the centre
			for (const pts of [
				[[0, 0], [-0.15, -0.22], [-0.1, -0.5]],
				[[0, 0], [0.05, -0.3], [0.28, -0.48]],
				[[0, 0], [-0.32, 0.05], [-0.58, -0.08]],
				[[0, 0], [0.3, -0.02], [0.55, 0.12]],
				[[0, 0], [-0.18, 0.25], [-0.32, 0.5]],
				[[0, 0], [0.15, 0.3], [0.1, 0.55]],
			] as [number, number][][]) {
				polyline(c, pts.map(([x, y]) => [x * s, y * s]));
			}
		},
		(c, s) => {
			// beach: surf over a shoreline
			wave(c, -0.5 * s, -0.38 * s, 0.5 * s, 0.1 * s);
			wave(c, -0.05 * s, -0.2 * s, 0.5 * s, 0.1 * s);
			c.beginPath();
			c.moveTo(-0.6 * s, 0.08 * s);
			c.bezierCurveTo(-0.2 * s, -0.12 * s, 0.2 * s, 0.22 * s, 0.6 * s, 0.02 * s);
			c.stroke();
			for (const [dx, dy] of [
				[-0.3, 0.38],
				[0.05, 0.48],
				[0.35, 0.32],
			] as const) {
				dot(c, dx * s, dy * s, 0.05 * s);
			}
		},
	],
};
