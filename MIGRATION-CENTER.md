# THE MIGRATION CENTER

> **Status (Aug 2026): scoped, zero code, deliberately deferred.** An
> acquisition channel to build after the core loop proves itself with live
> customers — not the front door. The brief is the front door
> (BUILD-BRIEF §"the brief is the product"). Nothing below is invalidated;
> it just isn't next.

**31 July 2026.** Design document. Framing per the founder: this is **leaving** — leaving
Replit, Lovable, Base44, Bolt, v0 — and Selvedge is where you land. Grounded in three
research passes over official docs, ToS, and APIs (citations in the research annex of
`SELVEDGE-VIABILITY-REVIEW.md` sources plus inline below).

---

## 1. THE DECISION: customer-owned infrastructure, Selvedge-orchestrated

The "Selvedge Railway / Selvedge Supabase" question is settled by three independent
forces that all point the same way:

1. **Contract.** Railway's fair-use policy prohibits "reselling compute resources"
   [V: railway.com/legal/fair-use]. Vercel's ToS prohibits "sublicense, resell…or make
   the Services available to any third party" [V: vercel.com/legal/terms]. A self-serve
   umbrella is a ToS violation on both. The umbrellas that exist (Lovable Cloud on
   Supabase, Replit on Neon) are negotiated commercial partnerships, not team accounts.
2. **Trust.** The pitch is "get your app into your own hands." An umbrella transfers the
   hostage; orchestrated customer accounts free it. The deed stays in their name;
   Selvedge holds the keys as caretaker — and they can fire Selvedge and everything
   keeps running, which (per IRONCLAD-1) is exactly why they won't.
3. **Economics.** Customer-owned means zero hosting COGS, no custody liability for the
   infrastructure, their billing surprises surfaced by our cost-custody brief rather
   than landing on our support queue — and Railway's Template Kickback Program pays
   **15% of ongoing usage (25% with support) for deployments of a published template**
   [V: docs.railway.com/templates/kickbacks]. The freedom model is revenue-positive.

**Managed tier, later, one place only:** Neon explicitly sells the umbrella pattern
("Embedded Postgres," claimable projects, per-user limits) [V: neon.com platform-
integration docs]. If a truly nontechnical segment demands a landlord, that's the
supported substrate — with a documented transfer-out right. Never the default door.

### The standard destination ("the Selvedge stack")

One destination shape, so every runbook converges:

| Layer | Destination | Mechanics |
|---|---|---|
| Code | **Customer's GitHub** | See §3 — repo created by the customer in a guided step; Selvedge App installed on that repo only |
| App hosting | **Customer's Railway** | OAuth ("Login with Railway") or customer workspace token; `templateDeployV2` deploys the repo + Postgres + env bundle in one call [V: Railway API/OAuth docs]. Vercel as the alternative for Next.js/static (Deploy Button / integration token) |
| Database + auth + files | **Customer's Supabase** (or keep their existing one) | Best-in-class: OAuth app + Management API `POST /v1/projects` creates projects in the customer's org; `auth.users` **including bcrypt/argon2 password hashes** imports cleanly — users don't reset passwords [V: supabase auth-migration docs]. JWT secret carried over so sessions survive where the source exposes it |
| DB alternative | **Neon claimable** | Provision under Selvedge with no signup, hand over the connection string, customer claims ownership within 72h; connection strings survive claiming [V: Neon docs]. The lowest-friction handoff in the industry |
| DNS | Customer's registrar | Entri Connect (35+ providers, one consent, writes records automatically) where supported; plain instructions + DNS-over-HTTPS polling verification everywhere else [V: entri.com] |
| Fuel | Customer's model subscription/key | The BYO connector (§25.3) |

### The GitHub wrinkle — solved in-app: borrow the key, use it once, hand it back

