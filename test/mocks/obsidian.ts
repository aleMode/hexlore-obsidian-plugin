// A stand-in for the `obsidian` module (aliased in vitest.config.ts) for the
// view smoke tests: an in-memory vault, a metadata cache over its notes'
// frontmatter, a workspace of leaves, and the UI classes the plugin uses,
// with just enough behaviour to run its views and dialogs under jsdom. Not a
// fidelity model of Obsidian: it catches crashes and broken wiring.

import { parseFrontmatter, resolver } from '../helpers/vault_folder';

export const apiVersion = '1.13.1';
export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false };

export function normalizePath(p: string): string {
	const out = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
	return out || '/';
}

export function setIcon(el: HTMLElement, name: string): void {
	el.dataset.icon = name;
}

export function setTooltip(el: HTMLElement, text: string): void {
	el.setAttribute('aria-label', text);
}

export function moment(): { format: (f: string) => string } {
	return { format: () => '2026-10-09' };
}

export function parseYaml(text: string): unknown {
	return parseFrontmatter(`---\n${text}\n---\n`);
}

// ----- events ---------------------------------------------------------------------

export interface EventRef {
	e: Events;
	name: string;
	fn: (...a: unknown[]) => unknown;
}

export class Events {
	private handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
	on(name: string, fn: (...a: unknown[]) => unknown): EventRef {
		(this.handlers.get(name) ?? this.handlers.set(name, []).get(name)!).push(fn);
		return { e: this, name, fn };
	}
	offref(ref: EventRef): void {
		const list = this.handlers.get(ref.name);
		if (list) this.handlers.set(ref.name, list.filter((f) => f !== ref.fn));
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...args);
	}
}

export class Component {
	private cleanups: (() => void)[] = [];
	load(): void {}
	onload(): void {}
	unload(): void {
		for (const c of this.cleanups.splice(0)) c();
		this.onunload();
	}
	onunload(): void {}
	register(cb: () => void): void {
		this.cleanups.push(cb);
	}
	registerEvent(ref: EventRef): void {
		this.cleanups.push(() => ref.e.offref(ref));
	}
	registerDomEvent(el: EventTarget, type: string, cb: (e: Event) => void, opts?: AddEventListenerOptions): void {
		el.addEventListener(type, cb, opts);
		this.cleanups.push(() => el.removeEventListener(type, cb));
	}
	registerInterval(id: number): number {
		return id;
	}
	addChild<T extends Component>(c: T): T {
		return c;
	}
}

export class Scope {
	readonly keys: { modifiers: string[]; key: string; fn: (e: KeyboardEvent) => unknown }[] = [];
	constructor(readonly parent?: Scope) {}
	register(modifiers: string[], key: string, fn: (e: KeyboardEvent) => unknown) {
		const k = { modifiers, key, fn };
		this.keys.push(k);
		return k;
	}
	/** Test helper: run the handler of [key]. */
	press(key: string, modifiers: string[] = []): unknown {
		const k = this.keys.find((x) => x.key === key && x.modifiers.join() === modifiers.join());
		return k?.fn(new KeyboardEvent('keydown', { key }));
	}
}

// ----- files ------------------------------------------------------------------------

export class TAbstractFile {
	vault!: Vault;
	parent: TFolder | null = null;
	constructor(public path: string) {}
	get name(): string {
		return this.path.split('/').pop()!;
	}
}

export class TFile extends TAbstractFile {
	stat = { ctime: 0, mtime: 0, size: 0 };
	get basename(): string {
		return this.name.replace(/\.[^.]*$/, '');
	}
	get extension(): string {
		const m = /\.([^.]*)$/.exec(this.name);
		return m ? m[1]! : '';
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === '/';
	}
}

export class FileSystemAdapter {
	getBasePath(): string {
		return '/home/test/vault';
	}
}

export class Vault extends Events {
	readonly configDir = '.obsidian';
	private readonly root = new TFolder('/');
	private readonly files = new Map<string, TAbstractFile>();
	private readonly text = new Map<string, string | ArrayBuffer>();
	readonly adapter: FileSystemAdapter & {
		exists(p: string): Promise<boolean>;
		read(p: string): Promise<string>;
		write(p: string, t: string): Promise<void>;
		remove(p: string): Promise<void>;
		list(p: string): Promise<{ files: string[]; folders: string[] }>;
	};

