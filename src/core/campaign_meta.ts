// campaign.json: the map's metadata (Flutter: FileManager._metaJson).
// Every key is always written; unknown ones are kept after them.

import type { GridWindow } from './geometry';
import { int, str, unknownKeys, type JsonObject } from './json';
import { MapScale } from './map_scale';

/** The format this build reads and writes (docs/format-2.md). */
export const FORMAT_VERSION = 2;

const META_KEYS = new Set(['format', 'name', 'grid_cols', 'grid_rows', 'grid_min_q', 'grid_r_shift', 'hex_distance', 'distance_unit']);

export class CampaignMeta {
	/** As read: 1 when absent. Written as FORMAT_VERSION. */
	format = FORMAT_VERSION;
	name = 'Map';
	gridCols = 10;
	gridRows = 10;
	gridMinQ = 0;
	gridRShift = 0;
	scale = MapScale.defaults;
	extra: JsonObject = {};

	get grid(): GridWindow {
		return { minQ: this.gridMinQ, cols: this.gridCols, rows: this.gridRows, rShift: this.gridRShift };
	}

	toJson(): JsonObject {
		return {
			format: FORMAT_VERSION,
			name: this.name,
			grid_cols: this.gridCols,
			grid_rows: this.gridRows,
			grid_min_q: this.gridMinQ,
			grid_r_shift: this.gridRShift,
			...this.scale.toJson(),
			...this.extra,
		};
	}

	static fromJson(json: JsonObject, fallbackName = 'Map'): CampaignMeta {
		const m = new CampaignMeta();
		m.format = int(json.format) ?? 1;
		m.name = str(json.name) ?? fallbackName;
		m.gridCols = int(json.grid_cols) ?? 10;
		m.gridRows = int(json.grid_rows) ?? 10;
		m.gridMinQ = int(json.grid_min_q) ?? 0;
		m.gridRShift = int(json.grid_r_shift) ?? 0;
		m.scale = MapScale.fromJson(json);
		m.extra = unknownKeys(json, META_KEYS);
		return m;
	}
}
