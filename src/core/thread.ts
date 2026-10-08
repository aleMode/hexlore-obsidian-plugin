// Port of Flutter's lib/core/thread.dart: a GM-only link between two hexes.

import { rawIfUnknown, str, unknownKeys, type JsonObject } from './json';

export const THREAD_TYPES = ['Quest Chain', 'NPC Relationship', 'Faction', 'Rumor', 'Trade Route', 'Secret', 'Custom'] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];
export const THREAD_DIRECTIONS = ['bidirectional', 'one-way'] as const;
export type ThreadDirection = (typeof THREAD_DIRECTIONS)[number];
export const THREAD_STATUSES = ['active', 'dormant', 'resolved'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_COLORS: Record<ThreadType, string> = {
	'Quest Chain': '#E05555',
	'NPC Relationship': '#5580E0',
	Faction: '#55B855',
	Rumor: '#D4C050',
	'Trade Route': '#C87E30',
	Secret: '#9A55D4',
	Custom: '#8A8A9A',
};
export const RESOLVED_COLOR = '#888888';

export function threadColorFor(type: ThreadType, status: ThreadStatus): string {
	return status === 'resolved' ? RESOLVED_COLOR : THREAD_COLORS[type];
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
	typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;

const THREAD_KEYS = new Set(['id', 'from_hex', 'to_hex', 'type', 'label', 'color', 'direction', 'status']);

export class Thread {
	label = '';
	/** "" means "by type". */
	color = '';
	extra: JsonObject = {};
	raw: JsonObject = {};
	private _type: ThreadType = 'Custom';
	private _direction: ThreadDirection = 'bidirectional';
	private _status: ThreadStatus = 'active';

	constructor(
		readonly id: string,
		public fromHex: string,
		public toHex: string,
	) {}

	get type(): ThreadType {
		return this._type;
	}
	set type(v: ThreadType) {
		this._type = v;
		delete this.raw.type;
	}
	get direction(): ThreadDirection {
		return this._direction;
	}
	set direction(v: ThreadDirection) {
		this._direction = v;
		delete this.raw.direction;
	}
	get status(): ThreadStatus {
		return this._status;
	}
	set status(v: ThreadStatus) {
		this._status = v;
		delete this.raw.status;
	}

	effectiveColor(): string {
		return this.color || threadColorFor(this.type, this.status);
	}

	/** A thread's colour IS its group (decision 27). */
	get colorKey(): string {
		return this.effectiveColor().toUpperCase();
	}

	toJson(): JsonObject {
		return {
			id: this.id,
			from_hex: this.fromHex,
			to_hex: this.toHex,
			type: this.type,
			label: this.label,
			color: this.color,
			direction: this.direction,
			status: this.status,
			...this.extra,
			...this.raw,
		};
	}

	static fromJson(json: JsonObject): Thread | null {
		const id = str(json.id), from = str(json.from_hex), to = str(json.to_hex);
		if (id === undefined || from === undefined || to === undefined) return null;
		const t = new Thread(id, from, to);
		const type = oneOf(THREAD_TYPES, json.type, 'Custom');
		const direction = oneOf(THREAD_DIRECTIONS, json.direction, 'bidirectional');
		const status = oneOf(THREAD_STATUSES, json.status, 'active');
		t._type = type;
		t._direction = direction;
		t._status = status;
		t.label = str(json.label) ?? '';
		let color = str(json.color) ?? '';
		// An older app STORED the derived colour; it was never the GM's choice.
		if (color.toUpperCase() === threadColorFor(type, status).toUpperCase()) color = '';
		t.color = color;
		t.extra = unknownKeys(json, THREAD_KEYS);
		t.raw = {
			...rawIfUnknown('type', json.type, type === json.type),
			...rawIfUnknown('direction', json.direction, direction === json.direction),
			...rawIfUnknown('status', json.status, status === json.status),
		};
		return t;
	}

	copy(): Thread {
		const t = Thread.fromJson(this.toJson())!;
		t.color = this.color;
		return t;
	}
}
