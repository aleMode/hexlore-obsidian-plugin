// The shared render spec and the generated art tables, vendored from the
// Flutter repo (vendor/player/). They are the JS mirrors of map_palette.dart
// and terrain_texture.dart and the generated glyph/texture tables (decisions
// 13, 16, 22), so they are USED here, never ported: a fix lands in Flutter and
// arrives with `npm run vendor`.
//
// Each file is a page script that hangs its table on `globalThis`. esbuild's
// `scoped` plugin (scripts/scoped.mjs) bundles each one wrapped in a function
// whose `globalThis` parameter is a private object, so nothing touches
// Obsidian's window and nothing is evaluated at runtime.

import featureGlyphs from '../../vendor/player/feature_glyphs.js?scoped';
import renderSpec from '../../vendor/player/render_spec.js?scoped';
import terrainGlyphs from '../../vendor/player/terrain_glyphs.js?scoped';
import textureSpec from '../../vendor/player/texture_spec.js?scoped';
import textureTables from '../../vendor/player/texture_tables.js?scoped';

export type Pt = [number, number];
export type Group = string;

export interface Credit {
	name: string;
	url?: string;
	license?: string;
}

export interface RoadStyle {
	casingAlpha: number;
	bodyAlpha: number;
	coreFrac: number;
	dash: number[];
	coreDash: number[];
	marks: string;
}

export interface RiverMouth {
	spine: Pt[];
	into: Pt;
}

export interface RiverSplit {
	runs: { points: Pt[] }[];
	mouths: RiverMouth[];
}

/** render_spec.js — the JS mirror of map_palette.dart (decision 13). */
export interface RenderSpec {
	terrainStampScale: number;
	featureStampScale: number;
	stampCentreOffset: number;
	stampStrokeRatio: number;
	labelOffset: number;
	labelFontSize: number;
	labelHaloWidth: number;
	labelInk: string;
	labelHalo: string;
	edgeColor: string;
	edgeQuietWidth: number;
	edgeQuietAlpha: number;
	edgeBoundaryWidth: number;
	edgeBoundaryAlpha: number;
	coastInset: number;
	coastWidth: number;
	coastAlpha: number;
	coastColor: string;
	isCoast(mine: Group, theirs: Group): boolean;
	jitterFill(hex: string, q: number, r: number): string;
	groupNone: Group;
	groupWater: Group;
	terrainGroup(terrain: string | null | undefined): Group;
	isBoundary(a: Group, b: Group): boolean;
	hexEdgeNeighbors: [number, number][];
	canonicalEdge(q: number, r: number, k: number): [number, number, number];
	parseHex(hex: string): [number, number, number];
	lerpHex(a: string, b: string, t: number): string;
	inkFor(fill: string): string;
	roadKindsByRank: string[];
	borderStyle: { base: number; dash: number[] };
	roadStyleOf(kind: string): RoadStyle | null;
	roadCasingColor(colour: string, style: RoadStyle): string;
	roadCoreColor(colour: string, style: RoadStyle): string;
	roadMarkColor(colour: string): string;
	roadCasingWidth(style: RoadStyle, width: number): number;
	roadBodyWidth(style: RoadStyle, width: number): number;
	smoothPolyline(pts: Pt[]): Pt[];
	roadMarks(style: RoadStyle, pts: Pt[], width: number, seed: number): { pebbles: number[]; ticks: number[] };
	riverMouthFlare: number;
	riverMouthSpill: number;
	riverCourseStep: number;
	sampleSmoothCourse(pts: Pt[], step: number): Pt[];
	splitCourseAtWater(samples: Pt[], wet: (x: number, y: number) => boolean, radius: number): RiverSplit | null;
	mouthOutline(m: RiverMouth, half: number, flare: number, spill: number, wet?: (x: number, y: number) => boolean, reach?: number): Pt[];
}

/** One generated glyph (game-icons silhouette). */
export interface Glyph {
	id: string;
	author: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
	path: string;
	scale?: number;
	dx?: number;
	dy?: number;
	outline?: boolean;
}

/** feature_glyphs.js / terrain_glyphs.js. */
export interface GlyphTable {
	glyphs: Record<string, Glyph[]>;
	credits?: Credit[];
	transform(g: Glyph, size: number): [number, number, number];
	path(g: Glyph): Path2D;
}

export interface TextureLayout {
	objects: number[];
	ground: number[];
}

/** One Illustrated texture variant of a biome. */
export interface TextureVariant {
	label: string;
	layouts: TextureLayout[];
	[k: string]: unknown;
}

/** [kind, path, shade, argb, opacity, stroke] */
export type TexturePart = [number, string, number, number, number, number];

export interface TextureTables {
	symbols: { id: string; parts: TexturePart[] }[];
	variants: Record<string, TextureVariant[]>;
	credits: Credit[];
}

export interface Placement {
	symbol: number;
	x: number;
	y: number;
	size: number;
	flip: boolean;
}

export interface Obstacle {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	halfWidth: number;
}

export interface Tones {
	outline: string;
	trunk: string;
	object(shade: number): string;
	ground(shade: number): string;
	snow(shade: number): string;
}

/** texture_spec.js — the JS mirror of terrain_texture.dart (decision 22). */
export interface TextureSpec {
	KIND: Record<'shape' | 'shadow' | 'trunk' | 'ink' | 'ground' | 'accent' | 'snow', number>;
	placementStride: number;
	texturePick(q: number, r: number, layoutCount: number): { layout: number; flip: boolean };
	featureSlotFor(q: number, r: number): number;
	featureSlotCentre(slot: number): Pt;
	textureLodBucket(radiusPx: number): number;
	textureLodCount(lod: number, objects: number): number;
	sliceLayout(
		layout: TextureLayout,
		opts: { flip: boolean; featureSlot: number | null; lodCount: number; obstacles: Obstacle[]; blendMask: number },
	): { ground: Placement[]; behind: Placement[]; front: Placement[] };
	localObstacles(cx: number, cy: number, segments: number[][], radius: number): Obstacle[];
	blendMaskFor(mine: Group, neighbour: (k: number) => Group): number;
	blendEdgeDepth: number;
	objectBounds(objects: Placement[]): [number, number, number, number] | null;
	textureGroundFill(fill: string, v: TextureVariant): string;
	textureTones(fill: string, v: TextureVariant): Tones;
	featureBodyTone(ground: string, feature: string): string;
	featureOutlineTone(ground: string): string;
	featureSideTone(ground: string, feature: string): string;
	featureHighlightTone(ground: string, feature: string): string;
	featureRimTone(ground: string, feature: string): string;
	featureSolidDepth: number;
	featureBevelPx: number;
	glyphSolidOutlinePx: number;
	textureOutlinePx: number;
	textureShadowAlpha: number;
	illustratedEdgeQuietWidth: number;
	illustratedEdgeQuietAlpha: number;
	illustratedEdgeBoundaryWidth: number;
	illustratedEdgeBoundaryAlpha: number;
}

const scope: Record<string, unknown> = {};
// Order matters: texture_spec.js reads the spec and the tables at load.
for (const load of [renderSpec, featureGlyphs, terrainGlyphs, textureTables, textureSpec]) load(scope);

export const SPEC = scope.HexLoreSpec as RenderSpec;
export const FEATURE_GLYPHS = scope.HexLoreGlyphs as GlyphTable;
export const TERRAIN_GLYPHS = scope.HexLoreTerrainGlyphs as GlyphTable;
export const TEXTURES = scope.HexLoreTextures as TextureTables;
export const TEX = scope.HexLoreTextureSpec as TextureSpec;
