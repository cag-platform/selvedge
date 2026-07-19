# Worked Examples — Context Packs

Eight packs. Each one exists to stress a different part of the schema:

| Pack | What it stresses |
|---|---|
| Loom | `live_critical` + money + downstream dependents |
| SILD | The trust ledger (stale GitHub, Replit as source of truth) + App Store |
| Toile | Internal tooling that must never alert + `serves` fan-out |
| Mirror | Multi-service topology (app + render pipeline + R2 storage) |
| SZD | Platform-with-tenants, two deploy lifecycles, the Modal blind spot |
| CAG Website/CRM | Split stakes; DB that secretly feeds the public site |
| SB Platform | Many surfaces in one service; `consumes` (inbound dependencies); Postgres-as-queue trap |
| YOKE | Pre-launch mode: readiness narration instead of uptime |

---

## 1. Loom — the live_critical worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "loom",
    "name": "Loom",
    "owner_description": "Loom is where my retailers place and track orders — the catalog and source of truth for the whole product ecosystem.",
    "audience": "12 live retail partners",
    "links": {
      "repo_url": "https://github.com/cag-platform/loom",
      "host_dashboard_url": "https://railway.app/project/loom"
    }
  },
  "stakes": {
    "tier": "live_critical",
    "has_external_users": true,
    "user_scale": "dozens",
    "touches_money": true,
    "business_role": "revenue_product",
    "downtime_translation": "my retailers can't submit or check orders"
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/loom", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<loom-service-id>", "role": "production_host", "environment": "production" },
      { "connector": "neon", "resource_id": "<loom-db-id>", "role": "database", "environment": "production" }
    ],
    "serves": ["chalk"],
    "stack_summary": "Node app on Railway, Neon Postgres, Clerk auth; emits order.submitted webhook consumed by Chalk"
  },
  "baselines": {
    "deploy_cadence": "weekly",
    "typical_build_seconds": 180,
    "build_failure_rate_30d": 0.05,
    "known_flaky": []
  },
  "state": {
    "serving_now": { "version_ref": "<sha>", "deployed_at": "2026-07-15T18:00:00Z", "healthy": true },
    "in_progress": [
      {
        "ref": "feature/webhook-pricing-snapshot",
        "summary": "Adding pricing details to the order webhook so Chalk can auto-record expenses.",
        "opened_at": "2026-06-20T00:00:00Z",
        "last_activity_at": "2026-06-24T00:00:00Z"
      }
    ],
    "stalled": []
  },
  "trust": {
    "sources": {
      "github": { "status": "fresh" },
      "railway": { "status": "fresh" },
      "neon": { "status": "fresh" }
    },
    "overall_confidence": "high"
  },
  "voice": {
    "detail_level": "plain_expandable",
    "notify": { "push_threshold": "failures" }
  }
}
```

**What this pack makes the narrator able to say:** a failed Loom deploy at this tier gets an immediate push, the full LLM path, and a verdict phrased with the owner's own words: *"A Loom update failed to go live. Your retailers can still submit and check orders — the previous version is running fine."* Note also: `in_progress` already contains a branch that (as of last activity) is 3+ weeks quiet — the stall detector would move it to `stalled` and the Ideas surface would nudge: *"The pricing-snapshot webhook work has been quiet since late June — still want it?"* And because `serves: ["chalk"]`, a Loom outage narration appends: *"This may also affect Chalk's auto-expense recording."*

---

## 2. SILD — the trust-ledger worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "sild",
    "name": "SILD",
    "owner_description": "SILD is my cross-border translation app for factory communication — live in the App Store with paying customers.",
    "audience": "paying B2B customers, including my own factory partners",
    "links": {
      "repo_url": "https://github.com/cag-platform/sild",
      "store_listing_url": "<app-store-url>"
    }
  },
  "stakes": {
    "tier": "live_critical",
    "has_external_users": true,
    "user_scale": "dozens",
    "touches_money": true,
    "business_role": "revenue_product",
    "downtime_translation": "customers can't translate factory messages — and a bad translation can cost them real money"
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/sild", "role": "code_mirror", "environment": "production",
        "notes": "STALE — do not treat as current until migration is revisited" },
      { "connector": "replit", "resource_id": "<sild-repl-id>", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<sild-service-id>", "role": "production_host", "environment": "production" },
      { "connector": "railway", "resource_id": "<kpack-service-id>", "role": "auxiliary", "environment": "production",
        "notes": "kpack knowledge-pack service" },
      { "connector": "neon", "resource_id": "<sild-db-id>", "role": "database", "environment": "production" },
      { "connector": "app_store_connect", "resource_id": "<bundle-id>", "role": "store_listing", "environment": "production" }
    ],
    "stack_summary": "Main app + kpack service on Railway, Neon Postgres (62-table Drizzle schema), iOS app in App Store"
  },
  "baselines": {
    "deploy_cadence": "multiple_daily",
    "known_flaky": []
  },
  "state": {
    "serving_now": { "version_ref": null, "deployed_at": null, "healthy": null },
    "last_event_at_by_source": {
      "github": "2026-05-01T00:00:00Z",
      "railway": "2026-07-17T00:00:00Z"
    }
  },
  "trust": {
    "sources": {
      "github": { "status": "stale_suspected", "note": "Repo quiet since migration; Railway keeps deploying. Code narration must not rely on the repo." },
      "replit": { "status": "fresh" },
      "railway": { "status": "fresh" },
      "app_store_connect": { "status": "fresh" }
    },
    "overall_confidence": "partial"
  },
  "voice": {
    "detail_level": "technical_forward",
    "notify": { "push_threshold": "critical_only" }
  }
}
```

