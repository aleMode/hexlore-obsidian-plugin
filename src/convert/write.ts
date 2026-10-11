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

export interface WriteResult {
	/** Files written. */
	written: number;
	/** Files the export no longer has, MOVED (never deleted) into [backupDir]. */
	setAside: number;
	/** Where they went; null when nothing was set aside. */
	backupDir: string | null;
}

// A window's timer under Obsidian; no wait at all under the tests (Node).
const wait = (ms: number) => new Promise<void>((r) => (typeof window === 'undefined' ? r() : window.setTimeout(r, ms)));

/** Rename [from] onto [to], retrying a refused rename a few times: Windows
 *  answers EPERM / EBUSY while an antivirus or an indexer holds a file that
 *  was just written (Flutter's `renameRetrying`). */
export async function renameRetrying(fs: Fs, from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
			await wait(25 * (attempt + 1));
		}
	}
}

/** Write [files] (campaign-relative path → text) under [dir], each through
 *  a temp file + rename. Files an earlier export left in the folders it owns
 *  are SET ASIDE in a sibling folder ([backupDir], made only when needed):
 *  what the export replaces may have been edited in HexLore since, and a
 *  delete here could not be undone. */
export async function writeFlutterCampaign(
	fs: Fs,
	dir: string,
	files: Map<string, string>,
	backupDir: string = `${dir} (replaced ${stamp(new Date())})`,
): Promise<WriteResult> {
	const join = (...parts: string[]) => parts.join('/');
	fs.mkdirSync(dir, { recursive: true });
	for (const [rel, text] of files) {
		const out = join(dir, rel);
		fs.mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
		const tmp = `${out}.tmp`;
		fs.writeFileSync(tmp, text, 'utf8');
		await renameRetrying(fs, tmp, out);
	}
	const keep = new Set(files.keys());
	let setAside = 0;
	const sweep = async (rel: string) => {
		const abs = join(dir, rel);
		if (!fs.existsSync(abs)) return;
		for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = join(rel, e.name);
			if (e.isDirectory()) await sweep(child);
			else if (!keep.has(child)) {
				const to = join(backupDir, child);
				fs.mkdirSync(to.slice(0, to.lastIndexOf('/')), { recursive: true });
				await renameRetrying(fs, join(dir, child), to);
				setAside++;
			}
		}
	};
	for (const d of OWNED) await sweep(d);
	return { written: files.size, setAside, backupDir: setAside ? backupDir : null };
}

function stamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** Why [dir] cannot take the export, or null. Inside the vault only a dot
 *  folder will do: Obsidian ignores those, else the pages show up as notes. */
export function folderProblem(dir: string, base: string | null): string | null {
	const d = dir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	if (/^[A-Za-z]:$/.test(d) || (dir.trim() !== '' && d === '')) return 'Pick a folder, not the root of a drive.';
	if (!d || !/^(\/|[A-Za-z]:\/)/.test(d)) return 'Give a full path (starting with / or a drive letter).';
	if (base && (d === base || d.startsWith(`${base}/`))) {
		const inside = d.slice(base.length + 1).split('/');
		if (!inside.some((seg) => seg.startsWith('.'))) return 'That folder is inside the vault: its pages would show up as notes. Pick one outside (or a dot-folder).';
	}
	return null;
}
