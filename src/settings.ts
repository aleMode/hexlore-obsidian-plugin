// The plugin's settings: what belongs to the VAULT (synced in data.json).
// Per-device choices (camera, map style, panel state) are in local storage;
// per-campaign ones (sections, overlays) in the map's index. Serving on the
// local network is stored here but switched from the players menu, where it
// is needed: one place per setting. So is the "Show maps together" layout,
// arranged in its own view.

import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from 'obsidian';
import { TERRAINS, type Terrain } from './core/hex_data';
import { readPartyBook, type PartyBook } from './party/party';
import { defaultTravel, readTravel, type TravelSettings } from './party/travel';
import { emptyLayout, readLayout, type AtlasLayout } from './view/atlas_layout';
import type { NoteOpening } from './view/open_note';

export interface HexLoreSettings {
	/** Where note templates are looked for (the "New note" dialog lists them). */
	templatesFolder: string;
	/** The player view is reachable from the local network, not just here. */
	playerLan: boolean;
	/** "New map" gives each map a folder of its own, with its section folders. */
	mapFolders: boolean;
	/** How a note opened from a map shows: a floating window or a pane. */
	noteOpening: NoteOpening;
	/** Clicking a hex shows the map panel when it is hidden. */
	revealPanel: boolean;
	/** "Show maps together": the maps shown and where each one is placed. */
	atlas: AtlasLayout;
	/** Travel time per terrain, and terrain heights for line of sight. */
	travel: TravelSettings;
	/** Rolls, trips and reveals are added to the session note's log. */
	sessionLog: boolean;
	/** Where the party is on each map, and its travel time (by index path). */
	party: PartyBook;
}

export const DEFAULT_SETTINGS: HexLoreSettings = {
	templatesFolder: 'Templates',
	playerLan: false,
	mapFolders: true,
	noteOpening: 'popover',
	revealPanel: true,
	atlas: emptyLayout(),
	travel: defaultTravel(),
	sessionLog: true,
	party: {},
};

/** Read settings tolerantly: unknown keys are kept (a newer build's). */
export function readSettings(raw: unknown): HexLoreSettings & Record<string, unknown> {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	return {
		...o,
		templatesFolder: typeof o.templatesFolder === 'string' ? o.templatesFolder : DEFAULT_SETTINGS.templatesFolder,
		playerLan: typeof o.playerLan === 'boolean' ? o.playerLan : DEFAULT_SETTINGS.playerLan,
		mapFolders: typeof o.mapFolders === 'boolean' ? o.mapFolders : DEFAULT_SETTINGS.mapFolders,
		noteOpening: o.noteOpening === 'pane' || o.noteOpening === 'popover' ? o.noteOpening : DEFAULT_SETTINGS.noteOpening,
		revealPanel: typeof o.revealPanel === 'boolean' ? o.revealPanel : DEFAULT_SETTINGS.revealPanel,
		atlas: readLayout(o.atlas),
		travel: readTravel(o.travel),
		sessionLog: typeof o.sessionLog === 'boolean' ? o.sessionLog : DEFAULT_SETTINGS.sessionLog,
		party: readPartyBook(o.party),
	};
}

/** `travel.hours.forest`, `travel.height.hills`, `travel.dayHours`…: the
 *  travel settings, one control each. */
const TRAVEL_KEY = /^travel\.(?:(hours|height)\.(\w+)|(referenceMiles|dayHours|roadHours|trailHours))$/;

