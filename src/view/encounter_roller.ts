// Rolling a region's encounters, from the map panel or the hex menu, and
// what becomes of the result: a short history per map (this session only)
// and a line added to the session note on request. The tables are read by
// notes/encounter_table.ts (pure).

import { Notice, type App, type TFile } from 'obsidian';
import {
	formatChance,
	parseEncounterChance,
	parseEncounterTables,
	rollEncounterCheck,
	rollEncounterTable,
	type EncounterChance,
	type EncounterTable,
} from '../notes/encounter_table';
import { DEFAULT_SECTIONS } from '../storage/hexmap_index';
import { sectionsOf } from '../storage/index_file';
import { notesInFolder, resolveLink } from './vault_notes';

export interface RollEntry {
	at: number;
	regionId: string;
	/** "North Woods · Night: 3 (1d4) wolves (2d6 7)". */
	line: string;
	/** The entry's indented notes. */
	detail: string[];
	/** The table rolled, to roll it again; absent for a check. */
	table?: string;
}

export interface RegionRef {
	id: string;
	name: string;
	/** The region's note, as written in the index. */
	link: string;
}

/** Kept per map for the session; the session note is the lasting record. */
const MAX_HISTORY = 20;
const histories = new Map<string, RollEntry[]>();
const chosen = new Map<string, string>();

/** This session's rolls on [index]'s map, newest first. */
export function rollHistory(index: TFile): readonly RollEntry[] {
	return histories.get(index.path) ?? [];
}

export function clearRollHistory(index: TFile): void {
	histories.delete(index.path);
}

function record(index: TFile, e: RollEntry): void {
	const list = histories.get(index.path) ?? [];
	list.unshift(e);
	if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
	histories.set(index.path, list);
}

/** The table picked for [regionId] (day / night…), if any. */
export function chosenTable(index: TFile, regionId: string): string | undefined {
	return chosen.get(`${index.path}#${regionId}`);
}

export function chooseTable(index: TFile, regionId: string, name: string): void {
	chosen.set(`${index.path}#${regionId}`, name);
}

export interface RegionNote {
	file: TFile;
	tables: EncounterTable[];
	chance: EncounterChance | null;
}

/** The region's note, its tables and its check; null when the note is gone. */
export async function readRegionNote(app: App, index: TFile, link: string): Promise<RegionNote | null> {
	const file = resolveLink(app, link, index.path);
	if (!file) return null;
	const tables = parseEncounterTables(await app.vault.cachedRead(file));
	const chance = parseEncounterChance(app.metadataCache.getFileCache(file)?.frontmatter?.['encounter-chance']);
	return { file, tables, chance };
}

/** Roll the region's table ([table], else the one picked, else the first),
 *  record it and show it. */
export async function rollRegion(app: App, index: TFile, region: RegionRef, table?: string): Promise<RollEntry | null> {
	const note = await readRegionNote(app, index, region.link);
	if (!note) {
		new Notice('The region’s note is missing.');
		return null;
	}
	return rollFrom(index, region, note, table);
}

function rollFrom(index: TFile, region: RegionRef, note: RegionNote, table?: string): RollEntry | null {
	if (!note.tables.length) {
		new Notice(`“${note.file.basename}” has no “## Encounters” table or list yet.`);
		return null;
	}
	const wanted = table ?? chosenTable(index, region.id);
	const t = note.tables.find((x) => x.name === wanted) ?? note.tables[0]!;
	const r = rollEncounterTable(t);
	const name = `${region.name}${t.name ? ` · ${t.name}` : ''}`;
	const roll = r.roll !== null ? ` (${r.dice ?? 'roll'} ${r.roll})` : '';
	const entry: RollEntry = { at: Date.now(), regionId: region.id, line: `${name}: ${r.text}${roll}`, detail: r.detail, table: t.name };
	record(index, entry);
	new Notice(`Encounter: ${entry.line}${entry.detail.length ? `\n${entry.detail.join('\n')}` : ''}`, 10000);
	return entry;
}

/** The encounter check (`encounter-chance` in the region's note); on a hit,
 *  the table is rolled at once. */
export async function checkRegion(app: App, index: TFile, region: RegionRef): Promise<RollEntry | null> {
	const note = await readRegionNote(app, index, region.link);
	if (!note) {
		new Notice('The region’s note is missing.');
		return null;
	}
	if (!note.chance) {
		new Notice(`Give “${note.file.basename}” an encounter chance first: “encounter-chance: 2” in its properties means 2 in 6.`, 8000);
		return null;
	}
	const c = rollEncounterCheck(note.chance);
	const entry: RollEntry = { at: Date.now(), regionId: region.id, line: `${region.name}: check ${formatChance(note.chance)}, rolled ${c.roll}: ${c.hit ? 'encounter' : 'nothing'}`, detail: [] };
	record(index, entry);
	if (!c.hit) {
		new Notice(entry.line, 5000);
		return entry;
	}
	return rollFrom(index, region, note) ?? entry;
}

/** The entry as plain text, for the clipboard or a note. */
export function entryText(e: RollEntry): string {
	return [e.line, ...e.detail.map((d) => `  ${d}`)].join('\n');
}

const time = (at: number) => {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The session note: the newest note in the map's "GM notes" section. */
export function sessionNote(app: App, index: TFile): TFile | null {
	const sections = sectionsOf(app, index) ?? [...DEFAULT_SECTIONS];
	const s = sections.find((x) => x.name.toLowerCase() === 'gm notes');
	if (!s) return null;
	const notes = notesInFolder(app, s.folder);
	return notes.reduce<TFile | null>((best, f) => (!best || f.stat.ctime > best.stat.ctime ? f : best), null);
}

/** Add [e] at the end of the session note, as a list item. */
export function addToSessionNote(app: App, index: TFile, e: RollEntry): Promise<boolean> {
	return appendToSessionNote(app, index, e.line, e.detail, e.at);
}

/** Add `- HH:MM · [line]` (and [detail] under it) at the end of the session
 *  note. False, with a notice, when there is none. */
export async function appendToSessionNote(app: App, index: TFile, line: string, detail: string[] = [], at = Date.now()): Promise<boolean> {
	const note = sessionNote(app, index);
	if (!note) {
		new Notice('No session note yet: create one from the notes button in the top bar.');
		return false;
	}
	const lines = [`- ${time(at)} · ${line}`, ...detail.map((d) => `    - ${d}`)].join('\n');
	await app.vault.process(note, (text) => (text.trim() ? `${text.replace(/\n*$/, '\n')}${lines}\n` : `${lines}\n`));
	new Notice(`Added to “${note.basename}”.`);
	return true;
}
