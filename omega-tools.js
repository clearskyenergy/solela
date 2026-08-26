/* ══════════════════════════════════════════════════════════════════════
   CLEARSKY-OMEGA · TOOL REGISTRY  (omega-tools.js)
   ----------------------------------------------------------------------
   ONE source of truth for every tool/app in the platform. Both the ADMIN
   console and every CUSTOMER portal load this same file, so a tool you add
   here shows up everywhere automatically — no per-portal HTML edits.

   HOW IT FITS THE ARCHITECTURE (locked conventions):
     • ES5 only — no arrow fns, template literals, let/const, optional chaining.
     • Single-file HTML tools live in ONE deploy (clearsky-omega repo). Every
       tenant loads the SAME tool file; Firestore scoping by orgId keeps each
       tenant's saved data separate. Tools are NOT one-repo-each.
     • This registry is the METADATA index only. It seeds from SEED_TOOLS and,
       when Firestore is present, hydrates/overrides from collection 'tools'.
       The admin "Import / Update Applications" button writes SEED_TOOLS ->
       Firestore so customer portals pick up new tools live.

   SAVED-DATA CONTRACT (so tools reopen with state):
     • Every tool has a stable `key` (e.g. 'valuestack'). Tools read & write
       their saved state to Firestore at:
           toolData / {orgId} / tools / {key}
       (per-tenant, per-tool document). Helpers OMEGATools.loadToolData /
       saveToolData below implement exactly this. Drop them into any tool.

   TIER / UNLOCK MODEL:
     • tier: minimum account tier that sees the tool unlocked.
         1 = Standard, 2 = Deluxe/Professional, 3 = Enterprise, 0 = everyone.
     • A tenant may also carry unlockedTools:[keys] to unlock specific tools
       above their tier (see WORKSPACES in the portal). Locked tools still
       render but with an upgrade overlay.

   ENTERPRISE CUSTOM EDITORS:
     • A tool entry may set custom:true. For those, the portal looks up the
       tenant's customEditorUrl / customToolUrls[key] and uses THAT href
       (their own repo's deployment) instead of the shared file. If the tenant
       has no override, the shared href is used.
   ══════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── Tier constants (readable) ── */
  var TIER = { ALL: 0, STANDARD: 1, DELUXE: 2, ENTERPRISE: 3 };

  /* ── Categories drive the section grouping in the marketplace grid ── */
  var CATEGORIES = [
    { key: 'origination', label: 'Origination & Prospecting' },
    { key: 'design',      label: 'Design & Engineering' }
  ];

  /* ══════════════════════════════════════════════════════════════════
     SEED_TOOLS — the master catalog. Add a tool here, click "Import /
     Update Applications" in the admin console, and every portal updates.

     Fields:
       key        stable id (also the saved-data doc id). REQUIRED, unique.
       name       display name.
       desc       one-line description (end-user voice).
       category   one of CATEGORIES[].key.
       file       shared deployment path (e.g. '/valuestack.html').
       action     optional: 'new:bess' | 'new:sandbox' — opens project modal
                  instead of navigating to a file.
       icon       single SVG path 'd' string (stroke, 24x24 viewBox).
       tier       min tier to unlock (TIER.*). Default STANDARD.
       badge      optional 'new' | 'invest' | free text.
       soon       true => renders disabled ("Soon"), non-clickable.
       custom     true => enterprise tenants may override href per-org.
       savesData  true => tool persists state via the toolData contract.
     ══════════════════════════════════════════════════════════════════ */
  var SEED_TOOLS = [
    { key:'comed_capacity', name:'ComEd Capacity Map', category:'origination',
      desc:'Hosting-capacity screening — identify and qualify C&I sites.',
      file:'/comed-capacity.html', tier:TIER.ALL, savesData:true,
      icon:'M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6zM12 8v4M12 16h.01' },

    { key:'editor', name:'BESS Site Map', category:'design',
      desc:'Wizard, conduit routing & equipment on live satellite.',
      action:'new:bess', tier:TIER.ALL, custom:true, savesData:true,
      icon:'M2 7h20v14H2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }
  ];

  /* ══════════════════════════════════════════════════════════════════
     REGISTRY OBJECT
     ══════════════════════════════════════════════════════════════════ */
  var OMEGATools = {
    TIER: TIER,
    CATEGORIES: CATEGORIES,
    SEED_TOOLS: SEED_TOOLS,
    _tools: SEED_TOOLS.slice(),   // active list; may be replaced by Firestore

    /* Get all tools (seed or hydrated). */
    all: function () { return this._tools.slice(); },

    byKey: function (key) {
      for (var i = 0; i < this._tools.length; i++) {
        if (this._tools[i].key === key) return this._tools[i];
      }
      return null;
    },

    /* ── TOOL HOST ──
       The ONE deployment that hosts every shared tool .html. All portals
       (admin + every client) link here, so a tool fix ships once. Set this
       to your tool-host origin. Leave '' to use same-origin relative paths
       (Option A / the admin console itself, which is same-repo as the tools). */
    TOOL_HOST: 'https://tools.csebuilders.com',

    /* Resolve the full href a given tenant should use for a tool.
       - action tool          => null (caller opens the project modal instead).
       - enterprise override   => the tenant's own bespoke URL (used as-is).
       - otherwise             => TOOL_HOST + tool.file + ?org=<orgId>, so the
                                  shared tool loads and scopes its saved data
                                  to the right tenant.
       When TOOL_HOST is '' (admin console, same-origin), returns a relative
       path with no org param (admin acts as ClearSky's own org). */
    hrefFor: function (tool, workspace) {
      if (!tool) return null;
      if (tool.action) return null;

      // Enterprise bespoke override wins — used exactly as provided.
      if (tool.custom && workspace) {
        if (workspace.customToolUrls && workspace.customToolUrls[tool.key]) {
          return workspace.customToolUrls[tool.key];
        }
        if (tool.key === 'editor' && workspace.customEditorUrl) {
          return workspace.customEditorUrl;
        }
      }

      var path = tool.file || null;
      if (!path) return null;

      // Absolute URL (e.g. a standalone app on another subdomain) => use as-is,
      // no TOOL_HOST prefix and no ?org= param appended.
      if (/^https?:\/\//i.test(path)) return path;

      var host = this.TOOL_HOST || '';
      var base = host ? (host.replace(/\/+$/, '') + path) : path;

      // Append org scope so the shared tool knows whose data to load/save.
      if (workspace && workspace.orgId) {
        base += (base.indexOf('?') >= 0 ? '&' : '?') + 'org=' +
                encodeURIComponent(workspace.orgId);
      }
      return base;
    },

    /* Can this tenant even SEE the tool? Client-specific tools (tool.orgs)
       are visible only to the listed orgs. Everyone sees non-restricted tools. */
    isVisible: function (tool, workspace) {
      if (!tool.orgs || !tool.orgs.length) return true;        // not restricted
      if (!workspace || !workspace.orgId) return false;        // restricted, no org
      return tool.orgs.indexOf(workspace.orgId) >= 0;
    },

    /* Is a tool unlocked for a tenant? tier gate OR explicit unlock list.
       (Visibility is separate — an unlocked tool the tenant can't see is hidden.) */
    isUnlocked: function (tool, workspace) {
      if (!this.isVisible(tool, workspace)) return false;
      if (!workspace) return true;              // admin/internal sees all
      var tier = workspace.tierLevel;
      if (typeof tier !== 'number') tier = TIER.ENTERPRISE; // internal defaults open
      if (workspace.requiredTools &&
          workspace.requiredTools.indexOf(tool.key) >= 0) return true;
      if (workspace.unlockedTools &&
          workspace.unlockedTools.indexOf(tool.key) >= 0) return true;
      return tier >= (typeof tool.tier === 'number' ? tool.tier : TIER.STANDARD);
    },

    /* Is a tool MANDATORY for this tenant? (Always pinned, cannot be removed.) */
    isRequired: function (tool, workspace) {
      return !!(workspace && workspace.requiredTools &&
                workspace.requiredTools.indexOf(tool.key) >= 0);
    },

    /* ── Hydrate the active list from Firestore 'tools' (if available). ──
         Called once at portal boot. Falls back silently to SEED_TOOLS. */
    hydrate: function (db, cb) {
      var self = this;
      if (!db) { if (cb) cb(self._tools); return; }
      db.collection('tools').orderBy('sort').get().then(function (snap) {
        if (!snap.empty) {
          var list = [];
          snap.forEach(function (doc) { list.push(doc.data()); });
          self._tools = list;
        }
        if (cb) cb(self._tools);
      })['catch'](function () { if (cb) cb(self._tools); });
    },

    /* ── ADMIN: push SEED_TOOLS -> Firestore 'tools'. Idempotent upsert.
         This is what the "Import / Update Applications" button calls. It
         writes/updates one doc per tool (id = key) and stamps a sort index
         so portals render in a stable order. Returns a Promise. ── */
    publishToFirestore: function (db, firebase) {
      if (!db) return Promise.reject(new Error('No Firestore.'));
      var batch = db.batch();
      for (var i = 0; i < SEED_TOOLS.length; i++) {
        var t = SEED_TOOLS[i];
        var doc = {};
        for (var k in t) { if (t.hasOwnProperty(k)) doc[k] = t[k]; }
        doc.sort = i;
        doc.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        batch.set(db.collection('tools').doc(t.key), doc, { merge: true });
      }
      return batch.commit();
    },

    /* ── SAVED DATA CONTRACT ──
         Drop these into any tool. They persist per-tenant, per-tool state
         at toolData/{orgId}/tools/{key} so the tool reopens with data. ── */
    loadToolData: function (db, orgId, key) {
      if (!db || !orgId || !key) return Promise.resolve(null);
      return db.collection('toolData').doc(orgId)
        .collection('tools').doc(key).get()
        .then(function (snap) { return snap.exists ? snap.data() : null; });
    },

    saveToolData: function (db, firebase, orgId, key, data) {
      if (!db || !orgId || !key) return Promise.reject(new Error('Missing scope.'));
      var payload = { data: data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      return db.collection('toolData').doc(orgId)
        .collection('tools').doc(key).set(payload, { merge: true });
    },

    /* ── Read the tenant org a shared tool was opened for ──
         Shared tools live on TOOL_HOST and receive ?org=<orgId> from the
         portal. A tool calls OMEGATools.orgFromUrl() to know whose data to
         load/save. Falls back to the signed-in user's email domain, then null.
         (A user can only read/write their own org per the Firestore rules, so
         the ?org= param is a convenience, not a trust boundary.) */
    orgFromUrl: function (fallbackEmail) {
      var m = (typeof window !== 'undefined' && window.location && window.location.search)
        ? window.location.search.match(/[?&]org=([^&]+)/) : null;
      if (m && m[1]) return decodeURIComponent(m[1]);
      if (fallbackEmail && fallbackEmail.indexOf('@') >= 0) {
        return fallbackEmail.split('@')[1].toLowerCase();
      }
      return null;
    },

    /* ══════════════════════════════════════════════════════════════════
       DASHBOARD PINS  —  the customer's chosen shortlist of tools.
       Marketplace = every tool their tier qualifies for (automatic).
       Dashboard   = only the keys the customer pinned (manual).
       Stored per-tenant at  toolData/{orgId}/prefs/pinned  as { keys:[...] }.
       Existing Firestore rules already scope this to the user's own org.
       ══════════════════════════════════════════════════════════════════ */

    /* Load the pinned tool keys for a tenant. Resolves to an array (never null). */
    loadPinned: function (db, orgId) {
      if (!db || !orgId) return Promise.resolve([]);
      return db.collection('toolData').doc(orgId)
        .collection('prefs').doc('pinned').get()
        .then(function (snap) {
          return (snap.exists && snap.data() && snap.data().keys) ? snap.data().keys : [];
        })['catch'](function () { return []; });
    },

    /* Overwrite the pinned list. */
    savePinned: function (db, firebase, orgId, keys) {
      if (!db || !orgId) return Promise.reject(new Error('Missing scope.'));
      return db.collection('toolData').doc(orgId)
        .collection('prefs').doc('pinned').set({
          keys: keys || [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    },

    /* Pin one tool (idempotent). Returns a Promise of the new keys array. */
    pinTool: function (db, firebase, orgId, key) {
      var self = this;
      return this.loadPinned(db, orgId).then(function (keys) {
        if (keys.indexOf(key) < 0) keys.push(key);
        return self.savePinned(db, firebase, orgId, keys).then(function () { return keys; });
      });
    },

    /* Unpin one tool. Returns a Promise of the new keys array. */
    unpinTool: function (db, firebase, orgId, key) {
      var self = this;
      return this.loadPinned(db, orgId).then(function (keys) {
        var out = [];
        for (var i = 0; i < keys.length; i++) { if (keys[i] !== key) out.push(keys[i]); }
        return self.savePinned(db, firebase, orgId, out).then(function () { return out; });
      });
    }
  };

  /* Expose globally (and as a CommonJS-ish export if ever bundled). */
  global.OMEGATools = OMEGATools;
  if (typeof module !== 'undefined' && module.exports) module.exports = OMEGATools;

})(typeof window !== 'undefined' ? window : this);
