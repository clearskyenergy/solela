# Solela LLC · Site Origination Portal

A deliberately narrow ClearSky-OMEGA tenant. Three destinations, one dashboard.

| Route | What it is |
|---|---|
| `/` | Origination funnel + sales rep dashboard |
| `/comed-capacity.html` | ComEd hosting-capacity map — where sites get identified |
| `/projects.html` | Sites taken forward |
| `/editor.html?id=…` | BESS Site Map, opened from a project |

No marketplace, no finance tools, no partner roll-up, no team hub.

---

## The dashboard

`index.html` is a projection of one collection: **`sites`**. Four numbers, in order:

**Sites identified → Sites called → Sales made → Sites in editor**

Each stage is a strict subset of the one before it. A site marked `won` counts as
called even if nobody stamped `calledAt` — without that rule the funnel can show
more sales than calls, which is the fastest way to make a rep stop trusting it.

Below the funnel: capacity identified (MW), open-not-yet-called, average days from
called → sold, and a sortable per-rep table with call % and close %. Everything
respects the time-window filter (all time / 90 / 30 / 7 days).

**The rep columns always sum to the headline numbers.** Both the funnel and the rep
table go through `countsInEditor()`, so a site whose project was deleted is excluded
from both. If you add a stage, route it through one shared predicate the same way.

---

## ⚠️ The one thing that must be wired up

**Nothing in this repo writes to `sites` yet.** `comed-capacity.html` lives on the
tool host (`tools.csebuilders.com`) and was not part of the source I was given, so
I defined the schema rather than guessed at it.

Until the capacity map saves a site, every number is a true zero and the dashboard
says so in an amber note. It never shows sample data — a funnel with invented numbers
in it is worse than an empty one, because a rep will act on it.

### `sites/{siteId}`

| Field | Type | Notes |
|---|---|---|
| `orgId` | string | `chileasing.com` — tenant tag, enforced by rules |
| `name` | string | site or business name |
| `address` | string | |
| `pin` | string | Cook County PIN, optional |
| `feeder` | string | ComEd feeder id, optional |
| `capacityKw` | number | hosting capacity |
| `source` | string | `comed-capacity` |
| `status` | string | `identified` · `contacted` · `qualified` · `won` · `lost` |
| `repEmail` | string | lowercase — the rep dashboard groups on this |
| `repName` | string | falls back to `team_members` |
| `calledAt` | timestamp | null until first contact |
| `wonAt` | timestamp | null until sold |
| `projectId` | string | `projects/{id}` once pushed into the editor |
| `createdAt` | timestamp | when identified — drives the window filter |

### If the capacity map already uses different field names

**Do not rewrite the dashboard.** Remap in `FIELD_MAP` near the top of the script in
`index.html`. Each entry is a list of candidate field names tried in order:

```js
var FIELD_MAP = {
  repEmail: ['repEmail','ownerEmail','assignedTo','uidEmail'],
  wonAt:    ['wonAt','soldAt','closedAt'],
  ...
};
```

Add the real name to the front of the relevant list. That is the whole change.

### Deploy the rules

`firestore-sites.rules` is a **fragment** — merge the `match /sites/{siteId}` block
into your existing `firestore.rules` next to the `projects` block. It scopes reads to
the caller's org and makes `orgId` immutable on update, so a rep can't move a site
into another tenant.

---

## Tenant config

`config.js` holds Firebase + Maps keys and branding. Access control is the
`WORKSPACES` map in `index.html`:

```js
'chileasing.com': {
  orgId: 'chileasing.com',
  tierLevel: 1,
  requiredTools: ['comed_capacity','editor'],
  unlockedTools: ['comed_capacity','editor'],
}
```

`tierLevel: 1` plus the explicit allowlist means anything added to
`omega-tools.js` later stays locked until it is named here.

`omega-tools.js` is otherwise a **shared platform file** — this copy has been cut
down to two tools, so it has diverged from the upstream registry. See below.

---

## Open items

1. **`comed-capacity.html` needs a write path.** It has to create `sites` docs on
   save and stamp `calledAt` / `wonAt` / `projectId` as a rep moves a site along.
   Without it the dashboard is correct and empty.

2. **`omega-tools.js` has forked from upstream.** The shared registry carries 15
   tools; this copy carries 2. Better long-term fix: keep the shared file identical
   and let `unlockedTools` do the filtering, so this tenant stops carrying a fork.
   Right now it is a fork and should be flagged as one.

3. **`index.html` loads `/omega-tools.js` locally**, not from the tool host, because
   of the fork above. Resolving item 2 lets it point back at
   `https://tools.csebuilders.com/omega-tools.js`.

4. **Rep names come from `team_members`.** A rep who has never signed in shows as the
   local-part of their email until they do.
