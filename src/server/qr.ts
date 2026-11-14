// The player view's link as a QR code, so a phone joins without typing an
// address. qrcode-generator (MIT) encodes; the code is drawn as an SVG with
// the DOM API (no innerHTML).

import qrcode from 'qrcode-generator';

/** The QR modules of [text], row by row (true = dark). */
export function qrModules(text: string): boolean[][] {
	const qr = qrcode(0, 'M');
	qr.addData(text);
	qr.make();
	const n = qr.getModuleCount();
	return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

const SVG = 'http://www.w3.org/2000/svg';

/** An SVG of [text]'s QR code, [px] wide, with the quiet zone the standard
 *  asks for (4 modules). Dark on white whatever the theme: scanners need it. */
export function qrSvg(doc: Document, text: string, px: number): SVGSVGElement {
	const modules = qrModules(text);
	const n = modules.length + 8;
	const svg = doc.createElementNS(SVG, 'svg');
	svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
	svg.setAttribute('width', String(px));
	svg.setAttribute('height', String(px));
	svg.setAttribute('shape-rendering', 'crispEdges');
	svg.setAttribute('role', 'img');
	const bg = doc.createElementNS(SVG, 'rect');
	bg.setAttribute('width', String(n));
	bg.setAttribute('height', String(n));
	bg.setAttribute('fill', '#fff');
	svg.appendChild(bg);
	// One path for every dark module: a few hundred rects would be slower.
	let d = '';
	modules.forEach((row, r) => row.forEach((dark, c) => dark && (d += `M${c + 4} ${r + 4}h1v1h-1z`)));
	const path = doc.createElementNS(SVG, 'path');
	path.setAttribute('d', d);
	path.setAttribute('fill', '#000');
	svg.appendChild(path);
	return svg;
}
