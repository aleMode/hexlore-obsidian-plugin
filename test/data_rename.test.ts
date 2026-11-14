// @vitest-environment jsdom
// Renaming a map's data folder, or its index, inside Obsidian: the open store
// follows the folder (its files do not read as deleted, and an edit is not
// written back under the old name), and the index's `data:` is rewritten so
// the map still opens.
import './mocks/dom';
import { describe, expect, it } from 'vitest';
import { App, Notice, TFolder, useApp } from './mocks/obsidian';
import HexLorePlugin from '../src/main';
import { encodeAll } from '../src/storage/map_codec';
import { afterFolderRename, afterIndexRename, dataFolderFor, dataValueFor } from '../src/storage/data_link';
import { movedPath, type StoreRegistry } from '../src/storage/store_registry';
import { fixtureMap } from './helpers/fixture_map';

const INDEX = 'Maps/purezza.hexmap.md';
const DATA = 'Maps/purezza.hexlore';

function vault(): App {
	const files: Record<string, string> = { [INDEX]: '---\nhexlore-plugin: map\n---\n\n## Hexes\n' };
	for (const [rel, text] of encodeAll(fixtureMap())) files[`${DATA}/${rel}`] = text;
	const app = new App(files);
	useApp(app);
	return app;
}

async function loaded(app: App): Promise<StoreRegistry> {
	const plugin = new HexLorePlugin(app as never, { id: 'hexlore', dir: `${app.vault.configDir}/plugins/hexlore` } as never);
	await plugin.onload();
	return (plugin as unknown as { stores: StoreRegistry }).stores;
}

const settle = () => new Promise((r) => setTimeout(r, 400)); // past the 250 ms batch

describe('data_link', () => {
	it('works out the folder an index names, and the value that names a folder', () => {
		expect(dataFolderFor(INDEX, undefined)).toBe(DATA);
		expect(dataFolderFor(INDEX, 'Other.hexlore')).toBe('Maps/Other.hexlore');
		expect(dataFolderFor('top.hexmap.md', undefined)).toBe('top.hexlore');
		expect(dataValueFor(INDEX, 'Maps/x/y.hexlore')).toBe('x/y.hexlore');
		expect(dataValueFor(INDEX, 'Elsewhere/y.hexlore')).toBeNull();
		expect(movedPath('A/b.hexlore', 'A', 'Z')).toBe('Z/b.hexlore');
		expect(movedPath('Ab/b.hexlore', 'A', 'Z')).toBeNull();
	});

	it('a renamed data folder gets a data: value; an unrelated one does not', () => {
		expect(afterFolderRename(INDEX, undefined, DATA, 'Maps/Renamed.hexlore')).toEqual({ data: 'Renamed.hexlore' });
		// A parent of both renamed: the index already has its new path then.
		expect(afterFolderRename('Atlas/purezza.hexmap.md', undefined, 'Maps', 'Atlas')).toBeNull();
		expect(afterFolderRename(INDEX, undefined, 'Other', 'Else')).toBeNull();
		expect(afterFolderRename(INDEX, undefined, DATA, 'Elsewhere/p.hexlore')).toHaveProperty('problem');
	});

	it('a renamed index keeps naming the folder it had', () => {
		const exists = (p: string) => p === DATA;
		expect(afterIndexRename(INDEX, 'Maps/Other.hexmap.md', undefined, exists)).toEqual({ data: 'purezza.hexlore' });
		expect(afterIndexRename(INDEX, 'Maps/Sub/purezza.hexmap.md', undefined, exists)).toHaveProperty('problem');
		// The folder moved with it (a parent rename): nothing to do.
		expect(afterIndexRename(INDEX, 'Atlas/purezza.hexmap.md', undefined, () => false)).toBeNull();
	});
});

