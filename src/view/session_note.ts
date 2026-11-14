// The session note (the newest note in the map's GM notes section) and its
// log: rolls, trips and reveals land under "## Session log", one timestamped
// list item each (notes/session_log.ts does the text). Writes to one note go
// one after another, so lines stay in the order things happened.

import { Notice, type App, type TFile } from 'obsidian';
import { appendToLog } from '../notes/session_log';
import { DEFAULT_SECTIONS } from '../storage/hexmap_index';
import { sectionsOf } from '../storage/index_file';
import { notesInFolder } from './vault_notes';

/** Whether events are logged on their own (the "Session log" setting);
 *  main.ts points it at the settings. */
export const sessionLog = { enabled: (): boolean => true };

/** The session note: the newest note in the map's "GM notes" section. */
export function sessionNote(app: App, index: TFile): TFile | null {
	const sections = sectionsOf(app, index) ?? [...DEFAULT_SECTIONS];
	const s = sections.find((x) => x.name.toLowerCase() === 'gm notes');
	if (!s) return null;
	const notes = notesInFolder(app, s.folder);
	return notes.reduce<TFile | null>((best, f) => (!best || f.stat.ctime > best.stat.ctime ? f : best), null);
}

export const clock = (at: number): string => {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const queues = new Map<string, Promise<unknown>>();
/** Maps already told they have no session note (said once per session). */
const warned = new Set<string>();

/** Add `- HH:MM · [line]` (and [detail] under it) to the session note's
 *  log. [notify]: say where it went, or that there is no session note
 *  (otherwise that is said once per map and session). */
export function writeToSessionLog(app: App, index: TFile, line: string, detail: string[] = [], at = Date.now(), notify = false): Promise<boolean> {
	const note = sessionNote(app, index);
	if (!note) {
		if (notify || !warned.has(index.path)) {
			warned.add(index.path);
			new Notice('No session note yet, so nothing is logged: create one from the session notes button in the top bar.', 8000);
		}
		return Promise.resolve(false);
	}
	const lines = [`- ${clock(at)} · ${line}`, ...detail.map((d) => `    - ${d}`)];
	const prev = queues.get(note.path) ?? Promise.resolve();
	const next = prev
		.catch(() => undefined)
		.then(() => app.vault.process(note, (text) => appendToLog(text, lines)))
		.then(() => {
			if (notify) new Notice(`Added to “${note.basename}”.`);
			return true;
		});
	queues.set(note.path, next);
	return next;
}

/** Log an event on its own, when the "Session log" setting is on. */
export function logEvent(app: App, index: TFile, line: string, detail: string[] = []): Promise<boolean> {
	if (!sessionLog.enabled()) return Promise.resolve(false);
	return writeToSessionLog(app, index, line, detail).catch(() => false);
}
