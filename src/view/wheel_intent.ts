// What a wheel event means on the map: pan or zoom. A mouse wheel zooms, a
// trackpad's two-finger scroll pans, a pinch (Ctrl+wheel, as Chromium
// reports it) zooms. The browser does not say which device sent a wheel
// event, so this guesses per GESTURE: events less than GESTURE_GAP_MS apart
// are one gesture, and once any of them looks like a trackpad (sideways,
// fractional or small) the whole rest of the gesture pans. Judged event by
// event, a fast swipe's large whole-number steps read as wheel notches and
// zoomed in the middle of a pan. No Obsidian or DOM import: unit-tested.

export type WheelIntent = 'pan' | 'zoom';

export interface WheelSample {
	deltaX: number;
	deltaY: number;
	deltaMode: number;
	ctrlKey: boolean;
	timeStamp: number;
}

/** Quiet time that ends a gesture (a trackpad's inertia keeps it going). */
export const GESTURE_GAP_MS = 300;

/** A mouse wheel notch is ±100 px (more with display scaling), or lines. */
const NOTCH_MIN = 50;

export class WheelClassifier {
	private last = -Infinity;
	private trackpad = false;

	classify(e: WheelSample): WheelIntent {
		if (e.timeStamp - this.last > GESTURE_GAP_MS) this.trackpad = false;
		this.last = e.timeStamp;
		if (e.ctrlKey) return 'zoom'; // a pinch, or Ctrl+wheel
		if (e.deltaMode !== 0) return 'zoom'; // lines or pages: a wheel
		if (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < NOTCH_MIN) this.trackpad = true;
		return this.trackpad ? 'pan' : 'zoom';
	}
}
