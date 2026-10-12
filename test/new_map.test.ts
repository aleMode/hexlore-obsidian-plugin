// "New map": with the "A folder for each new map" setting (the default) the
// map goes in a folder of its own, with a numbered folder per section, and
// those are written as its sections; off, it is made as before.
import { describe, expect, it } from 'vitest';
import { App, TFile } from './mocks/obsidian';
import { createMap, newMapFolder } from '../src/view/map_menus';
import { sectionsOf } from '../src/storage/index_file';
import { DEFAULT_SECTIONS, MAP_FOLDER_SECTIONS, mapFolderSections, sectionProblems } from '../src/storage/hexmap_index';
import { readSettings } from '../src/settings';

describe('new map', () => {
	it('a map folder holds the map, its data and a numbered folder per section', async () => {
		const app = new App();
		const index = await createMap(app as never, 'Campaigns', 'Purezza', 20, 15, true);
		expect(index.path).toBe('Campaigns/Purezza/Purezza.hexmap.md');
		expect(app.vault.textOf('Campaigns/Purezza/Purezza.hexlore/campaign.json')).toBeDefined();
		const sections = sectionsOf(app as never, index)!;
		expect(sections).toEqual(mapFolderSections('Campaigns/Purezza'));
		expect(sections.map((s) => s.folder)).toEqual([
			'Campaigns/Purezza/10 Places',
			'Campaigns/Purezza/20 Regions',
			'Campaigns/Purezza/30 NPCs',
			'Campaigns/Purezza/40 Factions',
			'Campaigns/Purezza/50 Quests',
			'Campaigns/Purezza/60 Adventures',
			'Campaigns/Purezza/70 GM notes',
			'Campaigns/Purezza/90 Miscellanea',
		]);
		for (const s of sections) expect(app.vault.getAbstractFileByPath(s.folder)).not.toBeNull();
		expect(sectionProblems(sections)).toEqual([]);
		// The data folder is named relative to the index, as before.
		expect(app.vault.textOf(index.path)).toContain('data: "Purezza.hexlore"');
	});

	it('the section names stay the ones the converter and the top bar know', () => {
		const known = new Set(DEFAULT_SECTIONS.map((s) => s.name));
		for (const name of ['Places', 'Regions', 'NPCs', 'GM notes', 'Adventures', 'Unsorted']) {
			expect(known.has(name)).toBe(true);
			expect(MAP_FOLDER_SECTIONS.some((s) => s.name === name)).toBe(true);
		}
	});

	it('a taken name gets a number, folder and all', async () => {
		const app = new App({ 'Purezza/notes.md': 'mine' });
		const index = await createMap(app as never, '', 'Purezza', 20, 15, true);
		expect(index.path).toBe('Purezza 2/Purezza 2.hexmap.md');
		expect(sectionsOf(app as never, index)![0]!.folder).toBe('Purezza 2/10 Places');
		expect(app.vault.getAbstractFileByPath('Purezza/10 Places')).toBeNull();
	});

	it('off, the map is made in the folder as before, with no sections', async () => {
		const app = new App();
		const index = await createMap(app as never, 'Maps', 'Purezza', 20, 15, false);
		expect(index.path).toBe('Maps/Purezza.hexmap.md');
		expect(app.vault.textOf('Maps/Purezza.hexlore/campaign.json')).toBeDefined();
		expect(sectionsOf(app as never, index)).toBeNull();
		expect(app.vault.getAbstractFileByPath('Maps/Purezza')).toBeNull();
	});

	it('proposes the folder beside the current map folder, never inside it', async () => {
		const app = new App({ 'Campaigns/Purezza/10 Places/Inn.md': '# Inn', 'Loose/note.md': '' });
		await createMap(app as never, 'Campaigns', 'Purezza 2', 20, 15, true);
		const at = (p: string) => {
			const f = app.vault.getAbstractFileByPath(p);
			if (!(f instanceof TFile)) throw new Error(p);
			return f;
		};
		const inn = at('Campaigns/Purezza/10 Places/Inn.md');
		const map = at('Campaigns/Purezza 2/Purezza 2.hexmap.md');
		expect(newMapFolder(map as never, true)).toBe('Campaigns');
		// "Purezza" holds no Purezza.hexmap.md: not a map folder.
		expect(newMapFolder(inn as never, true)).toBe('Campaigns/Purezza/10 Places');
		expect(newMapFolder(at('Loose/note.md') as never, true)).toBe('Loose');
		expect(newMapFolder(map as never, false)).toBe('Campaigns/Purezza 2');
		expect(newMapFolder(null, true)).toBe('');
	});

	it('a note inside a map folder proposes the folder beside the map', async () => {
		const app = new App();
		const index = await createMap(app as never, 'Campaigns', 'Purezza', 20, 15, true);
		await app.vault.create('Campaigns/Purezza/10 Places/Inn.md', '# Inn');
		const inn = app.vault.getAbstractFileByPath('Campaigns/Purezza/10 Places/Inn.md');
		expect(newMapFolder(inn as never, true)).toBe('Campaigns');
		expect(newMapFolder(index, true)).toBe('Campaigns');
	});

	it('the setting is on unless turned off', () => {
		expect(readSettings({}).mapFolders).toBe(true);
		expect(readSettings({ mapFolders: false }).mapFolders).toBe(false);
	});
});