**What this pack stresses:** two things the schema exists for. First, `role: code_mirror` vs `role: source_of_truth` on different code sources — the narrator describing "what changed in SILD's code" reads Replit, never the repo, and if only GitHub is connected it discloses: *"Heads up — SILD's repo looks out of date with what's actually running, so I can only see part of the picture."* Second, `serving_now.healthy: null` — the honest-uncertainty case. The narrator says "I can't verify SILD's health right now," not "everything's fine." `overall_confidence: partial` forces that disclosure at the top of any SILD narration.

---

## 3. Toile — the never-alert-me worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "toile",
    "name": "Toile",
    "owner_description": "Toile is my internal dev platform — my Replit replacement for managing all my apps.",
    "audience": "just me",
    "links": { "repo_url": "https://github.com/cag-platform/toile" }
  },
  "stakes": {
    "tier": "personal",
    "has_external_users": false,
    "user_scale": "none",
    "touches_money": false,
    "business_role": "internal_tooling",
    "downtime_translation": "my own build workflow is interrupted, nothing customer-facing"
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/toile", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<toile-service-id>", "role": "production_host", "environment": "production" }
    ],
    "serves": ["loom", "sild", "mirror", "chalk", "drape"],
    "stack_summary": "Internal platform on Railway; Clerk auth; orchestrates builds for sibling apps"
  },
  "baselines": { "deploy_cadence": "multiple_daily" },
  "state": {},
  "trust": { "overall_confidence": "high" },
  "voice": {
    "detail_level": "technical_forward",
    "notify": { "push_threshold": "never" }
  }
}
```

**What this pack stresses:** the router's silent path. Toile can fail builds all day — `tier: personal` + `push_threshold: never` means everything folds into the digest as one calm line, or nothing at all. But the `serves` fan-out is the interesting wrinkle: Toile is *personal* yet five projects depend on it, so a Toile outage earns a digest mention shaped as *"Toile is down — doesn't affect any of your users, but you won't be able to run builds until it's back."* Internal tooling gets narrated by consequence, not by severity.

---

## 4. Mirror — the multi-service topology worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "mirror",
    "name": "Mirror",
    "owner_description": "Mirror renders garment visualizations from Photoshop templates — deterministic, about $0.002 a render.",
    "audience": "internal for now; feeds product imagery for the retail ecosystem",
    "links": { "repo_url": "https://github.com/cag-platform/mirror" }
  },
  "stakes": {
    "tier": "live_small",
    "has_external_users": false,
    "user_scale": "none",
    "touches_money": false,
    "business_role": "internal_operations",
    "downtime_translation": "new product images stop generating; existing images are unaffected"
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/mirror", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<mirror-app-id>", "role": "production_host", "environment": "production" },
      { "connector": "railway", "resource_id": "<mirror-render-worker-id>", "role": "auxiliary", "environment": "production",
        "notes": "PSD template render pipeline (9 templates)" },
      { "connector": "custom", "resource_id": "r2:<bucket>", "role": "storage", "environment": "production",
        "notes": "Cloudflare R2 — no connector yet; tracked for topology completeness, no events" }
    ],
    "stack_summary": "App + render worker on Railway; deterministic PSD template pipeline; output to Cloudflare R2"
  },
  "baselines": { "deploy_cadence": "weekly" },
  "state": {},
  "trust": {
    "sources": { "custom": { "status": "disconnected", "note": "R2 has no connector — blind spot, disclosed if storage is implicated." } },
    "overall_confidence": "partial"
  },
  "voice": {
    "detail_level": "plain_expandable",
    "notify": { "push_threshold": "critical_only" }
  }
}
```

