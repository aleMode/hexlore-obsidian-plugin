// A paint choice drawn the way the map draws it (Clean style): one hex in the
// biome's fill with its stamp, or a feature's glyph on an unpainted hex. The
// brush palette and the toolbar's swatch show every choice this way, with the
// renderer's own stamp painters, so what you pick is what you get.

import { HEX_RADIUS as R, hexCorners } from '../core/geometry';
import { terrainColors, type Feature, type Terrain } from '../core/hex_data';
import { ART } from '../render/art';
import { paintBiomeStamp, paintGlyph } from '../render/painter';
import { SPEC } from '../render/vendor';

export interface PreviewOf {
	terrain?: Terrain | null;
	terrainVariant?: number;
	feature?: Feature | null;
	featureVariant?: number;
}

const HEX = hexCorners(0, 0);

/** A [px]-sized canvas showing [o], appended to [parent]. */
export function pickPreview(parent: HTMLElement, o: PreviewOf, px: number): HTMLCanvasElement {
	const dpr = parent.win.devicePixelRatio || 1;
	const cnv = parent.createEl('canvas', { cls: 'hexlore-pick-preview' });
	cnv.width = cnv.height = Math.round(px * dpr);
	cnv.style.width = cnv.style.height = `${px}px`;
	const c = cnv.getContext('2d');
	if (!c) return cnv;
	const scale = px / (2.08 * R); // CSS px per scene px: the hex, a hair of margin
	c.setTransform(scale * dpr, 0, 0, scale * dpr, (px * dpr) / 2, (px * dpr) / 2);
	const fill = terrainColors[o.terrain ?? 'default'];
	c.beginPath();
	HEX.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
	c.closePath();
	c.fillStyle = fill;
	c.fill();
	c.strokeStyle = 'rgba(0,0,0,0.3)';
	c.lineWidth = 1.5 / scale;
	c.stroke();
	if (o.feature) {
		const g = ART.featureGlyph(o.feature, o.featureVariant ?? 0);
		if (g) paintGlyph(c, g.table, g.glyph, 0, R * SPEC.stampCentreOffset, R * SPEC.featureStampScale, fill);
	} else if (o.terrain && o.terrain !== 'default') {
		paintBiomeStamp(c, ART.biomeStamp(o.terrain, o.terrainVariant ?? 0), 0, 0, fill, scale);
	}
	return cnv;
}

/** "mountain" → "Mountain". */
export const titleCase = (s: string): string => s[0]!.toUpperCase() + s.slice(1);