export class HexLoreSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly owner: Plugin & { settings: HexLoreSettings },
	) {
		super(app, owner);
	}

	private get hexlore(): HexLoreSettings {
		return this.owner.settings;
	}

	getControlValue(key: string): unknown {
		const m = TRAVEL_KEY.exec(key);
		if (!m) return super.getControlValue(key);
		const t = this.hexlore.travel;
		if (m[1] === 'hours') return t.terrainHours[m[2] as Terrain] ?? '';
		if (m[1] === 'height') return t.heights[m[2] as Terrain];
		const v = t[m[3] as 'referenceMiles' | 'dayHours' | 'roadHours' | 'trailHours'];
		return v ?? '';
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		const m = TRAVEL_KEY.exec(key);
		if (!m) return super.setControlValue(key, value);
		const t = { ...this.hexlore.travel, terrainHours: { ...this.hexlore.travel.terrainHours }, heights: { ...this.hexlore.travel.heights } };
		// Hours: a number, or blank for "cannot be entered" / "no effect".
		const hours = (v: unknown): number | null => {
			const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
			return Number.isFinite(n) && n >= 0 ? n : null;
		};
		if (m[1] === 'hours') t.terrainHours[m[2] as Terrain] = hours(value);
		else if (m[1] === 'height') t.heights[m[2] as Terrain] = Math.max(0, Math.min(10, Math.round(Number(value) || 0)));
		else if (m[3] === 'roadHours' || m[3] === 'trailHours') t[m[3]] = hours(value);
		else {
			const n = Number(value);
			if (Number.isFinite(n) && n > 0) t[m[3] as 'referenceMiles' | 'dayHours'] = n;
		}
		return super.setControlValue('travel', readTravel(t));
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const terrains = TERRAINS.filter((t) => t !== 'default');
		const titleCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
		const hoursValid = (v: string) => (v.trim() && !(Number(v) >= 0) ? 'A number of hours, or blank.' : undefined);
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
					{
						name: 'Show the map panel when a hex is clicked',
						desc: 'Clicking a hex opens the map panel (right sidebar) if it is closed or behind another tab. Off: the panel button in the top bar shows it.',
						control: { type: 'toggle', key: 'revealPanel' },
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
					{
						name: 'Open notes from the map',
						desc: 'Double-clicking a hex, clicking a note in the map panel, or creating a note for a hex. A floating window shows the note over the map, ready to edit; click outside it to close it. Ctrl/Cmd-click a note in the map panel opens it in a new tab either way. The floating window needs the core Page preview plugin: without it, notes open beside the map.',
						control: { type: 'dropdown', key: 'noteOpening', options: { popover: 'In a floating window', pane: 'In a pane beside the map' } },
					},
					{
						name: 'Session log',
						desc: 'Encounter rolls, the party’s trips and the hexes you reveal are added, with the time, under “## Session log” in the session note (the newest note in GM notes).',
						control: { type: 'toggle', key: 'sessionLog' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Travel',
				items: [
					{
						name: 'Hex size for these times',
						desc: 'The times below are for hexes this many miles across. A map with bigger or smaller hexes (its map scale) takes proportionally longer or shorter.',
						control: { type: 'number', key: 'travel.referenceMiles', min: 0.1, step: 'any' },
					},
					{
						name: 'Hours in a travel day',
						desc: 'The travel time is shown in days of this many hours.',
						control: { type: 'number', key: 'travel.dayHours', min: 1, step: 'any' },
					},
					{
						type: 'page',
						name: 'Time to enter a hex',
						desc: 'Hours to enter a hex of each terrain, or one a road runs through. Blank: cannot be entered on foot (terrain), or no effect (roads and trails). Moving the party charges the hex it arrives in.',
						items: [
							{
								type: 'group',
								heading: 'Hours to enter',
								items: [
									...terrains.map((t) => ({ name: titleCase(t), control: { type: 'text' as const, key: `travel.hours.${t}`, placeholder: 'cannot enter', validate: hoursValid } })),
									{ name: 'Unpainted hex', control: { type: 'text', key: 'travel.hours.default', placeholder: 'cannot enter', validate: hoursValid } },
									{ name: 'Road or highway', control: { type: 'text', key: 'travel.roadHours', placeholder: 'no effect', validate: hoursValid } },
									{ name: 'Trail', control: { type: 'text', key: 'travel.trailHours', placeholder: 'no effect', validate: hoursValid } },
								],
							},
						],
					},
					{
						type: 'page',
						name: 'Terrain heights',
						desc: 'How high each terrain stands, for "Reveal + line of sight": a hex of height h is seen from up to h hexes away, and hides what is behind it from lower ground.',
						items: [
							{
								type: 'group',
								heading: 'Height',
								items: terrains.map((t) => ({ name: titleCase(t), control: { type: 'slider' as const, key: `travel.height.${t}`, min: 0, max: 5, step: 1 } })),
							},
						],
					},
				],
			},
		];
	}
}
