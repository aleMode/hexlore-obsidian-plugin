// The `.hexmap.md` index: the one Markdown file of a map (plan §1.2–1.4).
//
// It holds only LINKS, as plain Markdown lines — Obsidian tracks wikilinks
// in ordinary lines (not in code blocks) and rewrites them when a note is
// renamed, which is the whole point. Grammar, version 1 (`hexlore-index: 1`
// in the frontmatter; the contract is vendor/docs/converter.md §3):
//
//   ## Hexes
//   - q5_r-2 :: [[Main note]] · [[Other note]]
//   ## Regions
//   - region_001 :: [[Northern Wastes]]
//
// - Each line is one hex: its id, `::`, its notes in order (the first is the
//   PRINCIPAL note), separated by `·`. A link is kept exactly as written,
//   alias and path included.
// - A region's first link is its note (encounters are rolled from it).
// - Only these two sections are the plugin's; everything else in the file
//   (the GM may write there) is left byte for byte.
// - Tolerant: a line in the section that does not parse is KEPT verbatim,
//   reported, and never dropped. A hex listed twice is merged.
//
// Sections (§1.4) live in the frontmatter as a list of {name, folder} (plus
// an optional `template`: the vault path of the note new notes start from).

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LINK = /\[\[([^\][\n]+)\]\]/g;
const SEPARATOR = /^[\s·,;|]*$/;

/** One `## <Heading>` section of `- <id> :: [[link]] · [[link]]` lines. */
export interface LinkSection {
	heading: string;
	/** The ids this section holds. */
	id: RegExp;
	/** The order entries are written in. */
	compare: (a: string, b: string) => number;
}

const cellOfId = (id: string) => /^q(-?\d+)_r(-?\d+)$/.exec(id)!.slice(1).map(Number) as [number, number];

/** Hex id → notes: the first is the PRINCIPAL note. */
export const HEXES: LinkSection = {
	heading: 'Hexes',
	id: /^q-?\d+_r-?\d+$/,
	compare: (a, b) => {
		const [aq, ar] = cellOfId(a), [bq, br] = cellOfId(b);
		return aq - bq || ar - br;
	},
};

/** Region id → its note (the one encounters are rolled from). */
export const REGIONS: LinkSection = {
	heading: 'Regions',
	id: /^[A-Za-z0-9][\w-]*$/,
	compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
};

export interface IndexProblem {
	/** 1-based line in the file. */
	line: number;
	text: string;
	reason: string;
}

export interface ParsedLinks {
	/** Id → the inner text of each [[link]], in order. */
	links: Map<string, string[]>;
	problems: IndexProblem[];
}

/** Where the frontmatter ends (the line index after its closing ---). */
function bodyStart(lines: string[]): number {
	if (lines[0]?.trim() !== '---') return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i]!.trim() === '---' || lines[i]!.trim() === '...') return i + 1;
	return 0;
}

/** The section's lines: [heading line, first line after it, end), or null. */
function findSection(lines: string[], heading: string): [number, number, number] | null {
	const re = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
	for (let i = bodyStart(lines); i < lines.length; i++) {
		if (!re.test(lines[i]!)) continue;
		let end = i + 1;
		while (end < lines.length) {
			const h = HEADING.exec(lines[end]!);
			if (h && h[1]!.length <= 2) break;
			end++;
		}
		return [i, i + 1, end];
	}
	return null;
}

function parseEntry(line: string, section: LinkSection): { id: string; links: string[] } | string {
	const m = /^\s*[-*+]\s+(\S+)\s*::\s*(.*?)\s*$/.exec(line);
	if (!m || !section.id.test(m[1]!)) return `not a "- <id> :: [[note]]" line`;
	const rest = m[2]!;
	const links: string[] = [];
	let outside = rest;
	for (const l of rest.matchAll(LINK)) {
		links.push(l[1]!);
		outside = outside.replace(l[0], '');
	}
	if (!SEPARATOR.test(outside)) return 'text that is not a [[link]]';
	return { id: m[1]!, links };
}

