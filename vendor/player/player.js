// HexLore player map — MAP-ONLY: revealed hexes, rivers, and roads/trails.
// Threads, NPCs, quests, docs are GM material and are never served.
// The axial->pixel formula is intentionally mirrored from the Dart side
// (core/geometry.dart) -- keep them in sync.

const R = 48;                       // hex radius, matches the desktop canvas
const SQRT3 = Math.sqrt(3);

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("campaign-name");

let state = { hexes: [], rivers: [], routes: [], grid: null };
let view = { scale: 1, ox: 0, oy: 0 };
let hover = null;                   // {q, r, hex|null} — any in-grid cell

function axialToPixel(q, r) {
  return { x: R * 1.5 * q, y: R * SQRT3 * (r + q / 2) };
}

// ----- pixel -> cell (mirrors core/geometry.dart) ---------------------------
// Needed because a travel vote may name an UNEXPLORED cell: hit-testing can no
// longer just scan the served hexes, it has to invert the projection.

// Dart's .round() breaks ties away from zero; Math.round breaks them toward
// +Infinity. Exact .5 is vanishingly rare from a pointer, but axialRound is a
// mirrored function and a mirror that is "almost" right is the worst kind.
function dartRound(v) {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

function axialRound(qf, rf) {
  const xf = qf, zf = rf, yf = -xf - zf;
  let rx = dartRound(xf), ry = dartRound(yf), rz = dartRound(zf);
  const dx = Math.abs(rx - xf), dy = Math.abs(ry - yf), dz = Math.abs(rz - zf);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

function pixelToAxial(x, y) {
  return axialRound(((2 / 3) * x) / R, ((-1 / 3) * x + (SQRT3 / 3) * y) / R);
}

// First row index of column q in the staggered grid window (colRStart).
function colRStart(q, rShift) {
  return -Math.floor(q / 2) + rShift;
}

function cellInGrid(q, r) {
  const g = state.grid;
  if (!g) return false;
  if (q < g.min_q || q >= g.min_q + g.cols) return false;
  const start = colRStart(q, g.r_shift);
  return r >= start && r < start + g.rows;
}

// The extreme cells of the grid window — enough to bound it. Both parities at
// each end, because the staggered rStart makes the vertical extent wobble by
// half a row between odd and even columns (same trick as gridPixelBounds).
function* cellsInGridWindow() {
  const g = state.grid;
  if (!g || g.cols <= 0 || g.rows <= 0) return;
  const maxQ = g.min_q + g.cols - 1;
  for (const q of [g.min_q, Math.min(g.min_q + 1, maxQ), Math.max(maxQ - 1, g.min_q), maxQ]) {
    const start = colRStart(q, g.r_shift);
    yield { q, r: start };
    yield { q, r: start + g.rows - 1 };
  }
}

// In-grid cells overlapping a screen rect; mirrors geometry.cellsInRect, so
// drawing the empty lattice stays O(visible) however big the grid window is.
function* cellsInView() {
  const g = state.grid;
  if (!g) return;
  const left = (0 - view.ox) / view.scale, right = (viewW - view.ox) / view.scale;
  const top = (0 - view.oy) / view.scale, bottom = (viewH - view.oy) / view.scale;
  const colW = R * 1.5, rowH = R * SQRT3;
  const qLo = Math.max(Math.floor(left / colW) - 1, g.min_q);
  const qHi = Math.min(Math.ceil(right / colW) + 1, g.min_q + g.cols - 1);
  for (let q = qLo; q <= qHi; q++) {
    const rStart = colRStart(q, g.r_shift);
    const rEnd = rStart + g.rows - 1;
    const rLo = Math.max(Math.floor(top / rowH - q / 2) - 1, rStart);
    const rHi = Math.min(Math.ceil(bottom / rowH - q / 2) + 1, rEnd);
    for (let r = rLo; r <= rHi; r++) yield { q, r };
  }
}

// Canonical river vertex (q, r, corner) -> pixel; mirrors app/geometry.py
// vertex_pixel (corner 0 at 0deg, corner 1 at 60deg).
function vertexPixel(q, r, c) {
  const p = axialToPixel(q, r);
  const a = (Math.PI / 180) * (60 * c);
  return { x: p.x + R * Math.cos(a), y: p.y + R * Math.sin(a) };
}

// Route anchor (kind,q,r,k) -> pixel; mirrors core/geometry.dart node_pixel.
// kind: "v" corner vertex | "e" edge midpoint | "c" hex centre.
function nodePixel(kind, q, r, k) {
  if (kind === "v") return vertexPixel(q, r, k);
  const p = axialToPixel(q, r);
  if (kind === "c") return p;
  const ap = (R * SQRT3) / 2;                 // apothem (centre to edge)
  const a = (Math.PI / 180) * (30 + 60 * k);
  return { x: p.x + ap * Math.cos(a), y: p.y + ap * Math.sin(a) };
}

// Catmull-Rom -> cubic Bezier through screen points; mirrors the desktop
// river smoothing (app/river_item.py _catmull_rom_path).
function smoothPath(pts) {
  ctx.beginPath();
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return;
  if (pts.length === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
  const ext = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y);
  }
}

function hexCorners(cx, cy) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);   // flat-top: first corner at 0deg
    pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return pts;
}

// The canvas in CSS px (viewW × viewH) and its backing store in device px
// (× dpr), so a phone or a HiDPI screen gets a sharp map instead of one
// stretched 2–3×. Everything below draws in CSS px; render() sets the scale.
let dpr = 1, viewW = 0, viewH = 0;

function resize() {
  dpr = window.devicePixelRatio || 1;
  viewW = canvas.clientWidth;
  viewH = canvas.clientHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  renderNow(); // resizing cleared the canvas: don't leave it blank a frame
}

// The scene rect on screen, grown by `pad` scene px on every side.
function viewRect(pad) {
  return {
    l: -view.ox / view.scale - pad,
    t: -view.oy / view.scale - pad,
    r: (viewW - view.ox) / view.scale + pad,
    b: (viewH - view.oy) / view.scale + pad,
  };
}

function inRect(rect, p) {
  return p.x >= rect.l && p.x <= rect.r && p.y >= rect.t && p.y <= rect.b;
}

function worldToScreen(x, y) {
  return { x: x * view.scale + view.ox, y: y * view.scale + view.oy };
}

