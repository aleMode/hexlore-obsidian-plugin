// Port of Flutter's app/undo.dart (decision 9): commands are model + disk
// only; `push` records an edit ALREADY applied (it does not run it); undo
// reverses, redo re-runs. One entry per gesture.
//
// Plugin addition (plan 2.2): every command lists the FILES it touches, so
// when one of them changes on disk under it, the entries that touched it are
// dropped — undoing them would write over what came from outside.

export const MAX_UNDO = 200;

export interface Command {
	label: string;
	run: () => void;
	undo: () => void;
	/** Data-folder-relative paths this edit writes. */
	touches: ReadonlySet<string>;
	/** Consecutive commands with the same id merge into one entry. */
	mergeId?: string | null;
}

export class UndoStack {
	private undoList: Command[] = [];
	private redoList: Command[] = [];

	get canUndo(): boolean {
		return this.undoList.length > 0;
	}
	get canRedo(): boolean {
		return this.redoList.length > 0;
	}
	get nextUndoLabel(): string | null {
		return this.undoList[this.undoList.length - 1]?.label ?? null;
	}
	get nextRedoLabel(): string | null {
		return this.redoList[this.redoList.length - 1]?.label ?? null;
	}

	push(c: Command): void {
		this.redoList = [];
		const last = this.undoList[this.undoList.length - 1];
		if (c.mergeId && last && last.mergeId === c.mergeId) {
			last.run = c.run;
			return;
		}
		this.undoList.push(c);
		if (this.undoList.length > MAX_UNDO) this.undoList.shift();
	}

	breakMerge(): void {
		const last = this.undoList[this.undoList.length - 1];
		if (last) last.mergeId = null;
	}

	undo(): string | null {
		const c = this.undoList.pop();
		if (!c) return null;
		c.undo();
		this.redoList.push(c);
		return c.label;
	}

	redo(): string | null {
		const c = this.redoList.pop();
		if (!c) return null;
		c.run();
		this.undoList.push(c);
		return c.label;
	}

	/** Drop every entry touching one of [paths]; how many went. */
	dropTouching(paths: Iterable<string>): number {
		const set = new Set(paths);
		const keep = (c: Command) => ![...c.touches].some((p) => set.has(p));
		const before = this.undoList.length + this.redoList.length;
		this.undoList = this.undoList.filter(keep);
		this.redoList = this.redoList.filter(keep);
		return before - this.undoList.length - this.redoList.length;
	}

	clear(): void {
		this.undoList = [];
		this.redoList = [];
	}
}
