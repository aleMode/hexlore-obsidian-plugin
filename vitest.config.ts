import { defineConfig } from 'vitest/config';
import { scopedVitePlugin } from './scripts/scoped.mjs';

export default defineConfig({
	plugins: [scopedVitePlugin],
	test: {
		include: ['test/**/*.test.ts'],
	},
});