// Frame the revealed hexes, or the whole grid window when nothing is revealed
// yet — with the lattice drawn there is always something to look at.
function centerOnContent() {
  const cells = state.hexes.length
    ? state.hexes
    : [...cellsInGridWindow()];
  if (!cells.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const h of cells) {
    const p = axialToPixel(h.q, h.r);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  view.ox = viewW / 2 - cx * view.scale;
  view.oy = viewH / 2 - cy * view.scale;
}

// River stroke constants; mirror app/river_item.py (border/water/glint).
const RIVER_BORDER = { color: "#5C3210", w: 8.0 };
const RIVER_WATER  = { color: "#3A7DBF", w: 5.0 };
const RIVER_GLINT  = { color: "rgba(107,174,214,0.6)", w: 1.8 };

// A served river anchor -> pixel. Rivers now walk the SAME anchor set routes
// do (corner / edge midpoint / centre), so an anchor arrives as
// [kind, q, r, k]. The legacy 3-element [q, r, corner] form is still accepted
// because an old campaign's rivers.json is read as-is: the discriminator is
// whether the first element is a string, exactly as core/river.dart does it.
function riverAnchorPixel(v) {
  if (typeof v[0] === "string") return nodePixel(v[0], v[1], v[2], v[3] || 0);
  return vertexPixel(v[0], v[1], v[2]);
}

// Rivers, mirroring _paintRivers: a segment that never meets water is its
// smooth path; one that does is cut at the shore into dry runs plus MOUTHS
// (render_spec.js splitCourseAtWater), which flare and fade into the fill of
// the water they meet. Water is what the player can see: an unrevealed lake
// is not water here, so a river running into fog is drawn as before.
function drawRivers(groups, fills) {
  const isWater = (q, r) => groups.get(cellKey(q, r)) === SPEC.groupWater;
  const wet = (x, y) => {
    const c = pixelToAxial(x, y);
    return isWater(c.q, c.r);
  };
  const toScreen = (p) => worldToScreen(p[0], p[1]);
  const whole = [], split = [];
  const nearWater = new Map(); // water cells a split river could paint over
  for (const river of state.rivers || []) {
    for (const seg of river.segments) {
      const world = seg.map((v) => {
        const p = riverAnchorPixel(v);
        return [p.x, p.y];
      });
      const samples = SPEC.sampleSmoothCourse(world, R * SPEC.riverCourseStep);
      const s = SPEC.splitCourseAtWater(samples, wet, R);
      if (!s) {
        whole.push({ width: river.width, pts: world.map((p) => toScreen(p)) });
        continue;
      }
      split.push({ width: river.width, s });
      const seen = new Set();
      for (const p of samples) {
        const c = pixelToAxial(p[0], p[1]);
        const key = cellKey(c.q, c.r);
        if (seen.has(key)) continue;
        seen.add(key);
        for (const [dq, dr] of [[0, 0], ...SPEC.hexEdgeNeighbors]) {
          if (isWater(c.q + dq, c.r + dr)) {
            nearWater.set(cellKey(c.q + dq, c.r + dr), { q: c.q + dq, r: c.r + dr });
          }
        }
      }
    }
  }
  const polygon = (pts) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const q = toScreen(p);
      if (i) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
    });
    ctx.closePath();
  };
  // Hexes as subpaths of the current path; `reversed` winds them against
  // ctx.rect, so under nonzero they cut holes (shared edges cancel too).
  const addHexes = (cells, reversed) => {
    for (const { q, r } of cells) {
      const c = axialToPixel(q, r);
      const corners = hexCorners(c.x, c.y).map((p) => worldToScreen(p[0], p[1]));
      if (reversed) corners.reverse();
      corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    }
  };
  const clipToLand = () => {
    ctx.beginPath();
    ctx.rect(0, 0, viewW, viewH);
    addHexes(nearWater.values(), true);
    ctx.clip("nonzero");
  };
  // Mirrors _paintRivers' mouthClip: a mouth stays inside the land cells its
  // spine runs through; its fade, those plus the water cell it opens into.
  const mouthInfo = new Map();
  for (const { s } of split) {
    for (const m of s.mouths) {
      const land = new Map();
      for (const p of m.spine) {
        const c = pixelToAxial(p[0], p[1]);
        if (!isWater(c.q, c.r)) land.set(cellKey(c.q, c.r), { q: c.q, r: c.r });
      }
      const shore = m.spine[m.spine.length - 1];
      const d = pixelToAxial(shore[0] + m.into[0] * R * 0.1, shore[1] + m.into[1] * R * 0.1);
      const f = fills.get(cellKey(d.q, d.r));
      mouthInfo.set(m, { land: [...land.values()], dest: d, fill: f ? f.drawn : null });
    }
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const layer of [RIVER_BORDER, RIVER_WATER, RIVER_GLINT]) {
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    for (const s of whole) {
      ctx.lineWidth = layer.w * s.width * view.scale;
      smoothPath(s.pts);
      ctx.stroke();
    }
    if (!split.length) continue;
    ctx.save();
    clipToLand();
    for (const { width, s } of split) {
      const half = (layer.w * width) / 2;
      ctx.lineWidth = layer.w * width * view.scale;
      for (const run of s.runs) {
        ctx.beginPath();
        run.points.forEach((p, i) => {
          const q = toScreen(p);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        ctx.stroke();
      }
      if (layer === RIVER_GLINT) continue; // the fade below swallows it
      for (const m of s.mouths) {
        const flare = half * SPEC.riverMouthFlare;
        ctx.save();
        ctx.beginPath();
        addHexes(mouthInfo.get(m).land, false);
        ctx.clip("nonzero");
        polygon(SPEC.mouthOutline(m, half, flare, 0, wet, 4 * flare));
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }
  // The fade into the water's own fill, spilling past the shore so the
  // coastline opens where the river comes in.
  for (const { width, s } of split) {
    const half = (RIVER_WATER.w * width) / 2;
    for (const m of s.mouths) {
      const info = mouthInfo.get(m);
      if (!info.fill) continue;
      const shore = m.spine[m.spine.length - 1];
      const spill = R * SPEC.riverMouthSpill;
      const start = m.spine[0];
      const end = [shore[0] + m.into[0] * spill, shore[1] + m.into[1] * spill];
      const total = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const atShore = total === 0 ? 1
        : Math.min(1, Math.max(0, Math.hypot(shore[0] - start[0], shore[1] - start[1]) / total));
      const a = toScreen(start), b = toScreen(end);
      const [r, g, bl] = SPEC.parseHex(info.fill);
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, `rgba(${r},${g},${bl},0)`);
      grad.addColorStop(atShore, `rgb(${r},${g},${bl})`);
      grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
      ctx.save();
      ctx.beginPath();
      addHexes([...info.land, info.dest], false);
      ctx.clip("nonzero");
      polygon(SPEC.mouthOutline(m, half, half * SPEC.riverMouthFlare, spill));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }
  }
}

// ----- feature stamps -------------------------------------------------------
// Icon-only overlays (city, settlement, mine, ...) served per revealed hex.
// Ported from app/stamps.dart -- keep the two in sync. Variant index mirrors
// featureVariantNames in core/hex_data.dart; out-of-range clamps to default.
//
// The ink is DERIVED FROM THE HEX FILL via the shared render spec (see
// render_spec.js / core/map_palette.dart): one constant cream could not stay
// legible across a palette spanning jungle #2D6B3C to tundra #B8C8D8.
const SPEC = globalThis.HexLoreSpec;
const DEFAULT_FILL = "#8A8A9A";

function sLine(x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
// Upper half-ellipse opening downward (Dart _topArc).
function sTopArc(cx, cy, rx, ry) {
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, Math.PI * 2);
  ctx.stroke();
}

// ----- biome stamps (procedural) --------------------------------------------
// Ported from _terrainDrawers in app/stamps.dart -- keep the two in sync. Only
// lake, tundra, hills and desert remain procedural (no good vendored glyph
// match for the first two; hills and desert both went glyph, then came back
// by GM preference -- see stamps.dart); every other biome renders via
// TERRAIN_GLYPHS below, mirroring drawBiomeStamp in app/glyphs.dart. Variant
// index mirrors terrainVariantNames in core/hex_data.dart; out-of-range clamps.
//
// A hex shows its FEATURE stamp if it has one, else its biome stamp -- same
// rule as the GM canvas (_paintCells).

// Dart _topArc takes a Rect; sTopArc takes centre + radii. Rect(l,t,w,h) maps
// to centre (l + w/2, t + h/2) with radii (w/2, h/2).
function sRectArc(l, t, w, hh) {
  sTopArc(l + w / 2, t + hh / 2, w / 2, hh / 2);
}

function sOval(cx, cy, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  fill ? ctx.fill() : ctx.stroke();
}

// Dart _wave: one "~" wavelet, a hump up then down.
function sWave(x0, y, w, a) {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.quadraticCurveTo(x0 + w * 0.25, y - a, x0 + w * 0.5, y);
  ctx.quadraticCurveTo(x0 + w * 0.75, y + a, x0 + w, y);
  ctx.stroke();
}

function sCircle(cx, cy, r, fill) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  fill ? ctx.fill() : ctx.stroke();
}

const TERRAIN = {
  lake: [
    (s) => {
      sOval(0, 0.05 * s, 0.35 * s, 0.22 * s, true);
      sRectArc(-0.55 * s, -0.25 * s, 1.1 * s, 0.55 * s);
    },
  ],
  hills: [
    (s) => {
      sRectArc(-0.7 * s, -0.1 * s, 0.8 * s, 0.8 * s);
      sRectArc(-0.1 * s, -0.25 * s, 0.8 * s, 0.8 * s);
    },
    (s) => {                                        // rocky
      TERRAIN.hills[0](s);
      for (const [dx, dy] of [[-0.35 * s, 0.55 * s], [0, 0.6 * s], [0.35 * s, 0.55 * s]]) {
        sCircle(dx, dy, 0.07 * s, true);
      }
    },
  ],
  tundra: [
    (s) => {
      for (let angle = 0; angle < 180; angle += 30) {
        const rad = (angle * Math.PI) / 180;
        const dx = Math.cos(rad) * 0.55 * s, dy = Math.sin(rad) * 0.55 * s;
        sLine(-dx, -dy, dx, dy);
      }
    },
    (s) => {                                        // cracked ice
      sLine(-0.6 * s, 0, 0.6 * s, 0);
      for (const pts of [
        [[-0.35 * s, 0], [-0.2 * s, -0.28 * s], [0, -0.18 * s], [0.18 * s, -0.42 * s]],
        [[0.1 * s, 0], [0.02 * s, 0.25 * s], [0.28 * s, 0.4 * s]],
      ]) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    },
  ],
  desert: [
    (s) => {                                        // dunes: three receding ridges
      sRectArc(-0.75 * s, 0.05 * s, 0.85 * s, 0.55 * s);
      sRectArc(-0.15 * s, -0.05 * s, 0.75 * s, 0.5 * s);
      sRectArc(0.15 * s, -0.15 * s, 0.6 * s, 0.42 * s);
    },
    (s) => {                                        // cracked ground: radiates from centre
      for (const pts of [
        [[0, 0], [-0.15 * s, -0.22 * s], [-0.1 * s, -0.5 * s]],
        [[0, 0], [0.05 * s, -0.3 * s], [0.28 * s, -0.48 * s]],
        [[0, 0], [-0.32 * s, 0.05 * s], [-0.58 * s, -0.08 * s]],
        [[0, 0], [0.3 * s, -0.02 * s], [0.55 * s, 0.12 * s]],
        [[0, 0], [-0.18 * s, 0.25 * s], [-0.32 * s, 0.5 * s]],
        [[0, 0], [0.15 * s, 0.3 * s], [0.1 * s, 0.55 * s]],
      ]) {
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.stroke();
      }
    },
    (s) => {                                        // beach: surf over a shoreline
      for (const [x0, y] of [[-0.5 * s, -0.38 * s], [-0.05 * s, -0.2 * s]]) {
        sWave(x0, y, 0.5 * s, 0.1 * s);
      }
      ctx.beginPath();
      ctx.moveTo(-0.6 * s, 0.08 * s);
      ctx.bezierCurveTo(-0.2 * s, -0.12 * s, 0.2 * s, 0.22 * s, 0.6 * s, 0.02 * s);
      ctx.stroke();
      for (const [dx, dy] of [[-0.3 * s, 0.38 * s], [0.05 * s, 0.48 * s], [0.35 * s, 0.32 * s]]) {
        sCircle(dx, dy, 0.05 * s, true);
      }
    },
  ],
};

function drawTerrainProcedural(h) {
  const fns = TERRAIN[h.terrain];
  if (!fns) return;
  const v = Math.max(0, Math.min(h.terrain_variant || 0, fns.length - 1));
  const c = axialToPixel(h.q, h.r);
  const p = worldToScreen(c.x, c.y + R * SPEC.stampCentreOffset);
  const s = R * SPEC.terrainStampScale * view.scale;
  const ink = SPEC.inkFor(h.color || DEFAULT_FILL);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(1, s * SPEC.stampStrokeRatio);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  fns[v](s);
  ctx.restore();
}

// Feature glyphs AND glyph-based biome stamps (game-icons silhouettes), from
// the generated tables shared with the Flutter painter -- see
// feature_glyphs.js / terrain_glyphs.js / core/glyph_data.dart. Path2D
// consumes the normalised M/L/C/Z data directly, so no parser here.
const GLYPHS = globalThis.HexLoreGlyphs;
const TERRAIN_GLYPHS = globalThis.HexLoreTerrainGlyphs;
const TEXTURES = globalThis.HexLoreTextures;
const TEX = globalThis.HexLoreTextureSpec;
const GLYPH_HALO_WIDTH = 2.5; // scene px; mirrors glyphHaloWidth in glyphs.dart
const GLYPH_OUTLINE_WIDTH = 1.4; // mirrors glyphOutlineWidth in glyphs.dart

// ----- map style ------------------------------------------------------------
// "clean" (fill + one stamp) or "illustrated" (ground textures, features as
// objects) — see docs/illustrated-map-plan.md. A per-viewer preference kept
// in localStorage, default illustrated; the GM's own choice is not served
// (the payload is unchanged), so each player picks what reads best for them.
const STYLE_KEY = "hexlore.mapStyle";
const BLEND_KEY = "hexlore.blend";
let blendEdges = false;
try {
  blendEdges = localStorage.getItem(BLEND_KEY) === "1";
} catch (_) {
  /* storage blocked: keep the default */
}
let mapStyle = "illustrated";
try {
  mapStyle = localStorage.getItem(STYLE_KEY) || "illustrated";
} catch (_) {
  /* storage blocked: keep the default */
}
// ?style=clean|illustrated and ?blend=0|1 override the saved choice for this
// visit only (handy for comparing looks, and for scripted screenshots). Read
// AFTER both saved values, so the URL wins — and after `let mapStyle`, which
// assigning earlier throws (a ReferenceError that stopped the page loading).
{
  const q = new URLSearchParams(location.search);
  if (q.get("style") === "clean" || q.get("style") === "illustrated") mapStyle = q.get("style");
  if (q.has("blend")) blendEdges = q.get("blend") === "1";
}

// ----- illustrated textures -------------------------------------------------
// Mirrors app/texture_paint.dart. Each distinct (variant, layout, mirror,
// feature slot, LOD, ground, slice, resolution) is rendered once into an
// offscreen canvas clipped to the hexagon and blitted per hex; the key holds
// no hex, so a reveal or a repaint only ever selects a key.
const TEX_MAX_CANVASES = 384;
const texCanvases = new Map(); // insertion order = LRU order
const texPaths = new Map();

function texPath(si, pi) {
  const key = si * 64 + pi;
  let p = texPaths.get(key);
  if (!p) {
    p = new Path2D(TEXTURES.symbols[si].parts[pi][1]);
    texPaths.set(key, p);
  }
  return p;
}

function argbCss(argb, alpha) {
  const r = (argb >>> 16) & 255, g = (argb >>> 8) & 255, b = argb & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function hexCss(hex, alpha) {
  if (alpha >= 1) return hex;
  const [r, g, b] = SPEC.parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// One placed symbol into an offscreen context whose unit is `px` pixels per
// hex radius. Mirrors _drawSymbol: shadows, then the outline (every solid part
// stroked at twice the width so only the silhouette line survives the fills),
// then fills and ink in source order.
function drawTextureSymbol(c, p, tones, px, object) {
  const K = TEX.KIND;
  const parts = TEXTURES.symbols[p.symbol].parts;
  const s = p.size * px;
  c.save();
  c.translate(p.x * px, p.y * px);
  c.scale(p.flip ? -s : s, s);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i][0] !== K.shadow) continue;
    c.fillStyle = `rgba(0,0,0,${TEX.textureShadowAlpha})`;
    c.fill(texPath(p.symbol, i));
  }
  if (object) {
    c.lineJoin = "round";
    c.strokeStyle = tones.outline;
    c.lineWidth = (2 * TEX.textureOutlinePx * (px / R)) / s;
    for (let i = 0; i < parts.length; i++) {
      const [kind, , , , , stroke] = parts[i];
      if (stroke === 0 && (kind === K.shape || kind === K.trunk || kind === K.accent || kind === K.snow)) {
        c.stroke(texPath(p.symbol, i));
      }
    }
  }
  for (let i = 0; i < parts.length; i++) {
    const [kind, , shade, argb, opacity, stroke] = parts[i];
    let colour;
    switch (kind) {
      case K.shadow: continue;
      case K.shape: colour = hexCss(tones.object(shade), opacity); break;
      case K.trunk: colour = hexCss(tones.trunk, opacity); break;
      case K.ink: colour = hexCss(tones.outline, opacity); break;
      case K.ground: colour = hexCss(tones.ground(shade), opacity); break;
      case K.snow: colour = hexCss(tones.snow(shade), opacity); break;
      default: colour = argbCss(argb, opacity); break; // accent
    }
    if (stroke > 0) {
      c.strokeStyle = colour;
      c.lineWidth = stroke;
      c.lineCap = "round";
      c.stroke(texPath(p.symbol, i));
    } else {
      c.fillStyle = colour;
      c.fill(texPath(p.symbol, i));
    }
  }
  c.restore();
}

