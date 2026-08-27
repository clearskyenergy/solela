/* ==========================================================================
   omega-comed-layers.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   The three background layers, lifted out of comed-capacity.html so both the
   map tool and the Site Finder draw the same data from one definition. A
   second copy of the ArcGIS query would drift within a month, and the two
   tools would then disagree about how much capacity a circuit has — which is
   the one thing they must never do.

     hosting  ComEd's published hosting-capacity polygons (live ArcGIS)
     ci       C&I / industrial parcels        (ci-industrial.js bundle)
     ilshines Illinois Shines solar projects  (ilshines-sites.js bundle)

   The two bundles are static files built offline. They load as <script> tags
   rather than fetch() on purpose: they are served from a different host than
   the tenant page, and a script tag is not subject to CORS. Falling back
   across DATA_HOSTS covers a tenant that has not had the bundle deployed to
   its own domain yet.

   ES5 only. Depends on Leaflet and nothing else.
   ========================================================================== */
(function (root) {
  "use strict";

  var M = {};

  /* ---------------------------------------------------------------- config */
  M.PROXY = "https://comed-proxy.clearsky-omega.workers.dev/comed";
  M.DIRECT = "https://utility.arcgis.com/usrsvcs/servers/" +
             "c0f9178a756c4246a99acdb3fe7de103/rest/services/" +
             "ComEd_BESS_Hosting_Capacity_JUN2026/FeatureServer";
  /* Same origin first, then the shared tools host. */
  M.DATA_HOSTS = ["", "https://tools.csebuilders.com/"];
  M.CI_URL = "ci-industrial.js";
  M.ILS_URL = "ilshines-sites.js";
  M.EDC_URL = "edc-sites.js";

  function base() { return M.PROXY || M.DIRECT; }
  function proxyRoot() { return M.PROXY ? M.PROXY.replace(/\/comed\/?$/, "") : null; }
  M.proxyRoot = proxyRoot;

  var map = null, panes = {};
  var DIAG = [];
  function diag(s) { DIAG.push(s); if (DIAG.length > 60) DIAG.shift(); }
  M.diag = function () { return DIAG.slice(); };

  /* Panes so the polygons sit UNDER the property markers no matter what order
     things finish loading in. Without this the capacity fill lands on top of
     the pins whenever the ArcGIS call is the slower of the two, which looks
     like a rendering bug and is really a race. */
  M.init = function (leafletMap) {
    map = leafletMap;
    if (!map) return M;
    [["capPane", 380], ["dataPane", 420], ["pinPane", 460]].forEach(function (p) {
      if (!map.getPane(p[0])) {
        map.createPane(p[0]);
        map.getPane(p[0]).style.zIndex = p[1];
      }
      panes[p[0]] = true;
    });
    return M;
  };

  /* ------------------------------------------------------------- transport */
  function getJSON(url, cb) {
    var x = new XMLHttpRequest();
    try { x.open("GET", url, true); } catch (e) { cb(e); return; }
    x.timeout = 30000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status < 200 || x.status >= 300) { cb(new Error("HTTP " + x.status)); return; }
      try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
    };
    x.ontimeout = function () { cb(new Error("Timed out")); };
    x.onerror = function () { cb(new Error("Network error")); };
    x.send();
  }

  /* A bundle is a plain script that assigns one global. Loaded once, cached,
     with every waiting caller answered when it lands — a second toggle while
     the first is still in flight must not fire a second download. */
  function loadBundle(store, url, globalName, cb) {
    if (store.state === "ready" || store.state === "failed") { if (cb) cb(store.state); return; }
    if (store.state === "loading") { if (cb) store.queue.push(cb); return; }
    store.state = "loading"; store.queue = cb ? [cb] : [];
    var hi = 0;
    (function tryHost() {
      if (hi >= M.DATA_HOSTS.length) {
        store.state = "failed";
        diag(globalName + ": " + url + " not found on this host or tools.csebuilders.com");
        var q0 = store.queue; store.queue = [];
        q0.forEach(function (f) { f("failed"); });
        return;
      }
      var full = M.DATA_HOSTS[hi++] + url;
      var sc = document.createElement("script");
      sc.src = full;
      sc.onload = function () {
        if (!root[globalName]) { tryHost(); return; }
        store.rows = root[globalName];
        store.state = "ready";
        diag(globalName + ": " + store.rows.length + " rows from " + (full || "same origin"));
        var q = store.queue; store.queue = [];
        q.forEach(function (f) { f("ready"); });
      };
      sc.onerror = function () { diag(globalName + ": miss " + full); tryHost(); };
      document.head.appendChild(sc);
    })();
  }

  /* ============================================================== HOSTING
     ComEd publishes the same data at several scales; 71 is township-grain and
     75 is circuit-grain. Picking by zoom rather than hardcoding one means the
     map is not either unreadably dense or uselessly coarse. */
  var SVC = { layers: [], ready: false };
  var HOST = { layer: null, on: false, busy: false, key: "", n: 0 };

  M.PREFERRED = [75, 73, 71, 74, 72, 70];

  /* Test-only: the zoom-to-layer mapping is the thing that decides whether a
     rep is looking at circuits or at block maxima, so it needs exercising
     without a live service index. */
  M.__setLayersForTest = function (layers) { SVC.layers = layers || []; SVC.ready = true; };

  M.boot = function (cb) {
    if (SVC.ready) { if (cb) cb(null, SVC); return; }
    getJSON(base() + "?f=json", function (err, j) {
      if (err || !j || !j.layers) {
        SVC.layers = M.PREFERRED.map(function (id) { return { id: id }; });
        SVC.ready = true;
        diag("service index unavailable — probing known layers");
        if (cb) cb(err || new Error("no service index"), SVC);
        return;
      }
      SVC.layers = j.layers;
      SVC.ready = true;
      diag("service: " + j.layers.length + " layers");
      if (cb) cb(null, SVC);
    });
  };

  /* Which layer to DRAW at a given zoom.

     ComEd publishes the same data at five grains and its own viewer switches
     between them by scale: township blocks when you are looking at the metro,
     buffered circuits when you are looking at a street. That is not a
     compromise, it is the only thing that works — there are tens of thousands
     of layer-75 buffers across the territory and no client can draw them all.

     This function used to return 75 unconditionally while claiming in a
     comment to pick by zoom. The effect was that a metro-wide view asked for
     circuit-grain features, hit the 1,200-record cap, and drew an arbitrary
     1,200 of them as though that were the territory. Empty areas on that map
     were not empty; they were past the cap. That is the exact failure this
     project treats as unacceptable — a shortened list that looks complete.

     Cut points follow ComEd's own scale breaks closely enough:
       z >= 14   75  buffered circuit          — address-resolved
       z 13      74  sixteenth-section block   — best circuit in block
       z 12      73  quarter-section block
       z 11      72  section, 1 sq mi
       z <= 10   71  township, 36 sq mi
     Everything below 75 reports the BEST circuit in its block, never the
     feeder serving a given parcel, so the grain travels with the answer and
     the legend has to say it. */
  var GRAIN = {
    75: { addressResolved: true,
          label: "Buffered circuit \u2014 address-resolved" },
    74: { addressResolved: false, label: "Sixteenth-section block \u2014 best circuit in block" },
    73: { addressResolved: false, label: "Quarter-section block \u2014 best circuit in block" },
    72: { addressResolved: false, label: "Section (1x1 mi) block \u2014 best circuit in block" },
    71: { addressResolved: false, label: "Township (6x6 mi) block \u2014 best circuit in block" }
  };

  var DRAW_BY_ZOOM = [
    { z: 14, id: 75 }, { z: 13, id: 74 }, { z: 12, id: 73 },
    { z: 11, id: 72 }, { z: 0,  id: 71 }
  ];

  function haveLayer(id) {
    for (var j = 0; j < SVC.layers.length; j++)
      if (SVC.layers[j].id === id) return true;
    return false;
  }

  /* Web-mercator scale denominator at a Leaflet zoom, 96 dpi. Same formula
     ComEd's viewer uses, so the two tools resolve a zoom to the same scale
     and therefore to the same layer. */
  function scaleAtZoom(z) { return 591657527.591555 / Math.pow(2, z - 1) / 2; }
  M.scaleAtZoom = scaleAtZoom;

  /* Finest grain first. Used to choose among the layers ComEd says are
     visible at the current scale — if both 75 and 74 are valid here, 75 is
     the one worth drawing because it is the only address-resolved grain. */
  var FINEST_FIRST = [75, 74, 73, 72, 71, 70];

  function detailLayer(zoom) {
    var z = zoom == null ? (map && map.getZoom ? map.getZoom() : 14) : zoom;
    var scale = scaleAtZoom(z), i, j, l, mn, mx, vis = [];

    /* AUTHORITATIVE PATH. Every ArcGIS layer publishes minScale (the
       zoomed-OUT limit) and maxScale (the zoomed-IN limit), and ComEd sets
       them so that exactly one grain is meant to be drawn at any given
       scale. Reading them is strictly better than the guessed break points
       below: when ComEd re-tunes its scale ranges, or the quarterly refresh
       changes which layers exist, this follows automatically. Zero means
       unbounded on that side, which is the ArcGIS convention. */
    for (j = 0; j < SVC.layers.length; j++) {
      l = SVC.layers[j];
      if (l.minScale == null && l.maxScale == null) continue;   /* no info */
      mn = l.minScale || 0; mx = l.maxScale || 0;
      if ((mn === 0 || scale <= mn) && (mx === 0 || scale >= mx)) vis.push(l.id);
    }
    if (vis.length) {
      for (i = 0; i < FINEST_FIRST.length; i++)
        for (j = 0; j < vis.length; j++)
          if (vis[j] === FINEST_FIRST[i]) return FINEST_FIRST[i];
      return vis[0];
    }

    /* FALLBACK. Only reached when the service index did not load, or when it
       carries no scale ranges. These break points are inferred, not
       published, and they exist so a failed metadata fetch degrades to a
       sensible map rather than to nothing. */
    for (i = 0; i < DRAW_BY_ZOOM.length; i++) {
      if (z >= DRAW_BY_ZOOM[i].z && haveLayer(DRAW_BY_ZOOM[i].id))
        return DRAW_BY_ZOOM[i].id;
    }
    for (i = 0; i < M.PREFERRED.length; i++)
      if (haveLayer(M.PREFERRED[i])) return M.PREFERRED[i];
    return 75;
  }
  M.detailLayer = detailLayer;

  /* Is what is currently on screen the feeder itself, or a block maximum?
     The legend and every card that quotes a drawn figure must be able to ask. */
  M.drawnGrain = function (zoom) {
    var id = detailLayer(zoom);
    return { layerId: id,
             addressResolved: id === 75,
             label: (GRAIN[id] && GRAIN[id].label) || ("layer " + id) };
  };

  /* ComEd's own three bands, and a prospecting palette that ranks by what is
     worth a call rather than by what the utility chose to emphasise. Both are
     kept because a rep and an engineer are reading for different things. */
  M.COMED_COLORS = { hi: "#8C8C8C", mid: "#00DB00", lo: "#A900E6" };
  M.PROSPECT_COLORS = { hi: "#E8590C", mid: "#F2B705", lo: "#C9CDD2" };
  M.prospect = true;
  function palette() { return M.prospect ? M.PROSPECT_COLORS : M.COMED_COLORS; }

  M.bandOf = function (kw) {
    var n = parseFloat(kw);
    if (isNaN(n)) return null;
    return n >= 1001 ? "hi" : n >= 501 ? "mid" : "lo";
  };
  M.bandColor = function (kw) {
    var b = M.bandOf(kw);
    return b ? palette()[b] : "#9aa7b4";
  };

  function ringsToLatLngs(rings) {
    var out = [], i, j, r, one;
    for (i = 0; i < rings.length; i++) {
      r = rings[i]; one = [];
      for (j = 0; j < r.length; j++) one.push([r[j][1], r[j][0]]);
      out.push(one);
    }
    return out;
  }

  /* Which column binds depends on the product being sited: a battery needs
     both directions (BESS_HC, the min of the two), a data centre only draws
     (EV_HC_kW), solar only exports (PV_HC_kW). Drawing the wrong one paints
     a circuit green that cannot take the thing being sold. */
  M.FIELD = { bess: "BESS_HC", ev: "EV_HC_kW", pv: "PV_HC_kW" };
  M.useField = "bess";
  function col() { return M.FIELD[M.useField] || "BESS_HC"; }

  /* ------------------------------------------------------- feeder lookup
     The polygons were already being fetched to shade the map and then
     thrown away except as Leaflet layers. They are the only thing that can
     tell a parcel which circuit it sits on, so they are kept as rows and
     the draw step reads the same cache. ONE query, two consumers — the
     alternative is a second copy of this URL, which is exactly the drift
     this file exists to prevent.

     Cached by bbox only, not by product: outFields already pull all three
     columns, so switching Battery/Load/Solar recolours from memory instead
     of hitting the service again. */
  var HQ = { key: "", rows: [], busy: false, queue: [] };

  function bboxKey(b) {
    return [b.s, b.n, b.w, b.e].map(function (x) { return (+x).toFixed(3); }).join(",");
  }

  /* What the drawn hosting layer currently represents. The page reads this
     for the legend: a map of block maxima and a map of circuits look
     identical on screen and mean very different things. */
  M.hostingState = function () {
    return { layerId: HQ.layerId || null,
             addressResolved: !!HQ.addressResolved,
             truncated: !!HQ.truncated,
             count: HQ.rows.length,
             label: (GRAIN[HQ.layerId] && GRAIN[HQ.layerId].label) || "" };
  };

  /* ══════════════════════════════════════════════════════════════════════
     ATTRIBUTION IS NOT DRAWING

     These are two different questions answered from two different layers,
     and conflating them was producing confidently wrong circuits.

       DRAWING     — which grain is legible at this zoom. ComEd switches
                     between five, exactly as its own viewer does, and a
                     metro view is necessarily block maxima.
       ATTRIBUTING — which circuit serves THIS parcel. Only layer 75 can
                     answer that. A township block says "the best feeder in
                     36 square miles is X", which is not a claim about any
                     particular building on it.

     Sharing one cache meant a parcel picked up whatever grain happened to be
     drawn. Zoomed out, every card got a block maximum — a real feeder id and
     a real number, both belonging to somewhere else.

     So attribution has its own cache, always layer 75, fetched at higher
     resolution than the drawn copy because it decides containment rather
     than appearance. Above a viewport of about ten miles it refuses to
     fetch at all: layer 75 across a metro is tens of thousands of buffers
     and the answer would be truncated, which is worse than absent. In that
     state parcels carry NO circuit and the page says to zoom in — an honest
     blank rather than a plausible wrong id.
     ══════════════════════════════════════════════════════════════════════ */
  var AQ = { key: "", rows: [], busy: false, queue: [], tooWide: false, truncated: false };
  M.ATTRIB_LAYER = 75;
  M.ATTRIB_MAX_DEG = 0.15;        /* ~10 miles of longitude at this latitude */

  M.attribState = function () {
    return { count: AQ.rows.length, tooWide: AQ.tooWide,
             truncated: AQ.truncated, layerId: M.ATTRIB_LAYER };
  };

  M.attribIn = function (bbox, cb) {
    var k = bboxKey(bbox);
    if (k === AQ.key) { cb(null, AQ.rows); return; }
    if (AQ.busy) { AQ.queue.push(cb); return; }

    if ((bbox.e - bbox.w) > M.ATTRIB_MAX_DEG || (bbox.n - bbox.s) > M.ATTRIB_MAX_DEG) {
      AQ.key = k; AQ.rows = []; AQ.tooWide = true; AQ.truncated = false;
      diag("attrib: viewport too wide for layer 75 — parcels get no circuit");
      cb(null, AQ.rows);
      return;
    }

    AQ.busy = true; AQ.queue = [cb];
    var env = JSON.stringify({
      xmin: bbox.w, ymin: bbox.s, xmax: bbox.e, ymax: bbox.n,
      spatialReference: { wkid: 4326 }
    });
    var url = base() + "/" + M.ATTRIB_LAYER + "/query?f=json&where=1%3D1" +
      "&geometry=" + encodeURIComponent(env) +
      "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
      "&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true" +
      /* Ten times finer than the drawn copy. The drawn one is simplified for
         speed; this one decides whether a parcel is on a circuit, and 22 m
         of simplification is enough to move a building off its own feeder. */
      "&geometryPrecision=6&maxAllowableOffset=0.00002" +
      "&maxRecordCountFactor=3&returnExceededLimitFeatures=false" +
      "&resultRecordCount=4000";

    getJSON(url, function (err, j) {
      AQ.busy = false; AQ.tooWide = false;
      var rows = [], i, row;
      if (!err && j && !j.error && j.features) {
        for (i = 0; i < j.features.length; i++) {
          if (!j.features[i].geometry || !j.features[i].geometry.rings) continue;
          row = interpret(j.features[i].attributes || {});
          row.rings = j.features[i].geometry.rings;
          rows.push(row);
        }
        AQ.truncated = !!j.exceededTransferLimit;
        diag("attrib: " + rows.length + " layer-75 circuits" +
             (AQ.truncated ? " (TRUNCATED)" : ""));
      } else {
        diag("attrib: " + (err ? err.message :
             (j && j.error ? "service " + j.error.code : "no result")));
      }
      AQ.key = k; AQ.rows = rows;
      var qs = AQ.queue; AQ.queue = [];
      for (i = 0; i < qs.length; i++) qs[i](null, rows);
    });
  };

  M.hostingIn = function (bbox, cb) {
    var k = bboxKey(bbox);
    if (k === HQ.key && HQ.rows.length) { cb(null, HQ.rows); return; }
    if (HQ.busy) { HQ.queue.push(cb); return; }
    HQ.busy = true; HQ.queue = [cb];

    var env = JSON.stringify({
      xmin: bbox.w, ymin: bbox.s, xmax: bbox.e, ymax: bbox.n,
      spatialReference: { wkid: 4326 }
    });
    var lid = detailLayer();
    var url = base() + "/" + lid + "/query?f=json&where=1%3D1" +
      "&geometry=" + encodeURIComponent(env) +
      "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=" + encodeURIComponent("OBJECTID,Feeder,SS_N,BESS_HC,PV_HC_kW,EV_HC_kW,Feeder_Q") +
      "&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0002" +
      /* maxRecordCountFactor is what ComEd's own viewer sends; it lifts the
         service's per-request cap rather than accepting the default.
         returnExceededLimitFeatures=false makes the service SAY it hit the
         cap (exceededTransferLimit) instead of quietly returning a partial
         set that draws exactly like a complete one. */
      "&maxRecordCountFactor=3&returnExceededLimitFeatures=false" +
      "&outSR=4326&resultRecordCount=2000";

    getJSON(url, function (err, j) {
      HQ.busy = false;
      var rows = [], i;
      var e = err || (j && j.error ? new Error("service " + j.error.code) : null);
      if (!e && j && j.features) {
        for (i = 0; i < j.features.length; i++) {
          var f = j.features[i], a = f.attributes;
          if (!f.geometry || !f.geometry.rings) continue;
          var q = parseFloat(a.Feeder_Q); if (isNaN(q)) q = 0;
          rows.push({
            a: a, rings: f.geometry.rings,
            feeder: String(a.Feeder == null ? "" : a.Feeder),
            sub: a.SS_N == null ? "" : String(a.SS_N),
            queue: q,
            bess: parseFloat(a.BESS_HC),
            pv: parseFloat(a.PV_HC_kW),
            ev: parseFloat(a.EV_HC_kW)
          });
        }
        HQ.key = k; HQ.rows = rows;
        /* What is on screen, and whether it is all of it. Both travel with
           the cache so the legend can state them rather than the map
           implying completeness it does not have. */
        HQ.layerId = lid;
        HQ.addressResolved = (lid === 75);
        HQ.truncated = !!(j.exceededTransferLimit ||
                          j.properties && j.properties.exceededTransferLimit);
        diag("hosting: cached " + rows.length + " circuits from layer " + lid +
             (HQ.truncated ? " (TRUNCATED — more exist in this view)" : ""));
      } else {
        diag("hosting: " + (e ? e.message : "no result"));
      }
      var qs = HQ.queue; HQ.queue = [];
      for (i = 0; i < qs.length; i++) qs[i](e, rows);
    });
  };

  M.hostingRows = function () { return HQ.rows.slice(); };

  /* Ray cast in lon/lat. Even-odd across every ring of the feature, so a
     donut counts as outside rather than inside twice. */
  function inRing(x, y, ring) {
    var inside = false, i, j, xi, yi, xj, yj;
    for (i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      xi = ring[i][0]; yi = ring[i][1];
      xj = ring[j][0]; yj = ring[j][1];
      if (((yi > y) !== (yj > y)) &&
          (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }

  /* Which circuit is this parcel on? Answered from the cached polygons, so
     it costs nothing per parcel — a sweep of 400 buildings is still one
     ArcGIS call. Returns null rather than guessing: a wrong feeder id on a
     card is worse than a blank one, because a rep will quote it. */
  /* Metres between two lon/lat points, and from a point to a segment.
     Equirectangular at the working latitude — good to a metre or two across
     a city, and it is only ever deciding "is this parcel on that circuit". */
  function mPerDeg(lat) {
    return { x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 };
  }
  function segDist(px, py, ax, ay, bx, by, k) {
    var dx = (bx - ax) * k.x, dy = (by - ay) * k.y;
    var wx = (px - ax) * k.x, wy = (py - ay) * k.y;
    var L = dx * dx + dy * dy;
    var t = L <= 0 ? 0 : Math.max(0, Math.min(1, (wx * dx + wy * dy) / L));
    var ex = wx - t * dx, ey = wy - t * dy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function ringDist(lon, lat, ring) {
    var k = mPerDeg(lat), best = Infinity, i, d;
    for (i = 0; i < ring.length - 1; i++) {
      d = segDist(lon, lat, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], k);
      if (d < best) best = d;
    }
    return best;
  }

  function covers(row, lat, lon) {
    var hit = false, j;
    for (j = 0; j < row.rings.length; j++)
      if (inRing(lon, lat, row.rings[j])) hit = !hit;
    return hit;
  }

  /* Net capacity for the selected product. Used to rank overlapping circuits
     the same way build_ci_bundles.py ranks them, so the map and the harvest
     never disagree about which feeder a parcel belongs to. */
  function netOf(row) {
    var c = M.capacityOf(row);
    if (!c || c.nameplate == null) return -1;
    return Math.max(0, c.nameplate - (c.queue || 0));
  }

  /* Circuit polygons are BUFFERS and they overlap — a point routinely sits
     inside several. Returning the first hit makes the answer depend on the
     order ComEd happened to serve them, which is how a parcel gets attributed
     to the 0 kW circuit while a 360 kW one covers it too. Take the one with
     the most genuinely available capacity, which is also the one a rep would
     work. This mirrors feeder_for() in build_ci_bundles.py exactly. */
  M.feederAt = function (lat, lon) {
    /* AQ, not HQ. The drawn cache may be block grain; only layer 75 can say
       which circuit serves a parcel. Empty AQ means "not resolvable at this
       zoom", and null is the correct answer to that. */
    var rows = AQ.rows, i, best = null, bestNet = -2, n;
    if (lat == null || lon == null) return null;
    for (i = 0; i < rows.length; i++) {
      if (!covers(rows[i], lat, lon)) continue;
      n = netOf(rows[i]);
      if (n > bestNet) { bestNet = n; best = rows[i]; }
    }
    return best;
  };

  /* Every circuit covering a point, best first. The card can then say "two
     circuits cover this parcel" instead of silently picking one. */
  M.feedersAt = function (lat, lon) {
    var rows = AQ.rows, out = [], i;
    if (lat == null || lon == null) return out;
    for (i = 0; i < rows.length; i++)
      if (covers(rows[i], lat, lon)) out.push(rows[i]);
    out.sort(function (a, b) { return netOf(b) - netOf(a); });
    return out;
  };

  /* NEAREST_M is how far outside a buffer a point may sit and still be
     attributed. ComEd's own viewer resolves addresses with a 150 ft buffer,
     which is 46 m, and that is the default here for the same reason: the
     published polygon is a generalised buffer around a circuit route, and a
     building on that street can fall a few metres outside it through
     rounding alone.

     A proximity match is NOT the same answer as a containment match and must
     never be rendered as one. It comes back flagged, with the distance, so
     the card can say "nearest circuit, 31 m away — confirm before quoting"
     rather than presenting a number the customer cannot actually reach. */
  M.NEAREST_M = 46;
  /* How far out to keep LOOKING, as opposed to how far out to ATTRIBUTE.
     A point with no circuit within 46 m is not the same situation as a point
     in the middle of nowhere, and "no circuit nearby" hides which one it is.
     Searching to 2 km lets the card say "the nearest is 190 m away" so a rep
     can judge, without that ever becoming an attribution. */
  M.LOOK_M = 2000;

  M.feederNear = function (lat, lon, maxM) {
    var inside = M.feederAt(lat, lon);
    if (inside) return { row: inside, contains: true, beyond: false, distance: 0,
                         alsoCovering: M.feedersAt(lat, lon).length };
    var lim = maxM == null ? M.NEAREST_M : maxM;
    var rows = AQ.rows, best = null, bd = Infinity, i, j, d;
    if (lat == null || lon == null) return null;
    for (i = 0; i < rows.length; i++) {
      for (j = 0; j < rows[i].rings.length; j++) {
        d = ringDist(lon, lat, rows[i].rings[j]);
        if (d < bd || (Math.abs(d - bd) < 0.5 && best && netOf(rows[i]) > netOf(best))) {
          bd = d; best = rows[i];
        }
      }
    }
    if (!best || bd > M.LOOK_M) return null;
    /* Beyond the attribution radius the circuit is REPORTED but not adopted:
       `beyond` true, and the caller must not read capacity off it. The
       distance is the useful part — it turns "nothing here" into "the grid
       is 190 m that way", which is a different conversation. */
    return { row: best, contains: false, beyond: bd > lim,
             distance: Math.round(bd), alsoCovering: 0 };
  };

  /* Test-only. The geometry rules below — which of several overlapping
     buffers wins, and how far outside one a point may sit — are the kind of
     thing that drifts silently, so they need to be exercised without a live
     ComEd fetch. Nothing in the page calls this. */
  M.__setHostingRows = function (rows) { HQ.rows = rows || []; HQ.key = "test"; };
  /* Attribution cache, which is what feederAt actually reads. */
  M.__setAttribRows = function (rows) { AQ.rows = rows || []; AQ.key = "test"; AQ.tooWide = false; };

  /* ------------------------------------------------------ point resolution
     ASK THE SERVER. The cached polygons this file draws with are fetched at
     maxAllowableOffset 0.0002 — roughly 22 m of simplification — because
     full-resolution rings for a whole viewport are enormous. That is right
     for drawing and wrong for deciding containment: a parcel can sit 20 m
     inside the real circuit and outside the simplified one, which is exactly
     how an address that ComEd's own viewer resolves comes back blank here.

     So a point is resolved by querying ComEd with a small envelope around it
     and letting the service intersect against its own untouched geometry.
     One request, no generalisation, same answer the utility's viewer gives.

     LAYER GRAIN IS NOT COSMETIC. Only layer 75 is the buffered circuit and
     therefore address-resolved. Layers 71-74 are PLSS grid blocks — township,
     section, quarter, sixteenth — and each reports the BEST circuit anywhere
     in that block, per ComEd's own service description. A reading off 74 is
     not the feeder serving the parcel; it is the best feeder within a
     quarter-mile of it. Answering from those without saying so would turn a
     "no data" into a confident wrong number, so the grain comes back with
     the result and the caller must show it. */
  M.POINT_LAYERS = [75, 74, 73, 72, 71];
  M.GRAIN = GRAIN;

  /* ~60 m each way. Wide enough that a click on the kerb still catches the
     circuit running down the street, tight enough that it cannot reach the
     next feeder over. */
  M.PROBE_DEG = 0.00055;

  /* Read capacity out of whatever attributes a layer actually returns.

     Field names are NOT the same across the five grains. Layer 75 carries
     Feeder and SS_N because it is a circuit; the block layers 71-74 carry an
     aggregate and no feeder at all. Asking for a named field list therefore
     ERRORS on the block layers rather than returning nothing, which is a
     different thing entirely and used to be indistinguishable here.

     So: request everything, uppercase the keys, and pick. Same approach the
     Capacity Finder uses, for the same reason. */
  function interpret(attrs) {
    if (!attrs) return null;
    var k = {}, p;
    for (p in attrs) if (attrs.hasOwnProperty(p)) k[p.toUpperCase()] = attrs[p];
    function n(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }
    function co(a, b) { return (a != null && a !== "") ? a : b; }
    var q = n(k.FEEDER_Q);
    return {
      a: attrs,
      rings: [],
      feeder: String(co(k.FEEDER, co(k.FEEDER_N, "")) || ""),
      sub: k.SS_N == null ? "" : String(k.SS_N),
      queue: q == null ? 0 : q,
      bess: n(k.BESS_HC),
      pv: n(k.PV_HC_KW),
      ev: n(k.EV_HC_KW),
      buff: n(k.BUFF_DIST)
    };
  }

  M.probePoint = function (lat, lon, cb) {
    if (lat == null || lon == null) { cb(new Error("no point given")); return; }
    var dLat = M.PROBE_DEG;
    var dLon = M.PROBE_DEG / Math.cos(lat * Math.PI / 180);
    var env = JSON.stringify({
      xmin: lon - dLon, ymin: lat - dLat, xmax: lon + dLon, ymax: lat + dLat,
      spatialReference: { wkid: 4326 }
    });
    var order = M.POINT_LAYERS.slice(), i = 0, errs = [], lastUrl = "";

    (function tryNext() {
      if (i >= order.length) {
        /* EVERY layer empty is close to impossible for a point inside the
           territory. Layers 71-74 are PLSS blocks that TILE the service
           area — a township block is 36 square miles and there is no gap
           between them. So if even layer 71 returned nothing, either the
           point is outside ComEd's footprint or the request is malformed in
           a way the service accepted and answered emptily.

           Both are reported, with the exact URL, because the difference is
           always in the request and a screenshot of the card cannot show it. */
        var inTerritory = (lat > 40.6 && lat < 42.6 && lon > -89.5 && lon < -87.4);
        cb(null, { rows: [], layerId: null, addressResolved: false,
                   grain: "", tried: order, errors: errs,
                   serviceFailed: errs.length === order.length,
                   emptyEverywhere: errs.length === 0,
                   suspicious: errs.length === 0 && inTerritory,
                   lastUrl: lastUrl });
        return;
      }
      var id = order[i++];
      var url = base() + "/" + id + "/query?f=json&where=1%3D1" +
        "&geometry=" + encodeURIComponent(env) +
        "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
        "&spatialRel=esriSpatialRelIntersects" +
        /* Everything, because the grains do not share a schema. */
        "&outFields=*&returnGeometry=false&resultRecordCount=25";
      lastUrl = url;

      getJSON(url, function (err, j) {
        if (err || !j || j.error) {
          var msg = err ? err.message : ("service " + (j.error.code || "?") +
                     (j.error.message ? " " + j.error.message : ""));
          errs.push("L" + id + ": " + msg);
          diag("probe L" + id + ": " + msg);
          diag("   url " + url);
          tryNext();
          return;
        }
        if (!j.features || !j.features.length) {
          /* A real, successful "nothing here" — recorded as such, not as an
             error, so the caller can tell the two apart. The URL is logged
             too: when this tool and ComEd's own viewer disagree about a
             point, the difference is always in the request, and guessing at
             it from a screenshot has cost this project several rounds. */
          diag("probe L" + id + ": 0 features");
          diag("   url " + url);
          tryNext();
          return;
        }
        var rows = [], n2, row;
        for (n2 = 0; n2 < j.features.length; n2++) {
          row = interpret(j.features[n2].attributes || {});
          if (row) rows.push(row);
        }
        rows.sort(function (x, y) { return netOf(y) - netOf(x); });
        diag("probe L" + id + ": " + rows.length + " circuit(s)");
        cb(null, {
          rows: rows, layerId: id,
          addressResolved: !!(GRAIN[id] && GRAIN[id].addressResolved),
          grain: (GRAIN[id] && GRAIN[id].label) || "unknown grain",
          tried: order.slice(0, i), errors: errs, serviceFailed: false
        });
      });
    })();
  };

  /* Nameplate for the product currently selected, net of queued DER. */
  M.capacityOf = function (row) {
    if (!row) return null;
    var f = M.useField === "ev" ? row.ev : M.useField === "pv" ? row.pv : row.bess;
    if (isNaN(f)) return null;
    return { nameplate: f, queue: row.queue || 0, feederId: row.feeder, sub: row.sub };
  };

  M.hosting = function (on, done) {
    HOST.on = !!on;
    if (!map) { if (done) done(); return; }
    if (!HOST.on) {
      if (HOST.layer) { map.removeLayer(HOST.layer); HOST.layer = null; }
      HOST.n = 0; HOST.key = "";
      if (done) done(0);
      return;
    }
    M.boot(function () { drawHosting(done); });
  };
  M.refreshHosting = function (done) {
    if (HOST.on) M.boot(function () { drawHosting(done); });
    else if (done) done(HOST.n);
  };

  function viewKey() {
    var b = map.getBounds();
    return [b.getSouth(), b.getNorth(), b.getWest(), b.getEast()]
      .map(function (x) { return x.toFixed(3); }).join(",") + "|" + M.useField;
  }

  function drawHosting(done) {
    if (HOST.busy) { if (done) done(HOST.n); return; }
    /* Below zoom 12 the request returns the whole service and the browser
       spends thirty seconds drawing a solid block of colour nobody can read. */
    if (map.getZoom() < 12) {
      if (HOST.layer) { map.removeLayer(HOST.layer); HOST.layer = null; }
      HOST.n = -1;
      if (done) done(-1);
      return;
    }
    var k = viewKey();
    if (k === HOST.key && HOST.layer) { if (done) done(HOST.n); return; }
    HOST.busy = true;

    var b = map.getBounds();
    var bbox = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() };

    M.hostingIn(bbox, function (err, rows) {
      HOST.busy = false;
      HOST.key = k;
      if (HOST.layer) { map.removeLayer(HOST.layer); HOST.layer = null; }
      if (err) {
        HOST.n = 0;
        if (done) done(0, err);
        return;
      }
      var g = L.layerGroup(), c = col(), i;
      for (i = 0; i < rows.length; i++) {
        var r = rows[i];
        var v = parseFloat(r.a[c]);
        /* Shaded on what is ACTUALLY available, not the published headline.
           Feeder_Q is queued DER that ComEd does not net out anywhere in its
           own data, so a circuit advertising 15,620 kW with 4,895 queued is
           really about 10,725 — and colouring it by the headline sends reps
           at capacity that is already spoken for. */
        var net = isNaN(v) ? null : Math.max(0, v - r.queue);
        var poly = L.polygon(ringsToLatLngs(r.rings), {
          pane: "capPane",
          color: M.bandColor(net),
          weight: 1,
          opacity: 0.55,
          fillColor: M.bandColor(net),
          fillOpacity: 0.16,
          interactive: false      /* the cards are the interaction surface */
        });
        poly._a = r.a; poly._net = net;
        g.addLayer(poly);
      }
      HOST.n = rows.length;
      HOST.layer = g;
      g.addTo(map);
      if (done) done(HOST.n);
    });
  }

  M.hostingCount = function () { return HOST.n; };

  /* =================================================================== C&I */
  var CI = { state: "idle", rows: [], queue: [], layer: null, on: false };

  M.ciRows = function () { return CI.rows || []; };
  M.ciState = function () { return CI.state; };

  /* ------------------------------------------------------- sharded parcels
     C&I across the whole territory is 150–250k parcels. As one script tag
     that is 30–50 MB and the tab is unresponsive before the map draws, so
     the bundle is split per county and the manifest carries each shard's
     bbox. Only the counties the viewport actually touches get downloaded,
     and each one downloads once.

     A shard that fails to load is reported by county name rather than as a
     silently short list — "5,200 parcels" when the honest answer is "5,200
     parcels and Will County did not load" is the kind of quiet wrong that
     sends a rep to a corridor believing it is empty. */
  var MAN = { state: "idle", shards: [], queue: [] };
  var SHARDS = {};                 /* key -> {state, rows, queue} */
  var CI_FAILED = [];
  M.CI_MANIFEST_URL = "ci-manifest.js";

  M.ciFailed = function () { return CI_FAILED.slice(); };
  M.ciShards = function () { return MAN.shards.slice(); };

  function loadManifest(cb) {
    if (MAN.state === "ready" || MAN.state === "failed") { cb(MAN.state); return; }
    if (MAN.state === "loading") { MAN.queue.push(cb); return; }
    MAN.state = "loading"; MAN.queue = [cb];
    loadBundle({ state: "idle", queue: [] }, M.CI_MANIFEST_URL, "CS_CI_MANIFEST",
      function (state) {
        if (state === "ready" && root.CS_CI_MANIFEST && root.CS_CI_MANIFEST.length) {
          MAN.shards = root.CS_CI_MANIFEST;
          MAN.state = "ready";
          diag("ci manifest: " + MAN.shards.length + " county shards");
        } else {
          /* No manifest means a pre-shard deployment. The old single bundle
             still works and still says so, rather than the layer going dark
             on a tenant nobody has rebuilt yet. */
          MAN.state = "failed";
          diag("ci manifest: absent — falling back to " + M.CI_URL);
        }
        var q = MAN.queue; MAN.queue = [];
        for (var i = 0; i < q.length; i++) q[i](MAN.state);
      });
  }

  function boxHits(bb, b) {
    /* manifest bbox is [w, s, e, n] */
    return !(bb[0] > b.e || bb[2] < b.w || bb[1] > b.n || bb[3] < b.s);
  }

  function loadShard(sh, cb) {
    var st = SHARDS[sh.key];
    if (st && (st.state === "ready" || st.state === "failed")) { cb(st.state); return; }
    if (st && st.state === "loading") { st.queue.push(cb); return; }
    st = SHARDS[sh.key] = { state: "idle", queue: [], rows: [] };
    loadBundle(st, sh.file, "CS_CI_" + sh.key.toUpperCase(), function (state) {
      if (state !== "ready" && CI_FAILED.indexOf(sh.key) < 0) CI_FAILED.push(sh.key);
      cb(state);
    });
  }

  /* Load the parcels WITHOUT drawing them, for the bbox in question. The Site
     Finder wants the rows as records, not as pins, and must not be forced to
     switch a map layer on to get at them. */
  M.loadCI = function (cb, bbox) {
    loadManifest(function (mstate) {
      if (mstate !== "ready") {
        /* Legacy single bundle. */
        loadBundle(CI, M.CI_URL, "CS_CI", function (state) {
          cb(state === "ready" ? null : new Error(M.CI_URL + " is not deployed to this host."),
             CI.rows || []);
        });
        return;
      }
      var want = [], i;
      for (i = 0; i < MAN.shards.length; i++)
        if (!bbox || boxHits(MAN.shards[i].bbox, bbox)) want.push(MAN.shards[i]);
      if (!want.length) { CI.rows = []; CI.state = "ready"; cb(null, []); return; }

      var pending = want.length;
      for (i = 0; i < want.length; i++) {
        loadShard(want[i], function () {
          if (--pending) return;
          var rows = [], missing = [], k, st;
          for (k = 0; k < want.length; k++) {
            st = SHARDS[want[k].key];
            if (!st || st.state !== "ready") { missing.push(want[k].key); continue; }
            if (st.rows && st.rows.length) rows = rows.concat(st.rows);
          }
          CI.rows = rows;
          CI.state = "ready";
          /* Only the shards THIS viewport asked for. CI_FAILED accumulates for
             the life of the tab, so reporting it wholesale means a county that
             failed once keeps appearing in the header long after the rep has
             panned away from it — a warning about a county that is not on
             screen is noise, and noise is how a real one gets ignored. */
          cb(missing.length
             ? new Error("These counties did not load: " + missing.join(", "))
             : null, rows);
        });
      }
    });
  };

  M.ci = function (on, done) {
    CI.on = !!on;
    if (!map) { if (done) done(); return; }
    if (!CI.on) {
      if (CI.layer) { map.removeLayer(CI.layer); CI.layer = null; }
      if (done) done(0);
      return;
    }
    var b = map.getBounds();
    M.loadCI(function (err) {
      if (err && !CI.rows.length) { if (done) done(0, err); return; }
      drawCI(function (n) { if (done) done(n, err); });
    }, { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() });
  };
  /* Panning west out of Cook and into Kane has to pull Kane, or the layer
     goes empty at the county line and reads as "no parcels here". */
  M.refreshCI = function (done) {
    if (!CI.on) { if (done) done(0); return; }
    if (!map) { if (done) done(0); return; }
    var b = map.getBounds();
    /* The error is passed through whether or not rows came back. A pan that
       pulls three counties and loses one draws a map that looks complete, and
       suppressing the error because SOMETHING loaded is precisely the quiet
       wrong the shard naming exists to prevent. The caller decides whether to
       show a count, a warning, or both. */
    M.loadCI(function (err) {
      drawCI(function (n) { if (done) done(n, err || null); });
    }, { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() });
  };

  function drawCI(done) {
    if (CI.layer) { map.removeLayer(CI.layer); CI.layer = null; }
    /* Below 13 there are tens of thousands of parcels in view and the canvas
       renderer stalls. Silence is worse than a message, so the caller is told
       how many were drawn and can say "zoom in". */
    if (map.getZoom() < 13) { if (done) done(-1); return; }
    var b = map.getBounds(), g = L.layerGroup(), n = 0, i;
    for (i = 0; i < CI.rows.length; i++) {
      var r = CI.rows[i];
      var lat = r.lat != null ? r.lat : r[0], lon = r.lon != null ? r.lon : r[1];
      if (lat == null || lon == null) continue;
      if (!b.contains([lat, lon])) continue;
      var ac = parseFloat(r.ac || r.acres || 0) || 0;
      var park = !!(r.park || r.inPark);
      g.addLayer(L.circleMarker([lat, lon], {
        pane: "dataPane",
        radius: Math.max(3, Math.min(3 + Math.sqrt(ac) * 1.6, 11)),
        color: "#fff", weight: 1,
        fillColor: park ? "#7C3AED" : "#A78BFA",
        fillOpacity: 0.65,
        interactive: false
      }));
      if (++n > 4000) break;
    }
    CI.layer = g; g.addTo(map);
    if (done) done(n);
  }

  /* ====================================================== ILLINOIS SHINES */
  var ILS = { state: "idle", rows: [], queue: [], layer: null, on: false };

  M.ilsRows = function () { return ILS.rows || []; };
  M.ilsState = function () { return ILS.state; };

  M.ilshines = function (on, done) {
    ILS.on = !!on;
    if (!map) { if (done) done(); return; }
    if (!ILS.on) {
      if (ILS.layer) { map.removeLayer(ILS.layer); ILS.layer = null; }
      if (done) done(0);
      return;
    }
    loadBundle(ILS, M.ILS_URL, "CS_ILSHINES", function (state) {
      if (state !== "ready") { if (done) done(0, new Error("ilshines-sites.js not deployed")); return; }
      drawILS(done);
    });
  };
  M.refreshILS = function (done) { if (ILS.on) drawILS(done); else if (done) done(0); };

  function drawILS(done) {
    if (ILS.layer) { map.removeLayer(ILS.layer); ILS.layer = null; }
    var b = map.getBounds(), g = L.layerGroup(), n = 0, i;
    for (i = 0; i < ILS.rows.length; i++) {
      var r = ILS.rows[i];
      var lat = r.lat, lon = r.lon;
      if (lat == null || lon == null) continue;
      if (!b.contains([lat, lon])) continue;
      var mw = parseFloat(r.mw || r.kw / 1000 || 0) || 0;
      var live = /energi|operat|in service/i.test(String(r.status || ""));
      g.addLayer(L.circleMarker([lat, lon], {
        pane: "dataPane",
        radius: Math.max(4, Math.min(4 + Math.sqrt(mw) * 3.2, 14)),
        color: "#fff", weight: 1.5,
        fillColor: live ? "#F59E0B" : "#94A3B8",
        fillOpacity: 0.7,
        interactive: false
      }));
      n++;
    }
    ILS.layer = g; g.addTo(map);
    /* These are ZIP centroids, not sited coordinates. Anyone reading them as
       parcel locations will drive to the wrong block. */
    if (done) done(n);
  }

  M.ILS_NOTE = "Illinois Shines pins are ZIP centroids, not sited coordinates.";

  M.loadILS = function (cb) {
    loadBundle(ILS, M.ILS_URL, "CS_ILSHINES", function (state) {
      cb(state === "ready" ? null : new Error(M.ILS_URL + " is not deployed to this host."),
         ILS.rows || []);
    });
  };

  /* ============================================== FOR SALE / FOR LEASE
     The Illinois EDC site-selection feed. It carries the one field nothing
     else here has: EXISTING ELECTRICAL SERVICE. Feeder capacity says what
     the grid will accept; service size says what is already built to the
     building, and a 200 A site needs a service upgrade before a battery
     conversation is real. That kills more C&I storage deals than
     interconnection does, which is why it travels with the listing rather
     than being discovered on site visit three. */
  var EDC = { state: "idle", rows: [], queue: [] };

  M.edcRows = function () { return EDC.rows || []; };
  M.edcState = function () { return EDC.state; };
  M.loadEDC = function (cb) {
    loadBundle(EDC, M.EDC_URL, "CS_EDC", function (state) {
      cb(state === "ready" ? null : new Error(M.EDC_URL + " is not deployed to this host."),
         EDC.rows || []);
    });
  };

  /* Re-run whatever is switched on after a pan or zoom. */
  M.refreshAll = function (done) {
    var pending = 3, counts = {};
    function step(k) { return function (n) { counts[k] = n; if (--pending === 0 && done) done(counts); }; }
    M.refreshHosting(step("hosting"));
    M.refreshCI(step("ci"));
    M.refreshILS(step("ilshines"));
  };

  root.OmegaComEdLayers = M;
})(typeof window !== "undefined" ? window : this);
