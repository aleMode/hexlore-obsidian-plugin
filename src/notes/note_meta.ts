// Note conventions (plan §1.3, item 2.5): what the plugin reads from a
// note's frontmatter, and what it writes into a note it creates. Pure: no
// Obsidian import.
//
// A note is PLAIN unless its frontmatter says `type: npc` / `type: quest` /
// `type: place`. NPCs and quests point at PLACE NOTES, never at coordinates
// (moving hexes never touches them):
//
//   NPC    type: npc     role, attitude (friendly / neutral / hostile /
//                        unknown), location, tags, npcs, quests
//   Quest  type: quest   status (seed / active / dormant / resolved /
//                        failed), hook, objectives (list), reward,
//                        location, npcs, tags
//
// `location` is one link or a list of links ("[[Base Culto]]"). These are
// Flutter's NPC and quest fields under the same names, so the converter
// (vendor/docs/converter.md) maps them one to one; the body holds the description
// (an NPC's) or the GM notes (a quest's).

export type NoteKind = 'note' | 'place' | 'npc' | 'quest';

export const NOTE_KINDS: readonly { kind: NoteKind; label: string }[] = [
	{ kind: 'note', label: 'Note' },
	{ kind: 'place', label: 'Place' },
	{ kind: 'npc', label: 'NPC' },
	{ kind: 'quest', label: 'Quest' },
];

export const NPC_ATTITUDES = ['friendly', 'neutral', 'hostile', 'unknown'] as const;
export const QUEST_STATUSES = ['seed', 'active', 'dormant', 'resolved', 'failed'] as const;

type Frontmatter = Record<string, unknown> | null | undefined;

/** The note's kind, from `type:` (case-insensitive). Unknown types are plain. */
export function kindOf(fm: Frontmatter): NoteKind {
	const t = typeof fm?.type === 'string' ? fm.type.trim().toLowerCase() : '';
	return t === 'npc' || t === 'quest' || t === 'place' ? t : 'note';
}

/** The link TEXT of each `location` entry ("[[Base Culto|the base]]" →
 *  "Base Culto"), in order. Accepts one value or a list, bracketed or not. */
export function locationLinks(fm: Frontmatter): string[] {
	const raw = fm?.location;
	const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const out: string[] = [];
	for (const v of list) {
		if (typeof v !== 'string') continue;
		const m = /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(v);
		const text = (m ? m[1]! : v).split('|')[0]!.split('#')[0]!.trim();
		if (text && !out.includes(text)) out.push(text);
	}
	return out;
}

/** The frontmatter a new note of [kind] starts with (as an object, for
 *  `processFrontMatter`), or null for a plain note. [location]: the place
 *  note's link text, when the note is made from a hex that has one. */
export function starterFrontmatter(kind: NoteKind, location: string | null): Record<string, unknown> | null {
	const loc = location ? `[[${location}]]` : '';
	switch (kind) {
		case 'note':
			return null;
		case 'place':
			return { type: 'place' };
		case 'npc':
			return { type: 'npc', role: '', attitude: 'unknown', location: loc, tags: [] };
		case 'quest':
			return { type: 'quest', status: 'seed', hook: '', objectives: [], reward: '', location: loc ? [loc] : [], npcs: [] };
	}
}

/** The kind a section's new notes default to, from its name. */
export function defaultKindFor(sectionName: string): NoteKind {
	const n = sectionName.trim().toLowerCase();
	if (n === 'npcs' || n === 'npc' || n === 'people' || n === 'characters') return 'npc';
	if (n === 'quests' || n === 'quest') return 'quest';
	if (n === 'places' || n === 'locations') return 'place';
	return 'note';
}

export interface TemplateVars {
	title: string;
	/** The hex's display id ("F3"), or '' when not made from a hex. */
	hex: string;
	/** The map's name. */
	map: string;
}

/** Fill a template: `{{title}}`, `{{hex}}`, `{{map}}`, and the core
 *  Templates plugin's `{{date}}`, `{{time}}`, `{{date:FORMAT}}`,
 *  `{{time:FORMAT}}` (formatted by [format], e.g. moment). Unknown
 *  placeholders are left as they are. */
export function expandTemplate(text: string, vars: TemplateVars, format: (fmt: string) => string): string {
	return text.replace(/\{\{\s*(\w+)(?::([^}]*))?\s*\}\}/g, (all, name: string, fmt: string | undefined) => {
		switch (name.toLowerCase()) {
			case 'title':
				return vars.title;
			case 'hex':
				return vars.hex;
			case 'map':
				return vars.map;
			case 'date':
				return format(fmt?.trim() || 'YYYY-MM-DD');
			case 'time':
				return format(fmt?.trim() || 'HH:mm');
			default:
				return all;
		}
	});
}

/** A file name for [title]: characters Obsidian refuses or links break on
 *  become spaces. */
export function safeNoteName(title: string): string {
	return title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

/** The hexes a note stands for on the map: the hexes listing it, plus the
 *  hexes listing any of its places (an NPC's or a quest's `location`).
 *  [byNote]: note path → the hexes listing it. */
export function hexesForNote(notePath: string, locationPaths: Iterable<string>, byNote: Map<string, Set<string>>): Set<string> {
	const out = new Set(byNote.get(notePath) ?? []);
	for (const p of locationPaths) for (const id of byNote.get(p) ?? []) out.add(id);
	return out;
}
