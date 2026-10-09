import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { scopedVitePlugin } from './scripts/scoped.mjs';

export default defineConfig({
	plugins: [scopedVitePlugin],
	resolve: {
		// The view smoke tests run the views against a stand-in for Obsidian.
		alias: { obsidian: fileURLToPath(new URL('./test/mocks/obsidian.ts', import.meta.url)) },
	},
	test: {
		include: ['test/**/*.test.ts'],
	},
});
