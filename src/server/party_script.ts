// The party marker on the player page: the plugin's own addition (design
// §1.12), served beside the Flutter app's page and never written into it
// (vendor/player/ is a copy). The page's scripts are classic scripts, so
// their top-level functions and `let`s are globals this one can use: it
// wraps `drawVoteMarkers` (the last thing a frame draws) to draw the party
// after it, and polls `/api/party`, which names the party's hex only while
// that hex is revealed.

/** Served as /static/party.js. */
export const PARTY_JS = `"use strict";
(function () {
  var party = null; // {q, r} or null
  var base = window.drawVoteMarkers;
  if (typeof base !== "function") return;
  window.drawVoteMarkers = function () {
    base();
    if (!party) return;
    var c = axialToPixel(party.q, party.r);
    var p = worldToScreen(c.x, c.y - R * 0.18);
    var rad = Math.max(8, R * 0.26 * view.scale);
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = "#D4A84A";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, 2.5 * view.scale);
    ctx.strokeStyle = "#2B1D0E";
    ctx.stroke();
    // A pennant: the party's flag.
    ctx.beginPath();
    ctx.moveTo(p.x - rad * 0.35, p.y + rad * 0.55);
    ctx.lineTo(p.x - rad * 0.35, p.y - rad * 0.6);
    ctx.lineTo(p.x + rad * 0.5, p.y - rad * 0.3);
    ctx.lineTo(p.x - rad * 0.35, p.y);
    ctx.lineWidth = Math.max(1.2, 1.8 * view.scale);
    ctx.stroke();
    ctx.restore();
  };
  var last = "";
  function poll() {
    fetch("/api/party", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var m = data && typeof data.hex === "string" ? /^q(-?\\d+)_r(-?\\d+)$/.exec(data.hex) : null;
        var next = m ? { q: Number(m[1]), r: Number(m[2]) } : null;
        var key = next ? next.q + "," + next.r : "";
        if (key !== last) {
          last = key;
          party = next;
          render();
        }
      })
      .catch(function () {})
      .then(function () { setTimeout(poll, 3000); });
  }
  poll();
})();
`;

/** The page with the party script after the page's own (the vendored file
 *  is left as it is; this is the copy served). */
export function withPartyScript(indexHtml: string): string {
	const tag = '<script src="/static/party.js"></script>';
	return indexHtml.includes('</body>') ? indexHtml.replace('</body>', `  ${tag}\n</body>`) : `${indexHtml}\n${tag}\n`;
}
