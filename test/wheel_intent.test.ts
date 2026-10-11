import { describe, expect, it } from 'vitest';
import { GESTURE_GAP_MS, WheelClassifier, type WheelSample } from '../src/view/wheel_intent';

const ev = (t: number, deltaY: number, more: Partial<WheelSample> = {}): WheelSample => ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, timeStamp: t, ...more });

describe('wheel intent', () => {
	it('a mouse wheel zooms, notch after notch', () => {
		const w = new WheelClassifier();
		expect([ev(0, 100), ev(40, 100), ev(80, -100), ev(120, 125)].map((e) => w.classify(e))).toEqual(['zoom', 'zoom', 'zoom', 'zoom']);
		expect(w.classify(ev(500, 3, { deltaMode: 1 }))).toBe('zoom');
	});

	it('a trackpad swipe pans throughout, even through whole-number steps of 50 and more', () => {
		const w = new WheelClassifier();
		const swipe = [ev(0, 4), ev(16, 18), ev(32, 60), ev(48, 120), ev(64, 100), ev(80, 52), ev(96, 7.5)];
		expect(swipe.map((e) => w.classify(e))).toEqual(swipe.map(() => 'pan'));
	});

	it('a sideways or fractional step marks the gesture as a trackpad', () => {
		const w = new WheelClassifier();
		expect(w.classify(ev(0, 80, { deltaX: 2 }))).toBe('pan');
		expect(w.classify(ev(10, 100))).toBe('pan');
		const v = new WheelClassifier();
		expect(v.classify(ev(0, 66.5))).toBe('pan');
		expect(v.classify(ev(10, 100))).toBe('pan');
	});

	it('a pause ends the gesture: the wheel zooms again after a trackpad pan', () => {
		const w = new WheelClassifier();
		expect(w.classify(ev(0, 5))).toBe('pan');
		expect(w.classify(ev(GESTURE_GAP_MS + 1, 100))).toBe('zoom');
	});

	it('a pinch zooms, in the middle of a pan too', () => {
		const w = new WheelClassifier();
		expect(w.classify(ev(0, 5))).toBe('pan');
		expect(w.classify(ev(16, -3.2, { ctrlKey: true }))).toBe('zoom');
	});
});