**What this pack stresses:** one project, multiple services with different jobs — a failed deploy on the *render worker* vs the *app* should narrate differently ("image generation is paused" vs "the Mirror app itself is down"), and `role` + `notes` give the LLM what it needs to make that distinction. Also the honest blind spot: R2 has no connector, so it's recorded as `disconnected` rather than omitted — if a rendering failure smells like storage, the narrator can say "this might be on the storage side, which I can't see into."

---

## 5. SZD — the platform-tenant worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "szd",
    "name": "SZD",
    "owner_description": "SZD turns four phone photos into tailoring measurements — a measurement service other clothing businesses plug into.",
    "audience": "tenant businesses (YOKE onboarding as tenant #1); their customers' scans flow through it",
    "links": { "repo_url": "https://github.com/cag-platform/szd" }
  },
  "stakes": {
    "tier": "live_small",
    "has_external_users": true,
    "user_scale": "handful",
    "touches_money": true,
    "business_role": "revenue_product",
    "downtime_translation": "tenant apps can't run body scans — their customers get stuck at the fitting step; a WRONG measurement is worse than no measurement"
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/szd", "role": "source_of_truth", "environment": "production" },
      { "connector": "custom", "resource_id": "docker:<szd-api>", "role": "production_host", "environment": "production",
        "notes": "API ships via Dockerfile — host connector depends on where it lands" },
      { "connector": "custom", "resource_id": "modal:szd", "role": "auxiliary", "environment": "production",
        "notes": "GPU worker (A10G) on Modal — deployed via 'modal deploy', separate lifecycle from the API. No Modal connector yet: blind spot." },
      { "connector": "neon", "resource_id": "<szd-db-id>", "role": "database", "environment": "production" },
      { "connector": "custom", "resource_id": "r2:<szd-photos>", "role": "storage", "environment": "production",
        "notes": "Scan photos; photos never transit the API, R2 keys only" }
    ],
    "serves": ["yoke"],
    "stack_summary": "Express+TS API (Drizzle/Neon) + Modal GPU worker (SAM 2.1, RTMPose); tenant webhooks HMAC-signed; deterministic measurement path, Claude only for capture QA and explanations"
  },
  "baselines": {
    "deploy_cadence": "weekly",
    "known_flaky": []
  },
  "state": {
    "in_progress": [
      { "ref": "phase-2-yoke-tenant", "summary": "Onboarding YOKE as the first tenant: capture UX, consent enforcement, and the correction-label join.", "opened_at": "2026-06-01T00:00:00Z", "last_activity_at": "2026-07-15T00:00:00Z" },
      { "ref": "phase-3-track-a", "summary": "Trained-model measurement path built but gated — the promotion gate has correctly rejected it twice; deterministic baseline stays live.", "opened_at": "2026-06-15T00:00:00Z", "last_activity_at": "2026-07-15T00:00:00Z" }
    ]
  },
  "trust": {
    "sources": {
      "custom": { "status": "disconnected", "note": "Modal worker has no connector — if scans hang, the dashboard can see the API but not the GPU side. Disclose when jobs stall." }
    },
    "overall_confidence": "partial"
  },
  "voice": {
    "detail_level": "technical_forward",
    "notify": { "push_threshold": "failures" }
  }
}
```

**What this pack stresses:** three schema limits found at once. First, **the connector enum breaks** — Modal isn't in it, and SZD's most failure-prone component (a GPU worker) is exactly the piece the dashboard can't see. The `custom` + `disconnected` pattern handles it honestly, but this is the argument for a generic webhook/status-URL connector in the roadmap: let unsupported hosts push events in. Second, **a two-lifecycle project**: API and worker deploy separately (`Dockerfile` vs `modal deploy`), so "SZD deployed" is ambiguous — `notes` per source is what lets the narrator say *which half* changed. Third, **B2B blast radius**: `serves: ["yoke"]` at the platform level means an SZD outage narrates downstream — "YOKE's fitting step is affected" — which is a different sentence than any single-app pack produces. And one nuance the stakes section almost misses: for a measurement service, the `downtime_translation` names the real fear — *wrong* beats *down* as the failure that matters, which should bias its routing toward treating data-integrity events as critical even when uptime is green.

## 6. Canvas Apparel Group Website/CRM — the split-stakes worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "cag-web-crm",
    "name": "CAG Website & CRM",
    "owner_description": "The Canvas Apparel Group public site — how prospective retail partners find us — plus the CRM behind /admin where I work leads and pipeline.",
    "audience": "prospective retail partners, press, and subscribers on the site; just me in the CRM",
    "links": { "live_url": "https://canvasapparelgroup.com", "repo_url": "https://github.com/cag-platform/<cag-web-repo>" }
  },
  "stakes": {
    "tier": "live_small",
    "has_external_users": true,
    "user_scale": "handful",
    "touches_money": false,
    "business_role": "marketing_surface",
    "downtime_translation": "the public site down looks bad to any partner checking us out and drops inbound leads on the floor; CRM downtime only stalls my own follow-ups. If live chat is on, a visitor mid-conversation gets cut off."
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/<cag-web-repo>", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<cag-web-service-id>", "role": "production_host", "environment": "production",
        "notes": "Single Node monolith: SSR marketing pages + /admin SPA + WebSocket chat in one process. Nixpacks build, /healthz check, restart-on-failure max 5." },
      { "connector": "neon", "resource_id": "<cag-db-id>", "role": "database", "environment": "production",
        "notes": "Leads/pipeline/CRM AND the CMS-lite content the public pages render from — DB down degrades the public site too, not just admin." },
      { "connector": "custom", "resource_id": "r2:<cag-assets>", "role": "storage", "environment": "production",
        "notes": "Optional; site falls back to /public statics when unconfigured" }
    ],
    "stack_summary": "Express + React 18 SSR monolith on Railway; raw-SQL Neon Postgres, migrations auto-run on boot; Resend email, Twilio SMS-relay chat behind CHAT_ENABLED flag; no CI, no tests"
  },
  "baselines": {
    "deploy_cadence": "monthly",
    "known_flaky": []
  },
  "state": {},
  "trust": { "overall_confidence": "high" },
  "voice": {
    "detail_level": "plain_expandable",
    "notify": { "push_threshold": "failures" }
  }
}
```

