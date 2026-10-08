// ARCHIVED, NOT LOADED: the pre-glyph-migration procedural biome stamps for
// the player canvas, kept side-by-side with the current glyph-based ones
// (see terrain_glyphs.js / player.js's TERRAIN_GLYPHS) purely so the two
// approaches can be compared before settling on one for good. This file is
// not referenced by index.html, so a browser never fetches or runs it, and
// its content is wrapped in a block comment below as belt-and-suspenders.
//
// Covers every biome that is STILL glyph-based: plains, forest (incl. the
// since-dropped Sparse variant), mountain, sea, swamp, jungle, volcano.
// Lake and tundra were NEVER migrated (no good vendored icon existed for
// either); hills and desert WERE migrated and then moved back to procedural
// by GM preference (the "contour line" look won for both) -- their drawers
// live for real in player.js's TERRAIN table now, so they are not
// duplicated here. Desert's CURRENT procedural drawers are new geometry
// (three receding dune ridges; a denser branching crack pattern), not a
// reversion to the original pre-migration desert drawers -- those are
// simply gone, recoverable only from git history if ever wanted.
//
// To bring one of these back for a real side-by-side render: uncomment,
// paste the relevant TERRAIN[...] entry and any helper functions it needs
// back into player.js, and temporarily make drawTerrain check the
// procedural TERRAIN table before TERRAIN_GLYPHS for that biome.

