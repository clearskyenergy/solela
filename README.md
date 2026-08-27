# Solela LLC · ComEd Capacity Portal

Tenant deployment for **Chileasing Energy** (portal brand: Solela LLC) on the
ClearSky-OMEGA platform.

This is a deliberately narrow deployment. It has three tools and nothing else:

| Tool | Route | Hosted |
|---|---|---|
| Projects | `/projects.html` | this repo |
| BESS Site Map | `/editor.html` | `tools.csebuilders.com` (Vercel rewrite) |
| ComEd Capacity map | `/comed-capacity.html` | `tools.csebuilders.com` (Vercel rewrite) |

There is **no marketplace, no tool catalog, and no pro-forma suite** in this
deployment. Navigation between the three tools happens in the topbar.

---

## Files

```
index.html                    Dashboard — ComEd pipeline KPIs + sales rep board
projects.html                 Project list (unchanged apart from nav)
config.js                     Firebase + Maps keys, tenant name
vercel.json                   Rewrites for /editor.html and /comed-capacity.html
firestore-comedsites.rules    Security rules for the sites collection
clearsky-omega-mark-white.png Topbar mark
```

### Removed from the previous build

`marketplace.html`, `investment-analysis.html`, `investment-analysis-logic.js`,
`omega-tools.js`.

`omega-tools.js` was the shared tool-catalog registry. With the marketplace and
the tool grid gone, nothing in this repo reads it, and the index no longer loads
it from `tools.csebuilders.com`. Removing it is what makes this deployment
genuinely narrow rather than cosmetically narrow — there is now no code path
that can surface a tool outside the three above.

`investment-analysis` was dropped because it was not one of the three tools in
scope. If it should stay, it needs to come back as a fourth nav tab plus its
logic file; say so and it is a small change.

---

## The dashboard

`index.html` renders KPIs only. No tool tiles, no team hub, no messaging.

**Headline strip** — sites identified · sites called · sites in site map · sales made

**Tiles** — deliverable capacity identified (MW) · contracted capacity (kW) ·
calls logged · open pipeline

**Stage conversion** — the same four steps as bars, each shown as a percentage of
all identified sites

**Sales reps** — one row per rep: identified, called, in site map, sales, call
rate, win rate, contracted kW, last activity. Reps are derived from the site
records themselves, so the table populates itself as sites get assigned. There
is no separate rep roster to maintain.

Below that: top sites by deliverable capacity, and a recent-activity feed.

### One counting decision worth knowing

A site that was called and later lost still counts as *called*. Losing a deal
does not undo the call that was made. Every step counts each site at the
furthest point it actually reached, and every figure is expressed as a share of
all identified sites — so the strip, the tiles and the bars always reconcile.
An earlier draft excluded lost sites from the funnel and produced 13 identified
in one place and 14 in another.

### Sample data

When `sites` is empty the dashboard renders 14 illustrative Cook County
sites across 4 reps, behind an amber "Sample" ribbon. It disappears on the first
real save. This follows the platform convention used in the other tenant
deployments. To remove it permanently, delete the `SAMPLE_SITES` block near the
top of the dashboard script.

---

## Data contract — `sites`

**This collection does not exist yet.** The dashboard reads it; the ComEd
Capacity tool must write it. Until the tool writes real rows, the dashboard will
show sample data indefinitely.

| Field | Type | Notes |
|---|---|---|
| `orgId` | string | **required** — `chileasing.com`. Enforced by security rules. |
| `siteName` | string | **required** |
| `address` | string | |
| `feeder` | string | ComEd feeder / circuit id |
| `hostingCapacityKw` | number | deliverable capacity from the hosting-capacity layer |
| `status` | string | `identified` \| `contacted` \| `qualified` \| `proposal` \| `won` \| `lost` |
| `repEmail` | string | the rep who owns the site — drives the whole rep board |
| `repName` | string | display name; falls back to the email local part |
| `callCount` | number | calls logged against the site |
| `contactedAt` | timestamp | first successful contact |
| `projectId` | string | set when the site is pushed into the Site Map editor |
| `contractedKw` | number | capacity on a signed deal (`status: 'won'`) |
| `identifiedAt` | timestamp | |
| `wonAt` | timestamp | |
| `updatedAt` | timestamp | drives the activity feed and "last activity" |

Every field except `orgId` and `siteName` degrades to a sensible default rather
than breaking a row, so the tool can adopt the schema incrementally.

### How the four headline numbers are derived

- **Identified** — every document
- **Called** — `callCount > 0` **or** `contactedAt` set **or** status past
  `identified`. Any one of the three is enough, so the count is right whether
  the tool logs calls, stamps contact dates, or only moves the status.
- **In site map** — `projectId` is set
- **Sales made** — `status === 'won'`

