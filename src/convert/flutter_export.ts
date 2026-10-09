// "Export to HexLore (Flutter)…" (plan item 2.7): the plugin's half of the
// converter, following docs/converter.md §5 (vendored: vendor/docs/). Pure:
// the caller hands in the map model, the index's links, the sections and
// the notes (text + frontmatter), and a link resolver; it gets back the
// Flutter campaign's files. Writing them (Node fs) is src/convert/write.ts.
//
// The section decides where a note's file goes; the hex keeps only a link
// (its page, or `also_links`).

import { Hex } from '../core/hex';
import { encodeJsonLines, type Json, type JsonObject } from '../core/json';
import type { MapModel } from '../core/map';
import { kindOf, locationLinks, type NoteKind } from '../notes/note_meta';
import { parseSections, updatePageFromNpc, type NpcText } from '../notes/npc_page';
import { sectionOf, type Section } from '../storage/hexmap_index';
import { applyFile, encodeAll, fileKeyOf } from '../storage/map_codec';
import { MapModel as Model } from '../core/map';

/** The converter contract this build writes (docs/converter.md §1). */
export const CONVERTER_CONTRACT = 1;

/** FNV-1a 32-bit over the UTF-8 bytes, 8 lowercase hex digits (§2). */
export function fingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (const b of new TextEncoder().encode(text)) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** Flutter's safeFilenameBase (core/entries.dart). */
export function flutterSafeName(name: string): string {
	// Drop what Flutter drops: path and shell characters, and control ones.
	let base = [...name].filter((ch) => ch.charCodeAt(0) >= 32 && !'\\/:*?"<>|'.includes(ch)).join('');
	base = base.split(/\s+/).filter((w) => w).join(' ');
	base = base.replace(/^\.+/, '').trim();
	return base || 'page';
}

/** Flutter's tabFolder: a tab's folder under pages/. */
export const tabFolder = (tab: string) => flutterSafeName(tab).toLowerCase();

export interface VaultNote {
	/** Vault path, with `.md`. */
	path: string;
	/** The whole file. */
	text: string;
	frontmatter: Record<string, unknown> | null;
}

export interface FlutterExportInput {
	model: MapModel;
	/** The index's vault path. */
	indexPath: string;
	/** Hex id → link texts (principal first), from `## Hexes`. */
	hexLinks: Map<string, string[]>;
	/** Region id → link texts, from `## Regions`. */
	regionLinks: Map<string, string[]>;
	sections: readonly Section[];
	/** Every note that may go (§5.1): by vault path. */
	notes: Map<string, VaultNote>;
	/** A link text, from a note at [from], to a vault path (or null). */
	resolve: (link: string, from: string) => string | null;
}

export interface FlutterExportPlan {
	/** Campaign-relative path → text. */
	files: Map<string, string>;
	reports: string[];
}

const DEFAULT_TABS = ['NPC', 'Unsorted'];
const isSection = (s: Section | null, name: string) => !!s && s.name.trim().toLowerCase() === name.toLowerCase();
const basename = (path: string) => {
	const last = path.split('/').pop()!;
	return last.endsWith('.md') ? last.slice(0, -3) : last;
};
const linkTarget = (link: string) => link.split('|')[0]!.split('#')[0]!.trim();

/** The note's text without its frontmatter. */
export function bodyOf(text: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
	return m ? text.slice(m[0].length) : text;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);
const linkList = (v: unknown): string[] => strList(v).map((s) => /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(s)?.[1] ?? s).filter((s) => s.trim());
const extraOf = (fm: Record<string, unknown> | null): JsonObject => {
	const e = fm?.['hexlore-extra'];
	return e && typeof e === 'object' && !Array.isArray(e) ? (e as JsonObject) : {};
};

