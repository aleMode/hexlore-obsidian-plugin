// The player page, served as it is: the files are the Flutter app's
// (vendor/player/), so both apps' players get the same page.

import featureGlyphs from '../../vendor/player/feature_glyphs.js?raw';
import indexHtml from '../../vendor/player/index.html?raw';
import playerCss from '../../vendor/player/player.css?raw';
import playerJs from '../../vendor/player/player.js?raw';
import renderSpec from '../../vendor/player/render_spec.js?raw';
import terrainGlyphs from '../../vendor/player/terrain_glyphs.js?raw';
import textureSpec from '../../vendor/player/texture_spec.js?raw';
import textureTables from '../../vendor/player/texture_tables.js?raw';

export const PLAYER_ASSETS: Readonly<Record<string, string>> = {
	'index.html': indexHtml,
	'player.css': playerCss,
	'player.js': playerJs,
	'render_spec.js': renderSpec,
	'feature_glyphs.js': featureGlyphs,
	'terrain_glyphs.js': terrainGlyphs,
	'texture_tables.js': textureTables,
	'texture_spec.js': textureSpec,
};
