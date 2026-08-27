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
    { key: 'design',         label: 'Design & Engineering' },
    { key: 'interconnection',label: 'Interconnection & Grid' },
    { key: 'finance',        label: 'Finance & Modeling' },
    { key: 'sales',          label: 'Sales & Proposals' },
    { key: 'permitting',     label: 'Permitting' },
    { key: 'operations',     label: 'Operations & Asset Management' },
    { key: 'marketplace',    label: 'Marketplace & Partners' }
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
    { key:'editor', name:'BESS Site Map', category:'design',
      desc:'Wizard, conduit routing & equipment on live satellite.',
      action:'new:bess', tier:TIER.STANDARD, custom:true, savesData:true,
      icon:'M2 7h20v14H2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' },

    { key:'gridatlas', name:'Grid Atlas', category:'interconnection',
      desc:'Interconnection & grid-proximity site intel — substations, lines, plants, EIA.',
      file:'/grid-atlas.html', badge:'new', tier:TIER.ALL,
      icon:'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15' },

    { key:'sandbox', name:'Open a Sandbox', category:'design',
      desc:'Full editor at any address — save when ready.',
      action:'new:sandbox', tier:TIER.STANDARD, savesData:true,
      icon:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4M12 16h.01' },

    { key:'proforma', name:'BESS Pro Forma', category:'finance',
      desc:'IRR, NPV, value stack & incentives in 8 steps.',
      file:'/proforma.html', tier:TIER.STANDARD, savesData:true,
      icon:'M18 20V10M12 20V4M6 20v-6' },

    { key:'dcfc', name:'DCFC BESS Pro Forma', category:'finance',
      desc:'EV fast-charging + storage economics & demand offset.',
      file:'/dcfc-proforma.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M14 2v6h6M4 22V4a2 2 0 0 1 2-2h8l6 6v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM11 11l-2 4h3l-2 4' },

    { key:'apartment', name:'Residential BESS Analyzer', category:'finance',
      desc:'Multi-state apartment portfolio modeling & VPP stacking.',
      file:'/apartment-bess.html', tier:TIER.DELUXE, savesData:true,
      icon:'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10' },

    { key:'fleet', name:'3D Fleet Financial Modeler', category:'finance',
      desc:'3D fleet with 24-hr dispatch, hourly earnings & PDF reports.',
      file:'/fleet-simulator-3d.html', tier:TIER.DELUXE, savesData:true,
      icon:'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12' },

    { key:'valuestack', name:'Value Stack Calculator', category:'finance',
      desc:'Revenue streams by utility with customer/ClearSky split.',
      file:'/valuestack.html', tier:TIER.STANDARD, savesData:true,
      icon:'M18 20V10M12 20V4M6 20v-6M2 20h20' },

    { key:'isocalc', name:'BESS ISO Calculator', category:'finance',
      desc:'Annual FTM/BTM revenue across PJM, ERCOT, CAISO & every ISO — size by MW, auto-MWh.',
      file:'/bess-iso-calculator.html', badge:'new', tier:TIER.STANDARD,
      icon:'M18 20V10M12 20V4M6 20v-6M2 20h20M4 4l4 4' },

    { key:'datacenter', name:'Data Center Compute Calculator', category:'finance',
      desc:'Size a data center by kW/MW — revenue, capex, land, substation demand, grid energy & aquifer water draw over 1-day / 1-year / 10-year.',
      file:'/datacenter-compute-calculator.html', badge:'new', tier:TIER.ALL,
      icon:'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h4M12 17h4' },

    /* ── COMPUTE POWER SIZER ──
       Sizes the solar array and battery needed to reach a target compute
       load at a site whose interconnect cannot carry it, then prices the
       whole build against GPU hosting revenue.

       tier ALL, matching gridatlas / datacenter: top-of-funnel screening
       whose whole job is to make the paid design tools worth opening. The
       answer it gives ("you need 4 MWdc and 13 MWh at this address") is the
       reason a tenant then opens siteoptimizer or interconnect.

       savesData true, standard contract — toolData/{orgId}/tools/computepower.
       The tool is ~20 assumption fields deep, so reopening cold is the whole
       difference between a scratch pad and a working model.

       Sits between 'datacenter' (which sizes the load and its site demands)
       and 'siteoptimizer' (which solves an optimal DER mix from an 8760).
       This one answers only the narrow question in the middle: what
       generation and storage does THIS compute target need at THIS address,
       and what does it cost. Keep the three descs distinct or they will read
       as duplicates in the Finance grid. */
    { key:'computepower', name:'Compute Power Sizer', category:'finance',
      desc:'Size the solar + battery needed to reach a target AI compute load at any address \u2014 array, storage, land, capex and payback.',
      file:'/compute-power-sizer.html', badge:'new', tier:TIER.ALL, savesData:true,
      icon:'M12 3v2M5.6 5.6l1.4 1.4M3 12h2M17 7l1.4-1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8M3 19h13v3H3zM18 20h2' },

    { key:'batterysizer', name:'Battery Sizer', category:'finance',
      desc:'Size a BESS from utility bills, bill PDFs or an 8760 \u2014 peak-shave dispatch, demand savings, payback & NPV.',
      file:'/battery-sizer.html', badge:'new', tier:TIER.STANDARD,
      icon:'M2 9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM22 11v2M11 9l-2 3.5h2.5L10 16' },

    { key:'investment', name:'Site Investment Analysis', category:'finance',
      desc:'Investor-grade returns, risk & portfolio underwriting.',
      file:'/investment-analysis.html', badge:'invest', tier:TIER.ENTERPRISE, savesData:true,
      icon:'M3 3v18h18M18 9l-5 5-3-3-4 4' },

    { key:'sales', name:'Sales Proposal Builder', category:'sales',
      desc:'3-page customer proposals with AI site placement.',
      file:'/sales-proposal.html', tier:TIER.STANDARD, savesData:true,
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },

    { key:'permit', name:'Permit Creator', category:'permitting',
      desc:'AHJ-ready sets — cover, plot plan, SLD, details.',
      file:'/permit.html', tier:TIER.DELUXE, savesData:true,
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8' },

    /* ── PROJECT INTAKE ──
       The one tool that is a SERVICE request rather than a calculator: the
       tenant describes a site, links their Drive/Dropbox folders, and either
       sends it to us to produce the plot, site map, costs and utility / AHJ
       packages, or saves it as their own record and does it themselves.

       tier ALL on purpose — a tenant cannot ask us to do work for them from
       behind an upgrade wall, and the submission itself is how an upgrade
       conversation starts. No unlockedTools edit needed for any tenant.

       savesData is true, but this tool DEVIATES from the toolData contract.
       toolData/{orgId}/tools/{key} is readable only by that org, and the
       ClearSky queue has to read submissions across every tenant to work
       them. Records live at intake_projects/{intakeId} instead, carrying
       orgId, with the rules doing the isolation. See INTAKE-README.md.

       The staff side (intake-admin.html) is deliberately NOT in this
       registry — see the note at the foot of SEED_TOOLS. */
    { key:'intake', name:'Project Intake', category:'permitting',
      desc:'Submit a site \u2014 L2, DCFC, BESS, DER, solar or compute \u2014 and get back the plot, site map, costs and utility / AHJ packages.',
      file:'/intake.html', badge:'new', tier:TIER.ALL, savesData:true,
      icon:'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' },

    { key:'ahj', name:'AHJ Approval Portal', category:'marketplace',
      desc:'Submit & track permit approvals with the AHJ.',
      file:'/ahj-portal.html', soon:true, tier:TIER.ALL,
      icon:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4' },

    { key:'procurement', name:'Procurement Marketplace', category:'marketplace',
      desc:'Market-wide equipment pricing & bankable products.',
      file:'/procurement.html', soon:true, tier:TIER.ALL,
      icon:'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0' },

    { key:'financing', name:'Financing Partners', category:'marketplace',
      desc:'Debt, tax equity & capital partners for projects.',
      file:'https://financing.csebuilders.com/', soon:false, tier:TIER.ALL,
      icon:'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },

    { key:'aggregators', name:'Aggregators', category:'marketplace',
      desc:'VPP / DR aggregator network & dispatch enrollment.',
      file:'/aggregators.html', soon:true, tier:TIER.ALL,
      icon:'M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 2v4M12 18v4M2 12h4M18 12h4' },

    { key:'offtakers', name:'AI Data Offtakers', category:'marketplace',
      desc:'Compute / data-center offtake & behind-the-meter load.',
      file:'/offtakers.html', soon:true, tier:TIER.ALL,
      icon:'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },

    /* ── CLIENT-SPECIFIC TOOLS ──
       `orgs:[...]` restricts a tool to specific tenants (by orgId). Only those
       orgs see it; it never appears for anyone else. Combine with a tenant's
       requiredTools list to make it a mandatory, non-removable dashboard tool. */
    { key:'spatco_ev', name:'EV / Project Estimate', category:'sales',
      desc:'SPATCO-format EV charger & project install estimates with AI scope.',
      file:'/spatco-ev-estimate.html', tier:TIER.ALL, orgs:['spatco.com'],
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6M9 9h1' },

    { key:'sitelifecycle', name:'Site Lifecycle Console', category:'permitting',
      desc:'Sites, leases, assets & permits in one enterprise console — with CRM sync.',
      file:'/site-lifecycle.html', badge:'new', tier:TIER.DELUXE, custom:true, savesData:true,
      icon:'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01' },

    /* ── OMEGA SIGNAL ──
       Account & integrations control plane. Available to EVERY tier — this is
       where a tenant connects their own monitoring / ticketing / alert
       providers. One connection here feeds all five O&M tools below (they read
       the shared collections the proxy fills). The O&M tools deep-link here in
       their "connect a source first" empty state. */
    { key:'signal', name:'OMEGA Signal', category:'operations',
      desc:'Connect your monitoring, EMS & alert providers — powers every OMEGA operations tool.',
      file:'/account-settings.html', badge:'new', tier:TIER.ALL, savesData:true,
      icon:'M4 12a8 8 0 0 1 8-8M4 12a8 8 0 0 0 8 8M12 12h.01M8 12a4 4 0 0 1 4-4M8 12a4 4 0 0 0 4 4' },

    /* ── O&M / OPERATIONS SUITE ──
       Post-COD asset operations. All gate at DELUXE (Performance) and above,
       matching each tool's isUnlocked() check. They share the om_integrations
       proxy and join to project cards by editorProjectId / mondayBoardId. */
    { key:'omconsole', name:'O&M Operations Console', category:'operations',
      desc:'Live performance vs revenue variance, availability & health across the fleet.',
      file:'/om-console.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M3 3v18h18M7 14l3-4 3 3 5-6' },

    { key:'slaintel', name:'SLA & Contractual Intelligence', category:'operations',
      desc:'Contract-adjusted availability, exclusion logic, breach ledger & LD exposure.',
      file:'/sla-intelligence.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4' },

    { key:'fieldservice', name:'Field Service & Dispatch', category:'operations',
      desc:'Dispatch board, technician & vendor continuity, signal-to-ticket workflow.',
      file:'/field-service.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6 2.7 2.7 6-6a4 4 0 0 0 5.4-5.4l-2.3 2.3-2-2 2.3-2.3' },

    { key:'ownerreport', name:'Owner Reporting & Audit', category:'operations',
      desc:'Owner-ready SLA & availability reports, one-click PDF/XLSX, unified audit trail.',
      file:'/owner-reporting.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15l2 2 4-4' },

    { key:'fleetcommand', name:'Fleet Command', category:'operations',
      desc:'Single pane across every OEM/monitoring portal — hybrid solar+storage in one view.',
      file:'/fleet-command.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z' },

    /* ── DESIGN & ENGINEERING SUITE (Xendee-gap tools) ──
       Optimizer -> Power Flow -> Conductor Sizing form a reinforcing chain:
       the Optimizer sizes the DER mix, Power Flow solves the resulting network,
       and Conductor Sizing turns that flow into a permit-ready schedule. All
       are shared single-file tools on TOOL_HOST with a per-org Settings tab
       (API keys stored at toolData/{orgId}/prefs/apiSettings via omega-settings.js). */
    { key:'siteoptimizer', name:'Site Optimizer', category:'design',
      desc:'Solves the optimal DER mix (BESS+solar+EV) with 8760 hourly dispatch — real NREL solar, bankable revenue split.',
      file:'/site-optimizer.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2' },

    { key:'powerflow', name:'Multi-Node Power Flow', category:'design',
      desc:'Solves current, voltage drop & loading at every node of a radial DER network.',
      file:'/power-flow.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M3 3h8v8H3zM13 13h8v8h-8zM11 7h2M7 11v2' },

    { key:'sitediscovery', name:'Site Discovery & Screening', category:'design',
      desc:'Ranks a pipeline of candidate sites by weighted fit — chase the winners first.',
      file:'/site-discovery.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3' },

    /* ── PERMITTING & INTERCONNECTION ── */
    { key:'conductorsizing', name:'Conductor & Transformer Sizing', category:'design',
      desc:'NEC 2023 feeder & transformer sizing — fills the conductor schedule for permit sets.',
      file:'/conductor-sizing.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3' },

    { key:'interconnect', name:'Interconnection Screener', category:'interconnection',
      desc:'Screens a project against FERC Order 792 fast-track rules — study vs fast-track upfront.',
      file:'/interconnection-screener.html', badge:'new', tier:TIER.STANDARD, savesData:true,
      icon:'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },

    { key:'interconnectstudy', name:'Interconnection Study', category:'interconnection',
      desc:'Distribution load-flow & short-circuit study — voltages and fault duty per bus.',
      file:'/interconnection-study.html', badge:'new', tier:TIER.ENTERPRISE, savesData:true,
      icon:'M13 2 3 14h7l-1 8 10-12h-7z' },

    /* ── COMED CAPACITY FINDER ──
       Reads ComEd's published hosting-capacity map (the same purple/green/gray
       the utility publishes) and resolves it to a street address: feeder,
       substation, BESS/PV/EV capacity in kW, and DER already in queue.

       TERRITORY-BOUND. ComEd is northern Illinois only. A tenant in another
       state gets "outside territory" for every address they try, so the desc
       says so up front rather than letting them discover it by failing. If
       other utilities' maps are added later this becomes one multi-utility
       tool and the desc drops the ComEd qualifier.

       tier ALL, matching gridatlas: top-of-funnel screening that makes the
       paid tools (interconnect, interconnectstudy) worth opening. Gating it
       would gate the reason to upgrade.

       No savesData. The tool holds no state — every answer is a live query
       keyed to a lat/lng, so there is nothing to reopen. If site shortlisting
       gets added later that state belongs in sitediscovery, not here.

       DEPENDENCY worth knowing: the tool reads ComEd through a Cloudflare
       Worker (comed-proxy.clearsky-omega.workers.dev). ComEd's ArcGIS proxy
       403s any request whose Referer isn't their own app, and browsers cannot
       set Referer from JS, so the hop is not optional. If this tool shows
       "403 from ComEd proxy" for everyone at once, check the Worker first —
       most likely ComEd rotated the monthly service name (JUN2026 -> ...) and
       UPSTREAM in the Worker needs the new one. */
    { key:'comedcap', name:'ComEd Capacity Finder', category:'interconnection',
      desc:'Feeder-level hosting capacity at any northern-Illinois address \u2014 BESS, PV and EV headroom, substation and queue, straight from ComEd\u2019s published map.',
      file:'/comed-capacity.html', badge:'new', tier:TIER.ALL,
      icon:'M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6zM9 12h2l-1 3h3' },

    /* ── SITE FINDER ──
       The browsing half of the same data the Capacity Finder reports on.
       Cards beside a live hosting-capacity map, ranked on DELIVERABLE kW
       rather than published headroom, with the circuit ledger behind it.

       WHY BOTH EXIST, since they read the same sources:
         comedcap    answers "what is the capacity at THIS address"
         sitefinder  answers "which of these hundred addresses do I call"
       Same pipeline, opposite direction. Merging them would mean one screen
       doing both jobs badly.

       SHARED DEPENDENCIES the tenant must have deployed alongside it:
         omega-capacity-ledger.js   circuit claims (Firestore capacityAllocations)
         omega-comed-layers.js      hosting capacity / C&I / Illinois Shines
         omega-listings-source.js   property providers
         ci-industrial.js           C&I parcel bundle   (optional layer)
         ilshines-sites.js          Illinois Shines     (optional layer)
       The two bundles are optional — a missing one shows '!' in the legend
       with a reason rather than an empty layer.

       savesData is FALSE deliberately. It persists nothing through the
       toolData contract; its writes go to capacityAllocations, which is
       org-wide by design because a claim nobody else can see stops nobody
       from selling over it. Marking it savesData:true would imply per-org
       toolData state that does not exist.

       SAME WORKER DEPENDENCY as comedcap — see the note above. If this shows
       '!' on hosting capacity for everyone at once, check the Worker before
       anything in this file. */
    { key:'sitefinder', name:'Site Finder', category:'interconnection',
      desc:'Browse C&I sites on a live hosting-capacity map, ranked by the battery you can actually deliver \u2014 and hold the circuit so nobody sells it twice.',
      file:'/clearsky-sitefinder.html', badge:'new', tier:TIER.ALL,
      icon:'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15' },

    /* ── OPERATIONS ── */
    { key:'degradation', name:'BESS Degradation & Warranty', category:'operations',
      desc:'Capacity fade over project life vs OEM warranty envelope, with augmentation planning.',
      file:'/degradation-warranty.html', badge:'new', tier:TIER.DELUXE, savesData:true,
      icon:'M6 7h12v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM9 7V5a3 3 0 0 1 6 0v2M9 15l6-4' },

    /* ── PROJECT INTAKE QUEUE (ClearSky staff only) ──
       The fulfilment side of Project Intake. Tenants submit sites from their
       own portal; this is where ClearSky picks them up, works them, and pushes
       progress back to the tenant.

       orgs:[] restricts it to ClearSky's own workspaces, exactly like
       spatco_ev is restricted to spatco.com. isVisible() returns false for
       every other tenant, so it never appears in a customer marketplace even
       though they all load this same file.

       That restriction is convenience, not security: the file is on a public
       host and the URL is guessable. The real boundary is the Firestore rule
       on intake_projects — listAll() is an unfiltered query, which Firestore
       refuses for anyone isAdmin() is false for, so a tenant who found this
       page gets a permission error and an empty table. */
    /* ── EV COST WORKBOOK (ClearSky staff only) ──
       Turns an electrical estimate into the customer proposal and the
       utility program forms. Reps use it while working an intake, so it
       carries the same orgs restriction as the intake queue itself.

       Same caveat as intake_admin: the orgs list is convenience, not
       security. The file sits on the public tools host and the URL is
       guessable. The boundary is the tool's own gate — it requires a
       signed-in clearsky-usa.com / csebuilders.com account and fails
       closed, so a tenant who finds the page gets a sign-in wall.

       No savesData: the estimate is pasted or handed over from the
       editor and never written to Firestore, so there is no per-tenant
       toolData document to reopen. */
    { key:'evcostwb', name:'EV Cost Workbook', category:'sales',
      desc:'Estimate \u2192 customer proposal + utility make-ready forms in one workbook. Level 2 and DC fast charging.',
      file:'/ev-cost-workbook.html', badge:'new', tier:TIER.ALL,
      orgs:['clearsky-usa.com','csebuilders.com'],
      icon:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h3l-1 3h3M16 13v6' },

    /* ── A NOTE ON THE TWO INTAKE ENTRIES ──
       'intake' is the customer-facing form: every tenant sees it.
       'intake_admin' is the staff queue: restricted by orgs:[] above.
       Both read the same intake_projects collection; the rules decide who
       sees whose records. Keep them adjacent so nobody adds one and forgets
       the other. */
    { key:'intake_admin', name:'Intake Queue', category:'operations',
      desc:'Work tenant-submitted sites \u2014 triage, quote, produce the packages and push progress back to the client.',
      file:'/intake-admin.html', badge:'new', tier:TIER.ALL, savesData:true,
      orgs:['clearsky-usa.com','csebuilders.com'],
      icon:'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' }
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

    /* Resolve an array of pinned KEYS to the matching tool objects, in stable
       catalog order. This is the dashboard's source of truth for "My
       Applications": if the customer pinned a tool, it renders — we do NOT
       re-filter through isUnlocked() here, because a pin is an explicit user
       choice and the tool was already unlocked when they added it. Visibility
       (tool.orgs) is still honored so client-specific tools never leak across
       tenants. Unknown keys (stale pins for removed tools) are skipped. */
    pinnedTools: function (keys, workspace) {
      var out = [];
      if (!keys || !keys.length) return out;
      for (var i = 0; i < this._tools.length; i++) {
        var t = this._tools[i];
        if (keys.indexOf(t.key) >= 0 && this.isVisible(t, workspace)) out.push(t);
      }
      return out;
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

      // Tools on TOOL_HOST are a different origin from the portal, so they
      // cannot work out where the person came from once the referrer is gone
      // (a refresh, or rel="noreferrer"). Hand them the way back explicitly.
      // Tools that don't use it simply ignore the param.
      if (host && typeof window !== 'undefined' && window.location && window.location.host) {
        var back = window.location.protocol + '//' + window.location.host +
                   (window.location.pathname || '/');
        base += (base.indexOf('?') >= 0 ? '&' : '?') + 'return=' +
                encodeURIComponent(back);
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
