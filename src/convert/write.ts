// Writing a planned Flutter campaign to disk (plan item 2.7). Node's `fs`
// is handed in: the export is desktop only, and the target folder is
// OUTSIDE the vault (docs/converter.md §5), so the Vault API cannot reach it.

/** The folders a Flutter export owns: files in them that the new export
 *  does not write are left from an earlier one, and go. */
const OWNED = ['pages', 'npcs', 'quests', 'adventures', 'paint'];

export type Fs = typeof import('fs');

/** What is at [dir]: nothing, an earlier export of this plugin (it has a
 *  round-trip manifest), or something else (a campaign made in HexLore, or
 *  any other folder). */
export function folderState(fs: Fs, dir: string): 'empty' | 'export' | 'other' {
	if (!fs.existsSync(dir)) return 'empty';
	const names = fs.readdirSync(dir);
	if (!names.length) return 'empty';
	return names.includes('roundtrip.json') ? 'export' : 'other';
}

/** Write [files] (campaign-relative path → text) under [dir], each through
 *  a temp file + rename, and remove what an earlier export left in the
 *  folders it owns. Returns how many files were written. */
export function writeFlutterCampaign(fs: Fs, dir: string, files: Map<string, string>): number {
	const join = (...parts: string[]) => parts.join('/');
	fs.mkdirSync(dir, { recursive: true });
	for (const [rel, text] of files) {
		const out = join(dir, rel);
		fs.mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
		const tmp = `${out}.tmp`;
		fs.writeFileSync(tmp, text, 'utf8');
		fs.renameSync(tmp, out);
	}
	const keep = new Set(files.keys());
	const sweep = (rel: string) => {
		const abs = join(dir, rel);
		if (!fs.existsSync(abs)) return;
		for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = join(rel, e.name);
			if (e.isDirectory()) sweep(child);
			else if (!keep.has(child)) fs.unlinkSync(join(dir, child));
		}
	};
	for (const d of OWNED) sweep(d);
	return files.size;
}

/** Why [dir] cannot take the export, or null. Inside the vault only a dot
 *  folder will do: Obsidian ignores those, else the pages show up as notes. */
export function folderProblem(dir: string, base: string | null): string | null {
	const d = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	if (!d || !/^(\/|[A-Za-z]:\/)/.test(d)) return 'Give a full path (starting with / or a drive letter).';
	if (base && (d === base || d.startsWith(`${base}/`))) {
		const inside = d.slice(base.length + 1).split('/');
		if (!inside.some((seg) => seg.startsWith('.'))) return 'That folder is inside the vault: its pages would show up as notes. Pick one outside (or a dot-folder).';
	}
	return null;
}
