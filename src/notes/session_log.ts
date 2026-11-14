// The session log: a section of the session note that rolls, trips and
// reveals are appended to, one timestamped list item each. Pure: the text in,
// the text out (written through `vault.process`).

/** The log's heading in the session note. */
export const SESSION_LOG_HEADING = 'Session log';

/** [text] with [lines] added at the end of its `## Session log` section,
 *  which is created at the end of the note when missing. The section ends
 *  at the next heading of level 1 or 2. */
export function appendToLog(text: string, lines: string[], heading = SESSION_LOG_HEADING): string {
	const block = lines.join('\n');
	const all = text.split('\n');
	const want = heading.trim().toLowerCase();
	const start = all.findIndex((l) => {
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
		return !!m && m[1]!.length === 2 && m[2]!.toLowerCase() === want;
	});
	if (start < 0) {
		const body = text.replace(/\s*$/, '');
		return `${body ? `${body}\n\n` : ''}## ${heading}\n\n${block}\n`;
	}
	let end = all.length;
	for (let i = start + 1; i < all.length; i++) {
		if (/^#{1,2}\s/.test(all[i]!)) {
			end = i;
			break;
		}
	}
	// After the section's last non-blank line.
	let at = end;
	while (at > start + 1 && !all[at - 1]!.trim()) at--;
	const head = all.slice(0, at);
	if (at === start + 1) head.push(''); // a blank line under the heading
	const rest = all.slice(at).join('\n').replace(/^\n+/, '').replace(/\n*$/, '');
	return `${[...head, block].join('\n')}\n${rest ? `\n${rest}\n` : ''}`;
}
