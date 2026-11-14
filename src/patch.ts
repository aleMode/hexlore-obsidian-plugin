// Wrapping a method another plugin may wrap too (the pattern of the
// `monkey-around` package). Undoing it must not undo anyone else's: if a
// later wrapper sits on top of ours, putting the original back would remove
// it until Obsidian restarts. So ours turns into a pass-through instead, and
// is taken out only while it is still the outermost.

/** Replace `obj[key]` by `wrap(next)`, where `next` is the method it
 *  replaced. Returns the undo. */
export function around<T extends object, K extends keyof T>(obj: T, key: K, wrap: (next: T[K]) => T[K]): () => void {
	const had = Object.prototype.hasOwnProperty.call(obj, key);
	const next = obj[key];
	const inner = wrap(next) as unknown as (...args: unknown[]) => unknown;
	let active = true;
	const wrapper = function (this: unknown, ...args: unknown[]): unknown {
		return (active ? inner : (next as unknown as (...a: unknown[]) => unknown)).apply(this, args);
	};
	obj[key] = wrapper as unknown as T[K];
	return () => {
		if (!active) return;
		active = false;
		if (obj[key] !== (wrapper as unknown)) return;
		if (had) obj[key] = next;
		else delete obj[key];
	};
}
