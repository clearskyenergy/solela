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

  function detailLayer() {
    for (var i = 0; i < M.PREFERRED.length; i++) {
      for (var j = 0; j < SVC.layers.length; j++)
        if (SVC.layers[j].id === M.PREFERRED[i]) return M.PREFERRED[i];
    }
    return 75;
  }
  M.detailLayer = detailLayer;

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

  M.hostingIn = function (bbox, cb) {
    var k = bboxKey(bbox);
    if (k === HQ.key && HQ.rows.length) { cb(null, HQ.rows); return; }
    if (HQ.busy) { HQ.queue.push(cb); return; }
    HQ.busy = true; HQ.queue = [cb];

    var env = JSON.stringify({
      xmin: bbox.w, ymin: bbox.s, xmax: bbox.e, ymax: bbox.n,
      spatialReference: { wkid: 4326 }
    });
    var url = base() + "/" + detailLayer() + "/query?f=json&where=1%3D1" +
      "&geometry=" + encodeURIComponent(env) +
      "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=" + encodeURIComponent("OBJECTID,Feeder,SS_N,BESS_HC,PV_HC_kW,EV_HC_kW,Feeder_Q") +
      "&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0002" +
      "&outSR=4326&resultRecordCount=1200";

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
        diag("hosting: cached " + rows.length + " circuits");
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
  M.feederAt = function (lat, lon) {
    var rows = HQ.rows, i, j, hit;
    if (lat == null || lon == null) return null;
    for (i = 0; i < rows.length; i++) {
      hit = false;
      for (j = 0; j < rows[i].rings.length; j++)
        if (inRing(lon, lat, rows[i].rings[j])) hit = !hit;
      if (hit) return rows[i];
    }
    return null;
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
