/* ==========================================================================
   omega-capacity-ledger.js  ·  ClearSky-OMEGA shared platform file
   --------------------------------------------------------------------------
   Circuit capacity is a SHARED, FINITE resource. Two reps working two
   different addresses can be working the same feeder without knowing it, and
   the second battery sold is not a second deal — it is a withdrawn
   interconnection application and a refunded deposit.

   This module is the single source of truth for "how much of this circuit is
   still ours to sell". It is deliberately tenant-neutral: no ComEd, no Cook
   County, no ClearSky. Feeder ids are opaque strings. Any utility whose
   hosting-capacity data resolves to (circuit id, kW) works here.

   ES5 only. No build step. Depends on nothing except (optionally) the
   firebase compat SDK already loaded by the host page.
   ========================================================================== */
(function (root) {
  "use strict";

  var L = {};

  /* ---------------------------------------------------------------- status
     Not every claim on a circuit consumes capacity, and the ones that do,
     do not all consume it equally hard. Getting this table wrong is the
     whole ballgame: too loose and you oversell, too tight and one rep's
     stale "maybe" freezes a substation for a quarter.

       weight 0    — visible, consumes nothing
       soft        — consumes, releasable, EXPIRES
       firm        — consumes, real paperwork exists, no expiry
  */
  L.STATUS = {
    prospect:    { key: "prospect",    label: "Prospect",        kind: "none", color: "#9aa7b4", rank: 0,
                   help: "We like the site. Nothing is held. Anyone may still sell this circuit." },
    reserved:    { key: "reserved",    label: "Held",            kind: "soft", color: "#c98a2b", rank: 1,
                   help: "Held for this rep while the deal is worked. Auto-releases on expiry." },
    proposal:    { key: "proposal",    label: "Proposal out",    kind: "soft", color: "#e08a1e", rank: 2,
                   help: "Priced and delivered to the customer. Still soft — no utility filing yet." },
    application: { key: "application", label: "Application in",  kind: "firm", color: "#0a6ed1", rank: 3,
                   help: "Filed with the utility. This capacity is committed until withdrawn." },
    approved:    { key: "approved",    label: "IA executed",     kind: "firm", color: "#1257a0", rank: 4,
                   help: "Interconnection agreement signed. Firm." },
    energized:   { key: "energized",   label: "Energized",       kind: "firm", color: "#2ea043", rank: 5,
                   help: "Operating. Permanent." },
    lost:        { key: "lost",        label: "Released",        kind: "none", color: "#c9cdd2", rank: -1,
                   help: "Withdrawn or lost. Capacity returned to the circuit." }
  };
  L.STATUS_ORDER = ["prospect", "reserved", "proposal", "application", "approved", "energized", "lost"];

  L.statusOf = function (k) { return L.STATUS[k] || L.STATUS.prospect; };

  /* Default life of a soft hold. A hold with no expiry is not a hold, it is
     an outage — the rep leaves, nobody remembers, and the circuit is dead
     stock forever. 30 days, renewable, surfaced with a countdown. */
  L.SOFT_HOLD_DAYS = 30;

  /* --------------------------------------------------------------- state */
  var FEEDERS = {};   /* feederId -> {id, sub, nameplate, queue, county, updatedAt} */
  var ALLOCS  = {};   /* allocId  -> allocation record                             */
  var LISTEN  = [];
  var DB = null, ORG = "", UNSUB = null, UNSUB_CAP = null;

  function now() { return Date.now(); }
  function num(v) { var x = parseFloat(v); return isNaN(x) ? null : x; }
  function emit() { for (var i = 0; i < LISTEN.length; i++) { try { LISTEN[i](); } catch (e) {} } }

  L.onChange = function (fn) { LISTEN.push(fn); return function () {
    for (var i = 0; i < LISTEN.length; i++) if (LISTEN[i] === fn) { LISTEN.splice(i, 1); return; }
  }; };

  /* ------------------------------------------------------------- feeders
     Registered from whatever hosting-capacity source the host page uses.
     `nameplate` is what the circuit will accept in total. `queue` is
     capacity already spoken for by OTHER developers' pending interconnection
     applications — it is not ours and never was, and a tool that shows
     nameplate as "available" will sell it twice a week. */
  /* ══════════════════════════════════════════════════════════════════════
     THE FEEDER REGISTRY IS DATA, NOT A CACHE

     What ComEd publishes for a circuit — nameplate, queue, substation — was
     held in memory only. Reload the page and the whole circuit ledger emptied:
     "6 circuits touched" became zero, and every saved site printed its own
     feeder id above the words "Circuit capacity unknown".

     It is worth persisting for a second reason. A rep who has looked at
     D5017 has learned something the rest of the team does not have to spend
     a request finding out again, and on a tool used across several states
     that adds up. So the registry is written locally on every change and,
     when the ledger is attached, shared through Firestore alongside the
     claims.

     FRESHNESS IS TRACKED, because ComEd revises these quarterly. A stored
     figure carries when it was read, and a live read always wins over a
     stored one — a saved June capacity must never overwrite September's.
     ══════════════════════════════════════════════════════════════════════ */
  var FEEDER_KEY = "cs.feeders";
  var feederSaveTimer = null;

  function loadFeeders() {
    try {
      var raw = (typeof localStorage !== "undefined") && localStorage.getItem(FEEDER_KEY);
      if (!raw) return;
      var j = JSON.parse(raw), id;
      for (id in j) {
        if (!j.hasOwnProperty(id)) continue;
        if (j[id] && j[id].nameplate != null) FEEDERS[id] = j[id];
      }
    } catch (e) { /* corrupt or unavailable — start empty rather than throw */ }
  }

  function saveFeeders() {
    /* Debounced. A viewport sweep can register a hundred feeders in a
       second and serialising on each one would stall the map. */
    if (feederSaveTimer) return;
    feederSaveTimer = setTimeout(function () {
      feederSaveTimer = null;
      try {
        if (typeof localStorage !== "undefined")
          localStorage.setItem(FEEDER_KEY, JSON.stringify(FEEDERS));
      } catch (e) { /* quota or private mode; the session still works */ }
      pushFeeders();
    }, 400);
  }

  /* Share what we have learned, when there is somewhere to share it. */
  function pushFeeders() {
    if (!DB || !ORG) return;
    var id, f, batch;
    try { batch = DB.batch(); } catch (e) { return; }
    var n = 0;
    for (id in FEEDERS) {
      if (!FEEDERS.hasOwnProperty(id)) continue;
      f = FEEDERS[id];
      if (f.nameplate == null || f.pushed) continue;
      try {
        batch.set(DB.collection("circuitCapacity").doc(ORG + "__" + id), {
          orgId: ORG, feederId: id, sub: f.sub || "", county: f.county || "",
          nameplate: f.nameplate, queue: f.queue || 0,
          readAt: f.updatedAt || now()
        }, { merge: true });
        f.pushed = true;
        n++;
      } catch (e) { return; }
      if (n >= 400) break;      /* Firestore caps a batch at 500 writes */
    }
    if (n) { try { batch.commit(); } catch (e) {} }
  }

  /* Restore what this browser already knew, before anything asks. */
  loadFeeders();

  L.setFeeder = function (id, o) {
    if (!id) return null;
    id = String(id);
    var f = FEEDERS[id] || { id: id, sub: "", nameplate: null, queue: 0, county: "" };
    if (o) {
      if (o.nameplate != null) f.nameplate = num(o.nameplate);
      if (o.queue != null)     f.queue     = Math.max(0, num(o.queue) || 0);
      if (o.sub)               f.sub       = String(o.sub);
      if (o.county)            f.county    = String(o.county);
    }
    f.updatedAt = now();
    /* A changed figure has to be shared again. */
    f.pushed = false;
    FEEDERS[id] = f;
    saveFeeders();
    return f;
  };
  L.getFeeder = function (id) { return id ? FEEDERS[String(id)] || null : null; };
  L.feederIds = function () { var a = [], k; for (k in FEEDERS) a.push(k); return a; };

  /* --------------------------------------------------------- allocations */
  function expired(a) {
    return L.statusOf(a.status).kind === "soft" && a.expiresAt && a.expiresAt < now();
  }
  L.isExpired = expired;

  L.daysLeft = function (a) {
    if (!a || !a.expiresAt) return null;
    return Math.ceil((a.expiresAt - now()) / 86400000);
  };

  /* Everything on a circuit, newest claim last. Expired soft holds stay in
     the list — they are still worth showing so somebody can renew rather
     than rediscover the site cold — but they stop consuming capacity. */
  L.allocations = function (feederId) {
    var out = [], k;
    if (!feederId) return out;
    feederId = String(feederId);
    for (k in ALLOCS) if (ALLOCS[k].feederId === feederId) out.push(ALLOCS[k]);
    out.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    return out;
  };

  L.allocationsForSite = function (siteId) {
    var out = [], k;
    if (!siteId) return out;
    siteId = String(siteId);
    for (k in ALLOCS) if (ALLOCS[k].siteId === siteId) out.push(ALLOCS[k]);
    return out;
  };

  /* ------------------------------------------------------------- the math
     One function, called everywhere, so a card, a drawer and the ledger can
     never disagree about a number.

       nameplate
         − queue          third-party interconnection applications
         − firm           our filed / signed / energized projects
         − soft           our live holds and outstanding proposals
         = sellable

     `firmAvailable` is what remains ignoring our own soft holds — the number
     a manager uses to decide whether to break someone's hold, and the only
     honest answer to "could we physically fit another battery here".

     `excludeSiteId` drops one site's own claims so that a rep editing an
     existing reservation is not shown as competing with themselves. */
  L.feederState = function (feederId, excludeSiteId) {
    var f = L.getFeeder(feederId);
    var nameplate = f ? f.nameplate : null;
    var queue = f ? (f.queue || 0) : 0;
    var list = L.allocations(feederId);
    var firm = 0, soft = 0, lapsed = 0, mine = 0, i, a, kind;

    for (i = 0; i < list.length; i++) {
      a = list[i];
      kind = L.statusOf(a.status).kind;
      if (kind === "none") continue;
      if (excludeSiteId && String(a.siteId) === String(excludeSiteId)) { mine += (a.kw || 0); continue; }
      if (kind === "firm") { firm += (a.kw || 0); continue; }
      if (expired(a)) { lapsed += (a.kw || 0); continue; }
      soft += (a.kw || 0);
    }

    var known = nameplate != null;
    var afterQueue = known ? Math.max(0, nameplate - queue) : null;
    var firmAvail  = known ? afterQueue - firm : null;
    var sellable   = known ? firmAvail - soft : null;
    var committed  = queue + firm + soft;

    return {
      feederId: feederId ? String(feederId) : null,
      sub: f ? f.sub : "",
      known: known,
      nameplate: nameplate,
      queue: queue,
      firm: firm,
      soft: soft,
      lapsed: lapsed,
      mine: mine,
      committed: committed,
      firmAvailable: known ? Math.max(0, firmAvail) : null,
      sellable: known ? Math.max(0, sellable) : null,
      /* Negative before the clamp means we have promised more than the wire
         will carry. Surfaced loudly rather than hidden by Math.max. */
      oversubscribed: known && sellable < -0.5,
      overBy: known && sellable < 0 ? Math.abs(sellable) : 0,
      pctUsed: known && nameplate > 0 ? Math.min(1, committed / nameplate) : 0,
      allocations: list,
      count: list.length
    };
  };

  /* Traffic light for a card. Deliberately coarse — a rep scanning 200
     listings needs four buckets, not a percentage. */
  L.circuitStatus = function (st) {
    if (!st || !st.known) return { key: "unknown", label: "Circuit unknown", color: "#9aa7b4",
      note: "No hosting-capacity record for this circuit yet." };
    if (st.oversubscribed) return { key: "over", label: "Oversubscribed", color: "#e0533d",
      note: "Commitments exceed the circuit by " + Math.round(st.overBy).toLocaleString() + " kW." };
    if (st.sellable <= 0) return { key: "closed", label: "Circuit taken", color: "#e0533d",
      note: "Nothing left to sell here. Existing claims consume the circuit." };
    if (st.firm > 0 || st.soft > 0) return { key: "partial", label: "Partly claimed", color: "#c98a2b",
      note: Math.round(st.sellable).toLocaleString() + " kW left after our existing claims." };
    if (st.queue > 0) return { key: "queued", label: "Queue ahead", color: "#8a5cd1",
      note: Math.round(st.queue).toLocaleString() + " kW held by other developers' applications." };
    return { key: "open", label: "Circuit open", color: "#2ea043",
      note: Math.round(st.sellable).toLocaleString() + " kW available." };
  };

  /* ------------------------------------------------------- battery sizing
     Two independent ceilings and they bind for different reasons:

       load ceiling    — what the customer's own peak justifies shaving
       circuit ceiling — what the wire will accept AFTER everyone's claims

     Reporting the smaller number alone is how a proposal ends up promising
     900 kW on a circuit with 200 kW left. Report both and name which binds. */
  L.sizeAt = function (opts) {
    var loadKw   = opts && opts.loadKw != null ? num(opts.loadKw) : null;
    var st       = L.feederState(opts && opts.feederId, opts && opts.siteId);
    var hours    = (opts && opts.hours) || 2;
    var circuitKw = st.known ? st.sellable : null;

    var kw, binds;
    if (loadKw == null && circuitKw == null) { kw = null; binds = "unknown"; }
    else if (loadKw == null)   { kw = circuitKw; binds = "circuit"; }
    else if (circuitKw == null){ kw = loadKw;    binds = "load"; }
    else if (circuitKw < loadKw) { kw = circuitKw; binds = "circuit"; }
    else { kw = loadKw; binds = "load"; }

    /* kWh is derived from the ROUNDED kW, not from the raw one. Rounding each
       independently publishes "267 kW / 535 kWh" off a raw 267.49 — two
       numbers side by side on the card that do not multiply. A rep checking
       267 x 2 in their head finds 534 and stops trusting the card, which is a
       bad trade for half a kilowatt-hour. */
    var kwOut = kw == null ? null : Math.max(0, Math.round(kw));
    return {
      kw: kwOut,
      kwh: kwOut == null ? null : kwOut * hours,
      hours: hours,
      loadCeiling: loadKw == null ? null : Math.round(loadKw),
      circuitCeiling: circuitKw == null ? null : Math.round(circuitKw),
      binds: binds,
      /* True when the circuit — not the customer — is the reason the system
         is small. That is a different sales conversation entirely. */
      circuitLimited: binds === "circuit",
      state: st
    };
  };

  /* ------------------------------------------------------------- writing
     Every mutation goes through here so that local state, Firestore and the
     UI can never drift. Optimistic locally, authoritative from the stream. */
  function allocId(feederId, siteId) {
    return String(feederId).replace(/[^A-Za-z0-9_-]/g, "_") + "__" +
           String(siteId).replace(/[^A-Za-z0-9_-]/g, "_");
  }
  L.allocId = allocId;

  L.reserve = function (o, cb) {
    cb = cb || function () {};
    if (!o || !o.feederId || !o.siteId) { cb(new Error("A reservation needs a circuit and a site.")); return; }
    var kw = num(o.kw);
    if (kw == null || kw <= 0) { cb(new Error("Enter how many kW to hold.")); return; }

    var status = L.STATUS[o.status] ? o.status : "reserved";
    var kind = L.statusOf(status).kind;
    var id = allocId(o.feederId, o.siteId);
    var prev = ALLOCS[id];

    /* Block the write that would oversell, rather than warn after the fact.
       Checked against firmAvailable minus other reps' live soft holds, with
       this site's own prior claim excluded so an edit is not self-blocking. */
    var st = L.feederState(o.feederId, o.siteId);
    if (st.known && kind !== "none" && kw > st.sellable + 0.5 && !o.force) {
      var e = new Error("Only " + Math.round(st.sellable).toLocaleString() +
        " kW is left on " + o.feederId + ". Reduce the size or release an existing claim.");
      e.code = "OVERSELL";
      e.available = st.sellable;
      cb(e); return;
    }

    var rec = {
      id: id,
      orgId: ORG,
      feederId: String(o.feederId),
      siteId: String(o.siteId),
      address: o.address || (prev && prev.address) || "",
      lat: o.lat != null ? o.lat : (prev ? prev.lat : null),
      lon: o.lon != null ? o.lon : (prev ? prev.lon : null),
      kw: Math.round(kw),
      kwh: o.kwh != null ? Math.round(num(o.kwh)) : Math.round(kw * ((o.hours || 2))),
      status: status,
      rep: o.rep || (prev && prev.rep) || "",
      note: o.note != null ? o.note : (prev ? prev.note : ""),
      createdAt: prev ? prev.createdAt : now(),
      updatedAt: now(),
      expiresAt: null
    };
    if (kind === "soft") {
      rec.expiresAt = o.expiresAt || (prev && prev.status === status && prev.expiresAt) ||
                      (now() + L.SOFT_HOLD_DAYS * 86400000);
    }

    ALLOCS[id] = rec;
    emit();
    push(rec, function (err) { cb(err || null, rec); });
    return rec;
  };

  L.release = function (id, cb) {
    cb = cb || function () {};
    var rec = ALLOCS[id];
    if (!rec) { cb(new Error("No such claim.")); return; }
    rec.status = "lost";
    rec.updatedAt = now();
    rec.expiresAt = null;
    emit();
    push(rec, cb);
  };

  L.renew = function (id, days, cb) {
    cb = cb || function () {};
    var rec = ALLOCS[id];
    if (!rec) { cb(new Error("No such claim.")); return; }
    rec.expiresAt = now() + (days || L.SOFT_HOLD_DAYS) * 86400000;
    rec.updatedAt = now();
    emit();
    push(rec, cb);
  };

  /* --------------------------------------------------------- persistence
     Same shape as the sites collection the CRM already uses: one document
     per claim, merged, never a whole-collection write. A floor of reps
     posting the full ledger would mean last-writer-wins and silently
     vanished holds. */
  function push(rec, cb) {
    cb = cb || function () {};
    if (!DB || !ORG) { cb(null); return; }   /* local-only mode is valid */
    var doc = {}, k;
    for (k in rec) doc[k] = rec[k];
    doc.orgId = ORG;
    try {
      DB.collection("capacityAllocations").doc(ORG + "__" + rec.id)
        .set(doc, { merge: true })
        .then(function () { cb(null); })
        .catch(function (e) { cb(e); });
    } catch (e) { cb(e); }
  }

  L.attach = function (db, orgId, cb) {
    cb = cb || function () {};
    DB = db || null; ORG = orgId || "";
    if (!DB || !ORG) { cb(new Error("Ledger is running locally — claims are not shared.")); return; }
    if (UNSUB) { try { UNSUB(); } catch (e) {} UNSUB = null; }
    if (UNSUB_CAP) { try { UNSUB_CAP(); } catch (e) {} UNSUB_CAP = null; }

    /* What the rest of the team has read about circuits. Merged in, never
       overwriting a figure this session read live — the local one is at
       worst as fresh, and at best fresher. */
    try {
      UNSUB_CAP = DB.collection("circuitCapacity").where("orgId", "==", ORG)
        .onSnapshot(function (snap) {
          var changed = false;
          snap.forEach(function (d) {
            var v = d.data();
            if (!v || !v.feederId || v.nameplate == null) return;
            var have = FEEDERS[String(v.feederId)];
            if (have && have.updatedAt && v.readAt && have.updatedAt >= v.readAt) return;
            FEEDERS[String(v.feederId)] = {
              id: String(v.feederId), sub: v.sub || "", county: v.county || "",
              nameplate: v.nameplate, queue: v.queue || 0,
              updatedAt: v.readAt || now(), pushed: true
            };
            changed = true;
          });
          if (changed) emit();
        }, function () { /* a rules rejection here must not break claims */ });
    } catch (e) {}

    /* Anything learned before signing in goes up now. */
    setTimeout(pushFeeders, 0);

    var first = true;
    UNSUB = DB.collection("capacityAllocations").where("orgId", "==", ORG)
      .onSnapshot(function (snap) {
        var next = {};
        snap.forEach(function (d) {
          var v = d.data();
          if (v && v.id && v.feederId) next[v.id] = v;
        });
        ALLOCS = next;
        emit();
        if (first) { first = false; cb(null); }
      }, function (err) {
        if (first) { first = false; cb(err); }
      });
  };

  L.mode = function () { return (DB && ORG) ? "shared" : "local"; };

  /* Seed from a plain array — used by the mock provider, by an imported
     harvest file, and by tests. */
  L.load = function (arr) {
    ALLOCS = {};
    for (var i = 0; arr && i < arr.length; i++) {
      var a = arr[i];
      if (a && a.feederId && a.siteId) { a.id = a.id || allocId(a.feederId, a.siteId); ALLOCS[a.id] = a; }
    }
    emit();
  };
  L.all = function () { var o = [], k; for (k in ALLOCS) o.push(ALLOCS[k]); return o; };

  /* ------------------------------------------------------------- reports */

  /* Circuits where we hold something, worst first. This is the manager's
     view: where are we blocked, where are we over, what expires this week. */
  L.ledgerRows = function () {
    var seen = {}, rows = [], k, a, id;
    for (k in ALLOCS) { a = ALLOCS[k]; if (a.feederId) seen[a.feederId] = 1; }
    for (id in FEEDERS) seen[id] = 1;
    for (id in seen) {
      var st = L.feederState(id);
      if (!st.count && !st.known) continue;
      rows.push({ feederId: id, state: st, status: L.circuitStatus(st) });
    }
    rows.sort(function (x, y) {
      var rank = { over: 0, closed: 1, partial: 2, queued: 3, open: 4, unknown: 5 };
      var d = rank[x.status.key] - rank[y.status.key];
      if (d) return d;
      return (y.state.committed || 0) - (x.state.committed || 0);
    });
    return rows;
  };

  /* Soft holds inside `days` of lapsing, so they can be renewed or dropped
     on purpose instead of by neglect. */
  L.expiringSoon = function (days) {
    days = days == null ? 7 : days;
    var out = [], k, a, d;
    for (k in ALLOCS) {
      a = ALLOCS[k];
      if (L.statusOf(a.status).kind !== "soft" || !a.expiresAt) continue;
      d = L.daysLeft(a);
      if (d != null && d <= days) out.push(a);
    }
    out.sort(function (x, y) { return (x.expiresAt || 0) - (y.expiresAt || 0); });
    return out;
  };

  /* Other live claims on the same circuit as this site — the "do not call"
     list that makes the whole tool worth having. */
  L.neighbourClaims = function (feederId, siteId) {
    var list = L.allocations(feederId), out = [], i, a;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      if (String(a.siteId) === String(siteId)) continue;
      if (L.statusOf(a.status).kind === "none") continue;
      out.push(a);
    }
    return out;
  };

  L.csv = function () {
    var rows = [["circuit", "substation", "nameplate_kw", "third_party_queue_kw", "firm_kw",
                 "soft_kw", "sellable_kw", "status", "site", "address", "claim_kw", "claim_status",
                 "rep", "expires"]];
    var lr = L.ledgerRows(), i, j;
    for (i = 0; i < lr.length; i++) {
      var st = lr[i].state, as = st.allocations;
      if (!as.length) { rows.push([lr[i].feederId, st.sub, st.nameplate, st.queue, st.firm, st.soft,
                                   st.sellable, lr[i].status.label, "", "", "", "", "", ""]); continue; }
      for (j = 0; j < as.length; j++) {
        var a = as[j];
        rows.push([lr[i].feederId, st.sub, st.nameplate, st.queue, st.firm, st.soft, st.sellable,
                   lr[i].status.label, a.siteId, a.address, a.kw, L.statusOf(a.status).label, a.rep,
                   a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : ""]);
      }
    }
    return rows.map(function (r) {
      return r.map(function (c) {
        c = c == null ? "" : String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(",");
    }).join("\n");
  };

  root.OmegaLedger = L;
})(typeof window !== "undefined" ? window : this);
