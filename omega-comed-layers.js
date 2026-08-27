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
    var env = JSON.stringify({
      xmin: b.getWest(), ymin: b.getSouth(), xmax: b.getEast(), ymax: b.getNorth(),
      spatialReference: { wkid: 4326 }
    });
    var url = base() + "/" + detailLayer() + "/query?f=json&where=1%3D1" +
      "&geometry=" + encodeURIComponent(env) +
      "&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=" + encodeURIComponent("OBJECTID,Feeder,SS_N,BESS_HC,PV_HC_kW,EV_HC_kW,Feeder_Q") +
      "&returnGeometry=true&geometryPrecision=5&maxAllowableOffset=0.0002" +
      "&outSR=4326&resultRecordCount=1200";

    getJSON(url, function (err, j) {
      HOST.busy = false;
      HOST.key = k;
      if (HOST.layer) { map.removeLayer(HOST.layer); HOST.layer = null; }
      if (err || !j || j.error || !j.features) {
        HOST.n = 0;
        diag("hosting: " + (err ? err.message : (j && j.error ? ("service " + j.error.code) : "no result")));
        if (done) done(0, err || new Error(j && j.error ? "service error" : "no result"));
        return;
      }
      var g = L.layerGroup(), c = col(), i;
      for (i = 0; i < j.features.length; i++) {
        var f = j.features[i], a = f.attributes;
        if (!f.geometry || !f.geometry.rings) continue;
        var v = parseFloat(a[c]);
        var q = parseFloat(a.Feeder_Q); if (isNaN(q)) q = 0;
        /* Shaded on what is ACTUALLY available, not the published headline.
           Feeder_Q is queued DER that ComEd does not net out anywhere in its
           own data, so a circuit advertising 15,620 kW with 4,895 queued is
           really about 10,725 — and colouring it by the headline sends reps
           at capacity that is already spoken for. */
        var net = isNaN(v) ? null : Math.max(0, v - q);
        var poly = L.polygon(ringsToLatLngs(f.geometry.rings), {
          pane: "capPane",
          color: M.bandColor(net),
          weight: 1,
          opacity: 0.55,
          fillColor: M.bandColor(net),
          fillOpacity: 0.16,
          interactive: false      /* the cards are the interaction surface */
        });
        poly._a = a; poly._net = net;
        g.addLayer(poly);
      }
      HOST.n = j.features.length;
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

  M.ci = function (on, done) {
    CI.on = !!on;
    if (!map) { if (done) done(); return; }
    if (!CI.on) {
      if (CI.layer) { map.removeLayer(CI.layer); CI.layer = null; }
      if (done) done(0);
      return;
    }
    loadBundle(CI, M.CI_URL, "CS_CI", function (state) {
      if (state !== "ready") { if (done) done(0, new Error("ci-industrial.js not deployed")); return; }
      drawCI(done);
    });
  };
  M.refreshCI = function (done) { if (CI.on) drawCI(done); else if (done) done(0); };

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
