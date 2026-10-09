// The Sketch view's trace image (decision 24): a reference picture to draw
// over, with no hex calibration — a placement (centre + size, scene px), a
// fade, shown / locked. The picture is a vault file linked from the index
// (`trace-image: "[[…]]"`); the placement is the Flutter app's own
// `sketch/trace_image.json`, so both apps place it alike. Display state:
// never undoable, never served to players.

import { isObject, num, parseJson, toPlain, type JsonObject } from '../core/json';

export interface TraceImage {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	opacity: number;
	visible: boolean;
	locked: boolean;
	/** Keys this build does not know, written back. */
	extra: JsonObject;
	image: CanvasImageSource | null;
}

export const TRACE_CONFIG = 'sketch/trace_image.json';

export function traceBounds(t: TraceImage): [number, number, number, number] {
	return [t.centerX - t.width / 2, t.centerY - t.height / 2, t.centerX + t.width / 2, t.centerY + t.height / 2];
}

const KNOWN = new Set(['center_x', 'center_y', 'width', 'height', 'opacity', 'visible', 'locked']);

/** The placement in [text], or null when it is not one. */
export function readTraceConfig(text: string): Omit<TraceImage, 'image'> | null {
	let j: unknown;
	try {
		j = parseJson(text);
	} catch {
		return null;
	}
	if (!isObject(j)) return null;
	const cx = num(j.center_x), cy = num(j.center_y), w = num(j.width), h = num(j.height);
	if (cx === undefined || cy === undefined || w === undefined || h === undefined) return null;
	const extra: JsonObject = {};
	for (const [k, v] of Object.entries(j)) if (!KNOWN.has(k)) extra[k] = v;
	return {
		centerX: cx,
		centerY: cy,
		width: w,
		height: h,
		opacity: Math.min(1, Math.max(0, num(j.opacity) ?? 0.6)),
		visible: j.visible !== false,
		locked: j.locked === true,
		extra,
	};
}

/** Written like Flutter's (doubles stay doubles: `6.0`). */
export function writeTraceConfig(t: Omit<TraceImage, 'image'>): string {
	const d = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
	const extra = Object.entries(toPlain(t.extra) as Record<string, unknown>).map(([k, v]) => `,\n  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join('');
	return `{\n  "center_x": ${d(t.centerX)},\n  "center_y": ${d(t.centerY)},\n  "width": ${d(t.width)},\n  "height": ${d(t.height)},\n  "opacity": ${d(t.opacity)},\n  "visible": ${t.visible},\n  "locked": ${t.locked}${extra}\n}\n`;
}

/** A new placement: centred on the view, 60 % of its width, the picture's
 *  own aspect ratio. */
export function initialTrace(view: [number, number, number, number], imageW: number, imageH: number): Omit<TraceImage, 'image'> {
	const [x0, y0, x1, y1] = view;
	const width = (x1 - x0) * 0.6;
	return { centerX: (x0 + x1) / 2, centerY: (y0 + y1) / 2, width, height: (width * imageH) / Math.max(1, imageW), opacity: 0.6, visible: true, locked: false, extra: {} };
}