/*
function sPoly(pts, fill) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  fill ? ctx.fill() : ctx.stroke();
}
function sCircle(cx, cy, r, fill) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  fill ? ctx.fill() : ctx.stroke();
}

// Dart _topArc takes a Rect; sTopArc takes centre + radii. Rect(l,t,w,h) maps
// to centre (l + w/2, t + h/2) with radii (w/2, h/2).
function sRectArc(l, t, w, hh) {
  sTopArc(l + w / 2, t + hh / 2, w / 2, hh / 2);
}

function sBezier(x0, y0, cx1, cy1, cx2, cy2, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x1, y1);
  ctx.stroke();
}

// One pine: apex at (cx, cy - 0.65*s*k), base half-width 0.45*s*k.
function sPine(s, cx, cy, k) {
  sPoly([
    [cx, cy - 0.65 * s * k],
    [cx - 0.45 * s * k, cy + 0.25 * s * k],
    [cx + 0.45 * s * k, cy + 0.25 * s * k],
  ]);
}

const TERRAIN_LEGACY = {
  plains: [
    (s) => {
      for (const dy of [-0.35 * s, 0, 0.35 * s]) {
        const amp = 0.15 * s, half = 0.45 * s;
        sBezier(-half, dy, -half * 0.5, dy - amp, half * 0.5, dy + amp, half, dy);
      }
    },
    (s) => {                                        // tilled fields
      const tl = [-0.35 * s, -0.35 * s], tr = [0.55 * s, -0.35 * s];
      const br = [0.35 * s, 0.35 * s], bl = [-0.55 * s, 0.35 * s];
      sPoly([tl, tr, br, bl]);
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      for (const t of [0.25, 0.5, 0.75]) {
        const p = lerp(tl, bl, t), q = lerp(tr, br, t);
        sLine(p[0], p[1], q[0], q[1]);
      }
    },
  ],
  forest: [
    (s) => {
      for (const [k, topY] of [[1.0, -0.1 * s], [0.65, 0.35 * s]]) {
        sPoly([
          [0, -0.65 * s * k + topY],
          [-0.45 * s * k, 0.25 * s * k + topY],
          [0.45 * s * k, 0.25 * s * k + topY],
        ]);
      }
    },
    (s) => sPine(s, 0, 0, 0.9),                     // sparse
    (s) => {                                        // dense
      sPine(s, -0.38 * s, 0.2 * s, 0.62);
      sPine(s, 0.38 * s, 0.2 * s, 0.62);
      sPine(s, 0, -0.18 * s, 0.85);
    },
    (s) => {                                        // dead
      sLine(0, 0.55 * s, 0, -0.55 * s);
      sLine(0, -0.15 * s, -0.38 * s, -0.45 * s);
      sLine(0, -0.32 * s, 0.32 * s, -0.58 * s);
      sLine(0, 0.1 * s, 0.34 * s, -0.1 * s);
      sLine(0, 0.05 * s, -0.26 * s, -0.08 * s);
    },
  ],
  mountain: [
    (s) => {
      sPoly([[0, -0.7 * s], [-0.6 * s, 0.45 * s], [0.6 * s, 0.45 * s]]);
      sPoly([[0, -0.7 * s], [-0.18 * s, -0.38 * s], [0.18 * s, -0.38 * s]], true);
    },
    (s) => {                                        // range
      sPoly([[0.25 * s, -0.35 * s], [-0.15 * s, 0.45 * s], [0.65 * s, 0.45 * s]]);
      sPoly([[-0.3 * s, -0.7 * s], [-0.75 * s, 0.45 * s], [0.15 * s, 0.45 * s]]);
      sPoly([[-0.3 * s, -0.7 * s], [-0.44 * s, -0.35 * s], [-0.16 * s, -0.35 * s]], true);
    },
  ],
  sea: [
    (s) => {
      for (const dy of [-0.3 * s, 0, 0.3 * s]) {
        const amp = 0.12 * s, half = 0.5 * s;
        ctx.beginPath();
        ctx.moveTo(-half, dy);
        ctx.bezierCurveTo(-half * 0.33, dy - amp, -half * 0.66, dy + amp, 0, dy);
        ctx.bezierCurveTo(half * 0.33, dy - amp, half * 0.66, dy + amp, half, dy);
        ctx.stroke();
      }
    },
  ],
  swamp: [
    (s) => {
      const amp = 0.1 * s, half = 0.5 * s, y = 0.15 * s;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.bezierCurveTo(-half * 0.33, y - amp, -half * 0.66, y + amp, 0, y);
      ctx.bezierCurveTo(half * 0.33, y - amp, half * 0.66, y + amp, half, y);
      ctx.stroke();
      for (const dx of [-0.28 * s, 0, 0.28 * s]) {
        sLine(dx, 0.12 * s, dx, -0.55 * s);
        sOval(dx, -0.6 * s, 0.07 * s, 0.1 * s);
      }
    },
    (s) => {                                        // dead trees
      const amp = 0.1 * s, half = 0.5 * s, y = 0.35 * s;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.bezierCurveTo(-half * 0.33, y - amp, -half * 0.66, y + amp, 0, y);
      ctx.bezierCurveTo(half * 0.33, y - amp, half * 0.66, y + amp, half, y);
      ctx.stroke();
      for (const sign of [-1, 1]) {
        const x = sign * 0.25 * s;
        sLine(x, 0.32 * s, x, -0.45 * s);
        sLine(x, -0.15 * s, x + sign * 0.22 * s, -0.38 * s);
        sLine(x, -0.02 * s, x - sign * 0.16 * s, -0.2 * s);
      }
    },
  ],
  jungle: [
    (s) => {
      for (const [cx, cy, rx, ry] of [
        [-0.3 * s, 0, 0.33 * s, 0.42 * s],
        [0.3 * s, 0, 0.33 * s, 0.42 * s],
        [0, -0.25 * s, 0.36 * s, 0.45 * s],
      ]) {
        sOval(cx, cy, rx, ry);
      }
    },
    (s) => {                                        // dense
      for (const [cx, cy, rx, ry] of [
        [-0.42 * s, 0.1 * s, 0.28 * s, 0.36 * s],
        [0.42 * s, 0.1 * s, 0.28 * s, 0.36 * s],
        [-0.2 * s, -0.2 * s, 0.3 * s, 0.4 * s],
        [0.2 * s, -0.2 * s, 0.3 * s, 0.4 * s],
        [0, 0.15 * s, 0.3 * s, 0.38 * s],
      ]) {
        sOval(cx, cy, rx, ry);
      }
    },
  ],
  volcano: [
    (s) => {
      sPoly([[0, -0.6 * s], [-0.5 * s, 0.45 * s], [0.5 * s, 0.45 * s]]);
      for (const sign of [-1, 1]) {
        sBezier(
          sign * 0.08 * s, -0.6 * s,
          sign * 0.35 * s, -0.85 * s,
          sign * 0.5 * s, -0.7 * s,
          sign * 0.45 * s, -0.45 * s);
      }
    },
  ],
};
*/
