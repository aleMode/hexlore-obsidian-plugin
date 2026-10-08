// Shared render spec — the JS MIRROR of lib/core/map_palette.dart.
//
// Every function and constant here must behave identically to its Dart
// counterpart. This is not a convention: the GM canvas and the player canvas
// draw the same map, so a divergence shows up as the two views disagreeing
// about what the terrain looks like. `test/render_spec_mirror_test.dart` runs
// this file under node against the same vector table as the Dart unit tests,
// so drift fails the build rather than the eye.
//
// Loaded as a plain <script> before player.js (it assigns a global), and
// require()-able from node for that test.

(function (root) {
  "use strict";

  // ----- hex-string colour helpers ------------------------------------------

  function parseHex(hex) {
    const h = hex.charAt(0) === "#" ? hex.slice(1) : hex;
    const v = parseInt(h.length === 8 ? h.slice(2) : h, 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }

  function formatHex(r, g, b) {
    const two = (c) =>
      Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0").toUpperCase();
    return "#" + two(r) + two(g) + two(b);
  }

  // Dart's .round() is round-half-away-from-zero; JS Math.round is
  // round-half-UP (-0.5 -> -0). Channel mixes are always >= 0 here, where the
  // two agree, but use an explicit helper so the intent survives edits.
  function roundHalfAway(x) {
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }

  function lerpHex(a, b, t) {
    const [ar, ag, ab] = parseHex(a);
    const [br, bg, bb] = parseHex(b);
    const mix = (x, y) => roundHalfAway(x + (y - x) * t);
    return formatHex(mix(ar, br), mix(ag, bg), mix(ab, bb));
  }

  function linearize(c) {
    const s = c / 255.0;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  // WCAG relative luminance (0 = black, 1 = white). Mirrors relativeLuminance.
  function relativeLuminance(hex) {
    const [r, g, b] = parseHex(hex);
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  }

  // ----- ink -----------------------------------------------------------------

  const INK_LUMA_THRESHOLD = 0.42;
  const INK_DARK = "#141420";
  const INK_LIGHT = "#F4F1E6";
  const INK_DARK_MIX = 0.66;
  const INK_LIGHT_MIX = 0.72;

  function inkFor(fill) {
    return relativeLuminance(fill) > INK_LUMA_THRESHOLD
      ? lerpHex(fill, INK_DARK, INK_DARK_MIX)
      : lerpHex(fill, INK_LIGHT, INK_LIGHT_MIX);
  }

  // ----- deterministic per-hex hash -----------------------------------------
  //
  // FNV-1a, masked to 32 bits. Math.imul is REQUIRED: `h * 0x01000193`
  // overflows the 53-bit mantissa and would silently diverge from Dart's
  // exact 64-bit multiply. `>>> 0` keeps the result unsigned, since JS bitwise
  // ops coerce to signed int32.

  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  function hash2(q, r, salt) {
    let h = FNV_OFFSET >>> 0;
    const feed = (byte) => {
      h = (h ^ (byte & 0xff)) >>> 0;
      h = Math.imul(h, FNV_PRIME) >>> 0;
    };
    for (let shift = 0; shift < 32; shift += 8) feed(q >> shift);
    for (let shift = 0; shift < 32; shift += 8) feed(r >> shift);
    feed(salt || 0);
    return h >>> 0;
  }

  function hashUnit(q, r, salt) {
    return (hash2(q, r, salt) & 0xffffff) / 0xffffff;
  }

  function hashSigned(q, r, salt, amount) {
    return (hashUnit(q, r, salt) * 2.0 - 1.0) * amount;
  }

  // ----- terrain grouping and edge topology ---------------------------------
  //
  // Mirrors terrainGroup/isBoundary in core/map_palette.dart and
  // hexEdgeNeighbors / canonicalEdge in core/river.dart + core/route.dart.
  // A divergence in canonicalEdge would drop or double cell outlines, so it is
  // covered by the mirror test alongside the colour maths.

  const GROUP_NONE = "none";
  const GROUP_WATER = "water";

  // Every biome value in core/hex_data.dart's Terrain enum. Needed because an
  // UNKNOWN terrain string (a stale or hand-edited file) must fall back the
  // same way on both sides: Dart's Terrain.fromValue returns `default`, so a
  // bare `return terrain` here would group it as its own terrain and outline
  // shapes the GM canvas doesn't. The mirror test walks the whole enum, so
  // this list cannot silently fall behind.
  const TERRAIN_VALUES = [
    "forest", "plains", "mountain", "sea", "hills", "desert",
    "swamp", "tundra", "lake", "jungle", "volcano", "default",
  ];

  // Grouping is on terrain ALONE — see the note in map_palette.dart: the
  // player payload never carries colorOverride, so any rule using it could not
  // be evaluated identically on both sides.
  function terrainGroup(terrain) {
    if (!terrain || TERRAIN_VALUES.indexOf(terrain) < 0) return GROUP_NONE;
    if (terrain === "default") return GROUP_NONE;
    if (terrain === "sea" || terrain === "lake") return GROUP_WATER;
    return terrain;
  }

  function isBoundary(a, b) {
    return a !== b;
  }

  // A water cell touching PAINTED land shows a coast halo. Unpainted does not
  // count, or every water hex at the fog frontier would be haloed.
  function isCoast(group, neighbour) {
    return (
      group === GROUP_WATER &&
      neighbour !== GROUP_WATER &&
      neighbour !== GROUP_NONE
    );
  }

  // Per-cell fill wobble; mirrors jitterFill in map_palette.dart. Applied only
  // to painted terrain — the ink is always derived from the UNJITTERED fill.
  const FILL_JITTER_AMOUNT = 0.06;
  const SALT_FILL_LIGHTNESS = 1;

  function jitterFill(fill, q, r) {
    const d = hashSigned(q, r, SALT_FILL_LIGHTNESS, FILL_JITTER_AMOUNT);
    return d >= 0 ? lerpHex(fill, "#FFFFFF", d) : lerpHex(fill, "#000000", -d);
  }

  // Neighbour across each of the 6 flat-top edges, indexed by edge k.
  const HEX_EDGE_NEIGHBORS = [
    [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
  ];

  // Canonical owner of hex (q, r)'s edge k, as [hq, hr, edge]: the
  // lexicographically smaller hex, with the edge re-expressed from there.
  // Drawing only edges a cell owns is what keeps each edge painted once.
  function canonicalEdge(q, r, k) {
    const [dq, dr] = HEX_EDGE_NEIGHBORS[((k % 6) + 6) % 6];
    const nq = q + dq, nr = r + dr;
    const selfSmaller = q < nq || (q === nq && r <= nr);
    return selfSmaller
      ? [q, r, ((k % 6) + 6) % 6]
      : [nq, nr, (k + 3) % 6];
  }

  // ----- shared render constants --------------------------------------------

  // ----- roads ---------------------------------------------------------------
  // Mirrors lib/core/road_style.dart: casing + body + core, and (Illustrated)
  // pebbles / paving joints along the body.

  const ROAD_STYLES = {
    highway: { base: 7.0, casingPad: 3.5, casingAlpha: 0.9, casingMix: 0.65,
      dash: [], bodyAlpha: 1.0, coreFrac: 0.16, coreMix: 0.55, coreDash: [7, 6],
      marks: "cobbles", markSpacing: 8.0 },
    road: { base: 5.0, casingPad: 2.5, casingAlpha: 0.85, casingMix: 0.6,
      dash: [], bodyAlpha: 1.0, coreFrac: 0.45, coreMix: 0.2, coreDash: [],
      marks: "pebbles", markSpacing: 6.0 },
    trail: { base: 3.5, casingPad: 1.5, casingAlpha: 0.28, casingMix: 0.6,
      dash: [10, 7, 5, 7], bodyAlpha: 0.9, coreFrac: 0.0, coreMix: 0.0, coreDash: [],
      marks: "pebbles", markSpacing: 14.0 },
  };
  const ROAD_KINDS_BY_RANK = ["trail", "road", "highway"];
  const BORDER_STYLE = { base: 3.0, dash: [12, 6, 3, 6] };
  const ROAD_MARK_CAP = 4000;
  const CASING_DARK = "#1A1208";
  const CASING_LIGHT = "#EDE6D2";
  const DARK_BODY_LUMA = 0.06;
  const DARK_MARK_LUMA = 0.12;

  // A road style by kind; null for a border. Unknown kinds draw as a road.
  function roadStyleOf(kind) {
    return kind === "border" ? null : (ROAD_STYLES[kind] || ROAD_STYLES.road);
  }
  function roadDefaultColor(kind) {
    return kind === "highway" ? "#B9A98A" : "#6B4A2F";
  }
  function roadCasingColor(body, style) {
    return relativeLuminance(body) < DARK_BODY_LUMA
      ? lerpHex(body, CASING_LIGHT, 0.5)
      : lerpHex(body, CASING_DARK, style.casingMix);
  }
  function roadCoreColor(body, style) {
    return lerpHex(body, "#FFFFFF", style.coreMix);
  }
  function roadMarkColor(body) {
    return relativeLuminance(body) < DARK_MARK_LUMA
      ? lerpHex(body, CASING_LIGHT, 0.4)
      : lerpHex(body, CASING_DARK, 0.5);
  }
  function roadCasingWidth(style, w) { return (style.base + style.casingPad) * w; }
  function roadBodyWidth(style, w) { return style.base * w; }

  // Catmull-Rom through pts ([[x, y], ...]) flattened to `steps` pieces per
  // span — mirrors smoothPolyline.
  function smoothPolyline(pts, steps) {
    steps = steps || 6;
    if (pts.length < 3) return pts.slice();
    const ext = [pts[0], ...pts, pts[pts.length - 1]];
    const out = [pts[0]];
    for (let i = 1; i < ext.length - 2; i++) {
      const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        out.push([
          u * u * u * p1[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p2[0],
          u * u * u * p1[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * p2[1],
        ]);
      }
    }
    return out;
  }

  // Mirrors roadMarks: { pebbles: flat x,y,r; ticks: flat x1,y1,x2,y2 }.
  function roadMarks(style, flat, routeWidth, seed) {
    const none = { pebbles: [], ticks: [] };
    if (style.marks === "none" || flat.length < 2) return none;
    const dist = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    const halfBody = roadBodyWidth(style, routeWidth) / 2;
    const pebbles = [], ticks = [];
    let seg = 0, segStart = 0, segLen = dist(flat[0], flat[1]);
    let at = style.markSpacing / 2;
    for (let i = 0; i < ROAD_MARK_CAP; i++) {
      const along = style.marks === "pebbles"
        ? at + (hashUnit(i, seed, 3) - 0.5) * style.markSpacing * 0.8
        : at;
      while (along > segStart + segLen && seg + 2 < flat.length) {
        segStart += segLen;
        seg++;
        segLen = dist(flat[seg], flat[seg + 1]);
      }
      if (along > segStart + segLen) break;
      at += style.markSpacing;
      if (segLen <= 1e-9) continue;
      const a = flat[seg], b = flat[seg + 1];
      const t = Math.max(0, (along - segStart) / segLen);
      const tx = (b[0] - a[0]) / segLen, ty = (b[1] - a[1]) / segLen;
      const nx = -ty, ny = tx;
      const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t;
      if (style.marks === "pebbles") {
        const lateral = (hashUnit(i, seed, 1) * 2 - 1) * halfBody * 0.8;
        pebbles.push(cx + nx * lateral, cy + ny * lateral, 0.5 + hashUnit(i, seed, 2) * 0.6);
      } else {
        const lean = (i % 2 === 0 ? 1 : -1) * 0.18 * halfBody;
        const half = halfBody * 0.85;
        ticks.push(cx - nx * half - tx * lean, cy - ny * half - ty * lean,
          cx + nx * half + tx * lean, cy + ny * half + ty * lean);
      }
    }
    return { pebbles, ticks };
  }

  // ----- river mouths -------------------------------------------------------
  // Mirrors lib/core/river_mouth.dart (the rules are documented there): a
  // river is cut where it meets lake or sea and widens into a mouth at the
  // shore. Points are [x, y]; wet(x, y) says whether a scene point is water.

  const RIVER_MOUTH_REACH = 0.45;
  const RIVER_MOUTH_FLARE = 2.2;
  const RIVER_MOUTH_SPILL = 0.18;
  const RIVER_COURSE_STEP = 1 / 12;
  const RIVER_MIN_RUN = 0.3;

  function cDist(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function cLerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function cUnit(x, y) {
    const l = Math.sqrt(x * x + y * y);
    return l === 0 ? [0, 0] : [x / l, y / l];
  }

  function cLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += cDist(pts[i - 1], pts[i]);
    return len;
  }

  function sampleSmoothCourse(pts, step) {
    if (pts.length < 2) return pts.slice();
    if (pts.length === 2) {
      const n = Math.max(1, Math.ceil(cDist(pts[0], pts[1]) / step));
      const out = [];
      for (let k = 0; k <= n; k++) out.push(cLerp(pts[0], pts[1], k / n));
      return out;
    }
    const ext = [pts[0], ...pts, pts[pts.length - 1]];
    const out = [pts[0]];
    for (let i = 1; i < ext.length - 2; i++) {
      const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      const len = (cDist(p1, c1) + cDist(c1, c2) + cDist(c2, p2) + cDist(p1, p2)) / 2;
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push([
          a * p1[0] + b * c1[0] + c * c2[0] + d * p2[0],
          a * p1[1] + b * c1[1] + c * c2[1] + d * p2[1],
        ]);
      }
    }
    return out;
  }

  function shoreDirection(p, wet, eps) {
    let sx = 0, sy = 0, wetCount = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k + 0.5) * Math.PI / 6;
      const dx = Math.cos(a), dy = Math.sin(a);
      if (wet(p[0] + dx * eps, p[1] + dy * eps)) {
        sx += dx;
        sy += dy;
        wetCount++;
      }
    }
    if (wetCount === 0 || wetCount === 12) return null;
    return cUnit(sx, sy);
  }

  function courseTail(pts, length) {
    const out = [pts[pts.length - 1]];
    let left = length;
    for (let i = pts.length - 1; i > 0; i--) {
      const seg = cDist(pts[i], pts[i - 1]);
      if (seg >= left) {
        out.push(cLerp(pts[i], pts[i - 1], seg === 0 ? 0 : left / seg));
        break;
      }
      out.push(pts[i - 1]);
      left -= seg;
    }
    return out.reverse();
  }

  // -> null (never touches water) or
  //    {runs: [{points, shoreAtStart, shoreAtEnd}], mouths: [{spine, into}]}
  function splitCourseAtWater(samples, wet, radius) {
    const n = samples.length;
    if (n < 2) return null;
    const isWet = (p) => !!wet(p[0], p[1]);
    const d = [0];
    for (let i = 1; i < n; i++) d.push(d[i - 1] + cDist(samples[i - 1], samples[i]));
    const runs = []; // [first sample, last sample, wet]
    for (let i = 0; i < n; i++) {
      const w = isWet(samples[i]);
      if (runs.length && runs[runs.length - 1][2] === w) runs[runs.length - 1][1] = i;
      else runs.push([i, i, w]);
    }
    const extent = (run) => {
      const a = run[0], b = run[1];
      const s = a === 0 ? 0 : (d[a - 1] + d[a]) / 2;
      const e = b === n - 1 ? d[n - 1] : (d[b] + d[b + 1]) / 2;
      return e - s;
    };
    const minRun = RIVER_MIN_RUN * radius;
    const absorb = (flag) => {
      for (let k = 0; k < runs.length && runs.length > 1; k++) {
        if (runs[k][2] !== flag || extent(runs[k]) >= minRun) continue;
        runs[k][2] = !flag;
      }
      for (let k = runs.length - 1; k > 0; k--) {
        if (runs[k][2] !== runs[k - 1][2]) continue;
        runs[k - 1][1] = runs[k][1];
        runs.splice(k, 1);
      }
    };
    absorb(true);
    absorb(false);

    const eps = 0.06 * radius;
    const startInto = runs[0][2] === false ? shoreDirection(samples[0], wet, eps) : null;
    const endInto = runs[runs.length - 1][2] === false
      ? shoreDirection(samples[n - 1], wet, eps)
      : null;
    if (runs.length === 1 &&
        (runs[0][2] === true || (startInto === null && endInto === null))) {
      return runs[0][2] === true ? { runs: [], mouths: [] } : null;
    }

    const crossing = (i) => {
      let a = samples[i], b = samples[i + 1];
      const wa = isWet(a);
      if (wa === isWet(b)) return cLerp(a, b, 0.5);
      for (let k = 0; k < 20; k++) {
        const m = cLerp(a, b, 0.5);
        if (isWet(m) === wa) a = m;
        else b = m;
      }
      return cLerp(a, b, 0.5);
    };

    const out = [], mouths = [];
    for (const run of runs) {
      if (run[2] === true) continue;
      const a = run[0], b = run[1];
      const pts = [];
      if (a > 0) pts.push(crossing(a - 1));
      for (let i = a; i <= b; i++) pts.push(samples[i]);
      if (b < n - 1) pts.push(crossing(b));
      const inStart = a > 0
        ? cUnit(samples[a - 1][0] - samples[a][0], samples[a - 1][1] - samples[a][1])
        : startInto;
      const inEnd = b < n - 1
        ? cUnit(samples[b + 1][0] - samples[b][0], samples[b + 1][1] - samples[b][1])
        : endInto;
      out.push({ points: pts, shoreAtStart: inStart !== null, shoreAtEnd: inEnd !== null });
      const len = cLength(pts);
      const reach = Math.min(RIVER_MOUTH_REACH * radius,
        inStart !== null && inEnd !== null ? len / 2 : len);
      if (reach <= 0) continue;
      if (inStart !== null) {
        mouths.push({ spine: courseTail(pts.slice().reverse(), reach), into: inStart });
      }
      if (inEnd !== null) mouths.push({ spine: courseTail(pts, reach), into: inEnd });
    }
    return { runs: out, mouths: mouths };
  }

  // wet / extend: carry each flank on along the final heading until it
  // reaches water (see mouthOutline in river_mouth.dart).
  function mouthOutline(m, halfStart, halfEnd, spill, wet, extend) {
    const s = m.spine;
    const len = cLength(s);
    const left = [], right = [];
    let acc = 0;
    let [tx, ty] = m.into;
    for (let i = 0; i < s.length; i++) {
      if (i > 0) acc += cDist(s[i - 1], s[i]);
      const t = len === 0 ? 1 : acc / len;
      const h = halfStart + (halfEnd - halfStart) * t * t;
      const prev = s[i === 0 ? 0 : i - 1], next = s[i === s.length - 1 ? i : i + 1];
      let [ux, uy] = cUnit(next[0] - prev[0], next[1] - prev[1]);
      if (ux === 0 && uy === 0) [ux, uy] = m.into;
      tx = ux;
      ty = uy;
      left.push([s[i][0] - ty * h, s[i][1] + tx * h]);
      right.push([s[i][0] + ty * h, s[i][1] - tx * h]);
    }
    if (wet && extend > 0) {
      const reach = (p) => {
        const steps = 12;
        for (let k = 0; k <= steps; k++) {
          const q = [p[0] + tx * extend * k / steps, p[1] + ty * extend * k / steps];
          if (wet(q[0], q[1])) return q;
        }
        return [p[0] + tx * extend, p[1] + ty * extend];
      };
      left.push(reach(left[left.length - 1]));
      right.push(reach(right[right.length - 1]));
    }
    if (spill > 0) {
      const [ix, iy] = m.into;
      const shore = s[s.length - 1];
      const e = [shore[0] + ix * spill, shore[1] + iy * spill];
      const h = halfEnd * 1.2;
      left.push([e[0] - iy * h, e[1] + ix * h]);
      right.push([e[0] + iy * h, e[1] - ix * h]);
    }
    return left.concat(right.reverse());
  }

  const SPEC = {
    saltFillLightness: 1,
    fillJitterAmount: 0.06,
    terrainStampScale: 0.5,
    featureStampScale: 0.42,
    stampCentreOffset: 0.08,
    stampStrokeRatio: 0.08,
    labelOffset: 0.45,
    labelFontSize: 11.0,
    labelHaloWidth: 3.5,
    labelInk: "#E8E8F0",
    labelHalo: "#1A1A2E",

    edgeColor: "#2A2A4A",
    edgeQuietWidth: 1.0,
    edgeQuietAlpha: 0.22,
    edgeBoundaryWidth: 2.0,
    edgeBoundaryAlpha: 0.55,

    coastInset: 0.86,
    coastWidth: 3.0,
    coastAlpha: 0.16,
    coastColor: "#FFFFFF",
    isCoast: isCoast,
    jitterFill: jitterFill,

    groupNone: GROUP_NONE,
    groupWater: GROUP_WATER,
    terrainGroup: terrainGroup,
    isBoundary: isBoundary,
    hexEdgeNeighbors: HEX_EDGE_NEIGHBORS,
    canonicalEdge: canonicalEdge,

    parseHex: parseHex,
    formatHex: formatHex,
    lerpHex: lerpHex,
    relativeLuminance: relativeLuminance,
    inkFor: inkFor,
    hash2: hash2,
    hashUnit: hashUnit,
    hashSigned: hashSigned,

    roadStyles: ROAD_STYLES,
    roadKindsByRank: ROAD_KINDS_BY_RANK,
    borderStyle: BORDER_STYLE,
    roadStyleOf: roadStyleOf,
    roadDefaultColor: roadDefaultColor,
    roadCasingColor: roadCasingColor,
    roadCoreColor: roadCoreColor,
    roadMarkColor: roadMarkColor,
    roadCasingWidth: roadCasingWidth,
    roadBodyWidth: roadBodyWidth,
    smoothPolyline: smoothPolyline,
    roadMarks: roadMarks,

    riverMouthReach: RIVER_MOUTH_REACH,
    riverMouthFlare: RIVER_MOUTH_FLARE,
    riverMouthSpill: RIVER_MOUTH_SPILL,
    riverCourseStep: RIVER_COURSE_STEP,
    riverMinRun: RIVER_MIN_RUN,
    sampleSmoothCourse: sampleSmoothCourse,
    splitCourseAtWater: splitCourseAtWater,
    mouthOutline: mouthOutline,
  };

  root.HexLoreSpec = SPEC;
  if (typeof module !== "undefined" && module.exports) module.exports = SPEC;
})(typeof globalThis !== "undefined" ? globalThis : this);
