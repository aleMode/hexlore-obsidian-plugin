// The notes side of a map, through Obsidian: resolving the index's links,
// which hexes a note stands for, the notes in a section, creating a note.
// The conventions themselves are pure, in notes/note_meta.ts.

import { TFile, TFolder, moment, normalizePath, type App } from 'obsidian';
import { expandTemplate, hexesForNote, kindOf, locationLinks, safeNoteName, starterFrontmatter, type NoteKind, type TemplateVars } from '../notes/note_meta';

/** A link's path part: no alias, no heading or block. */
export const linkPath = (link: string): string => link.split('|')[0]!.split('#')[0]!.trim();

export function resolveLink(app: App, link: string, source: string): TFile | null {
	return app.metadataCache.getFirstLinkpathDest(linkPath(link), source);
}

/** Note path → the hexes listing it, from a map's hex → notes lists. */
export function hexesByNote(app: App, index: TFile, links: Map<string, string[]>): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const [id, list] of links) {
		for (const link of list) {
			const f = resolveLink(app, link, index.path);
			if (!f) continue;
			let set = out.get(f.path);
			if (!set) out.set(f.path, (set = new Set()));
			set.add(id);
		}
	}
	return out;
}

export function noteKind(app: App, file: TFile): NoteKind {
	return kindOf(app.metadataCache.getFileCache(file)?.frontmatter);
}

/** The place notes a note's `location` points at (those that exist). */
export function locationFiles(app: App, file: TFile): TFile[] {
	const out: TFile[] = [];
	for (const l of locationLinks(app.metadataCache.getFileCache(file)?.frontmatter)) {
		const f = resolveLink(app, l, file.path);
		if (f && !out.includes(f)) out.push(f);
	}
	return out;
}

/** The hexes of the map a note stands for (see `hexesForNote`). */
export function hexesOfNote(app: App, file: TFile, byNote: Map<string, Set<string>>): Set<string> {
	return hexesForNote(
		file.path,
		locationFiles(app, file).map((f) => f.path),
		byNote,
	);
}

const isNote = (f: TFile) => f.extension === 'md' && !f.path.endsWith('.hexmap.md');

/** The notes in [folder] and below, by name. */
export function notesInFolder(app: App, folder: string): TFile[] {
	const root = app.vault.getAbstractFileByPath(normalizePath(folder));
	const out: TFile[] = [];
	const walk = (f: TFolder) => {
		for (const c of f.children) {
			if (c instanceof TFolder) walk(c);
			else if (c instanceof TFile && isNote(c)) out.push(c);
		}
	};
	if (root instanceof TFolder) walk(root);
	return out.sort((a, b) => a.basename.localeCompare(b.basename));
}

/** The templates on offer: the notes in the templates folder. */
export function templateFiles(app: App, folder: string): TFile[] {
	return folder ? notesInFolder(app, folder) : [];
}

/** NPC and quest notes AT a place: those whose `location` is one of
 *  [notePaths], and those listed there directly. */
export function peopleAt(app: App, notePaths: Set<string>): TFile[] {
	const out: TFile[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		const kind = kindOf(fm);
		if (kind !== 'npc' && kind !== 'quest') continue;
		if (notePaths.has(f.path) || locationFiles(app, f).some((p) => notePaths.has(p.path))) out.push(f);
	}
	return out.sort((a, b) => a.basename.localeCompare(b.basename));
}

export interface NewNote {
	title: string;
	/** '' = the vault root. */
	folder: string;
	kind: NoteKind;
	template: TFile | null;
	vars: TemplateVars;
	/** The place note's link text, for an NPC or quest made at a hex. */
	location: string | null;
}

/** Create a note: a free name in [folder] (made if missing), the template
 *  filled in (else a title heading), and the kind's starter frontmatter
 *  where the template did not set those keys. */
export async function createNote(app: App, spec: NewNote): Promise<TFile> {
	const name = safeNoteName(spec.title);
	const folder = normalizePath(spec.folder || '/');
	const base = folder === '/' ? name : `${folder}/${name}`;
	let path = `${base}.md`;
	for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
	if (folder !== '/' && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder).catch(() => undefined);
	const title = spec.title.trim() || name;
	const body = spec.template
		? expandTemplate(await app.vault.read(spec.template), { ...spec.vars, title }, (fmt) => moment().format(fmt))
		: `# ${title}\n\n`;
	const file = await app.vault.create(path, body);
	const starter = starterFrontmatter(spec.kind, spec.location);
	if (starter) {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			for (const [k, v] of Object.entries(starter)) if (!(k in fm)) fm[k] = v;
		});
	}
	return file;
}

/** The notes [file] links to (Obsidian's outgoing links), resolved first,
 *  then the unresolved ones as plain link texts. */
export function outgoingLinks(app: App, file: TFile): { resolved: TFile[]; unresolved: string[] } {
	const resolved: TFile[] = [];
	for (const p of Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {})) {
		const f = app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile && isNote(f) && f !== file) resolved.push(f);
	}
	return { resolved, unresolved: Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {}) };
}
