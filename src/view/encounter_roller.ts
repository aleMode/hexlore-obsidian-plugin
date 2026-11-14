// Rolling a region's encounters, from the map panel or the hex menu, and
// what becomes of the result: a short history per map (this session only)
// and a line in the session log (view/session_note.ts). The tables are read by
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
import { logEvent, writeToSessionLog } from './session_note';
import { resolveLink } from './vault_notes';

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
	return rollFrom(app, index, region, note, table);
}

/** [check]: the encounter check that led here ("2 in 6, rolled 1"), told in
 *  the same log line. */
function rollFrom(app: App, index: TFile, region: RegionRef, note: RegionNote, table?: string, check?: string): RollEntry | null {
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
	void logEvent(app, index, `Encounter${check ? ` (check ${check})` : ''}: ${entry.line}`, entry.detail);
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
		void logEvent(app, index, entry.line);
		new Notice(entry.line, 5000);
		return entry;
	}
	return rollFrom(app, index, region, note, undefined, `${formatChance(note.chance)}, rolled ${c.roll}`) ?? entry;
}

/** The entry as plain text, for the clipboard or a note. */
export function entryText(e: RollEntry): string {
	return [e.line, ...e.detail.map((d) => `  ${d}`)].join('\n');
}

/** Add [e] to the session note's log, saying where it went (the rolls
 *  list's button, shown when the log is not kept on its own). */
export function addToSessionNote(app: App, index: TFile, e: RollEntry): Promise<boolean> {
	return writeToSessionLog(app, index, e.line, e.detail, e.at, true);
}
