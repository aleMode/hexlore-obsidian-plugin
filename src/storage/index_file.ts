// Writing to a map's `.hexmap.md` index through Obsidian (the parsing and
// formatting are pure, in hexmap_index.ts).
//
// The hex list is rewritten with vault.process — an atomic read-modify-write,
// so a link Obsidian is updating for a rename at the same moment is not lost.
// Sections live in the frontmatter and go through processFrontMatter.

import type { App, TFile } from 'obsidian';
import { REGIONS, parseHexList, parseLinks, readSections, sectionsFrontmatter, writeHexList, writeLinks, type Section } from './hexmap_index';

/** Change a map's hex → notes links: [change] gets the current lists and
 *  returns the new ones. */
export async function updateHexLinks(
	app: App,
	index: TFile,
	change: (hexes: Map<string, string[]>) => Map<string, string[]>,
): Promise<void> {
	await app.vault.process(index, (text) => writeHexList(text, change(parseHexList(text).hexes)));
}

/** Change a map's region → note links the same way. */
export async function updateRegionLinks(
	app: App,
	index: TFile,
	change: (regions: Map<string, string[]>) => Map<string, string[]>,
): Promise<void> {
	await app.vault.process(index, (text) => writeLinks(text, REGIONS, change(parseLinks(text, REGIONS).links)));
}

/** The map's sections, or null when the index sets none (use the defaults). */
export function sectionsOf(app: App, index: TFile): Section[] | null {
	return readSections(app.metadataCache.getFileCache(index)?.frontmatter);
}

export async function writeSections(app: App, index: TFile, sections: Section[]): Promise<void> {
	await app.fileManager.processFrontMatter(index, (fm: Record<string, unknown>) => {
		fm.sections = sectionsFrontmatter(sections);
	});
}
