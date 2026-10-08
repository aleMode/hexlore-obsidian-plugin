// HexLore shared texture spec — JS mirror of lib/core/terrain_texture.dart.
//
// The pure half of the Illustrated map style: which layout a hex uses, where
// its feature sits, what survives the clearing, draw order, and the colours a
// symbol's tones resolve to. Every function and constant here must behave
// identically to its Dart counterpart; texture_spec_mirror_test.dart runs this
// file under node against the Dart results and fails on any drift.
//
// Needs render_spec.js (HexLoreSpec) and texture_tables.js (HexLoreTextures)
// loaded first; under node it requires them itself.
(function (root) {
  const SPEC =
    root.HexLoreSpec ||
    (typeof require !== "undefined" ? require("./render_spec.js") : null);
  const TABLES =
    root.HexLoreTextures ||
    (typeof require !== "undefined" ? require("./texture_tables.js") : null);

  // Part kinds: indices into TexturePartKind.
  const KIND = { shape: 0, shadow: 1, trunk: 2, ink: 3, ground: 4, accent: 5, snow: 6 };

  const SALT_TEXTURE_LAYOUT = 21;
  const SALT_TEXTURE_FLIP = 22;
  const SALT_FEATURE_SLOT = 23;

  function variantFor(terrain, variant) {
    const list = TABLES.variants[terrain];
    if (!list || !list.length) return null;
    const v = Math.max(0, Math.min(variant || 0, list.length - 1));
    return list[v];
  }

  function texturePick(q, r, layoutCount) {
    return {
      layout: SPEC.hash2(q, r, SALT_TEXTURE_LAYOUT) % layoutCount,
      flip: (SPEC.hash2(q, r, SALT_TEXTURE_FLIP) & 1) === 1,
    };
  }

  const FEATURE_SLOT_COUNT = 7;
  const FEATURE_SLOT_RADIUS = 0.12;

  // Always slot 0 (dead centre) — mirrors terrain_texture.dart's
  // featureSlotFor: a feature marks a specific place, and nudging it
  // off-centre per hex reads as the map disagreeing about where that is.
  function featureSlotFor(q, r) {
    return 0;
  }

  const SLOT_DIRS = [
    [0.866, 0.5], [0.0, 1.0], [-0.866, 0.5],
    [-0.866, -0.5], [0.0, -1.0], [0.866, -0.5],
  ];

  function featureSlotCentre(slot) {
    if (slot <= 0) return [0.0, SPEC.stampCentreOffset];
    const [dx, dy] = SLOT_DIRS[(slot - 1) % 6];
    return [dx * FEATURE_SLOT_RADIUS, SPEC.stampCentreOffset + dy * FEATURE_SLOT_RADIUS];
  }

  const CLEARING_RADIUS_X = 0.46;
  const CLEARING_RADIUS_Y = 0.36;
  const CLEARING_DROP = 0.12;
  const CLEARING_REF_SIZE = 0.42;
  const FEATURE_FOOT_DROP = 0.28;
  const STRIDE = 6;

  function textureLodBucket(radiusPx) {
    return radiusPx < 22 ? 0 : radiusPx < 34 ? 1 : 2;
  }

  function textureLodCount(bucket, objectCount) {
    if (bucket === 0) return Math.ceil(objectCount * 0.35);
    if (bucket === 1) return Math.ceil(objectCount * 0.65);
    return objectCount;
  }

  // ----- rivers and roads (mirrors LineObstacle / localObstacles /
  // objectHitsObstacle) ---------------------------------------------------
  const OBSTACLE_REACH = 1.35;

  // Dart's .round() breaks ties away from zero; Math.round does not.
  const roundHalfAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

  function segmentPointDistance(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const ex = ax + dx * t - px, ey = ay + dy * t - py;
    return Math.sqrt(ex * ex + ey * ey);
  }

  // segments: [[x1, y1, x2, y2, halfWidth], ...] in scene px.
  function localObstacles(cx, cy, segments, radius) {
    const q = (v) => roundHalfAway(v * 100) / 100;
    const out = [];
    for (const [x1, y1, x2, y2, hw] of segments) {
      const ax = (x1 - cx) / radius, ay = (y1 - cy) / radius;
      const bx = (x2 - cx) / radius, by = (y2 - cy) / radius;
      const w = hw / radius;
      if (segmentPointDistance(ax, ay, bx, by, 0, 0) > OBSTACLE_REACH + w) continue;
      out.push({ x1: q(ax), y1: q(ay), x2: q(bx), y2: q(by), halfWidth: q(w) });
    }
    return out;
  }

  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
    const d1 = cross(cx, cy, dx, dy, ax, ay);
    const d2 = cross(cx, cy, dx, dy, bx, by);
    const d3 = cross(ax, ay, bx, by, cx, cy);
    const d4 = cross(ax, ay, bx, by, dx, dy);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function segmentRectDistance(o, l, t, r, b) {
    const inside = (x, y) => x >= l && x <= r && y >= t && y <= b;
    if (inside(o.x1, o.y1) || inside(o.x2, o.y2)) return 0;
    const edges = [[l, t, r, t], [r, t, r, b], [r, b, l, b], [l, b, l, t]];
    for (const [ex1, ey1, ex2, ey2] of edges) {
      if (segmentsCross(o.x1, o.y1, o.x2, o.y2, ex1, ey1, ex2, ey2)) return 0;
    }
    let best = Infinity;
    for (const [cx, cy] of [[l, t], [r, t], [r, b], [l, b]]) {
      best = Math.min(best, segmentPointDistance(o.x1, o.y1, o.x2, o.y2, cx, cy));
    }
    for (const [ex1, ey1, ex2, ey2] of edges) {
      best = Math.min(best, segmentPointDistance(ex1, ey1, ex2, ey2, o.x1, o.y1));
      best = Math.min(best, segmentPointDistance(ex1, ey1, ex2, ey2, o.x2, o.y2));
    }
    return best;
  }

  function objectHitsObstacle(p, o) {
    const e = TABLES.symbols[p.symbol].extent;
    const half = Math.min(-e[0], e[2]) * p.size * 0.8;
    return segmentRectDistance(o, p.x - half, p.y - p.size * 0.9, p.x + half, p.y) < o.halfWidth;
  }

  // ----- blend mode (mirrors saltBlend / blendMaskFor / _spillAcrossEdge) --
  const SALT_BLEND = 24;
  const BLEND_DROP_BELOW = 0.4;
  const BLEND_SPILL_BELOW = 0.7;
  const BLEND_SPILL_GAP = 0.08;
  const BLEND_EDGE_DEPTH = 0.44;

  function spillAcrossEdge(p, band) {
    const a = (Math.PI / 180) * (60 * band + 30);
    const nx = Math.cos(a), ny = Math.sin(a);
    const d = 0.8660254037844386 - (p.x * nx + p.y * ny);
    const shift = 2 * d + BLEND_SPILL_GAP;
    return { symbol: p.symbol, x: p.x + nx * shift, y: p.y + ny * shift, size: p.size, flip: p.flip };
  }

  // neighbourGroup(k) -> the terrain group across edge k.
  function blendMaskFor(mine, neighbourGroup) {
    if (mine === SPEC.groupNone) return 0;
    let mask = 0;
    for (let k = 0; k < 6; k++) {
      const theirs = neighbourGroup(k);
      if (theirs !== SPEC.groupNone && theirs !== mine) mask |= 1 << k;
    }
    return mask;
  }

  // layout: {ground: [...], objects: [...]} flat runs of STRIDE numbers.
  // opts: {flip, featureSlot (null = none), lodCount (null = all), edgeMask}.
  function sliceLayout(layout, opts) {
    const flip = !!(opts && opts.flip);
    const featureSlot = opts && opts.featureSlot != null ? opts.featureSlot : null;
    const edgeMask = (opts && opts.edgeMask) || 0;
    const obstacles = (opts && opts.obstacles) || [];
    const blendMask = (opts && opts.blendMask) || 0;
    const at = (flat, i) => {
      const o = i * STRIDE;
      const x = flat[o + 1];
      const mirrored = flat[o + 4] !== 0;
      return {
        symbol: flat[o], x: flip ? -x : x, y: flat[o + 2],
        size: flat[o + 3], flip: mirrored !== flip,
      };
    };
    const ground = [];
    for (let i = 0; i < layout.ground.length / STRIDE; i++) ground.push(at(layout.ground, i));

    const total = layout.objects.length / STRIDE;
    const n = opts && opts.lodCount != null
      ? Math.max(0, Math.min(opts.lodCount, total))
      : total;
    const [fx, fy] = featureSlot == null ? [0, 0] : featureSlotCentre(featureSlot);
    const behind = [], front = [];
    for (let i = 0; i < n; i++) {
      const stored = layout.objects[i * STRIDE + 5];
      // Bands are recorded unmirrored; a mirror swaps edges 0<->2 and 3<->5.
      const band = stored < 0 ? -1 : flip ? (8 - stored) % 6 : stored;
      if (band >= 0 && ((edgeMask >> band) & 1) === 1) continue;
      let p = at(layout.objects, i);
      if (band >= 0 && ((blendMask >> band) & 1) === 1) {
        const u = SPEC.hashUnit(i, band, SALT_BLEND);
        if (u < BLEND_DROP_BELOW) continue;
        if (u < BLEND_SPILL_BELOW) p = spillAcrossEdge(p, band);
      }
      if (obstacles.length && obstacles.some((o) => objectHitsObstacle(p, o))) continue;
      if (featureSlot == null) {
        behind.push(p);
        continue;
      }
      const grow = Math.max(1.0, p.size / CLEARING_REF_SIZE);
      const dx = (p.x - fx) / (CLEARING_RADIUS_X * grow);
      const dy = (p.y - (fy + CLEARING_DROP)) / (CLEARING_RADIUS_Y * grow);
      if (dx * dx + dy * dy < 1) continue;
      (p.y < fy + FEATURE_FOOT_DROP ? behind : front).push(p);
    }
    const byDepth = (a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x);
    behind.sort(byDepth);
    front.sort(byDepth);
    return { ground, behind, front };
  }

  // What placed objects can cover, in hex radii: [left, top, right, bottom],
  // or null. Mirrors objectBounds.
  function objectBounds(objects) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const p of objects) {
      const e = TABLES.symbols[p.symbol].extent;
      const xl = p.flip ? -e[2] : e[0];
      const xr = p.flip ? -e[0] : e[2];
      l = Math.min(l, p.x + xl * p.size);
      r = Math.max(r, p.x + xr * p.size);
      t = Math.min(t, p.y + e[1] * p.size);
      b = Math.max(b, p.y + e[3] * p.size);
    }
    return Number.isFinite(l) ? [l, t, r, b] : null;
  }

  const TEXTURE_SHADOW_INK = "#0E1318";
  const TEXTURE_HIGHLIGHT = "#FFF8E6";
  const TEXTURE_TRUNK_BROWN = "#3E2A1C";
  const TEXTURE_SNOW_LIGHT = "#F6F9FC";
  const TEXTURE_SNOW_SHADOW = "#B4C2D0";

  // Mirrors featureMaterials: what each feature is made of.
  const FEATURE_MATERIALS = {
    city: "#E8DEC6", settlement: "#C9A06A", tower: "#D9D3C5", ruins: "#BEB5A2",
    dungeon: "#A39C91", lookout: "#BC915C", mine: "#AD8055", well: "#D2C8B3",
    pit: "#A1815F", pyre: "#DE8E3E", cage: "#9A9AA3", flag: "#C8544A",
  };

  function featureBodyTone(ground, feature) {
    return SPEC.lerpHex(FEATURE_MATERIALS[feature] || "#EAE0C8", ground, 0.12);
  }

  function featureSideTone(ground, feature) {
    return SPEC.lerpHex(featureBodyTone(ground, feature), TEXTURE_SHADOW_INK, 0.42);
  }

  function featureHighlightTone(ground, feature) {
    return SPEC.lerpHex(featureBodyTone(ground, feature), TEXTURE_HIGHLIGHT, 0.75);
  }

  function featureRimTone(ground, feature) {
    return SPEC.lerpHex(featureBodyTone(ground, feature), TEXTURE_SHADOW_INK, 0.25);
  }

  function featureOutlineTone(ground) {
    return SPEC.lerpHex(ground, TEXTURE_SHADOW_INK, 0.85);
  }

  function textureGroundFill(fill, v) {
    return v.groundMix <= 0 ? fill : SPEC.lerpHex(fill, v.groundTint, v.groundMix);
  }

  function textureTones(fill, v) {
    const lerp = SPEC.lerpHex;
    const tinted = lerp(fill, v.tint, v.tintMix);
    const base = v.lift >= 0
      ? lerp(tinted, TEXTURE_HIGHLIGHT, v.lift)
      : lerp(tinted, TEXTURE_SHADOW_INK, -v.lift);
    const t = {
      fill: fill,
      objectBase: base,
      objectDark: lerp(base, TEXTURE_SHADOW_INK, 0.5),
      objectLight: lerp(base, TEXTURE_HIGHLIGHT, 0.22),
      trunk: lerp(TEXTURE_TRUNK_BROWN, base, 0.2),
      outline: lerp(fill, TEXTURE_SHADOW_INK, 0.82),
      groundDark: lerp(fill, "#1C1810", 0.6),
      groundLight: lerp(fill, TEXTURE_HIGHLIGHT, 0.45),
    };
    t.object = (shade) =>
      shade < 0 ? lerp(t.objectBase, t.objectDark, -shade) : lerp(t.objectBase, t.objectLight, shade);
    t.ground = (shade) =>
      shade < 0 ? lerp(t.fill, t.groundDark, -shade) : lerp(t.fill, t.groundLight, shade);
    t.snow = (shade) => lerp(TEXTURE_SNOW_SHADOW, TEXTURE_SNOW_LIGHT, (shade + 1) / 2);
    return t;
  }

  const TEX = {
    KIND: KIND,
    placementStride: STRIDE,
    variantFor: variantFor,
    texturePick: texturePick,
    featureSlotCount: FEATURE_SLOT_COUNT,
    featureSlotFor: featureSlotFor,
    featureSlotCentre: featureSlotCentre,
    textureLodBucket: textureLodBucket,
    textureLodCount: textureLodCount,
    sliceLayout: sliceLayout,
    localObstacles: localObstacles,
    blendMaskFor: blendMaskFor,
    blendEdgeDepth: BLEND_EDGE_DEPTH,
    objectHitsObstacle: objectHitsObstacle,
    objectBounds: objectBounds,
    textureGroundFill: textureGroundFill,
    textureTones: textureTones,
    featureBodyTone: featureBodyTone,
    featureOutlineTone: featureOutlineTone,
    featureSideTone: featureSideTone,
    featureHighlightTone: featureHighlightTone,
    featureRimTone: featureRimTone,
    featureSolidDepth: 0.2,
    featureBevelPx: 1.1,
    glyphSolidOutlinePx: 1.1,

    // Rendering constants, mirrored from app/texture_paint.dart and
    // core/terrain_texture.dart.
    textureOutlinePx: 0.9,
    textureShadowAlpha: 0.3,
    illustratedEdgeQuietWidth: 1.6,
    illustratedEdgeQuietAlpha: 0.62,
    illustratedEdgeBoundaryWidth: 2.4,
    illustratedEdgeBoundaryAlpha: 0.85,
  };

  root.HexLoreTextureSpec = TEX;
  if (typeof module !== "undefined" && module.exports) module.exports = TEX;
})(typeof globalThis !== "undefined" ? globalThis : this);
