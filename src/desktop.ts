// Node's built-in modules, on desktop only, loaded when first needed. The
// manifest says `isDesktopOnly: true` (design §1.1), but loading them lazily
// keeps a way back to mobile and is the one way that works (below).
//
// Obsidian runs the plugin as CommonJS: they come from `require`. A dynamic
// `import('http')` is NOT an alternative there — esbuild keeps it as written
// and Electron's renderer cannot resolve a bare "http", so the promise rejects
// and the feature silently does nothing. `import()` is only the fallback for
// the tests, which run the sources as ES modules under Node.

import { Platform } from 'obsidian';

interface NodeModules {
	fs: typeof import('fs');
	http: typeof import('http');
	os: typeof import('os');
}

/** The Node module [name], or null on a phone or tablet. */
export async function nodeModule<K extends keyof NodeModules>(name: K): Promise<NodeModules[K] | null> {
	if (Platform.isDesktop && Platform.isDesktopApp) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Obsidian's CommonJS wrapper provides `require`
		if (typeof require === 'function') return require(name) as NodeModules[K];
		// The tests' way in: literal specifiers, never reached inside Obsidian.
		const imports: { [M in keyof NodeModules]: () => Promise<NodeModules[M]> } = { fs: () => import('fs'), http: () => import('http'), os: () => import('os') };
		return imports[name]();
	}
	return null;
}