// One slice of a hex's texture as {cv, left, top} — an offscreen canvas and
// where its top-left sits relative to the hex centre, in offscreen px — or
// null when the slice draws nothing. "ground" is clipped to the hexagon;
// "behind"/"front" objects are NOT, and their canvas is sized to what they
// cover (mirrors _record / _image in texture_paint.dart).
function textureCanvas(key, variant, pick, slot, lod, ground, slice, px, obstacles, blendMask) {
  if (texCanvases.has(key)) {
    const hit = texCanvases.get(key);
    texCanvases.delete(key); // most recently used goes last
    texCanvases.set(key, hit);
    return hit;
  }
  const layout = variant.layouts[pick.layout];
  const slices = TEX.sliceLayout(layout, {
    flip: pick.flip,
    featureSlot: slot,
    lodCount: TEX.textureLodCount(lod, layout.objects.length / TEX.placementStride),
    obstacles: slice === "ground" ? [] : obstacles,
    blendMask: slice === "ground" ? 0 : blendMask,
  });
  const tones = TEX.textureTones(ground, variant);
  const objects = slice === "front" ? slices.front : slices.behind;
  let bounds; // hex radii
  if (slice === "ground") {
    bounds = slices.ground.length ? [-1, -Math.sqrt(3) / 2, 1, Math.sqrt(3) / 2] : null;
  } else {
    bounds = TEX.objectBounds(objects);
    if (bounds) {
      const pad = (TEX.textureOutlinePx * 2) / R; // the outline is not in the extent
      bounds = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
    }
  }
  let hit = null;
  if (bounds) {
    const left = Math.floor(bounds[0] * px) - 1;
    const top = Math.floor(bounds[1] * px) - 1;
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(bounds[2] * px) + 1 - left;
    cv.height = Math.ceil(bounds[3] * px) + 1 - top;
    const c = cv.getContext("2d");
    c.translate(-left, -top);
    if (slice === "ground") {
      c.beginPath();
      hexCorners(0, 0).forEach(([x, y], i) => {
        const sx = (x / R) * px, sy = (y / R) * px;
        i ? c.lineTo(sx, sy) : c.moveTo(sx, sy);
      });
      c.closePath();
      c.clip();
      for (const p of slices.ground) drawTextureSymbol(c, p, tones, px, false);
    } else {
      for (const p of objects) drawTextureSymbol(c, p, tones, px, true);
    }
    hit = { cv, left, top };
  }
  texCanvases.set(key, hit);
  while (texCanvases.size > TEX_MAX_CANVASES) {
    texCanvases.delete(texCanvases.keys().next().value);
  }
  return hit;
}

