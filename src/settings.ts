// The plugin's settings: what belongs to the VAULT (synced in data.json).
// Per-device choices (camera, map style, panel state) are in local storage;
// per-campaign ones (sections, overlays) in the map's index.

import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from 'obsidian';

export interface HexLoreSettings {
	/** Where note templates are looked for (the "New note" dialog lists them). */
	templatesFolder: string;
}

export const DEFAULT_SETTINGS: HexLoreSettings = {
	templatesFolder: 'Templates',
};

/** Read settings tolerantly: unknown keys are kept (a newer build's). */
export function readSettings(raw: unknown): HexLoreSettings & Record<string, unknown> {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		...o,
		templatesFolder: typeof o.templatesFolder === 'string' ? o.templatesFolder : DEFAULT_SETTINGS.templatesFolder,
	};
}

export interface SettingsHost extends Plugin {
	settings: HexLoreSettings;
	saveSettings(): Promise<void>;
	/** Setting groups other modules add (the player server). */
	settingGroups: (() => SettingDefinitionItem[])[];
}

export class HexLoreSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
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
			...this.host.settingGroups.flatMap((g) => g()),
		];
	}
}