	constructor(initial: Record<string, string> = {}) {
		super();
		this.root.vault = this;
		this.files.set('/', this.root);
		for (const [p, t] of Object.entries(initial)) this.put(p, t, false);
		const self = this;
		this.adapter = Object.assign(new FileSystemAdapter(), {
			exists: (p: string) => Promise.resolve(self.text.has(normalizePath(p)) || self.files.has(normalizePath(p))),
			read: (p: string) => {
				const t = self.text.get(normalizePath(p));
				return typeof t === 'string' ? Promise.resolve(t) : Promise.reject(new Error(`no file ${p}`));
			},
			write: (p: string, t: string) => {
				self.put(normalizePath(p), t, true);
				return Promise.resolve();
			},
			remove: (p: string) => {
				self.drop(normalizePath(p));
				return Promise.resolve();
			},
			list: (p: string) => {
				const dir = normalizePath(p);
				const f = self.files.get(dir);
				const kids = f instanceof TFolder ? f.children : [];
				return Promise.resolve({ files: kids.filter((k) => k instanceof TFile).map((k) => k.path), folders: kids.filter((k) => k instanceof TFolder).map((k) => k.path) });
			},
		});
	}

	private folder(path: string): TFolder {
		if (path === '/' || path === '') return this.root;
		const known = this.files.get(path);
		if (known instanceof TFolder) return known;
		const f = new TFolder(path);
		f.vault = this;
		const parent = this.folder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');
		f.parent = parent;
		parent.children.push(f);
		this.files.set(path, f);
		return f;
	}

	private put(path: string, t: string | ArrayBuffer, notify: boolean): TFile {
		let f = this.files.get(path);
		const created = !f;
		if (!(f instanceof TFile)) {
			f = new TFile(path);
			f.vault = this;
			const parent = this.folder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/');
			f.parent = parent;
			parent.children.push(f);
			this.files.set(path, f);
		}
		this.text.set(path, t);
		if (notify) this.trigger(created ? 'create' : 'modify', f);
		return f as TFile;
	}

	private drop(path: string): void {
		const f = this.files.get(path);
		this.text.delete(path);
		if (!f) return;
		this.files.delete(path);
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		this.trigger('delete', f);
	}

	getAbstractFileByPath(p: string): TAbstractFile | null {
		return this.files.get(normalizePath(p)) ?? null;
	}
	getRoot(): TFolder {
		return this.root;
	}
	read(f: TFile): Promise<string> {
		const t = this.text.get(f.path);
		return Promise.resolve(typeof t === 'string' ? t : '');
	}
	cachedRead(f: TFile): Promise<string> {
		return this.read(f);
	}
	modify(f: TFile, t: string): Promise<void> {
		this.put(f.path, t, true);
		return Promise.resolve();
	}
	async process(f: TFile, fn: (t: string) => string): Promise<string> {
		const next = fn(await this.read(f));
		this.put(f.path, next, true);
		return next;
	}
	/** Vault.rename: moves [f] (with everything under it, for a folder) and
	 *  fires `rename` for it, then for each descendant, as Obsidian does. */
	rename(f: TAbstractFile, to: string): Promise<void> {
		const from = f.path;
		const dest = normalizePath(to);
		const moved = [...this.files.values()].filter((x) => x === f || x.path.startsWith(`${from}/`));
		if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
		const events: [TAbstractFile, string][] = [];
		for (const x of moved) {
			const old = x.path;
			const next = dest + old.slice(from.length);
			this.files.delete(old);
			const t = this.text.get(old);
			this.text.delete(old);
			x.path = next;
			this.files.set(next, x);
			if (t !== undefined) this.text.set(next, t);
			events.push([x, old]);
		}
		const parent = this.folder(dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '/');
		f.parent = parent;
		parent.children.push(f);
		for (const [x, old] of events) this.trigger('rename', x, old);
		return Promise.resolve();
	}
	/** Permanent delete (Vault.delete); counted, so a test can tell it from
	 *  FileManager.trashFile. */
	deletes = 0;
	delete(f: TAbstractFile, _force?: boolean): Promise<void> {
		this.deletes++;
		this.drop(f.path);
		return Promise.resolve();
	}
	create(p: string, t: string): Promise<TFile> {
		const path = normalizePath(p);
		if (this.files.has(path)) return Promise.reject(new Error('File already exists.'));
		return Promise.resolve(this.put(path, t, true));
	}
	createBinary(p: string, data: ArrayBuffer): Promise<TFile> {
		return Promise.resolve(this.put(normalizePath(p), data, true));
	}
	createFolder(p: string): Promise<TFolder> {
		const path = normalizePath(p);
		if (this.files.has(path)) return Promise.reject(new Error('Folder already exists.'));
		return Promise.resolve(this.folder(path));
	}
	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === 'md');
	}
	getFiles(): TFile[] {
		return [...this.files.values()].filter((f): f is TFile => f instanceof TFile);
	}
	getAllLoadedFiles(): TAbstractFile[] {
		return [...this.files.values()];
	}
	getResourcePath(f: TFile): string {
		return `app://local/${f.path}`;
	}
	/** Test helper: a file's current text. */
	textOf(p: string): string | undefined {
		const t = this.text.get(normalizePath(p));
		return typeof t === 'string' ? t : undefined;
	}
}