// Blend mode's colour pass: across every edge between two painted hexes of
// different base colour, a strip graded from one drawn fill to the other,
// fanning toward both centres so strips meet at corners without overlapping.
function drawBlendStrips(fills, groups) {
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (const [key, f] of fills) {
    if (!f.on) continue;
    const h = f.h;
    if ((groups.get(key) || SPEC.groupNone) === SPEC.groupNone) continue;
    for (let k = 0; k < 6; k++) {
      const [oq, or_, ok] = SPEC.canonicalEdge(h.q, h.r, k);
      if (oq !== h.q || or_ !== h.r || ok !== k) continue;
      const [dq, dr] = SPEC.hexEdgeNeighbors[k];
      const nKey = cellKey(h.q + dq, h.r + dr);
      const other = fills.get(nKey);
      const theirs = groups.get(nKey);
      if (!other || !theirs || theirs === SPEC.groupNone || other.base === f.base) continue;
      const cA = axialToPixel(h.q, h.r);
      const cB = axialToPixel(h.q + dq, h.r + dr);
      const a0deg = (Math.PI / 180) * 60 * k, a1deg = (Math.PI / 180) * 60 * ((k + 1) % 6);
      const p0 = { x: cA.x + R * Math.cos(a0deg), y: cA.y + R * Math.sin(a0deg) };
      const p1 = { x: cA.x + R * Math.cos(a1deg), y: cA.y + R * Math.sin(a1deg) };
      const d = TEX.blendEdgeDepth;
      const pts = [lerp(p0, cA, d), lerp(p1, cA, d), p1, lerp(p1, cB, d), lerp(p0, cB, d), p0]
        .map((p) => worldToScreen(p.x, p.y));
      const from = worldToScreen(...Object.values(lerp(lerp(p0, cA, d), lerp(p1, cA, d), 0.5)));
      const to = worldToScreen(...Object.values(lerp(lerp(p0, cB, d), lerp(p1, cB, d), 0.5)));
      const g = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      g.addColorStop(0, f.drawn);
      g.addColorStop(1, other.drawn);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    }
  }
}

// Served rivers and non-border routes as scene segments [x1, y1, x2, y2,
// halfWidth], indexed by the cells whose objects they can touch (along the
// segment plus neighbours, since a canopy overhangs). Mirrors
// _HexMapPainter._obstacleSegments: a river's bank width, a route's base width.
// It depends on the payload only, so it is built once per payload, not per
// frame (a pan redraws every frame).
let obstacleCache = { state: null, map: null };

function obstacleSegmentsByCell() {
  if (obstacleCache.state !== state) {
    obstacleCache = { state, map: buildObstacleSegments() };
  }
  return obstacleCache.map;
}

function buildObstacleSegments() {
  const out = new Map();
  const addPolyline = (pts, halfWidth) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const seg = [a.x, a.y, b.x, b.y, halfWidth];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / (R * 0.5)));
      const cells = new Set();
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const c = pixelToAxial(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        cells.add(cellKey(c.q, c.r));
        for (const [dq, dr] of SPEC.hexEdgeNeighbors) cells.add(cellKey(c.q + dq, c.r + dr));
      }
      for (const k of cells) {
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(seg);
      }
    }
  };
  for (const river of state.rivers || []) {
    for (const seg of river.segments) {
      addPolyline(seg.map(riverAnchorPixel), (8.0 * (river.width || 1)) / 2);
    }
  }
  for (const route of state.routes || []) {
    const style = SPEC.roadStyleOf(route.kind);
    if (!style) continue; // borders clear nothing
    for (const seg of route.segments) {
      addPolyline(seg.map((n) => nodePixel(n[0], n[1], n[2], n[3])), SPEC.roadCasingWidth(style, route.width || 1) / 2);
    }
  }
  return out;
}

// Everything the three texture passes need for one hex.
function hexTexture(h, variant, ground, obstacleSegments, blendMask) {
  const rs = R * view.scale; // on-screen hex radius
  const c = axialToPixel(h.q, h.r);
  const obstacles = TEX.localObstacles(c.x, c.y,
    obstacleSegments.get(cellKey(h.q, h.r)) || [], R);
  return {
    blendMask,
    obstacles,
    obstacleKey: obstacles.map((o) => [o.x1, o.y1, o.x2, o.y2, o.halfWidth].join(",")).join(";"),
    h, variant, ground, rs, c,
    // Offscreen resolution: the next power of two at or above the size in
    // DEVICE px, so zooming reuses a handful of canvases instead of one per
    // level, and a HiDPI screen gets textures as sharp as its hexes.
    px: Math.min(256, Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, rs * dpr))))),
    lod: TEX.textureLodBucket(rs),
    pick: TEX.texturePick(h.q, h.r, variant.layouts.length),
    slot: h.feature ? TEX.featureSlotFor(h.q, h.r) : null,
    screen: worldToScreen(c.x, c.y),
  };
}

function blitTexture(t, slice) {
  const key = [t.h.terrain, t.h.terrain_variant || 0, t.pick.layout, t.pick.flip,
    t.slot, t.lod, t.ground, slice, t.px, slice === "ground" ? "" : t.obstacleKey,
    slice === "ground" ? 0 : t.blendMask].join("|");
  const hit = textureCanvas(key, t.variant, t.pick, t.slot, t.lod, t.ground, slice, t.px,
    t.obstacles, t.blendMask);
  if (!hit) return;
  const k = t.rs / t.px;
  ctx.drawImage(hit.cv, t.screen.x + hit.left * k, t.screen.y + hit.top * k,
    hit.cv.width * k, hit.cv.height * k);
}

// Pass 1 (with the fills): the flat ground marks, clipped to the hex.
function drawHexGround(t) {
  blitTexture(t, "ground");
}

// Pass 2 (after the outlines, back to front): the standing objects, unclipped
// so a canopy overlaps its neighbour instead of being cut at the edge.
function drawHexObjects(t) {
  blitTexture(t, "behind");
}

// Pass 3: a feature and its own foreground objects, so a neighbour's canopy
// never buries a place of interest.
function drawHexFeature(t) {
  if (t.slot == null) return;
  const [fx, fy] = TEX.featureSlotCentre(t.slot);
  drawFeatureObject(t.h, worldToScreen(t.c.x + fx * R, t.c.y + fy * R), t.ground);
  blitTexture(t, "front");
}

