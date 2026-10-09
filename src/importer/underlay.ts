// Port of Flutter's lib/importer/underlay.dart: the imported map image kept
// as a GM-only underlay, with the affine that lines its grid up with the
// campaign's hexes (image → scene px). In the plugin the picture is a vault
// image linked from the index (`underlay:`), its placement the Flutter app's
// own `import/underlay.json`.

import { HEX_RADIUS, axialToPixel } from '../core/geometry';
import { SourceGrid } from './grid_calibration';

const SQRT3 = 1.7320508075688772;
const KNOWN = new Set(['grid', 'anchor_q', 'anchor_r', 'min_q', 'min_r']);

export class UnderlayConfig {
	constructor(
		readonly grid: SourceGrid,
		/** The campaign cell the import's top-left source cell went to. */
		readonly anchor: [number, number],
		/** That top-left source cell. */
		readonly minCell: [number, number],
		readonly extra: Record<string, unknown> = {},
	) {}

	toJson(): Record<string, unknown> {
		return { grid: this.grid.toJson(), anchor_q: this.anchor[0], anchor_r: this.anchor[1], min_q: this.minCell[0], min_r: this.minCell[1], ...this.extra };
	}

	static fromJson(j: Record<string, unknown>): UnderlayConfig | null {
		if (!j.grid || typeof j.grid !== 'object' || typeof j.anchor_q !== 'number' || typeof j.min_q !== 'number') return null;
		const extra: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(j)) if (!KNOWN.has(k)) extra[k] = v;
		return new UnderlayConfig(SourceGrid.fromJson(j.grid as Record<string, unknown>), [j.anchor_q, Number(j.anchor_r)], [j.min_q, Number(j.min_r)], extra);
	}

	/** [a, b, c, d, tx, ty]: scene = (a·x + b·y + tx, c·x + d·y + ty). */
	sceneTransform(campaignRadius = HEX_RADIUS): [number, number, number, number, number, number] {
		const s = this.grid.radius;
		let s00: number, s01: number, s10: number, s11: number;
		if (this.grid.orientation === 'flat') {
			s00 = 1.5 * s;
			s01 = 0;
			s10 = (SQRT3 / 2) * s;
			s11 = SQRT3 * s;
		} else {
			s00 = SQRT3 * s;
			s01 = (SQRT3 / 2) * s;
			s10 = 0;
			s11 = 1.5 * s;
		}
		const r0 = campaignRadius;
		const b00 = 1.5 * r0, b01 = 0, b10 = (SQRT3 / 2) * r0, b11 = SQRT3 * r0;
		const det = s00 * s11 - s01 * s10;
		const i00 = s11 / det, i01 = -s01 / det, i10 = -s10 / det, i11 = s00 / det;
		const a = b00 * i00 + b01 * i10, b = b00 * i01 + b01 * i11;
		const c = b10 * i00 + b11 * i10, d = b10 * i01 + b11 * i11;
		const [bx, by] = axialToPixel(this.anchor[0] - this.minCell[0], this.anchor[1] - this.minCell[1], r0);
		return [a, b, c, d, bx - (a * this.grid.originX + b * this.grid.originY), by - (c * this.grid.originX + d * this.grid.originY)];
	}
}