**What this pack stresses:** the split-stakes case, but the architecture doc sharpened it in two ways a guess would have missed. First, the DB `notes` correct a wrong assumption: because the public pages render CMS content *from Postgres*, a Neon outage is **not** "internal only" — the narrator's honest line is "your site may be up but showing incomplete content, and new leads can't save." The topology notes are where that causal knowledge lives. Second, migrations run on every boot with no CI and no tests — so for this project, *a deploy is the risky event*, not a routine one. That's a real router input the schema captures via `stack_summary`: the LLM path should treat "deploy started" on this pack with more attention than on a CI-gated project. Also worth noting: the whole live-chat feature sits behind `CHAT_ENABLED` — a reminder that `downtime_translation` can be conditional, and the narrator should know which flags are on before claiming what broke.

## 7. Smith Bespoke Platform (sb-master) — the many-surfaces worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "sb-master",
    "name": "Smith Bespoke Platform",
    "owner_description": "The Smith Bespoke engine — client closet, concierge, and storefront built on my 500+ client book. The Desk is where I work; the Atelier is what clients see.",
    "audience": "Smith Bespoke clients in the Atelier portal and storefront; me in the Desk console",
    "links": { "repo_url": "https://github.com/cag-platform/sb-master" }
  },
  "stakes": {
    "tier": "live_critical",
    "has_external_users": true,
    "user_scale": "hundreds",
    "touches_money": true,
    "business_role": "revenue_product",
    "downtime_translation": "clients can't reach their closet, the storefront, or chat; checkout and Square payments stop; my Desk goes dark. Worst case isn't downtime — it's an ungated outbound action reaching a client."
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/sb-master", "role": "source_of_truth", "environment": "production" },
      { "connector": "railway", "resource_id": "<sb-service-id>", "role": "production_host", "environment": "production",
        "notes": "ONE Railway service serving five surfaces: admin API, portal API, public API, webhook receivers (Square/Loom/SZD/chat), and three static SPAs. In-process workers using Postgres as the job queue — no separate worker deploy." },
      { "connector": "neon", "resource_id": "<sb-db-id>", "role": "database", "environment": "production",
        "notes": "Client book, orders, measurements, AND the job queue — DB down means workers stop too, silently" },
      { "connector": "custom", "resource_id": "r2:<sb-media>", "role": "storage", "environment": "production" }
    ],
    "serves": [],
    "consumes": ["loom", "szd", "mirror"],
    "stack_summary": "Express+TS monolith, Drizzle/Neon, three React 19 SPAs served statically, Postgres-as-queue workers, HMAC webhooks in from Square/Loom/SZD; Claude drafts but every outbound send is human-gated; operator launch flags in shared config"
  },
  "baselines": {
    "deploy_cadence": "weekly",
    "known_flaky": []
  },
  "state": {
    "in_progress": [
      { "ref": "phase-d-wedding-center", "summary": "Wedding Center scoped (groom's commission as front door) — only a config-gated landing entrance exists so far.", "opened_at": "2026-06-01T00:00:00Z", "last_activity_at": "2026-07-01T00:00:00Z" }
    ]
  },
  "trust": { "overall_confidence": "high" },
  "voice": {
    "detail_level": "plain_expandable",
    "notify": { "push_threshold": "failures" }
  }
}
```

**What this pack stresses:** two schema findings. First, it forced a new field — **`consumes`**, the inverse of `serves`. SB receives webhooks from Loom, SZD, and Mirror; when a Loom deploy goes sideways, the narrator should warn *SB's* owner-view too ("order-status sync into Smith Bespoke may lag"). Dependency edges need both directions. Second, the Postgres-as-job-queue detail is a narration trap worth encoding: workers live *inside* the web process and the queue lives *inside* the DB, so a "database blip" here quietly stops background jobs (Loom drafts, email sends, PDF extraction) even after the site looks recovered — the `notes` are what let the narrator say "the site's back, but check whether queued work resumed." And the `downtime_translation` captures something no monitoring tool would ever surface on its own: the owner's stated worst case is a *gated action escaping its gate*, not an outage — a reminder that stakes are the owner's fears, not the industry's defaults.

## 8. YOKE — the live-but-incomplete worked example

```json
{
  "pack_version": "1.0",
  "identity": {
    "project_id": "yoke",
    "name": "YOKE",
    "owner_description": "Pilot Shirting — custom dress shirts for airline pilots. Fit is the product: first order confirms fit against one shirt, then reorders are one tap.",
    "audience": "live on yokeshirts.com — visitors can browse and build fit profiles, but checkout isn't connected yet",
    "links": { "live_url": "https://yokeshirts.com", "repo_url": "https://github.com/cag-platform/yoke" }
  },
  "stakes": {
    "tier": "live_small",
    "has_external_users": true,
    "user_scale": "handful",
    "touches_money": false,
    "business_role": "revenue_product",
    "downtime_translation": "the storefront disappears for any pilot checking it out — but nobody can lose an order yet, because checkout isn't live. The real thing to watch is the gap: a live store that can't take money."
  },
  "topology": {
    "sources": [
      { "connector": "github", "resource_id": "cag-platform/yoke", "role": "source_of_truth", "environment": "production" },
      { "connector": "custom", "resource_id": "host:yokeshirts.com", "role": "production_host", "environment": "production",
        "notes": "Live at yokeshirts.com — host connector to be confirmed against actual deployment" },
      { "connector": "neon", "resource_id": "<yoke-db-id>", "role": "database", "environment": "production" }
    ],
    "consumes": ["szd", "loom"],
    "stack_summary": "React+Vite client, Express+TS server, Drizzle/Neon. LIVE with a capability gap: Stripe not connected (mock checkout only), 3DLOOK mocked, Loom submission stubbed. Onboarding as SZD tenant #1.",
    "capability_gaps": [
      { "gap": "checkout", "summary": "Stripe isn't connected — visitors can browse and get fitted but can't pay.", "blocking": "revenue" },
      { "gap": "scan", "summary": "Body scan runs on realistic mock data until SZD tenant onboarding and/or 3DLOOK credentials land.", "blocking": "core feature fidelity" },
      { "gap": "manufacturing", "summary": "Orders would stub out instead of reaching Loom.", "blocking": "fulfillment" }
    ]
  },
  "baselines": { "deploy_cadence": "weekly" },
  "state": {
    "in_progress": [
      { "ref": "stripe-connection", "summary": "Connecting real checkout — the gap between a live store and a store that makes money.", "opened_at": "2026-07-01T00:00:00Z", "last_activity_at": "2026-07-15T00:00:00Z" }
    ]
  },
  "trust": { "overall_confidence": "partial" },
  "voice": {
    "detail_level": "plain_expandable",
    "notify": { "push_threshold": "failures" }
  }
}
```

**What this pack stresses:** the mode the architecture doc got wrong and only the owner could correct — **live but incomplete**. The doc said "not deployed"; reality is a live storefront missing its money path. That mismatch teaches two things. First, packs drafted from docs must be reconciled against connectors, and human corrections outrank both — docs are just another source that can go stale. Second, it forced `capability_gaps`: a live_small site whose most important status isn't up/down but *"live, and still can't take an order."* The narrator's most valuable YOKE sentence is a standing one, not an event: "yokeshirts.com is healthy — and day 12 of visitors being unable to buy." That gentle drumbeat is worth more than any deploy notification, and it's a sentence no uptime monitor in existence produces.

## What the eight packs prove together

Each schema section earned its place against at least one real project — and the four architecture docs earned their upload by breaking the schema in three places a guess-based pack never would have:

1. **`consumes` didn't exist** until SB and YOKE forced it. Dependency edges need both directions (`serves` + `consumes`) for consequence-aware narration across a stack.
2. **The connector enum is already too small** — Modal (SZD's GPU worker) has no slot, and it's the most failure-prone piece of that system. The `custom` + `disconnected` pattern is the honest stopgap; a generic inbound-webhook connector is the roadmap answer.
3. **"Live but incomplete" is a first-class mode** — YOKE is deployed with its money path missing. Gap narration ("day N of a store that can't take orders") matters more than uptime there, and `capability_gaps` carries it. The doc-vs-reality miss that produced this pack is itself the lesson: docs draft packs, connectors verify them, the owner corrects both.

Still true from round one: `downtime_translation` did the most narration work in every single pack (and SB proved it can encode fears no monitor tracks, like a gate failing open — while SZD proved "wrong data" can outrank "downtime" as the real risk). Dormant-is-normal (Smith's old pack) migrated to YOKE. The split-stakes pattern (CAG) held, sharpened by the discovery that its "internal" database actually feeds the public pages. Topology `notes` graduated from nice-to-have to load-bearing: they're where causal knowledge lives ("DB is also the job queue," "photos never transit the API"), and they're what the LLM path quotes when explaining *why* something matters.