// A feature as an object on the ground: soft shadow, light stone body inside
// a dark outline. Mirrors paintFeatureShadow + featureObjectColours.
function drawFeatureObject(h, p, ground) {
  const list = GLYPHS.glyphs[h.feature];
  if (!list || !list.length) return;
  const v = Math.max(0, Math.min(h.feature_variant || 0, list.length - 1));
  const rs = R * view.scale;
  ctx.save();
  ctx.translate(p.x, p.y + rs * 0.34);
  ctx.scale(1, 0.2 / 0.72);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rs * 0.36);
  g.addColorStop(0, `rgba(0,0,0,${TEX.textureShadowAlpha})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rs * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  drawGlyphSolid(GLYPHS, list[v], p, R * SPEC.featureStampScale * view.scale, {
    body: TEX.featureBodyTone(ground, h.feature),
    side: TEX.featureSideTone(ground, h.feature),
    highlight: TEX.featureHighlightTone(ground, h.feature),
    rim: TEX.featureRimTone(ground, h.feature),
    outline: TEX.featureOutlineTone(ground),
  });
}

// A feature silhouette as a small carved solid: walls extruded below a raised
// top face, one outline around the whole, a lit face and an inner bevel.
// Mirrors drawFeatureSolid in app/glyphs.dart; widths are scene px.
function drawGlyphSolid(table, g, p, size, c) {
  const [s, tx, ty] = table.transform(g, size);
  const path = table.path(g);
  const depth = size * TEX.featureSolidDepth; // screen px
  const steps = Math.max(2, Math.min(12, Math.ceil(depth / (0.75 * view.scale))));
  const stepY = (i) => -depth / 2 + (depth * i) / steps;
  const at = (dy, draw) => {
    ctx.save();
    ctx.translate(p.x + tx, p.y + ty + dy);
    ctx.scale(s, s);
    draw();
    ctx.restore();
  };
  const mix = (a, b, t) => SPEC.lerpHex(a, b, t);
  ctx.lineJoin = "round";
  for (let i = 0; i <= steps; i++) {
    at(stepY(i), () => {
      ctx.strokeStyle = c.outline;
      ctx.lineWidth = (2 * TEX.glyphSolidOutlinePx * view.scale) / s;
      ctx.stroke(path);
    });
  }
  for (let i = steps; i >= 1; i--) {
    at(stepY(i), () => {
      ctx.fillStyle = mix(c.side, c.outline, (0.35 * i) / steps);
      ctx.fill(path);
    });
  }
  at(stepY(0), () => {
    const b = g.right - g.left, hgt = g.bottom - g.top;
    const grad = ctx.createLinearGradient(g.left, g.top, g.left + b, g.top + hgt);
    grad.addColorStop(0, mix(c.body, c.highlight, 0.35));
    grad.addColorStop(1, c.body);
    ctx.fillStyle = grad;
    ctx.fill(path);
    const bev = (TEX.featureBevelPx * view.scale) / s;
    ctx.save();
    ctx.clip(path);
    ctx.lineWidth = 2 * bev;
    ctx.translate(bev, bev);
    ctx.strokeStyle = c.highlight;
    ctx.stroke(path);
    ctx.translate(-2 * bev, -2 * bev);
    ctx.strokeStyle = c.rim;
    ctx.stroke(path);
    ctx.restore();
  });
}

// Shared by drawFeature and the glyph half of drawTerrain -- halo first (in
// the hex's own fill) then fill (in ink), so a solid silhouette separates
// from terrain of similar value without tinting it. Width is in scene px, so
// undo the glyph scale. Mirrors _drawGlyph in app/glyphs.dart. `colours`
// overrides both for the Illustrated style's object look.
function drawGlyph(table, g, p, size, h, colours) {
  const [s, tx, ty] = table.transform(g, size);
  const ink = colours ? colours.ink : SPEC.inkFor(h.color || DEFAULT_FILL);
  ctx.save();
  ctx.translate(p.x + tx, p.y + ty);
  ctx.scale(s, s);
  const inkWidth = g.outline ? GLYPH_OUTLINE_WIDTH : 0;
  ctx.strokeStyle = colours ? colours.halo : h.color || DEFAULT_FILL;
  ctx.lineWidth = ((GLYPH_HALO_WIDTH + inkWidth) * view.scale) / s;
  ctx.lineJoin = "round";
  ctx.stroke(table.path(g));
  if (g.outline) {
    // Contour instead of fill -- see Glyph.outline in core/glyph_data.dart.
    ctx.strokeStyle = ink;
    ctx.lineWidth = (inkWidth * view.scale) / s;
    ctx.stroke(table.path(g));
  } else {
    ctx.fillStyle = ink;
    ctx.fill(table.path(g));
  }
  ctx.restore();
}

function drawFeature(h) {
  const list = GLYPHS.glyphs[h.feature];
  if (!list || !list.length) return;
  const v = Math.max(0, Math.min(h.feature_variant || 0, list.length - 1));
  const c = axialToPixel(h.q, h.r);
  const p = worldToScreen(c.x, c.y + R * SPEC.stampCentreOffset);
  const size = R * SPEC.featureStampScale * view.scale;
  drawGlyph(GLYPHS, list[v], p, size, h);
}

// Dispatches to the vendored glyph when TERRAIN_GLYPHS has one for h.terrain,
// falling back to the procedural drawer otherwise (lake, tundra, hills, desert). Mirrors
// drawBiomeStamp in app/glyphs.dart -- callers don't need to know which
// biomes are glyph-based.
function drawTerrain(h) {
  const list = TERRAIN_GLYPHS.glyphs[h.terrain];
  if (list && list.length) {
    const v = Math.max(0, Math.min(h.terrain_variant || 0, list.length - 1));
    const c = axialToPixel(h.q, h.r);
    const p = worldToScreen(c.x, c.y + R * SPEC.stampCentreOffset);
    const size = R * SPEC.terrainStampScale * view.scale;
    drawGlyph(TERRAIN_GLYPHS, list[v], p, size, h);
    return;
  }
  drawTerrainProcedural(h);
}

// Packed cell key; mirrors _cellKey in hex_map.dart.
function cellKey(q, r) {
  return ((q + 0x8000) << 16) | (r + 0x8000);
}

// Stroke every cell outline once, quiet inside a terrain mass and heavier
// where the group changes. Mirrors _paintCellEdges in app/hex_map.dart: each
// edge is drawn by its canonical owner only, so the alphas land as specified
// instead of compounding where both sides are present. Culled to `rect`: the
// strokes are the same, though a smaller path can tip the rasteriser into
// another antialiasing method, so a few corner pixels may differ by a shade.
function drawCellEdges(groups, rect) {
  const quiet = [], boundary = [], coast = [];
  for (const h of state.hexes) {
    const c = axialToPixel(h.q, h.r);
    if (!inRect(rect, c)) continue;
    const mine = SPEC.terrainGroup(h.terrain);

    // Coast halo belongs to the water cell, not to a shared edge, so it looks
    // at all six neighbours rather than only the edges this cell owns.
    if (mine === SPEC.groupWater) {
      for (let k = 0; k < 6; k++) {
        const [dq, dr] = SPEC.hexEdgeNeighbors[k];
        const n = groups.get(cellKey(h.q + dq, h.r + dr)) || SPEC.groupNone;
        if (!SPEC.isCoast(mine, n)) continue;
        coast.push(c);
        break;
      }
    }

    for (let k = 0; k < 6; k++) {
      const [oq, or_, ok] = SPEC.canonicalEdge(h.q, h.r, k);
      if (oq !== h.q || or_ !== h.r || ok !== k) continue;
      const [dq, dr] = SPEC.hexEdgeNeighbors[k];
      const theirs =
        groups.get(cellKey(h.q + dq, h.r + dr)) || SPEC.groupNone;
      const both = mine === SPEC.groupNone && theirs === SPEC.groupNone;
      const a = (Math.PI / 180) * 60 * k;
      const b = (Math.PI / 180) * 60 * ((k + 1) % 6);
      const p0 = worldToScreen(c.x + R * Math.cos(a), c.y + R * Math.sin(a));
      const p1 = worldToScreen(c.x + R * Math.cos(b), c.y + R * Math.sin(b));
      // Blend: every edge is a quiet grid line (a heavy stroke along a
      // border would redraw the cut the gradient removed).
      (!blendEdges && SPEC.isBoundary(mine, theirs) && !both ? boundary : quiet).push(p0, p1);
    }
  }
  // Coast under the outlines, so a boundary stroke still reads cleanly.
  if (coast.length) {
    const [cr, cg, cb] = SPEC.parseHex(SPEC.coastColor);
    ctx.beginPath();
    for (const c of coast) {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * 60 * i;
        const p = worldToScreen(
          c.x + R * SPEC.coastInset * Math.cos(a),
          c.y + R * SPEC.coastInset * Math.sin(a));
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.closePath();
    }
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${SPEC.coastAlpha})`;
    ctx.lineWidth = SPEC.coastWidth * view.scale;
    ctx.stroke();
  }

  const [r, g, b] = SPEC.parseHex(SPEC.edgeColor);
  // Illustrated: heavier outlines, so the grid stays countable over a texture.
  const ill = mapStyle === "illustrated";
  for (const [pts, w, alpha] of [
    [quiet,
      ill ? TEX.illustratedEdgeQuietWidth : SPEC.edgeQuietWidth,
      ill ? TEX.illustratedEdgeQuietAlpha : SPEC.edgeQuietAlpha],
    [boundary,
      ill ? TEX.illustratedEdgeBoundaryWidth : SPEC.edgeBoundaryWidth,
      ill ? TEX.illustratedEdgeBoundaryAlpha : SPEC.edgeBoundaryAlpha],
  ]) {
    if (!pts.length) continue;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) {
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    }
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.lineWidth = w * view.scale;
    ctx.stroke();
  }
}

// The unexplored lattice: every in-grid cell the party has NOT revealed,
// stroked faintly so a travel vote has something to point at. It carries no
// information beyond "a hex could be here" — terrain, names and features are
// still served for revealed hexes only.
function drawGridLattice(revealed) {
  const pts = [];
  for (const { q, r } of cellsInView()) {
    if (revealed.has(cellKey(q, r))) continue;
    const c = axialToPixel(q, r);
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * 60 * i;
      const b = (Math.PI / 180) * 60 * ((i + 1) % 6);
      pts.push(
        worldToScreen(c.x + R * Math.cos(a), c.y + R * Math.sin(a)),
        worldToScreen(c.x + R * Math.cos(b), c.y + R * Math.sin(b)));
    }
  }
  if (!pts.length) return;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
  }
  ctx.strokeStyle = "rgba(122, 85, 212, 0.16)";
  ctx.lineWidth = Math.max(0.5, 1 * view.scale);
  ctx.stroke();
}

// Vote markers: a filled disc with the count, on every hex the party has put a
// vote on. The player's own pick is ringed so it reads at a glance.
function drawVoteMarkers() {
  const entries = votes.tally || [];
  if (!entries.length) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const entry of entries) {
    const cell = parseHexId(entry.hex);
    if (!cell) continue;
    const c = axialToPixel(cell.q, cell.r);
    const p = worldToScreen(c.x, c.y + R * 0.52);
    const rad = Math.max(7, R * 0.22 * view.scale);
    const mine = entry.hex === votes.your_hex;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = mine ? "#7A55D4" : "#26263A";
    ctx.fill();
    ctx.strokeStyle = mine ? "#E8E8F0" : "#7A55D4";
    ctx.lineWidth = Math.max(1.2, 2 * view.scale);
    ctx.stroke();
    ctx.fillStyle = "#E8E8F0";
    ctx.font = `700 ${Math.max(9, rad * 1.15)}px system-ui, sans-serif`;
    ctx.fillText(String(entry.count), p.x, p.y + 0.5);
  }
}


