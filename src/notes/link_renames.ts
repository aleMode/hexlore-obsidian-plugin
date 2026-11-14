// The renames of this session, so a link text kept for later (an undo
// snapshot) can find its note after the note moved. Obsidian rewrites the
// links in the index when a note is renamed, but not the copies held in the
// undo history: undoing a delete would bring back `Fort` after Fort.md became
// Places/Old fort.md. Pure: the plugin feeds it the vault's rename events.

/** The path part of a link text: `Fort#Gate|the fort` → `Fort`. */
export const linkPathOf = (link: string): string => link.split('|')[0]!.split('#')[0]!.trim();

/** [link] pointing at [linkpath] instead, keeping its heading and alias. */
export function withLinkPath(link: string, linkpath: string): string {
	const rest = link.slice(link.split('|')[0]!.split('#')[0]!.length);
	return `${linkpath}${rest}`;
}

const MAX = 500;

export class RenameLog {
	/** Oldest first: [old path, new path]. */
	private entries: [string, string][] = [];

	record(oldPath: string, newPath: string): void {
		this.entries.push([oldPath, newPath]);
		if (this.entries.length > MAX) this.entries.splice(0, this.entries.length - MAX);
	}

	/** Where the note [link] pointed at before a rename is now, or null when
	 *  no rename matches. A link names a path, or its end (`Fort`,
	 *  `Places/Fort`), with or without `.md`; a folder renamed is followed
	 *  too. The newest matching rename wins; later renames are chained. */
	follow(link: string): string | null {
		const lp = linkPathOf(link);
		if (!lp) return null;
		const target = /\.[^/.]+$/.test(lp) ? lp : `${lp}.md`;
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const [from, to] = this.entries[i]!;
			const moved = movedPath(from, to, target);
			if (moved !== null) return this.chain(moved, i + 1);
		}
		return null;
	}

	private chain(path: string, start: number): string {
		let p = path;
		for (let i = start; i < this.entries.length; i++) {
			const [from, to] = this.entries[i]!;
			const moved = movedPath(from, to, p, true);
			if (moved !== null) p = moved;
		}
		return p;
	}
}

/** [target] after [from] became [to]: the file itself, or a file under a
 *  renamed folder. With [exact] false, [target] may be the END of the old
 *  path (a link names the shortest unambiguous path). */
function movedPath(from: string, to: string, target: string, exact = false): string | null {
	if (from === target) return to;
	if (target.startsWith(`${from}/`)) return `${to}${target.slice(from.length)}`;
	if (exact) return null;
	if (from.endsWith(`/${target}`)) return to;
	// A renamed folder whose end is the start of the link: `Places/Fort`
	// after `Campaign/Places` became `Campaign/Sites`.
	const parts = target.split('/');
	for (let k = 1; k < parts.length; k++) {
		const head = parts.slice(0, k).join('/');
		if (from.endsWith(`/${head}`)) return `${to}/${parts.slice(k).join('/')}`;
	}
	return null;
}
