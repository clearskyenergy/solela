/* Exercises omega-grid-infra.js against synthetic Esri JSON, with a Leaflet
   stub. Checks the things that actually break: -999999 kV, polygon-geometry
   substations, truncation reporting, dedupe on pan, and nearest() math. */
var fs = require("fs");

/* ── Leaflet stub ─────────────────────────────────────────────────────── */
var drawn = { subs: [], lines: [] };
function LayerGroup() { this._l = []; }
LayerGroup.prototype.addLayer = function (x) { this._l.push(x); return this; };
LayerGroup.prototype.addTo = function () { return this; };

global.L = {
  canvas: function (o) { return { _pane: o.pane }; },
  layerGroup: function () { return new LayerGroup(); },
  circleMarker: function (ll, o) {
    var m = { ll: ll, o: o, bindTooltip: f, bindPopup: f, on: f };
    function f() { return m; }
    drawn.subs.push(m); return m;
  },
  polyline: function (pts, o) { var p = { pts: pts, o: o }; drawn.lines.push(p); return p; },
  latLng: function (a, b) { return { lat: a, lng: b }; }
};

var panes = {}, handlers = {};
var VIEW = { n: 42.10, s: 41.60, e: -87.50, w: -88.20, z: 12 };
var map = {
  getPane: function (n) { return panes[n]; },
  createPane: function (n) { panes[n] = { style: {} }; },
  getZoom: function () { return VIEW.z; },
  getBounds: function () {
    return {
      getNorth: function () { return VIEW.n; }, getSouth: function () { return VIEW.s; },
      getEast: function () { return VIEW.e; }, getWest: function () { return VIEW.w; }
    };
  },
  on: function (ev, fn) { handlers[ev] = fn; },
  removeLayer: function () { }, addLayer: function () { },
  closePopup: function () { }, setView: function () { }
};

/* ── DOM stub, just enough for the legend hooks ───────────────────────── */
var els = {};
global.document = {
  getElementById: function (id) {
    if (!els[id]) els[id] = { textContent: "", style: {}, checked: false };
    return els[id];
  }
};
global.window = global;
global.XMLHttpRequest = function () { };

/* ── synthetic services ───────────────────────────────────────────────── */
var CALLS = [];
function esriPoint(id, name, volt, x, y) {
  return { attributes: { OBJECTID: id, NAME: name, MAX_VOLT: volt, OWNER: "Commonwealth Edison Co", LINES: 4, CITY: "Elgin" }, geometry: { x: x, y: y } };
}
function esriLine(id, volt, x1, y1, x2, y2) {
  return { attributes: { OBJECTID: id, VOLTAGE: volt, OWNER: "ComEd", SUB_1: "ELGIN", SUB_2: "BARTLETT" }, geometry: { paths: [[[x1, y1], [x2, y2]]] } };
}

function fakeFetch(url, cb) {
  CALLS.push(url);
  if (/\?f=json$/.test(url)) {                       /* ComEd service root */
    return cb(null, { layers: [{ id: 75, name: "BESS Hosting Capacity" }, { id: 12, name: "Substations" }] });
  }
  if (/comed-proxy/.test(url)) {                     /* ComEd substations  */
    return cb(null, { features: [esriPoint(1, "ELGIN TSS", 138, -88.05, 42.02)] });
  }
  if (/Substations|substations/.test(url)) {
    return cb(null, {
      exceededTransferLimit: false,
      features: [
        esriPoint(10, "BARTLETT", 345, -88.10, 41.98),
        esriPoint(11, "UNKNOWN KV", -999999, -88.00, 41.90),      /* HIFLD null sentinel */
        { attributes: { OBJECTID: 12, NAME: "POLYGON SUB", MAX_VOLT: 69 },
          geometry: { rings: [[[-87.90, 41.80], [-87.88, 41.80], [-87.88, 41.82], [-87.90, 41.82]]] } }
      ]
    });
  }
  if (/Transmission/.test(url)) {
    return cb(null, { exceededTransferLimit: true, features: [esriLine(20, 138, -88.10, 41.80, -87.90, 41.85)] });
  }
  cb(new Error("unrouted " + url));
}

