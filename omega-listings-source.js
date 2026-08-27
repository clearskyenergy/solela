/* ==========================================================================
   omega-listings-source.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   One normalized property shape, several interchangeable sources behind it.

   IMPORTANT, read before wiring PropertyShark:
   PropertyShark does not publish a documented public REST API. What exists
   is (a) enterprise/bulk data agreements negotiated directly, (b) third-party
   scrapers of their site, which will violate their terms and break without
   notice. Do not design around an endpoint that has not been confirmed in
   writing. The adapter below is deliberately thin and the field mapping is
   isolated to ONE function so that swapping to PropertyRadar, Regrid, ATTOM,
   Reonomy — or the Cook County parcel pipeline this platform already runs —
   is an afternoon, not a rewrite.

   Every provider MUST return the shape documented in `NORMALIZED` and MUST
   stamp `src` on each record. A modelled number presented as measured is the
   failure mode that ends up in front of a customer.
   ========================================================================== */
(function (root) {
  "use strict";

  var S = { providers: {}, active: null, name: "" };

  /* ------------------------------------------------------------ the shape
     id            stable per provider; used as the ledger's siteId
     addr          street address, no unit
     city, state, zip
     lat, lon      WGS84 centroid
     sqft          building area
     lotAcres
     type          normalized: Industrial | Warehouse | Office | Retail |
                   Manufacturing | Cold Storage | Data Center | Flex |
                   Multifamily | Institutional | Vacant Land | Other
     subtype       provider's own words, kept verbatim for the rep
     yearBuilt
     owner         { name, mailing, phone, email }
     lastSale      { date, price }
     assessedValue
     photos        [url]  — may be empty
     annualKwh     { value, src: metered|modelled|proxy }
     feederId      circuit this parcel sits on (joined, not from the provider)
     src           provider key
  */
  S.NORMALIZED = ["id","addr","city","state","zip","lat","lon","sqft","lotAcres",
                  "type","subtype","yearBuilt","owner","lastSale","assessedValue",
                  "photos","annualKwh","feederId","src"];

  S.TYPES = ["Industrial","Warehouse","Manufacturing","Cold Storage","Flex",
             "Office","Retail","Data Center","Multifamily","Institutional",
             "Vacant Land","Other"];

  S.register = function (key, impl) { S.providers[key] = impl; return impl; };
  S.use = function (key) {
    if (!S.providers[key]) throw new Error("No listing provider registered as '" + key + "'.");
    S.active = S.providers[key]; S.name = key; return S.active;
  };
  S.search = function (bbox, filters, cb) {
    if (!S.active) { cb(new Error("No property source selected.")); return; }
    S.active.search(bbox, filters || {}, cb);
  };
  S.detail = function (id, cb) {
    if (!S.active) { cb(new Error("No property source selected.")); return; }
    if (!S.active.detail) { cb(null, null); return; }
    S.active.detail(id, cb);
  };

  /* ====================================================================
     PROVIDER 1 — PropertyShark (or any keyed commercial source)

     Runs through the same Cloudflare worker the ComEd proxy already uses.
     Two reasons it cannot call the vendor directly from this page:
       1. CORS. A browser origin will be rejected.
       2. The API key would be sitting in client JavaScript, readable by
          anyone with devtools, on a per-record-billed contract.

     Worker contract expected at  {PROXY}/listings/search  and  /listings/detail
     ==================================================================== */
  S.register("propertyshark", {
    label: "PropertyShark",
    ready: false,          /* flipped true once the worker route answers */
    proxy: "",             /* set via S.providers.propertyshark.proxy = "..." */

    search: function (bbox, filters, cb) {
      if (!this.proxy) {
        cb(new Error("PropertyShark is not connected. Set the proxy route, then re-run."));
        return;
      }
      var q = "?minLat=" + bbox.s + "&maxLat=" + bbox.n +
              "&minLon=" + bbox.w + "&maxLon=" + bbox.e +
              "&types=" + encodeURIComponent((filters.types || []).join(",")) +
              "&minSqft=" + (filters.minSqft || 0) +
              "&limit=" + (filters.limit || 300);
      req(this.proxy + "/listings/search" + q, function (err, j) {
        if (err) { cb(err); return; }
        var rows = (j && (j.results || j.properties || j.data)) || [];
        var out = [];
        for (var i = 0; i < rows.length; i++) out.push(fromPropertyShark(rows[i]));
        cb(null, out);
      });
    },

    detail: function (id, cb) {
      if (!this.proxy) { cb(null, null); return; }
      req(this.proxy + "/listings/detail?id=" + encodeURIComponent(id), function (err, j) {
        cb(err, err ? null : fromPropertyShark(j && (j.result || j)));
      });
    }
  });

  /* THE ONLY PLACE PROVIDER FIELD NAMES APPEAR.
     Field names below are PLACEHOLDERS. Confirm every one against a live
     record before trusting this in front of a customer — county and vendor
     schemas do not match their documentation often enough to assume. */
  function fromPropertyShark(r) {
    if (!r) return null;
    var o = r.owner || r.ownerInfo || {};
    return {
      id:      str(r.propertyId || r.id || r.parcelId || r.pin),
      addr:    str(r.address || r.streetAddress || r.situsAddress),
      city:    str(r.city || r.municipality),
      state:   str(r.state || "IL"),
      zip:     str(r.zip || r.zipCode),
      lat:     numOr(r.latitude != null ? r.latitude : (r.lat != null ? r.lat : (r.geo && r.geo.lat))),
      lon:     numOr(r.longitude != null ? r.longitude : (r.lon != null ? r.lon : (r.geo && r.geo.lng))),
      sqft:    numOr(r.buildingArea || r.grossArea || r.sqft || r.buildingSqFt),
      lotAcres:numOr(r.lotAcres || (r.lotSqFt ? r.lotSqFt / 43560 : null)),
      type:    normType(r.propertyType || r.landUse || r.buildingClass),
      subtype: str(r.propertyTypeDetail || r.landUse || r.buildingClass),
      yearBuilt: numOr(r.yearBuilt),
      owner: {
        name:    str(o.name || r.ownerName),
        mailing: str(o.mailingAddress || r.ownerAddress),
        phone:   str(o.phone || ""),
        email:   str(o.email || "")
      },
      lastSale: { date: str(r.lastSaleDate || (r.lastSale && r.lastSale.date)),
                  price: numOr(r.lastSalePrice || (r.lastSale && r.lastSale.price)) },
      assessedValue: numOr(r.assessedValue || r.marketValue),
      photos: r.photos || r.images || [],
      annualKwh: null,          /* joined separately — never comes from a listing source */
      feederId: null,           /* joined spatially against hosting capacity */
      src: "propertyshark"
    };
  }

  /* ====================================================================
     PROVIDER 2 — Crexi

     Crexi DOES publish a Listing API, unlike PropertyShark. Two things to
     know before budgeting time against it:

       1. It is a partnership, not a signup. Their help centre routes it
          through integrations@crexi.com and scopes it to brokerages and
          real-estate data providers.
       2. The documented API is oriented at getting listings ONTO Crexi —
          syndication inbound. Pulling their marketplace out is a data
          agreement, and it is a different conversation from the one on the
          Listing API page. Ask for outbound explicitly or the first call
          will be about the wrong product.

     What Crexi is good for here is narrow and worth being clear about: it
     covers what is ON THE MARKET. A for-sale or for-lease listing carries a
     verified address, building size, year built, zoning and a named broker —
     exactly the fields a county parcel file is worst at. It does NOT cover
     the owner-occupied industrial building that has never been listed, which
     is most of the target set. So this is an ENRICHMENT source layered onto
     the parcel pipeline, not a replacement for it.

     A site that is actively listed also changes the sales approach, which is
     why `listed` is surfaced rather than buried: the buyer signs the twenty
     year lease, not the seller.
     ==================================================================== */
  S.register("crexi", {
    label: "Crexi",
    enrichOnly: true,      /* not a primary source — see the note above */
    proxy: "",

    search: function (bbox, filters, cb) {
      if (!this.proxy) { cb(new Error("Crexi is not connected. Set the proxy route, then re-run.")); return; }
      var q = "?minLat=" + bbox.s + "&maxLat=" + bbox.n +
              "&minLon=" + bbox.w + "&maxLon=" + bbox.e +
              "&types=" + encodeURIComponent((filters.types || []).join(",")) +
              "&minSqft=" + (filters.minSqft || 0) +
              "&limit=" + (filters.limit || 300);
      req(this.proxy + "/crexi/search" + q, function (err, j) {
        if (err) { cb(err); return; }
        var rows = (j && (j.results || j.data || j.listings)) || [], out = [], i;
        for (i = 0; i < rows.length; i++) out.push(fromCrexi(rows[i]));
        cb(null, out);
      });
    },

    /* Address-first, because that is the join that matters. The parcel
       pipeline already knows where a building is; what it wants from Crexi
       is whether that building is on the market and who to call about it. */
    detail: function (idOrAddr, cb) {
      if (!this.proxy) { cb(null, null); return; }
      req(this.proxy + "/crexi/detail?q=" + encodeURIComponent(idOrAddr), function (err, j) {
        cb(err, err ? null : fromCrexi(j && (j.result || j)));
      });
    }
  });

  /* THE ONLY PLACE CREXI FIELD NAMES APPEAR. Placeholders until a live
     record is in hand — confirm every one before this reaches a customer. */
  function fromCrexi(r) {
    if (!r) return null;
    var br = r.broker || r.listingAgent || {};
    return {
      id:      str(r.listingId || r.id),
      addr:    str(r.address || r.streetAddress || (r.location && r.location.address)),
      city:    str(r.city || (r.location && r.location.city)),
      state:   str(r.state || (r.location && r.location.state) || "IL"),
      zip:     str(r.zip || r.zipCode),
      lat:     numOr(r.latitude != null ? r.latitude : (r.location && r.location.lat)),
      lon:     numOr(r.longitude != null ? r.longitude : (r.location && r.location.lng)),
      sqft:    numOr(r.buildingSize || r.squareFeet || r.sqft),
      lotAcres:numOr(r.lotSize || r.acres),
      type:    normType(r.propertyType || r.assetType),
      subtype: str(r.propertySubtype || r.propertyType),
      yearBuilt: numOr(r.yearBuilt),
      zoning:  str(r.zoning),
      owner: { name: str(r.ownerName || ""), mailing: "", phone: "", email: "" },
      /* The broker is the reachable human on a listed building, and often the
         only one. Kept distinct from `owner` because they are not the same
         person and a rep must know which they are calling. */
      broker: { name: str(br.name || br.fullName), firm: str(br.company || br.brokerage),
                phone: str(br.phone), email: str(br.email) },
      listed: {
        forSale:  r.forSale === true || /sale/i.test(str(r.dealType)),
        forLease: r.forLease === true || /lease/i.test(str(r.dealType)),
        askPrice: numOr(r.askingPrice || r.price),
        askRate:  numOr(r.askingRate || r.leaseRate),
        capRate:  numOr(r.capRate),
        daysOnMarket: numOr(r.daysOnMarket),
        url:      str(r.url || r.listingUrl)
      },
      lastSale: { date: str(r.lastSaleDate), price: numOr(r.lastSalePrice) },
      assessedValue: null,
      photos: r.images || r.photos || [],
      annualKwh: null,
      feederId: null,
      src: "crexi"
    };
  }

  /* ====================================================================
     PROVIDER 3 — Parcel pipeline (the one this platform already runs)

     Reads a finished harvest file rather than joining APIs live. This is
     the production path: the browser reads a table that was built offline,
     which is the only version of this that does not silently truncate.
     ==================================================================== */
  S.register("harvest", {
    label: "Harvest file",
    url: "prospects.json",
    rows: null,
    search: function (bbox, filters, cb) {
      var self = this;
      function done() {
        var out = [], i, r;
        for (i = 0; i < self.rows.length; i++) {
          r = self.rows[i];
          if (r.lat == null || r.lon == null) continue;
          if (r.lat < bbox.s || r.lat > bbox.n || r.lon < bbox.w || r.lon > bbox.e) continue;
          out.push(r);
        }
        cb(null, out);
      }
      if (self.rows) { done(); return; }
      req(self.url, function (err, j) {
        if (err) { cb(new Error("Could not read " + self.url + ". Run the harvest first.")); return; }
        var arr = (j && (j.rows || j)) || [];
        self.rows = [];
        for (var i = 0; i < arr.length; i++) {
          var n = fromHarvest(arr[i]);
          if (n) self.rows.push(n);
        }
        done();
      });
    }
  });

  function fromHarvest(r) {
    if (!r) return null;
    return {
      id: str(r.pin || r.id), addr: str(r.addr || r.address), city: str(r.city), state: str(r.state || "IL"),
      zip: str(r.zip), lat: numOr(r.lat), lon: numOr(r.lon),
      sqft: numOr(r.sqft || r.buildingSqFt), lotAcres: numOr(r.lotAcres),
      type: normType(r.clsLabel || r.type), subtype: str(r.clsLabel || r.type),
      yearBuilt: numOr(r.yearBuilt),
      owner: { name: str(r.owner || r.ownerName), mailing: str(r.ownerAddr),
               phone: str(r.phone), email: str(r.email) },
      lastSale: { date: str(r.saleDate), price: numOr(r.salePrice) },
      assessedValue: numOr(r.assessedValue),
      photos: r.photos || [],
      annualKwh: r.kwh != null ? { value: numOr(r.kwh), src: r.kwhSrc || "modelled" } : null,
      feederId: str(r.feeder) || null,
      nameplate: numOr(r.bess != null ? r.bess : r.val),
      queue: numOr(r.queue) || 0,
      sub: str(r.sub),
      src: "harvest"
    };
  }

  /* ====================================================================
     PROVIDER 4 — Demo

     Deterministic. The same viewport produces the same properties on every
     reload, because a demo that reshuffles itself looks broken to a
     customer. Seeded off a lat/lon grid, not Math.random().

     This exists so the UI, the sizing math and the ledger can be exercised
     end-to-end before any vendor contract is signed. It is labelled as
     sample data everywhere it surfaces.
     ==================================================================== */
  var DEMO_TYPES = [
    { t: "Warehouse",     sub: "Warehouse, distribution",       lf: 0.38, w: 26 },
    { t: "Industrial",    sub: "Industrial, light",             lf: 0.55, w: 18 },
    { t: "Manufacturing", sub: "Manufacturing plant",           lf: 0.60, w: 12 },
    { t: "Cold Storage",  sub: "Refrigerated warehouse",        lf: 0.72, w: 6  },
    { t: "Flex",          sub: "Flex / R&D",                    lf: 0.50, w: 8  },
    { t: "Retail",        sub: "Retail, big box",               lf: 0.45, w: 9  },
    { t: "Office",        sub: "Office, low-rise",              lf: 0.50, w: 8  },
    /* Deliberately rare. A colocation building is the best demand-charge
       target on any list, so it sorts to the top every time — at realistic
       frequency that is a signal, at demo frequency it is just noise. */
    { t: "Data Center",   sub: "Colocation",                    lf: 0.85, w: 1  },
    { t: "Institutional", sub: "School / campus",               lf: 0.42, w: 6  },
    { t: "Vacant Land",   sub: "Vacant industrial land",        lf: 0,    w: 5  }
  ];
  var DEMO_STREETS = ["W 47th St","S Kostner Ave","W Cermak Rd","S Pulaski Rd","W 63rd St",
    "S Cicero Ave","N Kedzie Ave","W Grand Ave","S Ashland Ave","W Fullerton Ave","S Damen Ave",
    "W Roosevelt Rd","N Elston Ave","S Western Ave","W Ogden Ave","S Halsted St","N Milwaukee Ave",
    "W Belmont Ave","S Archer Ave","E 95th St"];
  var DEMO_OWNERS = ["Prologis LP","Link Logistics REIT","Midwest Cold Holdings LLC","Clarius Partners",
    "Venture One Real Estate","Bridge Industrial","Hillwood Investment Props","Logistics Property Co",
    "First Industrial LP","Duke Realty LP","CenterPoint Properties","Brennan Investment Group",
    "IDI Logistics","Dermody Properties","Becknell Industrial","Sterling Bay LLC","Molto Properties",
    "NorthPoint Development","Crow Holdings Industrial","Panattoni Development"];

  /* xorshift — small, deterministic, no dependencies */
  function seeded(seed) {
    var x = seed | 0 || 88675123;
    return function () {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return ((x >>> 0) % 100000) / 100000;
    };
  }
  function hash(s) {
    var h = 2166136261, i;
    s = String(s);
    for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h;
  }
  function pickWeighted(rnd, arr) {
    var total = 0, i;
    for (i = 0; i < arr.length; i++) total += arr[i].w;
    var r = rnd() * total, acc = 0;
    for (i = 0; i < arr.length; i++) { acc += arr[i].w; if (r <= acc) return arr[i]; }
    return arr[arr.length - 1];
  }

  /* Circuits are assigned by a coarse spatial grid so that NEIGHBOURING
     properties genuinely share a feeder. That is the whole point of the
     ledger and a random assignment would never exercise it. ~0.012 deg is
     roughly a mile, which is the right order for an urban distribution
     circuit's footprint. */
  var CELL = 0.012;
  S.demoFeederFor = function (lat, lon) {
    var gy = Math.floor(lat / CELL), gx = Math.floor(lon / CELL);
    var h = hash(gy + ":" + gx);
    var subN = (h % 40) + 1;
    return { feederId: "F" + (2000 + (h % 7000)), sub: "SUB " + (subN < 10 ? "0" : "") + subN,
             gy: gy, gx: gx, h: h };
  };
  S.demoCapacityFor = function (feederId) {
    var h = hash(feederId), rnd = seeded(h);
    /* Hosting capacity on a real urban feeder is mostly small with a long
       right tail. A uniform draw would make every circuit look sellable. */
    var roll = rnd();
    var nameplate = roll < 0.30 ? Math.round(150 + rnd() * 550)      /* tight     */
                  : roll < 0.72 ? Math.round(700 + rnd() * 2300)     /* workable  */
                  : roll < 0.94 ? Math.round(3000 + rnd() * 5000)    /* good      */
                                : Math.round(8000 + rnd() * 12000);  /* rare, big */
    var queue = rnd() < 0.34 ? Math.round(nameplate * (0.10 + rnd() * 0.55)) : 0;
    return { nameplate: nameplate, queue: queue };
  };

  S.register("demo", {
    label: "Sample data",
    sample: true,
    search: function (bbox, filters, cb) {
      var out = [];
      var latSpan = bbox.n - bbox.s, lonSpan = bbox.e - bbox.w;
      if (latSpan <= 0 || lonSpan <= 0) { cb(null, out); return; }
      /* Walk a fixed grid over the viewport so results are stable as the map
         pans — a property does not move because you scrolled past it. */
      var step = 0.0018;
      var maxCells = 12000, cells = 0;
      var density = filters && filters.density ? filters.density : 0.16;
      var lat, lon;
      for (lat = Math.ceil(bbox.s / step) * step; lat <= bbox.n; lat += step) {
        for (lon = Math.ceil(bbox.w / step) * step; lon <= bbox.e; lon += step) {
          if (++cells > maxCells) { cb(null, out); return; }
          var key = Math.round(lat * 1e5) + ":" + Math.round(lon * 1e5);
          var h = hash(key), rnd = seeded(h);
          if (rnd() > density) continue;
          out.push(makeDemo(lat, lon, h, rnd));
          if (out.length >= (filters.limit || 400)) { cb(null, out); return; }
        }
      }
      cb(null, out);
    }
  });

  function makeDemo(lat, lon, h, rnd) {
    var ty = pickWeighted(rnd, DEMO_TYPES);
    var f = S.demoFeederFor(lat, lon);
    var num1 = (100 + (h % 89)) * 100 + (h % 98);
    var street = DEMO_STREETS[h % DEMO_STREETS.length];
    var sqft = ty.t === "Vacant Land" ? 0
             : ty.t === "Data Center" ? Math.round((30000 + rnd() * 90000) / 500) * 500
             : Math.round((8000 + rnd() * 420000) / 500) * 500;
    var lot = Math.round((sqft / 43560 * (1.6 + rnd() * 2.4) + rnd() * 2) * 100) / 100;

    /* EUI (kBtu/sf/yr) by type, converted to kWh. Modelled, and flagged as
       modelled — never shown as if it came off a meter. */
    var EUI = { "Warehouse": 32, "Industrial": 58, "Manufacturing": 95, "Cold Storage": 140,
                "Flex": 55, "Retail": 68, "Office": 62, "Data Center": 300,
                "Institutional": 54, "Vacant Land": 0 }[ty.t] || 55;
    var kwh = sqft ? Math.round(sqft * EUI * (0.75 + rnd() * 0.5) / 3.412) : null;

    return {
      id: "D" + h.toString(36).toUpperCase(),
      addr: num1 + " " + street,
      city: "Chicago", state: "IL", zip: "606" + (10 + (h % 40)),
      lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
      sqft: sqft || null,
      lotAcres: lot,
      type: ty.t, subtype: ty.sub,
      yearBuilt: ty.t === "Vacant Land" ? null : 1948 + Math.floor(rnd() * 74),
      owner: { name: DEMO_OWNERS[h % DEMO_OWNERS.length],
               mailing: "", phone: "", email: "" },
      lastSale: { date: (2014 + Math.floor(rnd() * 12)) + "-0" + (1 + Math.floor(rnd() * 9)) + "-1" + Math.floor(rnd() * 9),
                  price: sqft ? Math.round(sqft * (38 + rnd() * 95) / 1000) * 1000 : null },
      assessedValue: sqft ? Math.round(sqft * (22 + rnd() * 60) / 1000) * 1000 : null,
      photos: [],
      annualKwh: kwh ? { value: kwh, src: "modelled" } : null,
      loadFactor: ty.lf,
      feederId: f.feederId, sub: f.sub,
      src: "demo", sample: true
    };
  }

  /* ------------------------------------------------------------- helpers */
  function str(v) { return v == null ? "" : String(v).trim(); }
  function numOr(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }

  function normType(v) {
    var t = String(v || "").toLowerCase();
    if (/cold storage|refrigerat/.test(t)) return "Cold Storage";
    if (/data ?cent|colocation|server/.test(t)) return "Data Center";
    if (/warehouse|distribution/.test(t)) return "Warehouse";
    if (/manufactur|plant|foundry/.test(t)) return "Manufacturing";
    if (/flex|r&d|research/.test(t)) return "Flex";
    if (/office|bank/.test(t)) return "Office";
    if (/retail|store|mall|mercantile|shopping/.test(t)) return "Retail";
    if (/apartment|multifamily|residential/.test(t)) return "Multifamily";
    if (/school|college|university|hospital|church|worship|govern/.test(t)) return "Institutional";
    if (/vacant|land/.test(t)) return "Vacant Land";
    if (/industrial/.test(t)) return "Industrial";
    return "Other";
  }
  S.normType = normType;

  function req(url, cb) {
    var x = new XMLHttpRequest();
    try { x.open("GET", url, true); } catch (e) { cb(e); return; }
    x.timeout = 25000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status < 200 || x.status >= 300) { cb(new Error("HTTP " + x.status)); return; }
      try { cb(null, JSON.parse(x.responseText)); } catch (e) { cb(e); }
    };
    x.ontimeout = function () { cb(new Error("Timed out")); };
    x.onerror = function () { cb(new Error("Network error")); };
    x.send();
  }

  root.OmegaListings = S;
})(typeof window !== "undefined" ? window : this);
