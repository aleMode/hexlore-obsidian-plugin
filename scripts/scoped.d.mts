import type { Plugin as EsbuildPlugin } from 'esbuild';
import type { Plugin as VitePlugin } from 'vite';

export const SCOPED_SUFFIX: string;
export function scopedSource(file: string): Promise<string>;
export const scopedEsbuildPlugin: EsbuildPlugin;
export const scopedVitePlugin: VitePlugin;
export const rawEsbuildPlugin: EsbuildPlugin;
