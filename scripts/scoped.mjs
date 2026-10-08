// Bundles a vendored page script (vendor/player/*.js) as a module.
//
// Those scripts hang their tables on `globalThis` (the player page loads them
// as <script> tags). `import load from '…/x.js?scoped'` wraps one in a
// function whose `globalThis` parameter the caller supplies — a private
// object — so the plugin never touches Obsidian's window, and nothing is
// evaluated at runtime (src/render/vendor.ts). The script text is unchanged.
// Shared by esbuild (the plugin build) and Vitest (the tests).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const SCOPED_SUFFIX = '?scoped';

/** The wrapped module source. */
export async function scopedSource(file) {
	const src = await readFile(file, 'utf8');
	return `export default function (globalThis, module, require) {\n${src}\n}\n`;
}

/** The esbuild plugin. */
export const scopedEsbuildPlugin = {
	name: 'scoped',
	setup(build) {
		build.onResolve({ filter: /\?scoped$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.slice(0, -SCOPED_SUFFIX.length)),
			namespace: 'scoped',
		}));
		build.onLoad({ filter: /.*/, namespace: 'scoped' }, async (args) => ({
			contents: await scopedSource(args.path),
			loader: 'js',
			watchFiles: [args.path],
		}));
	},
};

/** The same, as a Vite plugin for Vitest. */
export const scopedVitePlugin = {
	name: 'scoped',
	enforce: 'pre',
	async load(id) {
		if (!id.endsWith(SCOPED_SUFFIX)) return null;
		return scopedSource(id.slice(0, -SCOPED_SUFFIX.length));
	},
};