export class MetadataCache extends Events {
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	constructor(private readonly vault: Vault) {
		super();
		vault.on('modify', (f) => this.trigger('changed', f));
		vault.on('create', (f) => this.trigger('changed', f));
	}
	getFileCache(f: TFile): { frontmatter?: Record<string, unknown> } | null {
		const t = this.vault.textOf(f.path);
		if (t === undefined || f.extension !== 'md') return null;
		const fm = parseFrontmatter(t);
		return fm ? { frontmatter: fm } : {};
	}
	getFirstLinkpathDest(link: string, source: string): TFile | null {
		const files = this.vault.getFiles().map((f) => f.path);
		const resolve = resolver(files.filter((p) => p.endsWith('.md')));
		const hit = resolve(link, source) ?? files.find((p) => p === link || p.endsWith(`/${link}`)) ?? null;
		return hit ? (this.vault.getAbstractFileByPath(hit) as TFile) : null;
	}
	fileToLinktext(f: TFile, _source: string, omitMd = true): string {
		const dupes = this.vault.getFiles().filter((x) => x.basename === f.basename);
		const base = dupes.length > 1 ? f.path : f.name;
		return omitMd ? base.replace(/\.md$/, '') : base;
	}
}

export class WorkspaceLeaf {
	view: View | null = null;
	opened: TFile[] = [];
	constructor(readonly workspace: Workspace) {}
	async setViewState(state: { type: string; active?: boolean; state?: unknown }): Promise<void> {
		const make = this.workspace.factories.get(state.type);
		if (make) {
			this.view = make(this);
			await this.view.onOpen();
			if (state.state) await this.view.setState(state.state, {});
		}
	}
	openFile(f: TFile): Promise<void> {
		this.opened.push(f);
		this.workspace.trigger('file-open', f);
		return Promise.resolve();
	}
	getViewState(): { type: string } {
		return { type: this.view?.getViewType() ?? 'empty' };
	}
	detach(): void {}
}

export class Workspace extends Events {
	readonly factories = new Map<string, (leaf: WorkspaceLeaf) => View>();
	readonly leaves: WorkspaceLeaf[] = [];
	activeLeaf: WorkspaceLeaf | null = null;
	activeFile: TFile | null = null;
	rightSplit = { collapsed: false, collapse() {}, expand() {} };
	leftSplit = { collapsed: false, collapse() {}, expand() {} };
	getActiveFile(): TFile | null {
		return this.activeFile;
	}
	getActiveViewOfType<T>(cls: new (...a: never[]) => T): T | null {
		const v = this.activeLeaf?.view;
		return v instanceof cls ? (v as T) : null;
	}
	getLeavesOfType(type: string): WorkspaceLeaf[] {
		return this.leaves.filter((l) => l.view?.getViewType() === type);
	}
	getLeaf(): WorkspaceLeaf {
		const leaf = new WorkspaceLeaf(this);
		this.leaves.push(leaf);
		return leaf;
	}
	getRightLeaf(): WorkspaceLeaf {
		return this.getLeaf();
	}
	getLeftLeaf(): WorkspaceLeaf {
		return this.getLeaf();
	}
	revealLeaf(): Promise<void> {
		return Promise.resolve();
	}
	requestSaveLayout(): void {}
	onLayoutReady(cb: () => void): void {
		cb();
	}
	openLinkText(): Promise<void> {
		return Promise.resolve();
	}
}