// ----- roads (mirrors _HexMapPainter._paintRoutes; look in render_spec.js) --
const LOD_FULL_PX = 14; // mirrors hex_map.dart's _lodFull
const roadMarkCache = new WeakMap(); // route segment -> { key, marks }

function roadMarksFor(route, seg, style, scenePts) {
  const key = route.kind + "|" + (route.width || 1);
  const hit = roadMarkCache.get(seg);
  if (hit && hit.key === key) return hit.marks;
  const first = seg[0];
  const marks = SPEC.roadMarks(style, SPEC.smoothPolyline(scenePts), route.width || 1,
    first[1] * 73 + first[2]);
  roadMarkCache.set(seg, { key, marks });
  return marks;
}

function drawRoutes(illustrated) {
  const roads = [], borders = [];
  const W = viewW, H = viewH;
  for (const route of state.routes || []) {
    const style = SPEC.roadStyleOf(route.kind);
    const w = route.width || 1;
    for (const seg of route.segments) {
      if (seg.length < 2) continue;
      const scenePts = seg.map((n) => {
        const p = nodePixel(n[0], n[1], n[2], n[3]);
        return [p.x, p.y];
      });
      const pts = scenePts.map(([x, y]) => worldToScreen(x, y));
      // Cull segments wholly off screen (a curve overshoots its control
      // points by a sixth of a span; the pad covers that and the casing).
      const pad = (style ? SPEC.roadCasingWidth(style, w) : SPEC.borderStyle.base * w) * view.scale + R * view.scale;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      if (x1 + pad < 0 || y1 + pad < 0 || x0 - pad > W || y0 - pad > H) continue;
      if (style) roads.push({ route, seg, style, w, pts, scenePts });
      else borders.push({ route, w, pts });
    }
  }
  const rank = (k) => SPEC.roadKindsByRank.indexOf(k);
  roads.sort((a, b) => rank(a.route.kind) - rank(b.route.kind));

  const stroke = (r, color, alpha, width, dash, round) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width * view.scale;
    ctx.lineCap = round ? "round" : "butt";
    ctx.lineJoin = "round";
    ctx.setLineDash(dash.map((d) => d * view.scale));
    smoothPath(r.pts);
    ctx.stroke();
  };
  const colour = (r) => r.route.color || "#6B4A2F";
  for (const r of roads) {
    stroke(r, SPEC.roadCasingColor(colour(r), r.style), r.style.casingAlpha,
      SPEC.roadCasingWidth(r.style, r.w), r.style.dash, true);
  }
  for (const r of roads) {
    stroke(r, colour(r), r.style.bodyAlpha,
      SPEC.roadBodyWidth(r.style, r.w), r.style.dash, true);
  }
  for (const r of roads) {
    if (r.style.coreFrac <= 0) continue;
    stroke(r, SPEC.roadCoreColor(colour(r), r.style), 1,
      SPEC.roadBodyWidth(r.style, r.w) * r.style.coreFrac, r.style.coreDash,
      r.style.coreDash.length === 0);
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineCap = "butt";

  // Illustrated marks, at the GM canvas's full-LOD threshold only.
  if (illustrated && R * view.scale >= LOD_FULL_PX) {
    for (const r of roads) {
      if (r.style.marks === "none") continue;
      const m = roadMarksFor(r.route, r.seg, r.style, r.scenePts);
      const ink = SPEC.roadMarkColor(colour(r));
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.55;
      for (let i = 0; i + 2 < m.pebbles.length; i += 3) {
        const p = worldToScreen(m.pebbles[i], m.pebbles[i + 1]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, ((m.pebbles[i + 2] < 0.8 ? 1.0 : 1.6) * view.scale) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (m.ticks.length) {
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 0.8 * view.scale;
        ctx.beginPath();
        for (let i = 0; i + 3 < m.ticks.length; i += 4) {
          const a = worldToScreen(m.ticks[i], m.ticks[i + 1]);
          const b = worldToScreen(m.ticks[i + 2], m.ticks[i + 3]);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  for (const b of borders) {
    ctx.strokeStyle = b.route.color || "#6B4A2F";
    ctx.lineWidth = SPEC.borderStyle.base * b.w * view.scale;
    ctx.setLineDash(SPEC.borderStyle.dash.map((d) => d * view.scale));
    ctx.beginPath();
    b.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// Redraws are coalesced to one per frame: pointer and wheel events arrive
// faster than the display refreshes, and a full repaint per event made a pan
// or a hover lag behind the pointer on a big map or a slow phone.
let frameRequest = 0;

function render() {
  if (frameRequest) return;
  frameRequest = requestAnimationFrame(() => {
    frameRequest = 0;
    renderNow();
  });
}

function renderNow() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Per-hex drawing is culled to the screen. The pad covers what reaches
  // past a hex's own outline: Illustrated canopies, feature objects, coast.
  const onScreen = viewRect(R * 2.5);

  // 0. The unexplored grid, under everything: voting targets any cell, so the
  //    lattice has to be visible and clickable even where nothing is revealed.
  drawGridLattice(revealedKeys);

  // 1. Hex fills. Outlines come after, in one weighted pass (step 1b), so a
  //    shared edge is stroked exactly once. Groups and fills are known for
  //    EVERY hex (outlines, river mouths and blend strips look at
  //    neighbours); only the visible ones are drawn.
  const groups = new Map();
  const illustrated = mapStyle === "illustrated";
  const textured = []; // hexes whose objects draw after rivers and roads
  const fills = new Map(); // cellKey -> {h, base, drawn, variant, on}
  const obstacleSegments = illustrated ? obstacleSegmentsByCell() : new Map();
  for (const h of state.hexes) {
    const c = axialToPixel(h.q, h.r);
    // Painted terrain gets a per-cell lightness wobble so a field of one
    // biome doesn't read as a component grid; the empty background doesn't.
    // Illustrated: the fill is the texture's GROUND colour (still derived
    // from the served fill) and the texture is drawn straight over it.
    const painted = h.terrain && h.terrain !== "default";
    const variant = illustrated && painted ? TEX.variantFor(h.terrain, h.terrain_variant) : null;
    const base = h.color || DEFAULT_FILL;
    const ground = variant ? TEX.textureGroundFill(base, variant) : base;
    const drawn = painted ? SPEC.jitterFill(ground, h.q, h.r) : ground;
    const on = inRect(onScreen, c);
    groups.set(cellKey(h.q, h.r), SPEC.terrainGroup(h.terrain));
    fills.set(cellKey(h.q, h.r), { h, base: ground, drawn, variant, on });
    if (!on) continue;
    ctx.beginPath();
    const corners = hexCorners(c.x, c.y).map((p) => worldToScreen(p[0], p[1]));
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = drawn;
    ctx.fill();
  }

  // 1a. Blend: colour gradients across borders, over the flat fills and under
  //     everything else. Mirrors _paintBlendStrips.
  if (blendEdges) drawBlendStrips(fills, groups);

  // 1a'. Illustrated ground marks (clipped), now that every fill is down.
  for (const [key, f] of fills) {
    if (!f.variant || !f.on) continue;
    const h = f.h;
    const mask = blendEdges
      ? TEX.blendMaskFor(groups.get(key), (k) => {
        const [dq, dr] = SPEC.hexEdgeNeighbors[k];
        return groups.get(cellKey(h.q + dq, h.r + dr)) || SPEC.groupNone;
      })
      : 0;
    const t = hexTexture(h, f.variant, f.base, obstacleSegments, mask);
    drawHexGround(t);
    textured.push(t);
  }

  // 1b. Cell outlines, weighted by whether they bound a terrain mass (mirrors
  //     _paintCellEdges). Only revealed hexes exist here, so the fog frontier
  //     always reads as a boundary — which is wanted: it frames what the party
  //     has actually seen.
  drawCellEdges(groups, onScreen);

  // 1c. Hover ring, above the outlines so it is never half-buried.
  if (hover) {
    const c = axialToPixel(hover.q, hover.r);
    ctx.beginPath();
    hexCorners(c.x, c.y)
      .map((p) => worldToScreen(p[0], p[1]))
      .forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = "#7A55D4";
    ctx.lineWidth = 2.5 * view.scale;
    ctx.stroke();
  }

  // 1b. Stamps (drawn under rivers/routes like the GM canvas, which stamps
  //     inside the hex pass). The feature overlay REPLACES the biome stamp --
  //     the biome still owns the fill colour -- exactly as in _paintCells.
  //     Illustrated: a textured hex already drew its feature inside its
  //     texture; an unpainted hex's feature is drawn as an object.
  for (const h of state.hexes) {
    if (!fills.get(cellKey(h.q, h.r)).on) continue;
    const painted = h.terrain && h.terrain !== "default";
    if (illustrated) {
      if (painted && TEX.variantFor(h.terrain, h.terrain_variant)) continue;
      if (h.feature) {
        const c = axialToPixel(h.q, h.r);
        drawFeatureObject(h, worldToScreen(c.x, c.y + R * SPEC.stampCentreOffset),
          h.color || DEFAULT_FILL);
        continue;
      }
    }
    if (h.feature) drawFeature(h);
    else if (painted) drawTerrain(h);
  }

  // 2. Rivers: ALL banks first, then all water, then glints — same layering
  //    as the desktop (RiverCasingLayer), so junctions blend instead of a
  //    later river's bank cutting an earlier river's water.
  drawRivers(groups, fills);

  // 2b. Routes above rivers — mirrors the GM canvas z-order (route z=2.0) and
  //     _paintRoutes: every casing, then every body, then every core, so roads
  //     merge where they meet; a bigger road's casing lies over a smaller
  //     one's; Illustrated adds pebbles / paving joints; borders go last.
  drawRoutes(illustrated);

  // 2c. Illustrated objects OVER the outlines, rivers and roads, back to front
  //     across hexes (adjacent flat-top columns are offset by half a row),
  //     then features with their own foreground objects. Objects standing on
  //     a river or road were left out of their slice. Mirrors _paintObjects.
  if (textured.length) {
    textured.sort((a, b) => (a.c.y !== b.c.y ? a.c.y - b.c.y : a.c.x - b.c.x));
    for (const t of textured) drawHexObjects(t);
    for (const t of textured) drawHexFeature(t);
  }

  // 3. Hex name labels on top — same placement, size and halo as the GM canvas
  //    (_paintLabels): above centre, near-white, with a background-coloured
  //    halo stroked underneath so the name survives crossing a stamp.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${SPEC.labelFontSize * view.scale}px system-ui, sans-serif`;
  ctx.lineJoin = "round";
  // A label can be much wider than its hex: a generous pad, not the hex one.
  const labelRect = viewRect(R * 8);
  for (const h of state.hexes) {
    if (!h.name) continue;
    const c = axialToPixel(h.q, h.r);
    if (!inRect(labelRect, c)) continue;
    const s = worldToScreen(c.x, c.y - R * SPEC.labelOffset);
    ctx.strokeStyle = SPEC.labelHalo;
    ctx.lineWidth = SPEC.labelHaloWidth * view.scale;
    ctx.strokeText(h.name, s.x, s.y);
    ctx.fillStyle = SPEC.labelInk;
    ctx.fillText(h.name, s.x, s.y);
  }

  // 4. Travel votes on top of the map they refer to.
  drawVoteMarkers();
}

// ----- interaction --------------------------------------------------------
// The same input model as the GM canvases (the Obsidian plugin's map view and
// wheel_intent.ts; Flutter's trackpad handling): a mouse wheel zooms, a
// trackpad's two-finger scroll PANS, a pinch zooms — on a trackpad
// (Ctrl+wheel in Chromium/Firefox, gesture events in Safari) and on a touch
// screen (two pointers).
const MIN_SCALE = 0.2, MAX_SCALE = 4;

// Below this much pointer travel a press counts as a click (a vote), not a
// pan. Touch drifts a few px even on a deliberate tap.
const CLICK_SLOP = 6;

function zoomAt(sx, sy, factor) {
  const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  view.ox = sx - (sx - view.ox) * (ns / view.scale);
  view.oy = sy - (sy - view.oy) * (ns / view.scale);
  view.scale = ns;
  render();
}

function panBy(dx, dy) {
  view.ox += dx;
  view.oy += dy;
  render();
}

function hideTooltip() {
  tooltip.hidden = true;
}

// Pointers down on the map, id -> {x, y}. One pans (or, released about where
// it went down, votes); two pinch-zoom about their midpoint and pan. Each
// pointer pans by its OWN last position: one shared "last" point made the
// view jump between two fingers.
const pointers = new Map();
let pressX = 0, pressY = 0, moved = 0;
let pinch = null;    // {dist, cx, cy} while two pointers are down
let pinched = false; // this press became a pinch: lifting it is not a vote

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return; // only the main button
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  hideTooltip();
  if (pointers.size === 1) {
    pressX = e.clientX; pressY = e.clientY; moved = 0;
    pinched = false;
  } else {
    pinched = true;
    pinch = pinchState();
  }
});

function liftPointer(e) {
  if (!pointers.delete(e.pointerId)) return false;
  pinch = pointers.size >= 2 ? pinchState() : null;
  return true;
}

canvas.addEventListener("pointerup", (e) => {
  if (!liftPointer(e)) return;
  if (pointers.size === 0 && !pinched && moved <= CLICK_SLOP) {
    const cell = cellAtScreen(e.clientX, e.clientY);
    if (cell) toggleVote(cell.q, cell.r);
  }
});
canvas.addEventListener("pointercancel", liftPointer);

canvas.addEventListener("pointermove", (e) => {
  const last = pointers.get(e.pointerId);
  if (!last) {
    if (e.pointerType !== "touch") updateHover(e.clientX, e.clientY);
    return;
  }
  const x = e.clientX, y = e.clientY;
  pointers.set(e.pointerId, { x, y });
  if (pinch) {
    const next = pinchState();
    view.ox += next.cx - pinch.cx;
    view.oy += next.cy - pinch.cy;
    zoomAt(next.cx, next.cy, next.dist / pinch.dist);
    pinch = next;
    return;
  }
  moved = Math.max(moved, Math.hypot(x - pressX, y - pressY));
  panBy(x - last.x, y - last.y);
});

canvas.addEventListener("pointerleave", (e) => {
  if (pointers.size || e.pointerType === "touch" || !hover) return;
  hover = null;
  hideTooltip();
  render();
});

// What a wheel event means: pan or zoom. Mirrors the plugin's
// WheelClassifier (obsidian-plugin/src/view/wheel_intent.ts) — keep the two
// in step. The browser does not say which device sent a wheel event, so it
// is judged per GESTURE: events under WHEEL_GESTURE_GAP_MS apart are one
// gesture, and once one of them looks like a trackpad (sideways, fractional
// or small) the rest of that gesture pans. Judged event by event, a fast
// swipe's large whole-number steps read as wheel notches and zoomed mid-pan.
const WHEEL_GESTURE_GAP_MS = 300;
const WHEEL_NOTCH_MIN = 50; // a mouse notch is ±100 px (more when scaled), or lines
let wheelLast = -Infinity, wheelTrackpad = false;

function wheelIntent(e) {
  if (e.timeStamp - wheelLast > WHEEL_GESTURE_GAP_MS) wheelTrackpad = false;
  wheelLast = e.timeStamp;
  if (e.ctrlKey) return "zoom"; // a pinch, or Ctrl+wheel
  if (e.deltaMode !== 0) return "zoom"; // lines or pages: a wheel
  if (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < WHEEL_NOTCH_MIN) {
    wheelTrackpad = true;
  }
  return wheelTrackpad ? "pan" : "zoom";
}

// Safari reports a trackpad pinch as gesture events, not Ctrl+wheel.
let safariGesture = null; // the last gesture scale while one is under way

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  hideTooltip();
  if (wheelIntent(e) === "pan") {
    panBy(-e.deltaX, -e.deltaY);
    return;
  }
  if (e.ctrlKey && safariGesture !== null) return; // the gesture events zoom
  // Zoom in proportion to the delta, so a pinch's many small steps and a
  // wheel's few big ones both feel right (a fixed step per event made a
  // pinch fly).
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
  zoomAt(e.clientX, e.clientY, Math.pow(1.15, (-dy / 100) * (e.ctrlKey ? 3 : 1)));
}, { passive: false });

canvas.addEventListener("gesturestart", (e) => {
  e.preventDefault();
  safariGesture = 1;
});
canvas.addEventListener("gesturechange", (e) => {
  e.preventDefault();
  // iOS sends these for a touch pinch too, which the pointers already zoom.
  if (safariGesture === null || pointers.size) return;
  zoomAt(e.clientX, e.clientY, e.scale / safariGesture);
  safariGesture = e.scale;
});
canvas.addEventListener("gestureend", (e) => {
  e.preventDefault();
  safariGesture = null;
});

// Screen point -> the in-grid cell under it (revealed or not), or null.
function cellAtScreen(sx, sy) {
  const cell = pixelToAxial(
    (sx - view.ox) / view.scale, (sy - view.oy) / view.scale);
  return cellInGrid(cell.q, cell.r) ? cell : null;
}

function updateHover(sx, sy) {
  const cell = cellAtScreen(sx, sy);
  const same = cell && hover ? cell.q === hover.q && cell.r === hover.r : !cell && !hover;
  hover = cell ? { ...cell, hex: hexAt(cell.q, cell.r) } : null;
  if (hover) {
    const found = hover.hex;
    tooltip.hidden = false;
    // textContent, not innerHTML: hex names are data, never markup
    const title = document.createElement("h4");
    title.textContent = found ? found.name || found.display_id : "Unexplored";
    const line = document.createElement("p");
    const terrain = found
      ? [found.terrain, found.feature].filter((t) => t && t !== "default").join(" · ")
      : "";
    const voted = voteFor(hexIdFor(hover.q, hover.r));
    line.textContent = voted
      ? `${terrain ? terrain + " — " : ""}votes: ${voted.names.join(", ")}`
      : terrain || "Click to vote to travel here";
    tooltip.replaceChildren(title, line);
    // Beside the pointer, flipped to the other side near the right or
    // bottom edge so it never runs off screen.
    const w = tooltip.offsetWidth, hgt = tooltip.offsetHeight;
    tooltip.style.left = (sx + 12 + w > viewW ? Math.max(0, sx - 12 - w) : sx + 12) + "px";
    tooltip.style.top = (sy + 12 + hgt > viewH ? Math.max(0, sy - 12 - hgt) : sy + 12) + "px";
  } else {
    tooltip.hidden = true;
  }
  if (!same) render(); // the hover ring only moves when the cell does
}

// ----- travel votes -------------------------------------------------------
// One standing vote per player for where the party should head next. The
// tally lives in the GM's running server and dies with it — nothing here is
// campaign data, and the map payload is untouched by it.

const voteList = document.getElementById("votelist");
const voteName = document.getElementById("votename");
const voteHint = document.getElementById("votehint");

let votes = { voters: 0, tally: [], your_hex: null };

// An opaque per-browser id so a reload keeps (and can change) the same vote
// instead of stacking a second one. Never displayed; the name is what people
// see.
// Storage can be blocked (a privacy setting, some embedded browsers): an
// uncaught throw here stopped the whole page loading. Without it the vote
// simply lasts until the page is reloaded.
function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* storage blocked: kept for this visit only */
  }
}

const voterId = (() => {
  let id = stored("hexlore.voter");
  if (!id) {
    id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    store("hexlore.voter", id);
  }
  return id;
})();

voteName.value = stored("hexlore.name") || "";
voteName.addEventListener("change", () => {
  store("hexlore.name", voteName.value.trim());
  // Re-cast so the new name reaches the GM without waiting for a vote change.
  if (votes.your_hex) {
    const cell = parseHexId(votes.your_hex);
    if (cell) postVote(cell);
  }
});

// Canonical hex id — mirrors hexIdFor in core/hex_data.dart. The server builds
// its own from q/r; this one only keys the local tally lookup.
function hexIdFor(q, r) { return `q${q}_r${r}`; }

function parseHexId(id) {
  const m = /^q(-?\d+)_r(-?\d+)$/.exec(id || "");
  return m ? { q: Number(m[1]), r: Number(m[2]) } : null;
}

function voteFor(hexId) {
  return (votes.tally || []).find((t) => t.hex === hexId) || null;
}

function applyVotes(data) {
  votes = data;
  renderVoteList();
  render();
}

async function postVote(cell) {
  try {
    const res = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        voter: voterId,
        name: voteName.value.trim(),
        // null q/r withdraws this voter's vote
        q: cell ? cell.q : null,
        r: cell ? cell.r : null,
      }),
    });
    if (res.ok) applyVotes(await res.json());
  } catch (err) {/* the poll below will resync */}
}

