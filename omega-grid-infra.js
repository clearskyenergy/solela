/* ═══════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · omega-grid-infra.js
   SUBSTATIONS + TRANSMISSION LINES as toggleable layers on the ComEd
   capacity map, plus a "nearest infrastructure" lookup for the side panel.

   WHY THIS IS A SEPARATE FILE
   comed-capacity.html is one 6,000-line IIFE. Nothing inside it is reachable
   from outside, so this module takes what it needs through install() rather
   than reaching for globals that do not exist. Load it BEFORE the main
   inline <script> and call install() from inside the IIFE.

   WHAT IT IS FOR
   Hosting capacity tells a rep how many kW a feeder can absorb. It does not
   tell them where the iron is. Two parcels can read 4,000 kW and be entirely
   different deals: one is 600 ft from a 138 kV substation fence, the other is
   four miles down a radial. The interconnection cost lives in that distance,
   so it belongs on the same screen as the capacity number.

   SOURCES, IN PREFERENCE ORDER
     1. ComEd's own service, IF it publishes a substation layer. Discovered
        at runtime, never hardcoded — ComEd renumbers layers between
        publishes. When present this is the best source available, because
        its substation names match the SUBSTATION field already shown in the
        capacity panel, so "nearest substation" and "serving substation" can
        actually be compared.
     2. EIA U.S. Energy Atlas / HIFLD mirrors. National coverage, three
        mirrors deep. These carry kV, line counts and owner, which ComEd's
        map does not.

   TRUNCATION IS REPORTED, NEVER SILENT
   Every query is capped and every response is checked for
   exceededTransferLimit. If a viewport returns a truncated set the legend
   says so. A short list that looks complete is worse than an error.
   ═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  "use strict";

  var NS = {};

  /* ── source registry ──────────────────────────────────────────────────
     Mirror chains, tried in order. A mirror that answers becomes sticky for
     the session: the fallback walk costs 20+ seconds when the first two are
     down, and paying it on every pan is not acceptable. */
  var SRC = {
    subs: [
      { u: "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Substations/FeatureServer/0",
        n: "EIA Energy Atlas" },
      { u: "https://services.arcgis.com/G4S1dGvn7PIgYd6Y/ArcGIS/rest/services/HIFLD_electric_power_substations/FeatureServer/0",
        n: "HIFLD mirror" },
      { u: "https://disasters.geoplatform.gov/arcgis/rest/services/IEM_Support/r00_energy/MapServer/2",
        n: "FEMA mirror" }
    ],
    lines: [
      { u: "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/US_Electric_Power_Transmission_Lines/FeatureServer/0",
        n: "EIA Energy Atlas" },
      { u: "https://services5.arcgis.com/HDRa0B57OVrv2E1q/ArcGIS/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0",
        n: "HIFLD mirror" },
      { u: "https://services.arcgis.com/G4S1dGvn7PIgYd6Y/ArcGIS/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0",
        n: "HIFLD mirror 2" }
    ]
  };

  /* Draw gates. Below these zooms the envelope covers half a state and the
     query returns a truncated national sample, which is worse than nothing:
     it looks like a map of substations and is actually a map of whichever
     3,000 rows the server felt like returning. */
  var MIN_Z_SUBS = 9;
  var MIN_Z_LINES = 9;
  var CAP_SUBS = 2000;
  var CAP_LINES = 2000;
  var STORE_MAX = 6000;      /* features held before the store is reset */
  var PAD = 0.35;            /* fetch 35% beyond the viewport so small pans are free */

  /* ── kV → colour ──────────────────────────────────────────────────────
     Deliberately a warm ramp. The capacity polygons underneath are grey /
     green / purple (ComEd) or the prospecting palette, and a rep glancing at
     the screen must never have to work out whether an orange thing is a
     feeder band or a wire. */
  function kvColor(kv) {
    if (kv == null) return "#8D6E63";        /* unknown — muted brown       */
    if (kv >= 345) return "#B3261E";         /* 345/500/765 kV — bulk transmission */
    if (kv >= 138) return "#E8590C";         /* 138–230 kV — sub-transmission */
    if (kv >= 69) return "#D9A404";          /* 69–115 kV                   */
    return "#7E9B2F";                        /* distribution-class          */
  }
  function kvBand(kv) {
    if (kv == null) return "kV not published";
    if (kv >= 345) return "345 kV and up";
    if (kv >= 138) return "138\u2013230 kV";
    if (kv >= 69) return "69\u2013115 kV";
    return "under 69 kV";
  }

  /* ── field pickers ────────────────────────────────────────────────────
     Every mirror spells these differently and HIFLD encodes "unknown" as
     -999999, which will happily render as a substation rated minus a million
     volts if nobody checks. */
  function pick(p, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = p[keys[i]];
      if (v !== undefined && v !== null && String(v).trim() !== "" && String(v) !== "NOT AVAILABLE") return v;
    }
    return null;
  }
  function pickNum(p, keys) {
    var v = pick(p, keys);
    if (v == null) return null;
    var n = parseFloat(v);
    if (isNaN(n) || n <= 0 || n <= -999) return null;
    return n;
  }
  function subName(p) {
    return pick(p, ["NAME", "Name", "name", "SUB_NAME", "SUBSTATION", "STATION_NAME", "SUBNAME"]) || "Unnamed substation";
  }
  function subKv(p) { return pickNum(p, ["MAX_VOLT", "MAX_VOLTAG", "VOLTAGE", "max_volt", "MAXVOLT", "KV", "OPERVOLT", "VOLT"]); }
  function subOwner(p) { return pick(p, ["OWNER", "Owner", "OPERATOR", "UTILITY", "COMPANY"]); }
  function subLines(p) { return pickNum(p, ["LINES", "lines", "NUM_LINES"]); }
  function lineKv(p) { return pickNum(p, ["VOLTAGE", "Voltage", "voltage", "KV"]); }
  function lineOwner(p) { return pick(p, ["OWNER", "Owner", "OPERATOR"]); }
  function lineEnds(p) {
    var a = pick(p, ["SUB_1", "SUB1", "FROM_SUB"]), b = pick(p, ["SUB_2", "SUB2", "TO_SUB"]);
    if (!a && !b) return null;
    return (a || "?") + " \u2194 " + (b || "?");
  }

  /* ── geometry helpers ─────────────────────────────────────────────── */
  var R = Math.PI / 180;
  function distMi(la1, lo1, la2, lo2) {
    var dLat = (la2 - la1) * R, dLon = (lo2 - lo1) * R;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  var COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function compassTo(la1, lo1, la2, lo2) {
    var p1 = la1 * R, p2 = la2 * R, dl = (lo2 - lo1) * R;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var b = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return COMPASS[Math.round(b / 22.5) % 16];
  }

  /* Esri JSON → a flat shape this module can draw.
     f=json rather than f=geojson on purpose: geojson output is optional on
     older MapServer publishes (the FEMA mirror is one) and a service that
     ignores the parameter returns Esri JSON anyway, which then parses as
     "no features" instead of failing loudly. One format, handled properly. */
  function normalize(j, kind) {
    var out = [], fs = (j && (j.features || [])) || [], i, f, g, p;
    for (i = 0; i < fs.length; i++) {
      f = fs[i];
      p = f.attributes || f.properties || {};
      g = f.geometry;
      if (!g) continue;

      if (kind === "point") {
        var lat = null, lon = null;
        if (typeof g.x === "number" && typeof g.y === "number") { lon = g.x; lat = g.y; }
        else if (g.type === "Point" && g.coordinates) { lon = g.coordinates[0]; lat = g.coordinates[1]; }
        else if (g.rings && g.rings.length) {            /* polygon substation → centroid */
          var r = g.rings[0], sx = 0, sy = 0, n = 0, k;
          for (k = 0; k < r.length; k++) { sx += r[k][0]; sy += r[k][1]; n++; }
          if (n) { lon = sx / n; lat = sy / n; }
        }
        if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) continue;
        out.push({ p: p, lat: lat, lon: lon });
      } else {
        var paths = g.paths ||
          (g.type === "LineString" ? [g.coordinates] :
            (g.type === "MultiLineString" ? g.coordinates : null));
        if (!paths || !paths.length) continue;
        out.push({ p: p, paths: paths });
      }
    }
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════
     INSTALL
     ═════════════════════════════════════════════════════════════════════ */
  NS.install = function (opts) {
    opts = opts || {};
    var map = opts.map;
    if (!map || typeof L === "undefined") return null;

    var esc = opts.esc || function (s) {
      s = (s == null ? "" : "" + s);
      return s.replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    };
    var diag = opts.diag || function () { };
    var onAnalyze = opts.onAnalyze || null;

    /* Transport. Reuses the host page's fetchJSON when handed one, so the
       file:// JSONP fallback and the CORS diagnostics already solved there
       are not solved a second time, differently, here. */
    var fetchJSON = opts.fetchJSON || function (url, cb) {
      var x = new XMLHttpRequest();
      x.open("GET", url, true); x.timeout = 25000;
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        if (x.status >= 200 && x.status < 300) {
          try { cb(null, JSON.parse(x.responseText)); }
          catch (e) { cb(new Error("bad JSON")); }
        } else cb(new Error("HTTP " + x.status));
      };
      x.ontimeout = function () { cb(new Error("timeout")); };
      x.onerror = function () { cb(new Error("network")); };
      x.send();
    };

    /* ── panes ────────────────────────────────────────────────────────
       Lines below substations, both above the capacity polygons (410) and
       below the data dots (450). A rep's own pipeline pin must still win
       every click contest; grid iron is context, not the work. */
    if (!map.getPane("gridLinePane")) {
      map.createPane("gridLinePane"); map.getPane("gridLinePane").style.zIndex = 425;
    }
    if (!map.getPane("gridSubPane")) {
      map.createPane("gridSubPane"); map.getPane("gridSubPane").style.zIndex = 435;
    }
    var lineRenderer = L.canvas({ pane: "gridLinePane" });
    var subRenderer = L.canvas({ pane: "gridSubPane" });

    var subLayer = null, lineLayer = null;
    var state = {
      subsOn: false, linesOn: false,
      subSrc: null, lineSrc: null,       /* sticky mirror that answered      */
      comedSub: null,                    /* ComEd's own substation layer, if any */
      busy: 0, truncated: false, note: ""
    };

    /* Accumulating stores. Panning back to somewhere already loaded should
       redraw instantly, so features are kept and the boxes already fetched
       are remembered. */
    var store = {
      subs: { feats: [], seen: {}, boxes: [] },
      lines: { feats: [], seen: {}, boxes: [] }
    };

    function keyOf(p, kind, f) {
      var id = pick(p, ["OBJECTID", "objectid", "FID", "ID", "id", "GlobalID"]);
      if (id != null) return kind + ":" + id;
      if (kind === "subs") return "subs:" + subName(p) + ":" + f.lat.toFixed(4) + "," + f.lon.toFixed(4);
      return "lines:" + (lineEnds(p) || "?") + ":" + (lineKv(p) || "?") + ":" + f.paths[0].length;
    }

    function padded(b) {
      var w = b.getEast() - b.getWest(), h = b.getNorth() - b.getSouth();
      return {
        xmin: b.getWest() - w * PAD, xmax: b.getEast() + w * PAD,
        ymin: b.getSouth() - h * PAD, ymax: b.getNorth() + h * PAD
      };
    }
    function covered(boxes, b) {
      for (var i = 0; i < boxes.length; i++) {
        var q = boxes[i];
        if (b.xmin >= q.xmin && b.xmax <= q.xmax && b.ymin >= q.ymin && b.ymax <= q.ymax) return true;
      }
      return false;
    }

    /* ── query ────────────────────────────────────────────────────────── */
    function envQuery(base, box, cap) {
      return base + "/query?f=json&where=1%3D1&outFields=*&returnGeometry=true" +
        "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
        "&spatialRel=esriSpatialRelIntersects&resultRecordCount=" + cap +
        "&geometry=" + encodeURIComponent(box.xmin + "," + box.ymin + "," + box.xmax + "," + box.ymax);
    }

    /* Walk the mirror chain. `sticky` is the source that worked last time —
       tried first, and demoted the moment it fails so a mirror going dark
       mid-session costs one slow pan, not every pan after it. */
    function chainFetch(chain, sticky, box, cap, kind, cb) {
      var order = [], i, stickyValid = false;
      for (i = 0; i < chain.length; i++) if (chain[i] === sticky) stickyValid = true;
      /* A sticky source that is no longer in the chain must not be tried.
         ComEd discovery can add a source and a later publish can remove it;
         honouring the stale one would keep querying a layer id that now
         points at different geometry. */
      if (stickyValid) order.push(sticky);
      for (i = 0; i < chain.length; i++) if (chain[i] !== sticky) order.push(chain[i]);
      var n = 0;
      (function attempt() {
        if (n >= order.length) { cb(new Error("all sources failed"), null, null, false); return; }
        var s = order[n++];
        fetchJSON(envQuery(s.u, box, cap), function (err, j) {
          if (err || !j || j.error || !j.features) {
            diag("grid " + kind + " " + s.n + ": " + (err ? err.message : (j && j.error ? ("srv " + j.error.code) : "no features")));
            attempt(); return;
          }
          var feats = normalize(j, kind === "subs" ? "point" : "line");
          var trunc = !!j.exceededTransferLimit || feats.length >= cap;
          diag("grid " + kind + ": " + feats.length + " from " + s.n + (trunc ? " (TRUNCATED)" : ""));
          cb(null, feats, s, trunc);
        });
      })();
    }

    function absorb(bucket, feats, kind, box) {
      var st = store[bucket], added = 0, i, k;
      if (st.feats.length > STORE_MAX) { st.feats = []; st.seen = {}; st.boxes = []; }
      for (i = 0; i < feats.length; i++) {
        k = keyOf(feats[i].p, bucket, feats[i]);
        if (st.seen[k]) continue;
        st.seen[k] = 1; st.feats.push(feats[i]); added++;
      }
      st.boxes.push(box);
      if (st.boxes.length > 40) st.boxes.shift();
      return added;
    }

    /* ── drawing ──────────────────────────────────────────────────────
       Only what intersects the padded viewport is drawn. The store can hold
       6,000 features; putting all of them on a canvas because the rep once
       panned past them is how a map starts stuttering. */
    function inBox(f, box) {
      if (f.lat != null) return f.lat >= box.ymin && f.lat <= box.ymax && f.lon >= box.xmin && f.lon <= box.xmax;
      var ps = f.paths, i, j, c;
      for (i = 0; i < ps.length; i++) for (j = 0; j < ps[i].length; j++) {
        c = ps[i][j];
        if (c[1] >= box.ymin && c[1] <= box.ymax && c[0] >= box.xmin && c[0] <= box.xmax) return true;
      }
      return false;
    }

    function subPopup(f) {
      var p = f.p, kv = subKv(p), own = subOwner(p), nl = subLines(p);
      var h = '<div style="font:600 13px/1.35 system-ui,sans-serif;margin-bottom:4px">' + esc(subName(p)) + "</div>";
      h += '<div style="font:11px/1.6 ui-monospace,monospace;color:#5b6672">';
      h += kvBand(kv) + (kv ? (" \u00b7 " + Math.round(kv) + " kV") : "") + "<br>";
      if (own) h += esc(own) + "<br>";
      if (nl) h += nl + " line" + (nl === 1 ? "" : "s") + " terminating<br>";
      h += esc(pick(p, ["CITY", "City"]) || "") + " \u00b7 " + f.lat.toFixed(5) + ", " + f.lon.toFixed(5);
      h += "</div>";
      if (onAnalyze) {
        h += '<button data-gridsub="1" style="margin-top:8px;width:100%;border:0;border-radius:7px;padding:7px;' +
          'background:#0a6ed1;color:#fff;font:600 11px system-ui,sans-serif;cursor:pointer">' +
          "Hosting capacity at this point</button>";
      }
      h += '<div style="font:9px ui-monospace,monospace;color:#94a3b8;margin-top:6px">' +
        esc((state.subSrc && state.subSrc.n) || "") + "</div>";
      return h;
    }

    function drawSubs() {
      if (subLayer) { map.removeLayer(subLayer); subLayer = null; }
      /* The zoom gate belongs here as well as in load(). Otherwise zooming
         out redraws whatever the store happens to hold — a handful of
         substations spread over six counties, which reads as "that is all
         there is" rather than "you are too far out to ask". */
      if (!state.subsOn || map.getZoom() < MIN_Z_SUBS) return;
      var box = padded(map.getBounds()), g = L.layerGroup(), st = store.subs, i, f, kv, col, r, m, shown = 0;
      for (i = 0; i < st.feats.length; i++) {
        f = st.feats[i];
        if (!inBox(f, box)) continue;
        kv = subKv(f.p);
        col = kvColor(kv);
        /* Radius carries voltage class, so the bulk substations read at a
           glance without having to click anything. */
        r = kv == null ? 5 : Math.max(5, Math.min(11, 4 + Math.sqrt(kv) / 4.5));
        m = L.circleMarker([f.lat, f.lon], {
          pane: "gridSubPane", renderer: subRenderer,
          radius: r, color: "#1f2937", weight: 1.2, opacity: .85,
          fillColor: col, fillOpacity: .92, interactive: true
        });
        m.bindTooltip("<b>" + esc(subName(f.p)) + "</b>" + (kv ? ("<br>" + Math.round(kv) + " kV") : ""), { direction: "top" });
        (function (feat, marker) {
          marker.bindPopup(subPopup(feat), { maxWidth: 280 });
          marker.on("popupopen", function (e) {
            var btn = e.popup.getElement().querySelector("[data-gridsub]");
            if (btn && onAnalyze) btn.onclick = function () { map.closePopup(); onAnalyze(feat.lat, feat.lon, feat); };
          });
        })(f, m);
        g.addLayer(m); shown++;
      }
      g.addTo(map); subLayer = g;
      report(shown);
    }

    function drawLines() {
      if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
      if (!state.linesOn || map.getZoom() < MIN_Z_LINES) return;
      var box = padded(map.getBounds()), g = L.layerGroup(), st = store.lines, i, j, f, kv, col, w, pts, k;
      for (i = 0; i < st.feats.length; i++) {
        f = st.feats[i];
        if (!inBox(f, box)) continue;
        kv = lineKv(f.p);
        col = kvColor(kv);
        w = kv == null ? 1.6 : Math.max(1.6, Math.min(4.2, 1.2 + Math.sqrt(kv) / 9));
        for (j = 0; j < f.paths.length; j++) {
          pts = [];
          for (k = 0; k < f.paths[j].length; k++) pts.push([f.paths[j][k][1], f.paths[j][k][0]]);
          if (pts.length < 2) continue;
          /* interactive:false on purpose. Transmission crosses half the
             parcels on this map; a rep clicking a rooftop to get its
             capacity must not hit a wire instead. Hover still identifies
             the line, via the substation markers and the legend. */
          g.addLayer(L.polyline(pts, {
            pane: "gridLinePane", renderer: lineRenderer,
            color: col, weight: w, opacity: .72,
            dashArray: kv == null ? "5,4" : null, interactive: false
          }));
        }
      }
      g.addTo(map); lineLayer = g;
    }

    /* ── status line under the legend toggles ─────────────────────────── */
    function report(subShown) {
      var c = opts.countEl && document.getElementById(opts.countEl);
      var m = opts.msgEl && document.getElementById(opts.msgEl);
      if (c) c.textContent = (state.subsOn ? (subShown == null ? "\u2026" : String(subShown)) : "\u2013");
      if (!m) return;
      var z = map.getZoom(), bits = [];
      if ((state.subsOn && z < MIN_Z_SUBS) || (state.linesOn && z < MIN_Z_LINES)) {
        bits.push("zoom to " + MIN_Z_SUBS + "+ to draw");
      } else if (state.busy) {
        bits.push("loading\u2026");
      } else {
        if (state.subSrc && state.subsOn) bits.push(state.subSrc.n);
        else if (state.lineSrc && state.linesOn) bits.push(state.lineSrc.n);
        if (state.truncated) bits.push("TRUNCATED \u2014 zoom in for the full set");
        if (state.note) bits.push(state.note);
      }
      m.textContent = bits.join(" \u00b7 ");
      m.style.color = state.truncated ? "#b45309" : "";
    }

    /* ── load for the current viewport ────────────────────────────────── */
    function load() {
      var z = map.getZoom(), box = padded(map.getBounds());
      state.truncated = false;

      if (state.subsOn && z >= MIN_Z_SUBS) {
        if (covered(store.subs.boxes, box)) drawSubs();
        else {
          state.busy++; report();
          chainFetch(subChain(), state.subSrc, box, CAP_SUBS, "subs", function (err, feats, src, trunc) {
            state.busy--;
            if (!err) {
              state.subSrc = src; state.truncated = state.truncated || trunc;
              absorb("subs", feats, "subs", box);
            } else { state.note = "substation sources unreachable"; }
            drawSubs(); report();
          });
        }
      } else { drawSubs(); }

      if (state.linesOn && z >= MIN_Z_LINES) {
        if (covered(store.lines.boxes, box)) drawLines();
        else {
          state.busy++; report();
          chainFetch(SRC.lines, state.lineSrc, box, CAP_LINES, "lines", function (err, feats, src, trunc) {
            state.busy--;
            if (!err) {
              state.lineSrc = src; state.truncated = state.truncated || trunc;
              absorb("lines", feats, "lines", box);
            } else { state.note = "transmission sources unreachable"; }
            drawLines(); report();
          });
        }
      } else { drawLines(); }

      report();
    }

    /* ComEd's own substation layer goes to the front of the chain when it
       exists — its names are the ones already printed in the capacity panel. */
    function subChain() {
      return state.comedSub ? [state.comedSub].concat(SRC.subs) : SRC.subs;
    }

    /* ── ComEd layer discovery ────────────────────────────────────────
       Never hardcode an id here. ComEd renumbers between publishes, and a
       stale id silently returns the wrong geometry rather than an error. */
    function discoverComEd() {
      if (!opts.comedBase) return;
      fetchJSON(opts.comedBase + "?f=json", function (err, root) {
        if (err || !root || root.error || !root.layers) return;
        for (var i = 0; i < root.layers.length; i++) {
          var l = root.layers[i];
          if (/sub\s*station|substation/i.test(l.name || "")) {
            state.comedSub = { u: opts.comedBase + "/" + l.id, n: "ComEd L" + l.id };
            diag("grid: ComEd substation layer " + l.id + " (" + l.name + ")");
            if (state.subsOn) { store.subs = { feats: [], seen: {}, boxes: [] }; load(); }
            return;
          }
        }
        diag("grid: ComEd publishes no substation layer \u2014 using EIA/HIFLD");
      });
    }

    /* ── debounce ─────────────────────────────────────────────────────── */
    var t = null;
    function schedule() {
      if (!state.subsOn && !state.linesOn) return;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; load(); }, 350);
    }
    map.on("moveend zoomend", schedule);

    /* ═══════════════════════════════════════════════════════════════════
       NEAREST-INFRASTRUCTURE LOOKUP

       Runs independently of the toggles. The panel must be able to answer
       "how far to the nearest substation" whether or not the rep has the
       layer switched on — an answer that depends on which checkboxes were
       ticked is not an answer.
       ═══════════════════════════════════════════════════════════════════ */
    var nearCache = {};

    function boxAround(lat, lon, mi) {
      var dLat = mi / 69, dLon = mi / (69 * Math.cos(lat * R) || 1);
      return { xmin: lon - dLon, xmax: lon + dLon, ymin: lat - dLat, ymax: lat + dLat };
    }

    /* Minimum distance from a point to a polyline, equirectangular. Accurate
       to well inside a rounding error at these scales and far cheaper than a
       geodesic solve over a few thousand segments. */
    function lineDistMi(f, lat, lon) {
      var cos = Math.cos(lat * R), best = 1e9, i, j, a, b;
      function xy(la, lo) { return [(lo - lon) * 69 * cos, (la - lat) * 69]; }
      function seg(p, q) {
        var dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
        var t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(p[0] * dx + p[1] * dy) / L2));
        var x = p[0] + t * dx, y = p[1] + t * dy;
        return Math.sqrt(x * x + y * y);
      }
      for (i = 0; i < f.paths.length; i++) {
        for (j = 0; j < f.paths[i].length - 1; j++) {
          a = xy(f.paths[i][j][1], f.paths[i][j][0]);
          b = xy(f.paths[i][j + 1][1], f.paths[i][j + 1][0]);
          var d = seg(a, b);
          if (d < best) best = d;
        }
      }
      return best;
    }

    /* radiusMi defaults to 12: far enough that a rural site still gets an
       answer, tight enough that the envelope does not pull half of Chicago. */
    function nearestImpl(lat, lon, cb, radiusMi) {
      var mi = radiusMi || 12;
      var ck = lat.toFixed(3) + "," + lon.toFixed(3) + "," + mi;
      if (nearCache[ck]) { cb(nearCache[ck]); return; }
      var box = boxAround(lat, lon, mi), out = { sub: null, line: null, err: null }, pending = 2;

      function done() {
        if (--pending) return;
        nearCache[ck] = out;
        cb(out);
      }

      chainFetch(subChain(), state.subSrc, box, 600, "subs", function (err, feats, src) {
        if (!err && feats && feats.length) {
          state.subSrc = src;
          var best = null, bd = 1e9, i, d;
          for (i = 0; i < feats.length; i++) {
            d = distMi(lat, lon, feats[i].lat, feats[i].lon);
            if (d < bd) { bd = d; best = feats[i]; }
          }
          if (best) out.sub = {
            name: subName(best.p), kv: subKv(best.p), owner: subOwner(best.p),
            lines: subLines(best.p), mi: bd,
            dir: compassTo(lat, lon, best.lat, best.lon),
            lat: best.lat, lon: best.lon, source: src.n
          };
          /* free intelligence: the same fetch feeds the visible layer */
          absorb("subs", feats, "subs", box);
        } else if (err) out.err = err.message;
        done();
      });

      chainFetch(SRC.lines, state.lineSrc, box, 600, "lines", function (err, feats, src) {
        if (!err && feats && feats.length) {
          state.lineSrc = src;
          var best = null, bd = 1e9, i, d;
          for (i = 0; i < feats.length; i++) {
            d = lineDistMi(feats[i], lat, lon);
            if (d < bd) { bd = d; best = feats[i]; }
          }
          if (best) out.line = {
            kv: lineKv(best.p), owner: lineOwner(best.p), ends: lineEnds(best.p),
            mi: bd, source: src.n
          };
          absorb("lines", feats, "lines", box);
        }
        done();
      });
    }

    /* ── public API ───────────────────────────────────────────────────── */
    var API = {
      setSubs: function (on) {
        state.subsOn = !!on;
        var k = opts.keyEl && document.getElementById(opts.keyEl);
        if (k) k.style.display = (state.subsOn || state.linesOn) ? "" : "none";
        if (state.subsOn) load(); else { drawSubs(); report(); }
      },
      setLines: function (on) {
        state.linesOn = !!on;
        var k = opts.keyEl && document.getElementById(opts.keyEl);
        if (k) k.style.display = (state.subsOn || state.linesOn) ? "" : "none";
        if (state.linesOn) load(); else { drawLines(); report(); }
      },
      refresh: load,

      /* nearest(lat, lon, cb[, radiusMi]) → cb({sub, line, err}) */
      nearest: function (lat, lon, cb, radiusMi) { nearestImpl(lat, lon, cb, radiusMi); },

      /* Ready-made panel HTML, so the caller does not reimplement the
         formatting — and so "0.4 mi NNE" reads the same everywhere. */
      nearestHtml: function (near) {
        if (!near) return '<div class="note">Grid infrastructure lookup unavailable.</div>';
        var h = "", s = near.sub, l = near.line;
        function r(k, v) {
          return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>";
        }
        if (s) {
          h += r("Nearest substation", s.name);
          h += r("Distance", s.mi.toFixed(2) + " mi " + s.dir);
          h += r("Voltage", s.kv ? (Math.round(s.kv) + " kV \u00b7 " + kvBand(s.kv)) : "not published");
          if (s.owner) h += r("Owner", s.owner);
          if (s.lines) h += r("Lines terminating", String(s.lines));
        } else {
          h += '<div class="note">No substation found within 12 miles in ' +
            esc((state.subSrc && state.subSrc.n) || "the national dataset") + ".</div>";
        }
        if (l) {
          h += r("Nearest transmission", (l.kv ? Math.round(l.kv) + " kV" : "kV not published") +
            (l.ends ? (" \u00b7 " + l.ends) : ""));
          h += r("Line distance", l.mi.toFixed(2) + " mi");
          if (l.owner) h += r("Line owner", l.owner);
        }
        h += '<div class="note">Distances are straight-line to the published ' +
          'point, not a routed circuit path. They rank sites; they do not price ' +
          'an interconnection. Source: ' +
          esc((s && s.source) || (l && l.source) || "EIA / HIFLD") +
          '. ComEd\u2019s serving substation above, where present, is the authoritative one \u2014 ' +
          'the nearest substation on the map is frequently not the one that feeds the parcel.</div>';
        return h;
      },

      /* Pan to the nearest substation and open its detail. */
      reveal: function (lat, lon) {
        nearestImpl(lat, lon, function (near) {
          if (!near || !near.sub) return;
          if (!state.subsOn) {
            var cb = opts.subsCheckbox && document.getElementById(opts.subsCheckbox);
            if (cb) { cb.checked = true; }
            API.setSubs(true);
          }
          map.setView([near.sub.lat, near.sub.lon], Math.max(map.getZoom(), 13));
        });
      },

      state: state,
      kvColor: kvColor
    };

    discoverComEd();
    return API;
  };

  global.OmegaGridInfra = NS;
})(window);
