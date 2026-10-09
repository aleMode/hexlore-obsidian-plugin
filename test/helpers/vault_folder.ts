// A vault folder on disk, read the way Obsidian would see it: notes with
// their frontmatter (a YAML subset: what the converters write), and links
// resolved by path or by name. For the converter tests.

import fs from 'node:fs';
import path from 'node:path';

/** The YAML the converters write: `key: scalar`, `key: []`, `key: {json}`,
 *  and block lists of scalars or `{json}` maps. Scalars: JSON strings,
 *  true/false, numbers, or bare text. */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
	const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
	if (!m) return null;
	const out: Record<string, unknown> = {};
	let list: unknown[] | null = null;
	const scalar = (v: string): unknown => {
		const t = v.trim();
		if (t === '') return null;
		if (t === 'true' || t === 'false') return t === 'true';
		if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
		if (t.startsWith('"') || t.startsWith('[') || t.startsWith('{')) return JSON.parse(t) as unknown;
		return t;
	};
	for (const line of m[1]!.split('\n')) {
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && list) {
			list.push(scalar(item[1]!));
			continue;
		}
		const kv = /^([^\s:][^:]*):\s?(.*)$/.exec(line);
		if (!kv) continue;
		if (kv[2]!.trim() === '') {
			list = [];
			out[kv[1]!.trim()] = list;
		} else {
			list = null;
			out[kv[1]!.trim()] = scalar(kv[2]!);
		}
	}
	return out;
}

export function readTree(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.set(path.relative(dir, p).split(path.sep).join('/'), e.name.endsWith('.png') ? `<${fs.statSync(p).size} bytes>` : fs.readFileSync(p, 'utf8'));
		}
	};
	walk(dir);
	return out;
}

/** Obsidian-like link resolution over [paths] (vault paths with `.md`). */
export function resolver(paths: string[]): (link: string, from: string) => string | null {
	const sorted = [...paths].sort();
	return (link, from) => {
		const target = link.split('|')[0]!.split('#')[0]!.trim();
		if (!target) return null;
		const want = target.endsWith('.md') ? target : `${target}.md`;
		const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
		for (const candidate of [want, dir + want]) if (sorted.includes(candidate)) return candidate;
		const lower = want.toLowerCase();
		return sorted.find((p) => p.toLowerCase().endsWith(`/${lower}`) || p.toLowerCase() === lower) ?? null;
	};
}