describe('renaming in the vault', () => {
	it('the open store follows its data folder, and the index is updated', async () => {
		const app = vault();
		const stores = await loaded(app);
		const store = await stores.acquire(DATA, 'purezza');
		expect(store.model.hexes.size).toBe(4);

		await app.vault.rename(app.vault.getAbstractFileByPath(DATA)!, 'Maps/Renamed.hexlore');
		await settle();
		expect(store.model.hexes.size).toBe(4); // not emptied as "deleted"
		expect(store.readOnly).toBe(false);
		expect(app.vault.textOf(INDEX)).toContain('data: "Renamed.hexlore"');

		store.model.getHex(0, 0)!.name = 'After the rename';
		store.markHex(0, 0);
		await store.flush();
		expect(app.vault.textOf('Maps/Renamed.hexlore/paint/c_0_0.json')).toContain('After the rename');
		expect(app.vault.getAbstractFileByPath(DATA)).toBeNull(); // not recreated
		await stores.release(DATA); // released under the name it was acquired by
	});

	it('sections follow a renamed map folder, section folder or template', async () => {
		const index = 'Purezza/Purezza.hexmap.md';
		const files: Record<string, string> = {
			[index]: [
				'---',
				'hexlore-plugin: map',
				'sections:',
				'  - {"name": "Places", "folder": "Purezza/10 Places"}',
				'  - {"name": "NPCs", "folder": "Purezza/30 NPCs", "template": "Purezza/Templates/NPC.md"}',
				'  - {"name": "Shared", "folder": "Shared"}',
				'---',
				'',
				'## Hexes',
				'',
			].join('\n'),
			'Purezza/10 Places/Fort.md': '# Fort',
			'Purezza/30 NPCs/Hermit.md': '# Hermit',
			'Purezza/Templates/NPC.md': '# {{title}}',
			'Shared/Smith.md': '# Smith',
		};
		for (const [rel, text] of encodeAll(fixtureMap())) files[`Purezza/Purezza.hexlore/${rel}`] = text;
		const app = new App(files);
		useApp(app);
		await loaded(app);
		// The whole map folder moves: one event for it, then one per file inside.
		await app.vault.rename(app.vault.getAbstractFileByPath('Purezza')!, 'Campaigns/Purezza');
		await settle();
		let text = app.vault.textOf('Campaigns/Purezza/Purezza.hexmap.md')!;
		expect(text).toContain('"folder":"Campaigns/Purezza/10 Places"');
		expect(text).toContain('"folder":"Campaigns/Purezza/30 NPCs"');
		expect(text).toContain('"template":"Campaigns/Purezza/Templates/NPC.md"');
		expect(text).toContain('"folder":"Shared"');
		// One section folder renamed.
		await app.vault.rename(app.vault.getAbstractFileByPath('Campaigns/Purezza/10 Places')!, 'Campaigns/Purezza/10 Luoghi');
		await settle();
		text = app.vault.textOf('Campaigns/Purezza/Purezza.hexmap.md')!;
		expect(text).toContain('"folder":"Campaigns/Purezza/10 Luoghi"');
		expect(text).toContain('"folder":"Campaigns/Purezza/30 NPCs"');
	});

	it('a renamed index gets the data: value that keeps its map', async () => {
		const app = vault();
		await loaded(app);
		await app.vault.rename(app.vault.getAbstractFileByPath(INDEX)!, 'Maps/Other.hexmap.md');
		await settle();
		expect(app.vault.textOf('Maps/Other.hexmap.md')).toContain('data: "purezza.hexlore"');
		expect(app.vault.getAbstractFileByPath(DATA)).toBeInstanceOf(TFolder);
	});

	it('an index moved away from its folder is reported, not silently broken', async () => {
		const app = vault();
		await loaded(app);
		Notice.log.length = 0;
		await app.vault.rename(app.vault.getAbstractFileByPath(INDEX)!, 'Elsewhere/purezza.hexmap.md');
		await settle();
		expect(Notice.log.some((m) => m.includes('can no longer find its map'))).toBe(true);
	});
});