// Clicking your own pick again withdraws it; clicking elsewhere moves it.
function toggleVote(q, r) {
  const id = hexIdFor(q, r);
  postVote(votes.your_hex === id ? null : { q, r });
}

function renderVoteList() {
  const entries = votes.tally || [];
  voteHint.textContent = entries.length
    ? `${votes.voters} vote${votes.voters === 1 ? "" : "s"} in`
    : "Click a hex to vote for where the party goes next.";
  const rows = entries.map((entry) => {
    const cell = parseHexId(entry.hex);
    const hex = cell ? hexAt(cell.q, cell.r) : null;
    const li = document.createElement("li");
    if (entry.hex === votes.your_hex) li.className = "mine";
    const head = document.createElement("strong");
    // textContent throughout: names are typed by players, never markup
    head.textContent = hex ? hex.name || hex.display_id : "Unexplored";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = entry.count;
    const who = document.createElement("p");
    who.textContent = entry.names.join(", ");
    li.append(head, count, who);
    li.addEventListener("click", () => {
      if (!cell) return;
      const p = axialToPixel(cell.q, cell.r);
      view.ox = viewW / 2 - p.x * view.scale;
      view.oy = viewH / 2 - p.y * view.scale;
      render();
    });
    return li;
  });
  voteList.replaceChildren(...rows);
}