export function parseLinks(markdown: string, section: LinkSection): ParsedLinks {
	const lines = markdown.split('\n');
	const links = new Map<string, string[]>();
	const problems: IndexProblem[] = [];
	const found = findSection(lines, section.heading);
	if (!found) return { links, problems };
	for (let i = found[1]; i < found[2]; i++) {
		const line = lines[i]!.replace(/\r$/, '');
		if (!line.trim()) continue;
		const e = parseEntry(line, section);
		if (typeof e === 'string') {
			problems.push({ line: i + 1, text: line, reason: e });
			continue;
		}
		const list = links.get(e.id);
		if (list) {
			problems.push({ line: i + 1, text: line, reason: `${e.id} is listed twice; the lists were merged` });
			for (const l of e.links) if (!list.includes(l)) list.push(l);
		} else {
			links.set(e.id, e.links);
		}
	}
	return { links, problems };
}

/** One entry line, in the canonical form. */
export function formatEntry(id: string, links: string[]): string {
	return `- ${id} :: ${links.map((l) => `[[${l}]]`).join(' · ')}`;
}

/** [markdown] with one section rewritten from [entries] (sorted; ids with no
 *  links left out). Lines in it that did not parse are kept, after the
 *  entries. Nothing outside the section moves. With no section yet, one is
 *  appended. */
export function writeLinks(markdown: string, section: LinkSection, entries: Map<string, string[]>): string {
	const lines = markdown.split('\n');
	const body = [...entries]
		.filter(([, links]) => links.length > 0)
		.sort(([a], [b]) => section.compare(a, b))
		.map(([id, links]) => formatEntry(id, links));
	const found = findSection(lines, section.heading);
	if (!found) {
		if (!body.length) return markdown;
		const trimmed = markdown.replace(/\n*$/, '');
		return `${trimmed}${trimmed ? '\n\n' : ''}## ${section.heading}\n\n${body.join('\n')}\n`;
	}
	const [, from, to] = found;
	const kept = lines.slice(from, to).filter((l) => l.trim() && typeof parseEntry(l.replace(/\r$/, ''), section) === 'string');
	const after = lines.slice(to);
	const replacement = ['', ...body, ...kept, ...(after.length && after.some((l) => l.trim()) ? [''] : [])];
	let text = [...lines.slice(0, from), ...replacement, ...after].join('\n');
	if (!after.length) text = text.replace(/\n*$/, '\n');
	return text;
}

/** The hexes' links (the `## Hexes` section). */
export interface ParsedIndex {
	hexes: Map<string, string[]>;
	problems: IndexProblem[];
}

export function parseHexList(markdown: string): ParsedIndex {
	const p = parseLinks(markdown, HEXES);
	return { hexes: p.links, problems: p.problems };
}

export function writeHexList(markdown: string, hexes: Map<string, string[]>): string {
	return writeLinks(markdown, HEXES, hexes);
}

/** Move note lists along with remapped hexes (explode, move selection,
 *  cut/paste): a hex's notes follow it. */
export function remapHexLinks(hexes: Map<string, string[]>, idMap: Map<string, string>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [id, links] of hexes) if (!idMap.has(id)) out.set(id, links);
	for (const [id, links] of hexes) {
		const to = idMap.get(id);
		if (to !== undefined) out.set(to, links);
	}
	return out;
}

// ----- sections (frontmatter) --------------------------------------------------

export interface Section {
	name: string;
	/** Vault folder, relative to the vault root. */
	folder: string;
	/** Vault path of the template new notes here start from. */
	template?: string;
}

/** The defaults mirror Flutter's categories, so the converter maps them 1:1. */
export const DEFAULT_SECTIONS: readonly Section[] = [
	{ name: 'Places', folder: 'Places' },
	{ name: 'Regions', folder: 'Regions' },
	{ name: 'NPCs', folder: 'NPCs' },
	{ name: 'GM notes', folder: 'GM notes' },
	{ name: 'Adventures', folder: 'Adventures' },
	{ name: 'Unsorted', folder: 'Unsorted' },
];

