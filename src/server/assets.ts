// The player page: the files are the Flutter app's (vendor/player/), so both
// apps' players get the same page, plus the plugin's party marker
// (party_script.ts), added to the page as served.

import featureGlyphs from '../../vendor/player/feature_glyphs.js?raw';
import indexHtml from '../../vendor/player/index.html?raw';
import playerCss from '../../vendor/player/player.css?raw';
import playerJs from '../../vendor/player/player.js?raw';
import renderSpec from '../../vendor/player/render_spec.js?raw';
import terrainGlyphs from '../../vendor/player/terrain_glyphs.js?raw';
import textureSpec from '../../vendor/player/texture_spec.js?raw';
import textureTables from '../../vendor/player/texture_tables.js?raw';
import { PARTY_JS, withPartyScript } from './party_script';

export const PLAYER_ASSETS: Readonly<Record<string, string>> = {
	'index.html': withPartyScript(indexHtml),
	'party.js': PARTY_JS,
	'player.css': playerCss,
	'player.js': playerJs,
	'render_spec.js': renderSpec,
	'feature_glyphs.js': featureGlyphs,
	'terrain_glyphs.js': terrainGlyphs,
	'texture_tables.js': textureTables,
	'texture_spec.js': textureSpec,
};