async function fetchVotes() {
  try {
    const res = await fetch(`/api/votes?voter=${encodeURIComponent(voterId)}`,
      { cache: "no-store" });
    applyVotes(await res.json());
  } catch (err) {/* offline; the map poll reports it */}
}

// ----- data ---------------------------------------------------------------
// Revealed cells as packed keys, rebuilt per poll: the lattice pass asks
// "is this cell revealed?" for every visible cell, which must not be a scan.
let revealedKeys = new Set();
let hexByKey = new Map();

function hexAt(q, r) { return hexByKey.get(cellKey(q, r)) || null; }

// One-shot: "no hexes yet" is no longer a proxy for "first load" now that the
// grid lattice gives centerOnContent something to frame — keying off it would
// re-centre every poll and yank the view out from under a panning player.
let framed = false;

// The server tags each payload (ETag); a poll that carries the tag back gets
// 304 while nothing changed, so an idle map is not re-sent every 4 s. A
// server without tags simply answers 200 every time.
let mapTag = null;

async function fetchMap() {
  try {
    const res = await fetch("/api/map", {
      cache: "no-store",
      headers: mapTag ? { "If-None-Match": mapTag } : {},
    });
    if (res.status === 304 && state) {
      statusEl.textContent = `${state.hexes.length} revealed hexes`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    mapTag = res.headers.get("ETag");
    const firstLoad = !framed;
    framed = true;
    state = data;
    revealedKeys = new Set(state.hexes.map((h) => cellKey(h.q, h.r)));
    hexByKey = new Map(state.hexes.map((h) => [cellKey(h.q, h.r), h]));
    nameEl.textContent = data.campaign_name || "HexLore";
    statusEl.textContent = `${data.hexes.length} revealed hexes`;
    if (firstLoad) centerOnContent();
    // Hex names in the tally come from the map, so refresh it when they land.
    renderVoteList();
    render();
  } catch (err) {
    statusEl.textContent = "offline";
  }
}

// ----- credits ------------------------------------------------------------
// Built from the generated table, not hand-written, so swapping a glyph for
// one by a different author updates the notice automatically.
(function credits() {
  const el = document.getElementById("credits");
  if (!el || !GLYPHS) return;
  el.append("Icons made by ");
  GLYPHS.credits.forEach((c, i) => {
    if (i) el.append(", ");
    if (c.url) {
      const a = document.createElement("a");
      a.href = c.url;
      a.textContent = c.name;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      el.append(a);
    } else {
      el.append(c.name);
    }
  });
  el.append(" — game-icons.net, CC BY 3.0");
  if (TEXTURES && TEXTURES.credits.length) {
    el.append(". Terrain symbols: ");
    TEXTURES.credits.forEach((c, i) => {
      if (i) el.append(", ");
      const a = document.createElement("a");
      a.href = c.url;
      a.textContent = c.name;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      el.append(a, ` (${c.license})`);
    });
  }
})();

// ----- style toggle ----------------------------------------------------------
(function blendToggle() {
  const btn = document.getElementById("blendbtn");
  if (!btn) return;
  const label = () => {
    btn.textContent = blendEdges ? "Blend: on" : "Blend: off";
    btn.title = "Soften the borders between biomes";
  };
  label();
  btn.addEventListener("click", () => {
    blendEdges = !blendEdges;
    try {
      localStorage.setItem(BLEND_KEY, blendEdges ? "1" : "0");
    } catch (_) {
      /* storage blocked: the switch still applies for this visit */
    }
    label();
    render();
  });
})();

(function styleToggle() {
  const btn = document.getElementById("stylebtn");
  if (!btn) return;
  const label = () => {
    btn.textContent = mapStyle === "illustrated" ? "Illustrated" : "Clean";
    btn.title = "Switch map style";
  };
  label();
  btn.addEventListener("click", () => {
    mapStyle = mapStyle === "illustrated" ? "clean" : "illustrated";
    try {
      localStorage.setItem(STYLE_KEY, mapStyle);
    } catch (_) {
      /* storage blocked: the switch still applies for this visit */
    }
    label();
    render();
  });
})();

window.addEventListener("resize", resize);
resize();
fetchMap();
fetchVotes();
setInterval(fetchMap, 4000);   // poll so reveals appear without refresh
// Votes are the conversation between players: poll them faster than the map,
// and it costs nothing — the tally never touches the disk.
setInterval(fetchVotes, 2000);