`projectId` should be the `projects` document id, which is what makes the site
name in the top-sites table link through to `/editor.html?id=…`.

### Rules

Merge `firestore-comedsites.rules` into the existing `clearsky-portal` ruleset
alongside `projects` and `team_*`. It follows the same convention: a user's org
is their email domain, `orgId` is immutable after creation, and
`@csebuilders.com` is mapped onto the tenant for support access.

---

## Access

Sign-in is gated to `@chileasing.com`, with `@csebuilders.com` allowed for
ClearSky support. Both resolve to `orgId: chileasing.com`, so support sees the
same data the client does.

The allowlist lives in **two** places and they must be kept in sync:
`WORKSPACES` in `index.html`, and the `WS` fallback in `projects.html`.
`projects.html` is loaded directly rather than through the index, so
`window.OMEGA_WORKSPACE` is normally absent and its own fallback is what runs.

---

## Open items

1. **Confirm `tools.csebuilders.com/comed-capacity.html` exists.** The rewrite in
   `vercel.json` assumes it, mirroring how `/editor.html` is routed. If the tool
   lives elsewhere, change the destination there. If the URL is wrong the tab
   404s.
2. **Wire the ComEd Capacity tool to write `sites`.** If it already tracks
   status, calls and rep assignment under different field names, remapping the
   dashboard to those names is the better direction — it is a single normalize
   function.
3. **Deploy the Firestore rules** before the tool starts writing.
4. **Domain-restrict the Google Maps key** in Google Cloud Console if it is not
   already. It ships in client-side source, which is normal for browser use, but
   an unrestricted key is billable by anyone who finds it.

## Testing status

Verified against a DOM harness: KPI arithmetic, strip/bar reconciliation, empty
state, live-data path, Firestore `Timestamp` handling, domain resolution
(including mixed case and unknown domains), malformed documents, and HTML
escaping of injected markup in site and rep names.

**Not verified: visual layout.** No browser was available in the build
environment, so the responsive breakpoints at 1080px and 760px are unexercised.
Worth a look on a phone before it goes to the client.


---

## Site Finder  (added)

`/clearsky-sitefinder.html` — the browsing half of the same data the ComEd
Capacity Finder reports on. Cards beside a live hosting-capacity map, ranked
on **deliverable kW** rather than published headroom, with a circuit ledger
that stops two reps selling the same wire twice.

Both tools read the same sources and answer opposite questions:

| | asks |
|---|---|
| ComEd Capacity Finder | what is the capacity at **this** address |
| Site Finder | which of **these hundred** addresses do I call |

### What was changed in this repo

- `index.html` — Site Finder tab, added to `tools` for both workspaces, and
  the tab href stamped with `?org=`.
- `vercel.json` — rewrites for the page and its three shared files.
- `ci-industrial.js` and `ilshines-sites.js` were already here; the Site Finder
  reads the same two bundles for its optional map layers. These stay local on
  purpose — `DATA_HOSTS` tries same-origin first, so a local copy is the fast
  path.

### The shared files are NOT copied into this repo, deliberately

`clearsky-sitefinder.html`, `omega-capacity-ledger.js`, `omega-comed-layers.js`
and `omega-listings-source.js` are served from `tools.csebuilders.com` through
the rewrites. They are not in this repo, so a platform update reaches Solela
without a tenant deploy.

**Vercel checks the filesystem BEFORE rewrites.** A local copy of any of those
filenames would be served instead and the rewrite would never fire — silently,
with no error, and the next person to edit the shared file would find their
change had no effect here.

⚠ That is already true of `comed-capacity.html`. There is a copy in this repo
**and** a rewrite pointing at the shared deployment. The local copy wins, so
this tenant is running a fork and the rewrite below it is dead. Worth
reconciling: either delete the local file and let the rewrite serve the shared
one, or delete the rewrite and own the fork explicitly. Leaving both means the
question of which file is live is decided by a routing rule nobody remembers.

### ?org= is not optional

Circuit claims are written to `capacityAllocations`, keyed on the org. Without
`?org=chileasing.com` a rep signing in from `csebuilders.com` would file holds
against their own domain instead of Solela's, and the two would never see each
other's claims — which is the exact failure the tool exists to prevent. The tab
href is stamped in `paintUser()` alongside the Capacity and Site Map tabs.

### Firestore

Needs the `capacityAllocations` block merged into the live rules (see
`firestore-capacity.rules`). Until it is deployed the tool signs in fine and
then shows **Local only — claims not shared** with the reason in the tooltip,
rather than pretending the ledger is working.

### Sign-in

The tool gates on Firebase auth before anything renders. A rep who has read a
circuit as free, called the customer, and only then found they were never
signed in has already done the damage. The name on a claim comes from the
token and cannot be typed.