export class FileManager {
	constructor(private readonly app: App) {}
	async processFrontMatter(f: TFile, fn: (fm: Record<string, unknown>) => void): Promise<void> {
		const text = await this.app.vault.read(f);
		const fm = parseFrontmatter(text) ?? {};
		fn(fm);
		const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
		const yaml = Object.entries(fm)
			.map(([k, v]) => (Array.isArray(v) ? (v.length ? `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join('\n')}` : `${k}: []`) : `${k}: ${JSON.stringify(v)}`))
			.join('\n');
		await this.app.vault.modify(f, `---\n${yaml}\n---\n${body}`);
	}
	trashFile(f: TFile): Promise<void> {
		return this.app.vault.adapter.remove(f.path);
	}
}

export class App {
	readonly vault: Vault;
	readonly metadataCache: MetadataCache;
	readonly workspace = new Workspace();
	readonly fileManager: FileManager;
	readonly scope = new Scope();
	private local = new Map<string, unknown>();
	constructor(files: Record<string, string> = {}) {
		this.vault = new Vault(files);
		this.metadataCache = new MetadataCache(this.vault);
		this.fileManager = new FileManager(this);
	}
	loadLocalStorage(k: string): unknown {
		return this.local.get(k) ?? null;
	}
	saveLocalStorage(k: string, v: unknown): void {
		this.local.set(k, v);
	}
}

// ----- views ---------------------------------------------------------------------------

export class View extends Component {
	app: App;
	containerEl: HTMLElement;
	navigation = false;
	scope: Scope | null = null;
	readonly actions: { icon: string; title: string; el: HTMLElement; cb: (e: MouseEvent) => void }[] = [];
	constructor(readonly leaf: WorkspaceLeaf) {
		super();
		this.app = (leaf.workspace as unknown as { app?: App }).app ?? currentApp!;
		this.containerEl = document.body.createDiv({ cls: 'workspace-leaf-content' });
	}
	getViewType(): string {
		return '';
	}
	getDisplayText(): string {
		return '';
	}
	getIcon(): string {
		return '';
	}
	getState(): Record<string, unknown> {
		return {};
	}
	setState(_state: unknown, _result: unknown): Promise<void> {
		return Promise.resolve();
	}
	onOpen(): Promise<void> {
		return Promise.resolve();
	}
	onClose(): Promise<void> {
		return Promise.resolve();
	}
	onResize(): void {}
	onPaneMenu(_menu: Menu, _source: string): void {}
}

export class ItemView extends View {
	contentEl: HTMLElement;
	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
	}
	addAction(icon: string, title: string, cb: (e: MouseEvent) => void): HTMLElement {
		const el = this.containerEl.createDiv({ cls: 'view-action' });
		this.actions.push({ icon, title, el, cb });
		el.addEventListener('click', (e) => cb(e));
		return el;
	}
}

export class MarkdownView extends ItemView {
	file: TFile | null = null;
}

/** The App the next view or modal is built for (a test sets it). */
export let currentApp: App | null = null;
export function useApp(app: App): void {
	currentApp = app;
	(app.workspace as unknown as { app: App }).app = app;
}

export class Plugin extends Component {
	manifest = { id: 'hexlore', dir: '.obsidian/plugins/hexlore', version: '0.0.1' };
	constructor(readonly app: App) {
		super();
	}
	registerView(type: string, factory: (leaf: WorkspaceLeaf) => View): void {
		this.app.workspace.factories.set(type, factory);
	}
	addCommand(c: unknown): unknown {
		return c;
	}
	addSettingTab(): void {}
	addStatusBarItem(): HTMLElement {
		return document.body.createDiv();
	}
	registerHoverLinkSource(): void {}
	loadData(): Promise<unknown> {
		return Promise.resolve(null);
	}
	saveData(): Promise<void> {
		return Promise.resolve();
	}
}

// ----- UI -------------------------------------------------------------------------------

export class Notice {
	static readonly log: string[] = [];
	constructor(message: string | DocumentFragment) {
		Notice.log.push(typeof message === 'string' ? message : (message.textContent ?? ''));
	}
	setMessage(): this {
		return this;
	}
	hide(): void {}
}

