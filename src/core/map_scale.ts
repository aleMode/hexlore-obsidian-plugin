// Port of Flutter's lib/core/map_scale.dart: campaign metadata for what one
// hex measures (decision 18), the ruler read-out and the scale bar.

import { dbl, num, type JsonObject } from './json';

export type DistanceUnit = 'mi' | 'km';

export class MapScale {
	constructor(
		readonly hexDistance = 6.0,
		readonly unit: DistanceUnit = 'mi',
	) {}

	static readonly defaults = new MapScale();

	toJson(): JsonObject {
		return { hex_distance: dbl(this.hexDistance), distance_unit: this.unit };
	}

	static fromJson(json: JsonObject): MapScale {
		const d = num(json.hex_distance);
		return new MapScale(d !== undefined && d > 0 && Number.isFinite(d) ? d : 6.0, json.distance_unit === 'km' ? 'km' : 'mi');
	}

	distanceOf(hexes: number): number {
		return hexes * this.hexDistance;
	}

	distanceOfPx(px: number, hexRadius: number): number {
		return this.distanceOf(px / hexStepPx(hexRadius));
	}

	formatDistance(d: number): string {
		return `${trim(d)} ${this.unit}`;
	}

	describe(): string {
		return `1 hex = ${this.formatDistance(this.hexDistance)}`;
	}
}

/** Centre-to-centre distance of neighbouring hexes. */
export function hexStepPx(hexRadius: number): number {
	return Math.sqrt(3) * hexRadius;
}

function trim(v: number): string {
	const rounded = Math.round(v * 10) / 10;
	return rounded === Math.round(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1);
}

export function describeRuler(scale: MapScale, hexes: number, cellSteps?: number): string {
	let s = `${trim(hexes)} hex${hexes === 1 ? '' : 'es'} · ${scale.formatDistance(scale.distanceOf(hexes))}`;
	if (cellSteps !== undefined) s += ` (${cellSteps} hex${cellSteps === 1 ? '' : 'es'} walked)`;
	return s;
}

export interface ScaleBar {
	distance: number;
	px: number;
	hexes: number;
}

/** The longest 1-2-5 distance whose bar fits in [targetPx]. */
export function pickScaleBar(scale: MapScale, pxPerHex: number, targetPx: number): ScaleBar | null {
	if (pxPerHex <= 0 || targetPx <= 0 || !Number.isFinite(pxPerHex)) return null;
	const pxPerUnit = pxPerHex / scale.hexDistance;
	const maxDistance = targetPx / pxPerUnit;
	if (maxDistance <= 0 || !Number.isFinite(maxDistance)) return null;
	const base = 10 ** Math.floor(Math.log10(maxDistance));
	const best = [5, 2, 1].map((m) => m * base).find((c) => c <= maxDistance);
	if (best === undefined || best < 0.01) return null;
	return { distance: best, px: best * pxPerUnit, hexes: best / scale.hexDistance };
}
