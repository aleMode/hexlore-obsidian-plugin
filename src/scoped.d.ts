// esbuild's `scoped` plugin (scripts/scoped.mjs): a vendored page script
// wrapped in a function whose arguments replace the globals it reads; the
// first is the object it hangs its tables on.
declare module '*?scoped' {
	const load: (globalThis: Record<string, unknown>, ...rest: unknown[]) => unknown;
	export default load;
}
