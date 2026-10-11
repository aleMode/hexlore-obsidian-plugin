// The `.hexmap.md` index names its data folder RELATIVE to its own folder:
// `data:` in the frontmatter, defaulting to `<Name>.hexlore`. A rename in
// Obsidian — of the data folder, or of the index — breaks that link unless
// `data:` is rewritten; Obsidian only updates wikilinks, and `data:` is a
// plain path. Pure: the plugin applies what this works out.

/** The folder holding [path] ('' for the vault root). */
export function parentOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** The data folder an index at [indexPath] names with [data] (its
 *  frontmatter value, or undefined for the default). */
export function dataFolderFor(indexPath: string, data: string | undefined): string {
	const base = (indexPath.split('/').pop() ?? '').replace(/\.md$/, '').replace(/\.hexmap$/, '');
	const value = data ? data : `${base}.hexlore`;
	const parent = parentOf(indexPath);
	return parent ? `${parent}/${value}` : value;
}

/** The `data:` value that makes an index at [indexPath] name [dataPath], or
 *  null when it cannot (the folder is not inside the index's folder:
 *  `data:` does not climb with `..`). */
export function dataValueFor(indexPath: string, dataPath: string): string | null {
	const parent = parentOf(indexPath);
	if (!parent) return dataPath;
	return dataPath.startsWith(`${parent}/`) ? dataPath.slice(parent.length + 1) : null;
}

/** What to do after a rename, for one index: the new `data:` value, the
 *  sentence to tell the GM when the link cannot be kept, or nothing. */
export type DataLinkFix = { data: string } | { problem: string } | null;

/** The data folder [from] was renamed to [to]; the index at [indexPath]
 *  (which did not move) has `data:` = [data]. */
export function afterFolderRename(indexPath: string, data: string | undefined, from: string, to: string): DataLinkFix {
	const current = dataFolderFor(indexPath, data);
	const moved = current === from ? to : current.startsWith(`${from}/`) ? to + current.slice(from.length) : null;
	if (moved === null) return null;
	const value = dataValueFor(indexPath, moved);
	if (value === null) return { problem: `“${indexPath}” can no longer find its map: its data folder moved to “${moved}”, outside the index's folder. Move it back next to the index.` };
	return value === data ? null : { data: value };
}

/** The index was renamed or moved from [oldPath] to [newPath] with `data:` =
 *  [data]; [exists] says whether a folder is there. The data folder did not
 *  move, so `data:` must now name it from the new place. */
export function afterIndexRename(oldPath: string, newPath: string, data: string | undefined, exists: (path: string) => boolean): DataLinkFix {
	const was = dataFolderFor(oldPath, data);
	const now = dataFolderFor(newPath, data);
	if (was === now || !exists(was) || exists(now)) return null;
	const value = dataValueFor(newPath, was);
	if (value === null) return { problem: `“${newPath}” can no longer find its map: its data folder “${was}” is not inside the index's new folder. Move the index back, or move the folder next to it.` };
	return { data: value };
}