/** Plan the Flutter campaign for a map (docs/converter.md §5). */
export function planFlutterExport(input: FlutterExportInput): FlutterExportPlan {
	const { notes, sections, resolve, indexPath } = input;
	const reports: string[] = [];
	const files = new Map<string, string>();
	const manifest: { flutter: string; vault: string; fingerprint: string }[] = [];

	// A copy of the model: the export sets page links; the live map is not touched.
	const model = new Model();
	for (const [path, text] of encodeAll(input.model)) {
		const key = fileKeyOf(path);
		if (key) applyFile(model, key, text, input.model.meta.name);
	}

	// ----- what each hex and region links to ------------------------------------
	const resolveAll = (links: string[]) => links.map((l) => resolve(l, indexPath)).filter((p): p is string => !!p && notes.has(p));
	const hexNotes = new Map<string, string[]>();
	for (const [id, links] of input.hexLinks) {
		const list = [...new Set(resolveAll(links))];
		if (list.length) hexNotes.set(id, list);
	}
	const byNote = new Map<string, string[]>(); // note → hexes listing it (sorted)
	const hexIds = [...hexNotes.keys()].sort(compareHexIds);
	for (const id of hexIds) for (const p of hexNotes.get(id)!) (byNote.get(p) ?? byNote.set(p, []).get(p)!).push(id);
	const regionNote = new Map<string, string>();
	for (const [id, links] of [...input.regionLinks].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const p = resolveAll(links)[0];
		if (p) regionNote.set(id, p);
	}

	// ----- allocation in pages/ ---------------------------------------------------
	const taken = new Map<string, Set<string>>();
	const allocate = (folder: string, name: string) => {
		const set = taken.get(folder) ?? taken.set(folder, new Set()).get(folder)!;
		const base = flutterSafeName(name);
		let file = `${base}.md`;
		for (let n = 2; set.has(file.toLowerCase()); n++) file = `${base}_${n}.md`;
		set.add(file.toLowerCase());
		return `${folder}/${file}`;
	};

	const kind = (p: string): NoteKind => kindOf(notes.get(p)!.frontmatter);
	const sectionFor = (p: string) => sectionOf(sections, p);

	// Where each note became something Flutter can name (for links, §5.2).
	const flutterName = new Map<string, string>();
	// The pages/-relative page file(s) of each note (for also_links).
	const pageOf = new Map<string, string>();
	const pages = new Map<string, { vault: string; text: string }>(); // pages/-relative → source

	// Hex pages: the principal note of a hex, when it is a Places note.
	const hexPage = new Map<string, string>();
	const isPlace = (p: string) => isSection(sectionFor(p), 'Places') || kind(p) === 'place';
	for (const id of hexIds) {
		const principal = hexNotes.get(id)![0]!;
		if (!isPlace(principal) || kind(principal) === 'npc' || kind(principal) === 'quest') continue;
		const page = allocate('hexes', basename(principal));
		const hex = model.hexes.get(id);
		pages.set(page, { vault: principal, text: notes.get(principal)!.text });
		hexPage.set(id, page);
		if (!pageOf.has(principal)) pageOf.set(principal, page);
		const name = hex?.name;
		if (name && !flutterName.has(principal)) flutterName.set(principal, name);
	}
	const hexPageNotes = new Set([...pages.values()].map((v) => v.vault));
	const shared = [...hexPageNotes].filter((p) => (byNote.get(p) ?? []).filter((id) => hexNotes.get(id)![0] === p).length > 1);
	for (const p of shared) reports.push(`“${basename(p)}” is the page of several hexes: each gets a copy (they merge back on the way home).`);

	// Regions.
	for (const [id, p] of regionNote) {
		const g = model.regions.get(id);
		if (!g) continue;
		const page = pageOf.get(p) && pageOf.get(p)!.startsWith('regions/') ? pageOf.get(p)! : allocate('regions', basename(p));
		g.pageFile = page;
		pages.set(page, { vault: p, text: notes.get(p)!.text });
		if (!pageOf.has(p)) pageOf.set(p, page);
		if (g.name && !flutterName.has(p)) flutterName.set(p, g.name);
	}

	// NPCs, quests, adventures, and every other note by section.
	const npcNotes: string[] = [], questNotes: string[] = [], advNotes: string[] = [];
	const entries: { name: string; tab: string; page: string | null; npc?: string; vault: string }[] = [];
	const customTabs: string[] = [];
	const placed = new Set([...hexPageNotes, ...regionNote.values()]);
	for (const p of [...notes.keys()].sort()) {
		const k = kind(p);
		if (k === 'npc') {
			npcNotes.push(p);
			continue;
		}
		if (k === 'quest') {
			questNotes.push(p);
			continue;
		}
		const s = sectionFor(p);
		if (isSection(s, 'Adventures')) {
			advNotes.push(p);
			continue;
		}
		if (placed.has(p)) continue;
		let page: string;
		if (isSection(s, 'GM notes')) page = allocate('prep', basename(p));
		else if (isSection(s, 'Regions')) page = allocate('regions', basename(p));
		else if (isSection(s, 'NPCs')) {
			page = allocate(tabFolder('NPC'), basename(p));
			entries.push({ name: basename(p), tab: 'NPC', page, vault: p });
		} else if (s && !['places', 'unsorted', 'quests'].includes(s.name.trim().toLowerCase())) {
			const tab = s.name.trim();
			if (!customTabs.some((t) => t.toLowerCase() === tab.toLowerCase())) customTabs.push(tab);
			page = allocate(tabFolder(tab), basename(p));
			entries.push({ name: basename(p), tab, page, vault: p });
		} else {
			page = allocate(tabFolder('Unsorted'), basename(p));
			entries.push({ name: basename(p), tab: 'Unsorted', page, vault: p });
		}
		pages.set(page, { vault: p, text: notes.get(p)!.text });
		pageOf.set(p, page);
		if (!flutterName.has(p)) flutterName.set(p, basename(p));
	}

	// ----- ids ----------------------------------------------------------------------
	const ids = new Set<string>();
	const nextId = (prefix: string, wanted: unknown) => {
		if (typeof wanted === 'string' && wanted.startsWith(`${prefix}_`) && !ids.has(wanted)) {
			ids.add(wanted);
			return wanted;
		}
		for (let n = 1; ; n++) {
			const id = `${prefix}_${String(n).padStart(3, '0')}`;
			if (!ids.has(id)) {
				ids.add(id);
				return id;
			}
		}
	};
	// Ids from hexlore-id first, so they keep theirs.
	const wantedId = (p: string) => notes.get(p)!.frontmatter?.['hexlore-id'];
	const reserve = (list: string[], prefix: string) => {
		const out = new Map<string, string>();
		for (const p of list) {
			const w = wantedId(p);
			if (typeof w === 'string' && w.startsWith(`${prefix}_`) && !ids.has(w)) out.set(p, nextId(prefix, w));
		}
		for (const p of list) if (!out.has(p)) out.set(p, nextId(prefix, null));
		return out;
	};

	// The hexes a note stands for: listing it, and listing its places.
	const placeHexes = (p: string): string[] => {
		const fm = notes.get(p)!.frontmatter;
		const out = new Set(byNote.get(p) ?? []);
		for (const l of locationLinks(fm)) {
			const place = resolve(l, p);
			for (const id of place ? (byNote.get(place) ?? []) : []) out.add(id);
		}
		return [...out].sort(compareHexIds);
	};

	// NPCs: one record per hex of its places (§5.2).
	const npcFirstId = reserve(npcNotes, 'npc');
	const questId = reserve(questNotes, 'quest');
	const npcIdsOf = new Map<string, string[]>();
	for (const p of npcNotes) {
		const hexes = placeHexes(p);
		const list = [npcFirstId.get(p)!];
		for (let i = 1; i < hexes.length; i++) list.push(nextId('npc', null));
		npcIdsOf.set(p, list);
		if (hexes.length > 1) reports.push(`NPC “${basename(p)}” is at ${hexes.length} hexes: one copy per hex.`);
	}

	// ----- links in text (§5.2) -------------------------------------------------------
	for (const p of npcNotes) flutterName.set(p, basename(p));
	for (const p of questNotes) flutterName.set(p, basename(p));
	for (const p of advNotes) if (!flutterName.has(p)) flutterName.set(p, basename(p));
	const rewrite = (text: string, from: string) =>
		text.replace(/(!?)\[\[([^\][\n]+)\]\]/g, (all, bang: string, inner: string) => {
			if (bang) return all; // an embed stays as it is
			const bar = inner.indexOf('|');
			const target = bar < 0 ? inner : inner.slice(0, bar);
			const alias = bar < 0 ? null : inner.slice(bar + 1);
			const hash = target.indexOf('#');
			const heading = hash < 0 ? '' : target.slice(hash);
			const path = resolve(target.slice(0, hash < 0 ? undefined : hash), from);
			const name = path ? (flutterName.get(path) ?? basename(path)) : null;
			if (!name) return all;
			const shown = alias ?? basename(target.slice(0, hash < 0 ? undefined : hash));
			return shown && shown !== name ? `[[${name}${heading}|${shown}]]` : `[[${name}${heading}]]`;
		});

	// ----- pages ------------------------------------------------------------------------
	const record = (flutter: string, vault: string, text: string) => manifest.push({ flutter, vault, fingerprint: fingerprint(text) });
	for (const [page, src] of pages) {
		const text = rewrite(src.text, src.vault);
		files.set(`pages/${page}`, text);
		record(`pages/${page}`, src.vault, text);
	}

	// ----- NPC records --------------------------------------------------------------------
	const linkedIds = (v: unknown, from: string, map: Map<string, string[] | string>) =>
		linkList(v)
			.map((l) => resolve(linkTarget(l), from))
			.map((p) => (p ? map.get(p) : undefined))
			.map((x) => (Array.isArray(x) ? x[0] : x))
			.filter((x): x is string => !!x);
	const npcMap = new Map<string, string[] | string>([...npcIdsOf]);
	const questMap = new Map<string, string[] | string>([...questId]);
	for (const p of npcNotes) {
		const note = notes.get(p)!;
		const fm = note.frontmatter ?? {};
		const body = rewrite(bodyOf(note.text), p);
		const [, known] = parseSections(body);
		const text: NpcText = { role: str(fm.role), attitude: str(fm.attitude), description: known.description ?? '', secret: known.secret ?? '' };
		const page = allocate(tabFolder('NPC'), basename(p));
		const pageText = updatePageFromNpc(body, text);
		files.set(`pages/${page}`, pageText);
		record(`pages/${page}`, p, pageText);
		const hexes = placeHexes(p);
		const idsHere = npcIdsOf.get(p)!;
		idsHere.forEach((id, i) => {
			const json: JsonObject = {
				id,
				name: basename(p),
				hex_id: hexes[i] ?? null,
				role: text.role,
				attitude: text.attitude,
				description: text.description,
				secret: text.secret,
				tags: strList(fm.tags),
				linked_npc_ids: linkedIds(fm.npcs, p, npcMap),
				linked_quest_ids: linkedIds(fm.quests, p, questMap),
				notes_file: page,
				is_secret: fm.secret === true,
				...withoutKnown(extraOf(note.frontmatter), NPC_KEYS),
			};
			files.set(`npcs/${id}.json`, encodeJsonLines(json));
			if (i === 0) record(`npcs/${id}.json`, p, pageText);
			entries.push({ name: basename(p), tab: 'NPC', page, npc: id, vault: p });
		});
		if (!pageOf.has(p)) pageOf.set(p, page);
	}

	// ----- quests ----------------------------------------------------------------------------
	for (const p of questNotes) {
		const note = notes.get(p)!;
		const fm = note.frontmatter ?? {};
		const id = questId.get(p)!;
		const hexes = placeHexes(p);
		const gm = rewrite(bodyOf(note.text), p).replace(/\n+$/, '');
		const json: JsonObject = {
			id,
			title: basename(p),
			hex_id: hexes[0] ?? null,
			hook: str(fm.hook),
			objectives: strList(fm.objectives),
			reward: str(fm.reward),
			status: str(fm.status) || 'seed',
			gm_notes: gm,
			linked_hex_ids: hexes.slice(1),
			linked_npc_ids: linkedIds(fm.npcs, p, npcMap),
			tags: strList(fm.tags),
			unresolved: fm.unresolved === true,
			is_secret: fm.secret === true,
			...withoutKnown(extraOf(note.frontmatter), QUEST_KEYS),
		};
		files.set(`quests/${id}.json`, encodeJsonLines(json));
		record(`quests/${id}.json`, p, gm);
	}

	// ----- adventures --------------------------------------------------------------------------
	const advIds = reserve(advNotes, 'adv');
	const rows: { id: string; title: string; order: number }[] = [];
	advNotes.forEach((p, i) => {
		const note = notes.get(p)!;
		const order = note.frontmatter?.order;
		const id = advIds.get(p)!;
		const body = rewrite(bodyOf(note.text), p);
		rows.push({ id, title: basename(p), order: typeof order === 'number' && Number.isInteger(order) ? order : i });
		files.set(`adventures/${id}.md`, body);
		record(`adventures/${id}.md`, p, body);
	});
	rows.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
	files.set('adventures/manifest.json', encodeJsonLines(rows.map((r) => ({ id: r.id, title: r.title, order: r.order }))));

	// ----- entries -------------------------------------------------------------------------------
	const tabs = [...DEFAULT_TABS.map((name) => ({ name, fixed: true, mode: 'global' })), ...customTabs.map((name) => ({ name, fixed: false, mode: 'global' }))];
	const entryJson: Record<string, Json> = {};
	entries.forEach((e, i) => {
		const id = `entry_${String(i + 1).padStart(3, '0')}`;
		entryJson[id] = { id, name: e.name, tab: e.tab, npc_id: e.npc ?? null, page_file: e.page };
		if (!flutterName.has(e.vault)) flutterName.set(e.vault, e.name);
	});
	files.set('entries.json', encodeJsonLines({ tabs, entries: entryJson }));

	// ----- hexes: page and also_links -----------------------------------------------------------
	// A note on a cell with no hex record: Flutter needs a record to hold it.
	for (const id of hexIds) {
		const m = /^q(-?\d+)_r(-?\d+)$/.exec(id);
		if (m && !model.hexes.has(id)) model.hexes.set(id, new Hex(Number(m[1]), Number(m[2])));
	}
	for (const h of model.hexes.values()) {
		delete h.extra.also_links;
		// The page is the one made from its principal note; any page_file it
		// carried from an earlier trip is not exported, so it goes.
		h.pageFile = hexPage.get(h.id) ?? null;
		const also = (hexNotes.get(h.id) ?? []).map((p) => pageOf.get(p)).filter((pf): pf is string => !!pf && pf !== h.pageFile);
		if (also.length) h.extra.also_links = [...new Set(also)];
	}
	for (const [path, text] of encodeAll(model)) files.set(path, text);

	files.set(
		'roundtrip.json',
		encodeJsonLines({
			converter: CONVERTER_CONTRACT,
			vault_index: indexPath,
			files: manifest.sort((a, b) => (a.flutter < b.flutter ? -1 : a.flutter > b.flutter ? 1 : 0)) as unknown as Json,
		}),
	);
	return { files, reports };
}

const NPC_KEYS = new Set(['id', 'name', 'hex_id', 'role', 'attitude', 'description', 'secret', 'tags', 'linked_npc_ids', 'linked_quest_ids', 'notes_file', 'is_secret']);
const QUEST_KEYS = new Set(['id', 'title', 'hex_id', 'hook', 'objectives', 'reward', 'status', 'gm_notes', 'linked_hex_ids', 'linked_npc_ids', 'tags', 'unresolved', 'is_secret']);

function withoutKnown(extra: JsonObject, known: Set<string>): JsonObject {
	const out: JsonObject = {};
	for (const [k, v] of Object.entries(extra)) if (!known.has(k)) out[k] = v;
	return out;
}

function compareHexIds(a: string, b: string): number {
	const x = /^q(-?\d+)_r(-?\d+)$/.exec(a), y = /^q(-?\d+)_r(-?\d+)$/.exec(b);
	if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
	return Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
}