/* ── load module ──────────────────────────────────────────────────────── */
eval(fs.readFileSync("omega-grid-infra.js", "utf8"));

var fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log("  PASS  " + name); }
  else { fails++; console.log("  FAIL  " + name + (extra ? ("  \u2192 " + extra) : "")); }
}

var DIAG = [];
var API = OmegaGridInfra.install({
  map: map, fetchJSON: fakeFetch, diag: function (s) { DIAG.push(s); },
  comedBase: "https://comed-proxy.clearsky-omega.workers.dev/comed",
  countEl: "subsCount", msgEl: "gridMsg", keyEl: "gridKey",
  onAnalyze: function () { }
});

console.log("\nComEd layer discovery");
ok("finds the substation layer without a hardcoded id",
  DIAG.join("|").indexOf("ComEd substation layer 12") >= 0, DIAG.join(" | "));
ok("prefers ComEd over HIFLD once discovered", API.state.comedSub && /\/12$/.test(API.state.comedSub.u));

console.log("\nSubstation layer");
drawn.subs = [];
API.setSubs(true);
ok("draws markers", drawn.subs.length > 0, drawn.subs.length + " markers");
ok("legend key revealed", els.gridKey.style.display === "");
ok("count reported", els.subsCount.textContent !== "\u2013", els.subsCount.textContent);

console.log("\nZoom gate");
drawn.subs = [];
VIEW.z = 7; API.refresh();
ok("nothing drawn below z9", drawn.subs.length === 0, drawn.subs.length + " drawn");
ok("legend says why", /zoom to 9/.test(els.gridMsg.textContent), els.gridMsg.textContent);
VIEW.z = 12;

console.log("\nTransmission layer");
drawn.lines = [];
API.setLines(true);
ok("draws polylines", drawn.lines.length > 0);
ok("lines are non-interactive so clicks reach the map", drawn.lines[0].o.interactive === false);
ok("truncation surfaced, not swallowed", /TRUNCATED/.test(els.gridMsg.textContent), els.gridMsg.textContent);

console.log("\nDedupe on pan");
var before = API.state ? null : null;
var n1 = drawn.subs.length;
VIEW.w = -88.19; VIEW.e = -87.51;      /* tiny pan, inside the padded box */
var callsBefore = CALLS.length;
API.refresh();
ok("a small pan inside the fetched box costs no request", CALLS.length === callsBefore,
  (CALLS.length - callsBefore) + " extra calls");

console.log("\nNearest lookup");
var got = null;
API.nearest(41.90, -88.02, function (n) { got = n; });
ok("returns a substation", !!(got && got.sub), JSON.stringify(got && got.sub));
ok("kV -999999 never surfaces as a voltage",
  !got.sub || got.sub.kv === null || got.sub.kv > 0, String(got.sub && got.sub.kv));
ok("distance is plausible", got.sub && got.sub.mi >= 0 && got.sub.mi < 12, got.sub && got.sub.mi);
ok("carries a compass bearing", got.sub && /^[NSEW]/.test(got.sub.dir), got.sub && got.sub.dir);
ok("returns a transmission line", !!got.line);
ok("names both ends", got.line && /\u2194/.test(got.line.ends || ""), got.line && got.line.ends);
ok("attributes its source", got.sub && !!got.sub.source, got.sub && got.sub.source);

console.log("\nPanel HTML");
var html = API.nearestHtml(got);
ok("renders rows", /Nearest substation/.test(html));
ok("says distances are straight-line", /straight-line/.test(html));
ok("warns nearest \u2260 serving", /not the one that feeds/.test(html));

console.log("\nPolygon-geometry substations (national fallback)");
var poly = null;
API.state.comedSub = null;               /* force the HIFLD chain */
VIEW.n = 41.85; VIEW.s = 41.75; VIEW.w = -87.95; VIEW.e = -87.85;
API.nearest(41.81, -87.89, function (n) { poly = n; }, 5);
ok("polygon substation resolves to a centroid",
  poly && poly.sub && poly.sub.mi < 5, JSON.stringify(poly && poly.sub && { n: poly.sub.name, mi: poly.sub.mi }));

console.log("\n" + (fails ? (fails + " FAILED") : "all passed"));
process.exit(fails ? 1 : 0);