/** The sections of a map made in a folder of its own: numbered folders, so
 *  they sort in this order. The names are the converter's (Factions is a
 *  custom section, a custom tab in Flutter); Unsorted's folder is
 *  "Miscellanea". */
export const MAP_FOLDER_SECTIONS: readonly Section[] = [
	{ name: 'Places', folder: '10 Places' },
	{ name: 'Regions', folder: '20 Regions' },
	{ name: 'NPCs', folder: '30 NPCs' },
	{ name: 'Factions', folder: '40 Factions' },
	{ name: 'Quests', folder: '50 Quests' },
	{ name: 'Adventures', folder: '60 Adventures' },
	{ name: 'GM notes', folder: '70 GM notes' },
	{ name: 'Unsorted', folder: '90 Miscellanea' },
];

/** [MAP_FOLDER_SECTIONS] inside [home], the map's folder ('' = vault root). */
export const mapFolderSections = (home: string): Section[] =>
	MAP_FOLDER_SECTIONS.map((s) => ({ name: s.name, folder: home ? `${home}/${s.folder}` : s.folder }));

const cleanFolder = (f: string) => f.trim().replace(/^\/+|\/+$/g, '');

/** Tolerant read of the `sections` frontmatter key: a list of {name, folder}
 *  or of plain names (the folder is the name). Null when absent. */
export function readSections(frontmatter: Record<string, unknown> | null | undefined): Section[] | null {
	const raw = frontmatter?.sections;
	if (!Array.isArray(raw)) return null;
	const out: Section[] = [];
	for (const s of raw) {
		if (typeof s === 'string' && s.trim()) out.push({ name: s.trim(), folder: cleanFolder(s) });
		else if (s && typeof s === 'object') {
			const o = s as Record<string, unknown>;
			const name = typeof o.name === 'string' ? o.name.trim() : '';
			const folder = typeof o.folder === 'string' ? cleanFolder(o.folder) : name;
			const template = typeof o.template === 'string' && o.template.trim() ? o.template.trim() : undefined;
			if (name && folder) out.push(template ? { name, folder, template } : { name, folder });
		}
	}
	return out;
}

export const sectionsFrontmatter = (sections: Section[]) =>
	sections.map((s) => (s.template ? { name: s.name, folder: s.folder, template: s.template } : { name: s.name, folder: s.folder }));

/** The section a vault path belongs to (its folder or below), or null. */
export function sectionOf(sections: readonly Section[], path: string): Section | null {
	return sections.find((s) => path.startsWith(`${s.folder}/`)) ?? null;
}

/** Why [sections] are not valid, or []: a folder inside another section's
 *  folder (nesting is refused, Q11), or a folder used twice. */
export function sectionProblems(sections: Section[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		for (let j = 0; j < sections.length; j++) {
			if (i === j) continue;
			const a = sections[i]!, b = sections[j]!;
			if (a.folder === b.folder && i < j) out.push(`"${a.name}" and "${b.name}" use the same folder (${a.folder})`);
			else if (b.folder.startsWith(`${a.folder}/`)) out.push(`"${b.name}" is inside "${a.name}": sections cannot be nested`);
		}
	}
	return out;
}

/** [path] after [from] (a file or a folder) was renamed to [to], or null when
 *  [path] is neither [from] nor inside it. */
function movedTo(path: string, from: string, to: string): string | null {
	if (path === from) return to;
	return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

/** [sections] after the vault path [from] was renamed to [to]: section
 *  folders and templates at or under it follow. Null when none moved (the
 *  frontmatter stays as it is). Section folders are vault paths, which
 *  Obsidian does not update the way it updates links. */
export function sectionsAfterRename(sections: readonly Section[], from: string, to: string): Section[] | null {
	let changed = false;
	const out = sections.map((s) => {
		const folder = movedTo(s.folder, from, to);
		const template = s.template !== undefined ? movedTo(s.template, from, to) : null;
		if (folder === null && template === null) return s;
		changed = true;
		const next: Section = { name: s.name, folder: folder ?? s.folder };
		if (s.template !== undefined) next.template = template ?? s.template;
		return next;
	});
	return changed ? out : null;
}