export class MenuItem {
	title = '';
	disabled = false;
	click: (() => void) | null = null;
	setTitle(t: string): this {
		this.title = t;
		return this;
	}
	setIcon(): this {
		return this;
	}
	setDisabled(d: boolean): this {
		this.disabled = d;
		return this;
	}
	checked: boolean | null = null;
	isLabel = false;
	setChecked(c: boolean | null): this {
		this.checked = c;
		return this;
	}
	setIsLabel(l: boolean): this {
		this.isLabel = l;
		return this;
	}
	setSection(): this {
		return this;
	}
	onClick(fn: () => void): this {
		this.click = fn;
		return this;
	}
}

export class Menu {
	static last: Menu | null = null;
	readonly items: MenuItem[] = [];
	addItem(cb: (i: MenuItem) => void): this {
		const i = new MenuItem();
		cb(i);
		this.items.push(i);
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtMouseEvent(): this {
		Menu.last = this;
		return this;
	}
	showAtPosition(): this {
		Menu.last = this;
		return this;
	}
	/** Test helper. */
	choose(title: string): void {
		this.items.find((i) => i.title.startsWith(title))?.click?.();
	}
}

export class Modal {
	static open: Modal[] = [];
	app: App;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	scope = new Scope();
	constructor(app: App) {
		this.app = app;
		this.containerEl = document.createElement('div');
		this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
		this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
		this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
	}
	setTitle(t: string): this {
		this.titleEl.textContent = t;
		return this;
	}
	open(): void {
		document.body.appendChild(this.containerEl);
		Modal.open.push(this);
		this.onOpen();
	}
	close(): void {
		this.onClose();
		this.containerEl.remove();
		Modal.open = Modal.open.filter((m) => m !== this);
	}
	onOpen(): void {}
	onClose(): void {}
}

export abstract class FuzzySuggestModal<T> extends Modal {
	setPlaceholder(): void {}
	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt?: MouseEvent | KeyboardEvent): void;
}

export abstract class SuggestModal<T> extends Modal {
	setPlaceholder(): void {}
	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract onChooseSuggestion(item: T, evt?: MouseEvent | KeyboardEvent): void;
}

export class AbstractInputSuggest<T> {
	constructor(
		readonly app: App,
		readonly inputEl: HTMLInputElement,
	) {}
	setValue(v: string): void {
		this.inputEl.value = v;
	}
	close(): void {}
	protected getSuggestions(_q: string): T[] | Promise<T[]> {
		return [];
	}
}

class BaseComponent {
	disabled = false;
	setDisabled(d: boolean): this {
		this.disabled = d;
		return this;
	}
}

class ValueComponent<V> extends BaseComponent {
	protected value!: V;
	protected changed: ((v: V) => unknown) | null = null;
	getValue(): V {
		return this.value;
	}
	setValue(v: V): this {
		this.value = v;
		return this;
	}
	onChange(fn: (v: V) => unknown): this {
		this.changed = fn;
		return this;
	}
	/** Test helper: as if the user changed it. */
	change(v: V): unknown {
		this.setValue(v);
		return this.changed?.(v);
	}
}

export class ButtonComponent extends BaseComponent {
	readonly buttonEl: HTMLButtonElement;
	private clickFn: ((e: MouseEvent) => unknown) | null = null;
	constructor(parent: HTMLElement) {
		super();
		this.buttonEl = parent.createEl('button') as HTMLButtonElement;
		this.buttonEl.addEventListener('click', (e) => {
			if (!this.disabled) void this.clickFn?.(e);
		});
	}
	setButtonText(t: string): this {
		this.buttonEl.textContent = t;
		return this;
	}
	setCta(): this {
		return this;
	}
	setWarning(): this {
		return this;
	}
	setDestructive(): this {
		return this;
	}
	setTooltip(): this {
		return this;
	}
	setIcon(): this {
		return this;
	}
	onClick(fn: (e: MouseEvent) => unknown): this {
		this.clickFn = fn;
		return this;
	}
}

export class ExtraButtonComponent extends ButtonComponent {}

