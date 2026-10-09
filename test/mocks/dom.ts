// Obsidian's DOM helpers and the browser bits jsdom lacks, for the view smoke
// tests (`// @vitest-environment jsdom` + `import './mocks/dom'`). Only what
// the plugin calls; enough to run its views, not a reimplementation.

import { recordingContext } from '../helpers/fake_canvas';

interface ElInfo {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	type?: string;
	value?: string;
	href?: string;
	placeholder?: string;
	prepend?: boolean;
}

type Ctor = { prototype: Record<string, unknown> };

function apply(el: HTMLElement, o?: ElInfo | string): void {
	if (!o) return;
	if (typeof o === 'string') {
		el.className = o;
		return;
	}
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(' ') : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.title) el.title = o.title;
	if (o.type) el.setAttribute('type', o.type);
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	if (o.href) el.setAttribute('href', o.href);
	if (o.placeholder) el.setAttribute('placeholder', o.placeholder);
	for (const [k, v] of Object.entries(o.attr ?? {})) if (v !== null && v !== false) el.setAttribute(k, String(v));
}

const P = (Node as unknown as Ctor).prototype;
const E = (HTMLElement as unknown as Ctor).prototype;

P.createEl = function (this: HTMLElement, tag: string, o?: ElInfo | string, cb?: (el: HTMLElement) => void) {
	const el = document.createElement(tag);
	apply(el, o);
	if (typeof o === 'object' && o?.prepend) this.prepend(el);
	else this.appendChild(el);
	cb?.(el);
	return el;
};
P.createDiv = function (this: HTMLElement, o?: ElInfo | string, cb?: (el: HTMLElement) => void) {
	return (this as unknown as { createEl: (t: string, o?: ElInfo | string, cb?: unknown) => HTMLElement }).createEl('div', o, cb);
};
P.createSpan = function (this: HTMLElement, o?: ElInfo | string, cb?: (el: HTMLElement) => void) {
	return (this as unknown as { createEl: (t: string, o?: ElInfo | string, cb?: unknown) => HTMLElement }).createEl('span', o, cb);
};
P.empty = function (this: HTMLElement) {
	while (this.firstChild) this.removeChild(this.firstChild);
};
P.detach = function (this: HTMLElement) {
	this.remove();
};
P.appendText = function (this: HTMLElement, t: string) {
	this.appendChild(document.createTextNode(t));
};
P.setText = function (this: HTMLElement, t: string) {
	this.textContent = t;
};
P.getText = function (this: HTMLElement) {
	return this.textContent ?? '';
};
E.addClass = function (this: HTMLElement, ...c: string[]) {
	this.classList.add(...c.flatMap((x) => x.split(' ')).filter((x) => x));
};
E.removeClass = function (this: HTMLElement, ...c: string[]) {
	this.classList.remove(...c);
};
E.toggleClass = function (this: HTMLElement, c: string | string[], on: boolean) {
	for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, on);
};
E.hasClass = function (this: HTMLElement, c: string) {
	return this.classList.contains(c);
};
E.setAttr = function (this: HTMLElement, k: string, v: string | number | boolean | null) {
	if (v === null) this.removeAttribute(k);
	else this.setAttribute(k, String(v));
};
E.toggle = function (this: HTMLElement, show: boolean) {
	this.style.display = show ? '' : 'none';
};
E.show = function (this: HTMLElement) {
	this.style.display = '';
};
E.hide = function (this: HTMLElement) {
	this.style.display = 'none';
};
E.isShown = function (this: HTMLElement) {
	return this.style.display !== 'none';
};
Object.defineProperty(P, 'win', { get: () => window, configurable: true });
Object.defineProperty(P, 'doc', { get: () => document, configurable: true });

const g = globalThis as Record<string, unknown>;
g.createEl = (tag: string, o?: ElInfo | string) => {
	const el = document.createElement(tag);
	apply(el, o);
	return el;
};
g.createDiv = (o?: ElInfo | string) => (g.createEl as (t: string, o?: unknown) => HTMLElement)('div', o);
g.createSpan = (o?: ElInfo | string) => (g.createEl as (t: string, o?: unknown) => HTMLElement)('span', o);
g.activeWindow = window;
g.activeDocument = document;

// Canvas: every 2D call recorded, nothing drawn (jsdom has no canvas).
const canvasProto = (HTMLCanvasElement as unknown as Ctor).prototype;
canvasProto.getContext = function () {
	return recordingContext(new Map());
};
// A real 1×1 PNG, so a PDF can embed what a canvas "encodes".
const PNG_1X1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
canvasProto.toBlob = function (cb: (b: Blob | null) => void) {
	cb(new Blob([PNG_1X1], { type: 'image/png' }));
};
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
g.ImageData ??= class {
	constructor(
		readonly data: Uint8ClampedArray,
		readonly width: number,
		readonly height: number,
	) {}
};
g.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};
window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0) as unknown as number;
window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);
(HTMLImageElement as unknown as Ctor).prototype.decode = () => Promise.resolve();
const elProto = (Element as unknown as Ctor).prototype;
elProto.setPointerCapture = () => {};
elProto.releasePointerCapture = () => {};
g.PointerEvent ??= class extends MouseEvent {
	pointerId: number;
	pointerType: string;
	pressure: number;
	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
		this.pointerType = init.pointerType ?? 'mouse';
		this.pressure = init.pressure ?? 0.5;
	}
	getCoalescedEvents() {
		return [];
	}
};
