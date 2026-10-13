// The plugin's settings: what belongs to the VAULT (synced in data.json).
// Per-device choices (camera, map style, panel state) are in local storage;
// per-campaign ones (sections, overlays) in the map's index. Serving on the
// local network is stored here but switched from the players menu, where it
// is needed: one place per setting. So is the "Show maps together" layout,
// arranged in its own view.

import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { emptyLayout, readLayout, type AtlasLayout } from './view/atlas_layout';

export interface HexLoreSettings {
	/** Where note templates are looked for (the "New note" dialog lists them). */
	templatesFolder: string;
	/** The player view is reachable from the local network, not just here. */
	playerLan: boolean;
	/** "New map" gives each map a folder of its own, with its section folders. */
	mapFolders: boolean;
	/** "Show maps together": the maps shown and where each one is placed. */
	atlas: AtlasLayout;
}

export const DEFAULT_SETTINGS: HexLoreSettings = {
	templatesFolder: 'Templates',
	playerLan: false,
	mapFolders: true,
	atlas: emptyLayout(),
};

/** Read settings tolerantly: unknown keys are kept (a newer build's). */
export function readSettings(raw: unknown): HexLoreSettings & Record<string, unknown> {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		...o,
		templatesFolder: typeof o.templatesFolder === 'string' ? o.templatesFolder : DEFAULT_SETTINGS.templatesFolder,
		playerLan: typeof o.playerLan === 'boolean' ? o.playerLan : DEFAULT_SETTINGS.playerLan,
		mapFolders: typeof o.mapFolders === 'boolean' ? o.mapFolders : DEFAULT_SETTINGS.mapFolders,
		atlas: readLayout(o.atlas),
	};
}

export class HexLoreSettingTab extends PluginSettingTab {
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Maps',
				items: [
					{
						name: 'A folder for each new map',
						desc: 'A new map gets a folder of its own: the map note, its data folder and a numbered folder for each section (places, regions, characters, factions, quests, adventures, GM notes, miscellanea). Off: the map note and its data folder go straight into the folder you choose, and the map uses the default sections at the vault root. Maps that already exist are not changed.',
						control: { type: 'toggle', key: 'mapFolders' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Notes',
				items: [
					{
						name: 'Templates folder',
						desc: 'Notes in this folder are offered as templates when you create a note from a hex or a section. They may use {{title}}, {{hex}}, {{map}}, {{date}} and {{time}}.',
						control: { type: 'folder', key: 'templatesFolder', placeholder: 'Templates' },
					},
				],
			},
		];
	}
}