export class TextComponent extends ValueComponent<string> {
	readonly inputEl: HTMLInputElement;
	constructor(parent: HTMLElement) {
		super();
		this.inputEl = parent.createEl('input', { type: 'text' }) as HTMLInputElement;
		this.value = '';
		this.inputEl.addEventListener('input', () => {
			this.value = this.inputEl.value;
			void this.changed?.(this.value);
		});
	}
	setValue(v: string): this {
		this.value = v;
		this.inputEl.value = v;
		return this;
	}
	getValue(): string {
		return this.inputEl.value;
	}
	setPlaceholder(): this {
		return this;
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	readonly toggleEl: HTMLElement;
	constructor(parent: HTMLElement) {
		super();
		this.toggleEl = parent.createDiv({ cls: 'checkbox-container' });
		this.value = false;
	}
	setTooltip(): this {
		return this;
	}
}

export class DropdownComponent extends ValueComponent<string> {
	readonly selectEl: HTMLSelectElement;
	readonly options: [string, string][] = [];
	constructor(parent: HTMLElement) {
		super();
		this.selectEl = parent.createEl('select') as HTMLSelectElement;
		this.value = '';
	}
	addOption(v: string, label: string): this {
		this.options.push([v, label]);
		this.selectEl.createEl('option', { text: label, value: v });
		return this;
	}
	addOptions(o: Record<string, string>): this {
		for (const [k, v] of Object.entries(o)) this.addOption(k, v);
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	readonly sliderEl: HTMLInputElement;
	constructor(parent: HTMLElement) {
		super();
		this.sliderEl = parent.createEl('input', { type: 'range' }) as HTMLInputElement;
		this.value = 0;
	}
	setLimits(): this {
		return this;
	}
	setDynamicTooltip(): this {
		return this;
	}
}

export class ColorComponent extends ValueComponent<string> {
	constructor(parent: HTMLElement) {
		super();
		parent.createEl('input', { type: 'color' });
		this.value = '#000000';
	}
}

export class Setting {
	static all: Setting[] = [];
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	readonly components: unknown[] = [];
	constructor(container: HTMLElement) {
		this.settingEl = container.createDiv({ cls: 'setting-item' });
		this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
		this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
		Setting.all.push(this);
	}
	setName(n: string | DocumentFragment): this {
		this.nameEl.textContent = typeof n === 'string' ? n : (n.textContent ?? '');
		return this;
	}
	setDesc(d: string | DocumentFragment): this {
		this.descEl.textContent = typeof d === 'string' ? d : (d.textContent ?? '');
		return this;
	}
	setHeading(): this {
		return this;
	}
	setClass(c: string): this {
		this.settingEl.addClass(c);
		return this;
	}
	setTooltip(): this {
		return this;
	}
	private add<C>(c: C, cb: (c: C) => unknown): this {
		this.components.push(c);
		cb(c);
		return this;
	}
	/** As Obsidian's: `cb(this)`, then `this`. It makes a Setting a THENABLE:
	 *  a promise resolved with one (`p.then(() => row.setDesc(…))`) calls
	 *  it again and again, in microtasks, and Obsidian freezes. Here a run of
	 *  calls with no timer in between throws instead, so the test fails. */
	private static thenRun = 0;
	then(cb: (s: this) => unknown): this {
		if (Setting.thenRun++ === 0) setTimeout(() => (Setting.thenRun = 0));
		if (Setting.thenRun > 1000) throw new Error('A Setting was used as a promise value: Setting.then makes Obsidian loop forever');
		cb(this);
		return this;
	}
	addButton(cb: (b: ButtonComponent) => unknown): this {
		return this.add(new ButtonComponent(this.controlEl), cb);
	}
	addExtraButton(cb: (b: ExtraButtonComponent) => unknown): this {
		return this.add(new ExtraButtonComponent(this.controlEl), cb);
	}
	addText(cb: (t: TextComponent) => unknown): this {
		return this.add(new TextComponent(this.controlEl), cb);
	}
	addToggle(cb: (t: ToggleComponent) => unknown): this {
		return this.add(new ToggleComponent(this.controlEl), cb);
	}
	addDropdown(cb: (d: DropdownComponent) => unknown): this {
		return this.add(new DropdownComponent(this.controlEl), cb);
	}
	addSlider(cb: (s: SliderComponent) => unknown): this {
		return this.add(new SliderComponent(this.controlEl), cb);
	}
	addColorPicker(cb: (c: ColorComponent) => unknown): this {
		return this.add(new ColorComponent(this.controlEl), cb);
	}
}

export class PluginSettingTab {
	containerEl = document.createElement('div');
	constructor(
		readonly app: App,
		readonly plugin: Plugin,
	) {}
	setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin as unknown as { settings: Record<string, unknown> }).settings[key] = value;
		return Promise.resolve();
	}
	getControlValue(key: string): unknown {
		return (this.plugin as unknown as { settings: Record<string, unknown> }).settings[key];
	}
	display(): void {}
	hide(): void {}
}
