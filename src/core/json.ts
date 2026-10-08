// Campaign JSON, byte-compatible with the Flutter app.
//
// Port of json_lines.dart (the one-record-per-line encoder, id ordering) and
// json_extra.dart (unknown keys and values), plus what Dart's JSON gives for
// free and JavaScript does not: the difference between 6 and 6.0.
//
// Dart writes a double as `6.0` and an int as `6`. JavaScript has one number
// type and writes both as `6`, so a file saved here would flip every
// whole-number double (a river's width, the map scale, sketch coordinates)
// from `1.0` to `1` — a changed line in git for every record, each time the
// other app saves. So:
// - a model writes its double-typed fields through `dbl()`;
// - `parseJson` remembers which numbers were WRITTEN as doubles (`6.0`,
//   `1e3`) by keeping them as `JsonDouble`, so unknown keys round-trip
//   exactly. Models read numbers through `num()`, which unwraps them.

/** A number that Dart typed as a double: written with a fraction. */
export class JsonDouble {
	constructor(readonly value: number) {}
}

/** Mark a double-typed field for writing. */
export function dbl(v: number): JsonDouble {
	return new JsonDouble(v);
}

/** A number read from campaign JSON (plain, or kept as a JsonDouble). */
export function num(v: unknown): number | undefined {
	if (typeof v === 'number') return v;
	if (v instanceof JsonDouble) return v.value;
	return undefined;
}

/** An integer, or undefined (a double — even 2.0 — is not one, as in Dart). */
export function int(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

export type Json = null | boolean | number | string | JsonDouble | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export function isObject(v: unknown): v is JsonObject {
	return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonDouble);
}

interface ReviverContext {
	source?: string;
}

/** JSON.parse, keeping numbers written as doubles as JsonDouble. Without the
 *  reviver's source text (an older engine), numbers are plain: the encoding
 *  of whole-number doubles in unknown keys is then lost, nothing else. */
export function parseJson(text: string): Json {
	return JSON.parse(text, function (this: unknown, _key: string, value: unknown, ctx?: ReviverContext) {
		if (typeof value === 'number' && Number.isInteger(value) && ctx?.source && /[.eE]/.test(ctx.source)) {
			return new JsonDouble(value);
		}
		return value;
	} as (this: unknown, key: string, value: unknown) => unknown) as Json;
}

/** Dart's double.toString. */
export function dartDouble(v: number): string {
	if (!Number.isFinite(v)) throw new Error(`not encodable as JSON: ${v}`);
	if (Object.is(v, -0)) return '-0.0';
	const s = String(v);
	return Number.isInteger(v) && !/e/.test(s) ? `${s}.0` : s;
}

/** Compact JSON, as Dart's JsonEncoder writes it. */
export function encodeCompact(v: unknown): string {
	if (v === null || v === undefined) return 'null';
	if (v instanceof JsonDouble) return dartDouble(v.value);
	switch (typeof v) {
		case 'number':
			return Number.isInteger(v) ? String(v) : dartDouble(v);
		case 'string':
			return JSON.stringify(v);
		case 'boolean':
			return v ? 'true' : 'false';
	}
	if (Array.isArray(v)) return `[${v.map(encodeCompact).join(',')}]`;
	if (typeof v === 'object') {
		const parts: string[] = [];
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			if (x === undefined) continue;
			parts.push(`${JSON.stringify(k)}:${encodeCompact(x)}`);
		}
		return `{${parts.join(',')}}`;
	}
	throw new Error(`not encodable as JSON: ${typeof v}`);
}

const isContainer = (v: unknown) =>
	v !== null && typeof v === 'object' && !(v instanceof JsonDouble);

function block(out: string[], container: unknown, indent: string): void {
	if (Array.isArray(container)) {
		if (!container.length) {
			out.push('[]');
			return;
		}
		out.push('[\n');
		container.forEach((x, i) => out.push(`${i ? ',\n' : ''}${indent}  ${encodeCompact(x)}`));
		out.push(`\n${indent}]`);
		return;
	}
	const entries = Object.entries(container as Record<string, unknown>).filter(([, x]) => x !== undefined);
	if (!entries.length) {
		out.push('{}');
		return;
	}
	out.push('{\n');
	entries.forEach(([k, x], i) => out.push(`${i ? ',\n' : ''}${indent}  ${JSON.stringify(k)}: ${encodeCompact(x)}`));
	out.push(`\n${indent}}`);
}

/** Encode a campaign file: one record per line (json_lines.dart). */
export function encodeJsonLines(value: unknown): string {
	const out: string[] = [];
	if (Array.isArray(value)) {
		block(out, value, '');
	} else if (isContainer(value)) {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, x]) => x !== undefined);
		if (!entries.length) {
			out.push('{}');
		} else {
			out.push('{\n');
			entries.forEach(([k, x], i) => {
				out.push(`${i ? ',\n' : ''}  ${JSON.stringify(k)}: `);
				if (isContainer(x)) block(out, x, '  ');
				else out.push(encodeCompact(x));
			});
			out.push('\n}');
		}
	} else {
		out.push(encodeCompact(value));
	}
	out.push('\n');
	return out.join('');
}

const NUMBERED = /^(.*?)(\d+)$/;

/** Ids the way a person reads them: `route_2` before `route_10`. */
export function compareIds(a: string, b: string): number {
	const ma = NUMBERED.exec(a), mb = NUMBERED.exec(b);
	if (ma && mb && ma[1] === mb[1] && ma[2]!.length < 16 && mb[2]!.length < 16) {
		const na = Number(ma[2]), nb = Number(mb[2]);
		if (na !== nb) return na - nb;
	}
	// Dart's String.compareTo: by UTF-16 code unit.
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Cells by (q, r). */
export function compareCells(a: readonly [number, number], b: readonly [number, number]): number {
	return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** The entries of [json] whose key is not in [known]. */
export function unknownKeys(json: JsonObject, known: ReadonlySet<string>): JsonObject {
	const out: JsonObject = {};
	for (const [k, v] of Object.entries(json)) if (!known.has(k)) out[k] = v;
	return out;
}

/** `{key: value}` when [value] is present but not [recognised]: the raw entry
 *  for one field. */
export function rawIfUnknown(key: string, value: Json | undefined, recognised: boolean): JsonObject {
	return value !== undefined && value !== null && !recognised ? { [key]: value } : {};
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
export const strings = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : undefined;

/** Plain JSON values (JsonDouble unwrapped): for payloads leaving the app. */
export function toPlain(v: unknown): unknown {
	if (v instanceof JsonDouble) return v.value;
	if (Array.isArray(v)) return v.map(toPlain);
	if (v !== null && typeof v === 'object') {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) o[k] = toPlain(x);
		return o;
	}
	return v;
}