GitHub Apps **cannot create repos in a personal user account** — that needs an OAuth
`repo` scope, which grants access to ALL the customer's private repos [V: GitHub docs +
community #171040]. The earlier draft of this document routed around that by sending
the customer to GitHub's UI to "create a repository" — which fails the vocabulary test
(a nontechnical owner doesn't know what a repository is) and breaks the in-app flow.

The better design — **borrow-and-return**, fully in-app:

1. In-app popup: *"Connect your GitHub account"* (or *"Create one — it's where your
   app's code will live, in your name"* — GitHub signup happens inside the same popup
   for customers who have none, and a brand-new account has nothing for a broad scope
   to reach).
2. Selvedge uses the OAuth token for exactly one action: create the single private
   repo, in their account, named for their app.
3. **Selvedge then revokes its own broad authorization** — `DELETE
   /applications/{client_id}/grant` — and directs the customer's one remaining consent:
   install the Selvedge App **on that repo only**.
4. The ledger records all three acts: key borrowed, one door built, key returned —
   with timestamps.

Total broad-permission exposure: seconds, one action, self-revoked, receipted. The
plain-level copy never says repository: *"I set up your app's new home on GitHub —
it's in your name, and I gave back the master key. Here's the receipt."* This is the
product's permission philosophy executed rather than merely respected: ask for exactly
what the job needs, and when the job briefly needs more, give it back in the same
breath and show your work.

---

## 2. THE EXITS — per-platform runbooks

Difficulty and value move together: the harder the exit, the more it is worth paying
for. Summary from the research (full citations in the agent reports):

| Source | Difficulty | The exit in one line | What cannot come out |
|---|---|---|---|
| **v0** | Clean | GitHub sync exists; standard Next.js; data already in external Postgres | "Sensitive" env values; Vercel-specific services get swapped |
| **Bolt** | Clean | Standard Vite; **Claim** flow transfers the Bolt-owned Supabase project — auth hashes travel | Chat history; unclaimed DBs auto-pause after ~6 idle days |
| **Lovable** | Clean → Moderate | Free-tier GitHub sync; own-Supabase apps just disconnect; **Lovable Cloud** apps use official "Export data" + the OSS Dreamlit exporter (claims hash-preserving auth moves) | Secret values (re-enter); OAuth configs (redo); `lovable-tagger` (strip) |
| **Replit** | Moderate | Git pane/zip for code; **Helium DB is not externally reachable — pg_dump from inside the Shell**; Replit Auth → official Clerk migration BEFORE leaving; secrets readable (eye icon); object storage scripted out | Replit-account identities (Clerk conversion first); the prod-DB export path is **undocumented — empirical test #1** |
| **Base44** | **Hostile** | Frontend exports but every data/auth/storage call goes through their SDK to their servers; data via per-entity CSV/REST; **password hashes cannot leave** | Hashes (forced resets), secrets, automations, agent memories — and the ToS allows **deleting all customer data immediately on termination**, so the subscription is cancelled LAST, always |

**Cursor (and Claude Code, Windsurf…) is not a migration** — the code already lives in
the customer's repo and hosting. The Center's page says so:
*"Already own your code? Skip to Connect."* That sentence is itself the freedom posture.

**Known breakage points the sandbox must fix mechanically** (from documented
post-mortems): leftover Neon serverless-HTTP driver calls (break on any standard
Postgres — swap to `pg`); SSL config mismatches (Helium has none, everything else
requires it); Replit Auth/ReplDB/Object-Storage SDK calls with no replacement; missing
env vars; `lovable-tagger`; Bolt env keys; edge functions not redeployed.

### Launch order

1. **Replit — first.** The spend-qualified refugee (§20) lives here; the founder's own
   exit is the founding story; the stack Replit Agent scaffolds (React+Vite+Express+
   Drizzle) is virtually Selvedge's own, so our machinery understands it natively; and
   the December 2025 Helium change made DIY *harder* (the old pg_dump-from-outside
   guides are dead), which widens the moat for a productized path. The documented
   post-backlash exit market is real.
2. **Lovable — second.** The volume play; mostly clean; the Cloud-export fork is the
   value-add. The existing OSS exporter is a component to build on, not compete with.
3. **Bolt / v0 — cheap adds.** Mostly guided steps + connect; support them early
   because they cost little and widen the funnel.
4. **Base44 — waitlist until Phase 3.** The exit requires *rewriting the data layer*
   (every SDK call → Supabase client), which is agent work — it needs the repair
   engine. When it ships it is the most defensible migration in the market (one agency
   already monetizes it). Until then: loud waitlist + a free "what would it take"
   assessment, which measures demand and starts the relationship.
5. **Everything else** — waitlist per platform; the waitlist IS the demand research.

---

## 3. THE CUSTOMER EXPERIENCE — five stages, verdict-first

The whole move framed the only way this product frames anything: propose → estimate →
approve → work → verify. Nothing destructive until the end, and the old home stays
alive until the new one is proven.

**Stage 1 — The Survey (free, read-only).** Connect the source platform read-only.
Selvedge inspects and produces the **Migration Brief**: what moves cleanly, what needs
work (named: "your login system is Replit's and must be converted first — I can do
that"), what cannot come (named plainly: "Base44 cannot give us your users'
passwords — they'll reset them once"), how long, and the price. The brief carries a
verdict and an honest unknown where one exists. This is the protection brief's sibling
and the Center's front door — worth sharing even if they don't buy.

**Stage 2 — Prepare (on the old platform, nothing moves yet).** The pre-exit
conversions done while the source still works: Replit Auth → Clerk (official path),
Bolt DB **Claim**, Lovable Cloud → export/own-Supabase, secrets inventoried. Reversible
by construction — the app never stops running where it is.

**Stage 3 — The Parallel Build.** In a Selvedge sandbox: import the code, fix the known
breakage classes mechanically, provision the customer's destination accounts (guided
OAuth connects — their name on everything), deploy, load a **snapshot** of the data,
run the smoke checks. The customer gets a URL: *"Here's your app, running in its new
home, with a copy of Tuesday's data. Click around."* Nothing about the live app has
changed. This is the toile ship-flow pointed at customer-owned accounts — the machinery
already exists.

**Stage 4 — Cutover (approved, scheduled, reversible).** A quiet-hours window: brief
write-freeze on the old app → final data delta → verify counts match → DNS repoint
(Entri where possible; guided-with-verification everywhere else) → watch propagation →
the five-value verdict on the migration itself: **verified working in its new home /
probably / inconclusive / didn't work — old app still serving, nothing lost / stopped**.
The old platform is still running and DNS can point back in minutes. That reversibility
is the difference between a scary move and a safe one, and it is what the customer is
paying for.

**Stage 5 — Decommission + handoff (the funnel's second door).** After N green days:
walk the customer through cancelling the old platform (in the safe order — Base44
LAST-cancels always), confirm the savings against their old bill, and:
*"It's yours now — repo, hosting, database, all in your name. Want me to keep watching
it?"* The care plan starts with every permission already granted, because the customer
granted each one during a migration they asked for. **The permission cliff is crossed
as a side effect of the move.**

---

## 4. HOW MUCH LIVES IN THE APP — and the vocabulary rule

**Founder directive:** a nontechnical customer who sees "create repository" is lost;
every step needs the same three levels of context the rest of the product has. And:
get as much of the migration as possible directly into the app.

### The vocabulary rule

The migration speaks through the same `voice.detail_level` machinery as everything
else. The plain register never uses infrastructure nouns:

| Plain (default) | Plain + why (expand) | Technical |
|---|---|---|
| "your app's new home" | "GitHub — where the code lives, in your name" | repo, branch, App installation |
| "your app's memory" | "the database — every order, user, and record" | Postgres, `pg_dump`, row counts |
| "your web address" | "pointing yourname.com at the new home" | DNS, A record, TTL, propagation |
| "the keys" | "passwords and connections the app uses" | secrets, env vars, OAuth configs |
| "your sign-in system" | "how your users log in — this moves with them" | auth provider, password hashes, JWT |
| "the practice copy" | "a full copy running on Tuesday's data, so we can check everything before touching the real one" | staging deploy, snapshot, smoke checks |

No step title, button, or progress line may use the right-hand column at plain level.
The technical register stays one tap away for the engineer reading over a shoulder —
same page, same three depths, exactly like the situation cards.

### Three classes of step — and the answer to "can the whole thing be in-app?"

**Class A — fully in-app (the large majority).** Everything driven by APIs and OAuth
popups that never leave our surface: destination provisioning (Supabase project via
Management API; Railway via OAuth/template deploy — signup happens *inside* the OAuth
popup for customers who have no account; Neon claimable needs no signup at all),
GitHub via borrow-and-return (§1), the entire parallel build, data import,
verification, cutover orchestration, and DNS **where Entri Connect covers the
customer's provider** (35+ providers, one sign-in inside our flow, records written
automatically).

**Class B — guided-remote: their screen, our copilot, our confirmation.** A handful of
actions only the customer can perform, on the source platform's screen. We cannot
click for them — but we can watch, and that changes everything about how these feel.
The pattern, every time:

1. The app shows exactly what to do, in plain words, with a picture of the screen
   they'll see and a deep link that opens it.
2. **The app detects completion server-side and confirms it** — the customer never has
   to judge whether it worked. "Press the button on that screen; I'll tell you the
   moment I can see it worked." Repo synced → we see the code arrive. Bolt Claim →
   the project appears in their Supabase org. Database copied → we count the rows and
   compare. DNS changed → we poll public resolvers and announce propagation live.

The full Class-B inventory, per source: **Replit** — one line pasted into Replit's
Shell tab (we show exactly where) that pipes the database straight from Replit to
their new database: `pg_dump "$DATABASE_URL" | psql "<their-new-connection>"` — the
data never touches Selvedge's servers, which is both the simplest and the most
private design; **Lovable** — clicking "GitHub sync" and (Cloud apps) "Export data" in
Lovable's UI; **Bolt** — the Claim button; **Base44** — copying one API key from their
dashboard into our app (after which the entire data pull runs from our side);
**DNS fallback** — for registrars Entri doesn't cover, typed-out record changes with
live verification.

**Class C — unavoidably theirs, and honestly named.** Two moments cannot and should
not be absorbed: creating accounts that will be *in their name* (a signup inside an
OAuth popup still asks for their email), and **entering a payment card at the hosting
company**. Do not hide the card moment — frame it as the point: *"This is the part
where the hosting starts being yours instead of theirs. It's about $5–20 a month, paid
straight to the hosting company — most of why your bill is about to drop."* The deed
moments are the product promise made tangible, not friction to apologize for.

### The in-app share, per source

| Source | In-app (Class A) | Their-screen steps (Class B) | Verdict |
|---|---|---|---|
| Lovable, own Supabase, already GitHub-synced | ~95% | possibly zero | **Effectively fully in-app** — the existence proof |
| Lovable Cloud | ~90% | sync click + export click | Near-total |
| Bolt | ~90% | one Claim click | Near-total |
| v0 | ~90% | env-pull or re-entry of "Sensitive" values | Near-total |
| Replit | ~85% | one pasted line + a few clicks | The paste is the floor — and it is one paste |
| Base44 | ~90% of *supported* steps | one API key copy | The rewrite itself is Phase 3 agent work |

So: **the entire migration cannot be literally 100% in-app for every source — but it
gets within one or two watched, confirmed, plain-language steps of it, and for the
best case it effectively is.** The bar that matters is not "zero steps elsewhere"; it
is that the customer never faces another platform's screen without our copilot
narrating exactly what to press and confirming the moment it worked, and never faces a
word they don't know at the level they chose.

One boundary held deliberately: Selvedge never asks for the customer's *login
credentials* to a source platform to drive its UI for them. API keys the platform
officially issues, yes; impersonating their session, never. The convenience isn't
worth teaching customers to hand their passwords to a service — least of all one whose
brand is trust.

---

## 5. SCALE DESIGN

- **Runbooks are data, not code** — same doctrine as the routing table. A runbook per
  source platform: steps, per-step verification, known breakage classes and their
  mechanical fixes, refusal conditions. New platform = new runbook + its test corpus,
  not new architecture.
- **The pipeline is toile's machinery** under Selvedge tenancy: sandbox import → fix →
  deploy → verify is the ship flow with a customer-owned destination. Migration is
  Phase 1–3's first big workload, not a separate engine.
- **Refuse loudly at the boundary.** Supported = named platforms × the standard stack.
  Everything else gets the waitlist and, where useful, the free Survey ("here's what
  your exit would take") — demand measurement that starts relationships. A refused
  migration costs nothing; a hand-done one costs the week. The Survey's verdict
  discipline applies to refusals too: say exactly why.
- **Empirical test queue before launch** (things the docs don't answer): (1) Replit
  *production* Helium dump path — the single biggest unknown; (2) Railway OAuth scope
  coverage for project-create/template-deploy (fallback: customer workspace token,
  verified to work); (3) whether Lovable Cloud's official export includes auth hashes
  (the OSS exporter claims to; verify both); (4) Base44 REST API completeness vs CSV.
  Each gets tested with a real throwaway app before a customer's real one.
- **Unit economics:** COGS per migration ≈ sandbox hours + agent time on breakage fixes
  — single-digit dollars for clean exits, tens for Replit-class. Priced as a job
  (hundreds, anchored against the £999+ human-rescue market and the platform bill it
  ends), converting to the care plan at ~50% of the old platform spend (§21). Railway
  kickbacks add a small perpetual margin on hosting we don't pay for.
- **Capacity:** sandbox concurrency is the only physical limit; everything else is
  queue depth. Stage 1–3 are fully parallel across customers; Stage 4 is scheduled.

---

## 6. WHAT THIS CHANGES IN THE BUILD PLAN

Phase 1's internal order becomes: **connect flows first** (GitHub App + guided repo
creation; Railway OAuth/token; Supabase OAuth app; fuel), then the **Survey** (read-only
source inspection + the Migration Brief — this is the protection brief pointed at a
platform instead of a repo), then Stage 2–3 automation for **Replit only**, then the
brief/watching of Phase 2 greeting the migrated app. Base44's rewrite engine waits for
Phase 3's agent machinery, as does fully-automated breakage fixing beyond the known
mechanical classes.

*The one-line pitch the research supports: "Leaving is safe now. We move your app to
infrastructure you own — your GitHub, your hosting, your database, your name on all of
it — prove it works before anything changes, and then take care of it for half what the
old platform charged."*
