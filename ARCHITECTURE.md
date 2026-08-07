# Selvedge — Architecture

How the system is put together, and why it's put together that way. Written for
someone who needs to change it: where a thing lives, what it may talk to, and
which properties must survive the change.

Companion documents: **BUILD-BRIEF.md** (what gets built, in what order),
**STATUS.md** (what is switched on right now), **MIGRATION-CENTER.md** (the
front door, scoped not built), `docs/routing-table.md` (the routing contract).

---

## 1. What the system is

A multi-tenant TypeScript monolith: one Node process serving one React SPA,
backed by one Postgres database, calling out to a handful of third-party
services. Roughly **20k lines of source, 11.6k lines of test**.

It does four things, and the layering follows them exactly:

1. **Watches** software the owner didn't write by hand — webhooks, probes,
   error beacons — and turns what it sees into one plain-English morning brief.
2. **Changes** that software on request — a sandbox, a coding agent, an
   approval grammar, a cap that stops.
3. **Verifies** the change honestly — a five-value verdict that can say "I can't
   tell", and a post-deploy watch that rolls back a confirmed break.
4. **Remembers** — an append-only ledger of intent → outcome, learned baselines,
   and a full export so the owner can leave.

The governing constraint, which explains most of the design: **a confidently
wrong "everything's fine" is the one unforgivable output.** Deterministic code
decides; the model only narrates. Every guard that could be inert is tested by
deliberately breaking it once.

---

## 2. Stack and topology

| Piece | Choice |
|---|---|
| Runtime | Node ≥ 20, ESM, TypeScript 5.6 (strict) |
| Server | Express 4, `src/server/index.ts` → `web/app.ts` |
| Client | React 18 + React Router 6, Vite 5, Tailwind 3 |
| Database | Postgres via `postgres` + Drizzle ORM 0.36; migrations by drizzle-kit |
| Auth | Clerk (`@clerk/express` server, `@clerk/clerk-react` client) |
| Scheduling | `node-cron`, in-process |
| Sandboxes | Daytona SDK (one persistent sandbox per project) |
| Agent | Claude Code CLI, executed *inside* the sandbox |
| Models | Anthropic SDK, per-org key, through one narrow seam (`llm/types.ts`) |
| Tests | Vitest + PGlite (real Postgres semantics in-process), Supertest, Playwright |

**One process.** The web server, the cron jobs, and the pollers all live in the
same process. Three pieces of state are deliberately in-memory rather than in
the database — the health-check debounce, the deploy poller's last-known state,
and the staged-upload registry (§9). That is a documented single-process
tradeoff, not an oversight; scaling horizontally means moving those three
first.

```
                     ┌───────────────────────────────────────────┐
  GitHub webhooks ──▶│                                           │
  Error beacons   ──▶│   Express (src/server/web/app.ts)         │──▶ Postgres
  Browser (SPA)   ──▶│   · webhook + beacon routers (pre-auth)   │    (Drizzle,
                     │   · Clerk → ensureOrg → /api routers      │     events
  *.PREVIEW_DOMAIN──▶│   · preview proxy (pre-auth, host-scoped) │     partitioned)
                     │                                           │
                     │   node-cron: digest · health · deploy ·   │
                     │              sweeps                       │
                     └────────────┬──────────────────────────────┘
                                  │
        Anthropic · Daytona · GitHub · Railway · Vercel · Neon · Supabase · APNs
```

---

## 3. The seven layers

BUILD-BRIEF §2 names seven layers. They map onto directories one-for-one, and
the dependency direction is strictly downward — nothing in *Decide* imports
from *Surface*, nothing in *Understand* imports a connector.

| # | Layer | Lives in | Responsibility |
|---|---|---|---|
| 1 | **Connect** | `server/connectors/*` | Speak each third party's protocol; normalize into one event envelope. Hold credentials encrypted. |
| 2 | **Understand** | `server/packs`, `shared/types/pack.ts` | One *context pack* per project: what it is, who it serves, what breakage costs, stakes tier, topology, baselines. |
| 3 | **Observe** | `server/monitor`, `server/resolution` | Probes and ingest. Place an event on a project's timeline, refine its type, correlate a break to the change before it. |
| 4 | **Decide** | `server/routing`, `server/cards` | Deterministic, side-effect-free. Where does this event go (routing table); how risky is this change (risk tiering); may this card advance (state machine). |
| 5 | **Work** | `server/build`, `server/runner` | Sandbox → agent turn → ship. Staged budget checkpoints, caps that stop. |
| 6 | **Verify & record** | `server/verify`, `server/ledger`, `server/trust`, `server/memory` | Five-value verdict, post-deploy observation window, append-only ledger, calibration, learned baselines. |
| 7 | **Surface** | `server/narration`, `server/digest`, `server/web/routes`, `src/client` | Turn decisions into sentences; the brief, the cards, the rail. |

The load-bearing rule across layers 3–4: **the model narrates decisions, it does
not make them.** Routing, risk, gating, verdicts and caps are all pure
TypeScript with no network in reach.

---

## 4. Path A — an event becomes a sentence

The watching pipeline. Entry points: the GitHub webhook router, the error beacon
router, the health poller, the deploy poller. All four converge on one function.

```
source ──▶ normalize ──▶ ingestEvent ──▶ route ──▶ narrate ──▶ deliver
           (connector)   (resolution)   (routing)  (narration)  (push | digest | nothing)
```

`server/resolution/ingest.ts` is the spine. In order, it:

1. **Inserts the event** into the partitioned `events` table, keyed
   `(org_id, dedupe_key, occurred_at)` — a webhook retry redelivers the
   identical payload, so this is the idempotency boundary. A duplicate returns
   early.
2. **Resolves the project** (`resolveProject.ts`) from the pack's
   `topology.sources`, then **refines the event type** (`refineEventType.ts`)
   using pack context a connector can't see on its own.
3. **Correlates** — for a break event, lines it up against the change that
   shipped just before it on the same timeline (`correlate.ts`). No change in
   the window means no culprit is invented.
4. **Routes** (`routing/route.ts`) — pure. Finds the row for the event type in
   `config/routing-table.json` (**35 rows**, groups A–G), reads the decision for
   the project's stakes tier, then applies five global modifiers: known-flaky
   downgrade, dormancy inversion, storm collapse, quiet hours, and the per-project
   push-threshold cap. Returns `{ path, delivery, modifiers }` and always reports
   the doc's `intended_path` alongside the collapsed one.
5. **Narrates** (`narration/dispatch.ts`) — honors the routed path:
   `TEMPLATE` → the slot-filling registry, no model call. `LIB` → the graduated
   library first, falling back to `LLM` on a miss. `LLM` / `LLM+VERDICT` → a
   model call using the org's own fuel, budget-checked and metered.
6. **Delivers** — `PUSH` sends to the org's devices (and still folds into
   tomorrow's brief); `DIGEST` folds in only; `NONE` is memory.
7. **Trips the tripwire** (`trust/tripwire.ts`) — if a hard negative lands within
   24h of a "users are fine" narration on the same project, Selvedge records
   a *false all-clear* against itself in `trust_incidents`.

The routing table is **configuration, not code** — `config/routing-table.json` is
the single source of truth for which rows exist; `docs/routing-table.md` is its
prose form; `shared/types/event.ts` carries the connector-facing event-type
union — **23 members** across groups A (code), B (build/deploy), C (runtime/data)
and E (connector self-monitoring). Group D (app-store events) has rows but no
connector yet; groups F (cross-project riders) and G (standing narration) carry
`event_type: null` because nothing triggers them — they are conditions the
digest composer evaluates, not events.

### The morning brief

`server/digest` composes one digest per org per local day. `jobs/cron.ts` fires
every 15 minutes and composes for any org whose local time is in the 7:00 hour —
`composeDigestForOrg` is idempotent per `(org, local day)`, so over-firing is
safe.

The skeleton is deterministic and stays that way: gather → order → collapse
repeats → sections → render. With fuel present, the selected fragments go through
a Stage-2 composition call and a validator; **any failure falls back to the
mechanical rendering.** The brief always sends. That is why `voice` is recorded
on every digest as `mechanical | composed | fallback`.

---

## 5. Path B — an ask becomes a shipped change

Two entry points, one grammar.

**The card loop** (`server/cards`) is what an *incident* or a *request* becomes:
propose → estimate → cap → approve → work → verify. `machine.ts` is a pure state
machine and the only thing allowed to move a card between states. It exists to
guarantee two properties:

- **The cap actually stops.** Spending that reaches the cap transitions the card
  to `stopped`. Large work pauses at staged checkpoint fractions ("40% in,
  continue?") rather than running to the cap blind.
- **A hard gate cannot be walked through.** A card classified `sensitive`
  (payments / auth / user data) cannot be approved without a verified backup, and
  no card reaches `working` without an approval.

Risk (`risk.ts`) is a fact about what the change *touches*, decided before any
work — not a guess about how it will go. States `declined`, `stopped`, `done`,
`failed` are terminal and reject every action.

When a card becomes runnable and the build engine is configured, `cards/drive.ts`
composes the back half: run, and *only if the run finished the work*, verify.

**The Workshop** (`server/build`, `web/routes/workshop.ts`) is the same engine
with a conversational surface:

- `sandbox.ts` — one persistent Daytona sandbox per project, created with native
  idle auto-stop at **15 minutes**. A stopped sandbox bills only storage; the
  next use resumes it. Never one sandbox per change.
- `agent.ts` — one turn: the Claude Code CLI runs backgrounded inside the
  sandbox writing stream-json to a log; this loop polls the log, parses tool
  activity, and updates a live `activity` row in place, so the owner watches
  real work rather than a spinner. `--resume` carries the conversation across
  turns; a stale resume is retried once fresh. Every turn's real cost is
  recorded in cents.
- Attachments — screenshots ride inline as base64 (≤6MB, ≤4 per message); docs,
  code and zips are streamed to local disk by multer, referenced by id, then
  streamed disk → sandbox, so a several-hundred-MB export never sits whole in
  memory or in a JSON body.
- `preview.ts` + `web/previewProxy.ts` — the live preview iframe (§8).
- `ship.ts` — **the one moment the workshop touches the real world, and therefore
  the one moment safety bites.** It classifies risk from *which files actually
  changed*, not from the conversation: an innocent-sounding ask that ended up
  editing checkout code is still gated. Then commit, push to the project's
  branch, record the commit, and arm undo as a real `git revert` of exactly that
  commit.
- `golive.ts` — "put it online": create the database if needed, create the host
  service from the repo, set variables, mint a web address, wait for the first
  build to land. Idempotent by construction — a project that already has a host
  source reuses it, so a retry after a timeout converges instead of multiplying
  infrastructure. It writes into the pack's `topology.sources`, which is
  precisely why the deploy poller and health monitor start watching the new app
  with no extra wiring.

**Sketch** (`server/sketch`) is the cheap room next door: think an idea through
with no sandbox anywhere near it, on its own daily budget so thinking can never
starve tomorrow's brief. Its replies are structured, so "the idea is ready" is
data rather than prose someone has to parse, and one button hands the brief to
the Workshop.

---

## 6. Verification and the honesty machinery

`verify/verdict.ts` reasons over three checks — *smoke* (does it still run),
*regression* (does what worked before still work), *acceptance* (did it do what
was asked) — each of which passed, failed, or **could not run**. `could_not_run`
is first-class and is never read as a pass: absence of evidence is not evidence
of success. The five values are `verified | probably | inconclusive |
didnt_work | stopped`, and `stopped` comes only from the card machine, never
from verification.

**`verified` is currently unreachable, by construction.** `verify/checks.ts`
generates the acceptance check with `how: { via: 'manual' }`, `runCheckSpec`
short-circuits manual checks to `could_not_run`, and `computeVerdict` returns
`verified` only when acceptance *passes*. So today's ceiling is `probably`.
Nothing in `server/verify/` imports an LLM module at all — the second model that
would supply the acceptance evidence does not exist yet. This is the honesty
machinery behaving correctly (it will not claim success it cannot evidence)
rather than a bug, but it is worth knowing before reading the verdict code and
assuming a grader is wired somewhere.

`verify/observe.ts` is the post-deploy window: probe the live app on a cadence
for the duration of the watch, and roll back on a **confirmed** break. It reuses
the monitor's two-failure debounce exactly — one failed probe never rolls
anything back. The mirror image of the false-calm rule: as reluctant to cry "it
broke" as to cry "it's fine". Probe, rollback, clock and sleep are all injected,
so the window is fully testable without a network or real time.

`trust/` records Selvedge's own misses; `ledger/` is the read-side view of the
cards table (**the cards table *is* the ledger** — nothing is stored twice), and
`ledger/costs.ts` closes the flywheel: the estimate for a new change is learned
from the real cost of the ones before it.

---

## 7. Data model

Postgres, 23 tables, Drizzle schema in `server/db/schema/`, 18 forward-only
migrations in `server/db/migrations/`.

| Group | Tables |
|---|---|
| Tenancy | `orgs` |
| Timeline | `events` (partitioned), `narrations`, `digests`, `narration_library`, `narration_library_uses` |
| Understanding | `packs` |
| Work | `cards`, `project_build`, `agent_messages`, `agent_message_attachments`, `agent_runs`, `sketches`, `sketch_messages` |
| Connections | `connector_credentials`, `connector_health`, `health_checks`, `project_beacons`, `error_rate_state` |
| Accounting & trust | `llm_usage`, `trust_incidents`, `feedback`, `devices` |

Three properties worth knowing before you add a table:

**Every table carries `org_id`, and a test fails the build if a new one forgets.**
Tenancy is not a convention here, it is enforced by the suite.

**`events` is physically partitioned by month on `occurred_at`.** drizzle-kit
cannot express `PARTITION BY` declaratively, so that migration is hand-augmented
and **must not be regenerated**. Postgres requires the partition key in every
unique constraint, which is why both the primary key and the dedupe index carry
`occurred_at`. A daily cron ensures this month's and next month's partitions
exist so writes never fall through to `events_default`.

**Two cost ledgers, deliberately separate.** `agent_runs.cost_cents` is sandbox
and agent work; `llm_usage.cost_usd` is model calls for narration, composition,
ask and sketch. They measure different things — don't add them together
carelessly.

`events.raw` is stored and **never read by any layer downstream of the connector
that wrote it.**

---

## 8. Connectors, credentials and the preview proxy

`connectors/*` is the only place that knows a third party exists. Each one
normalizes into `NewSelvedgeEvent`; everything above the layer sees one envelope.

- **github** — App install (webhooks, repo reads), OAuth borrow-and-return for
  repo creation, HMAC verification on the raw request bytes, backfill,
  normalizer.
- **host** — deploy state polling, shared by Railway and Vercel.
- **railway** — GraphQL client, OAuth, provisioning (service, variables, domain,
  wait-for-deploy).
- **neon / supabase / vercel** — database and host clients.
- **errors** — the beacon receiver; the beacon token *is* the auth, so it mounts
  before Clerk alongside the GitHub webhook.

**The credential vault** (`connectors/credentials/crypto.ts`) is AES-256-GCM with
three deliberate properties, each fixing a known defect inherited from Toile:

1. **A dedicated key root** — `CREDENTIALS_KEY` and nothing else. Rotating Clerk,
   sessions or webhook secrets never touches stored credentials.
2. **Per-org key derivation** — the org id is part of the scrypt salt, so a bug
   that serves the wrong org's row returns ciphertext the caller *cannot*
   decrypt. Tenancy enforced by cryptography, not only by `WHERE` clauses.
3. **Ciphertext bound to its home** — org id and provider ride along as AES-GCM
   additional authenticated data, so a row copied between orgs or relabelled
   between providers fails authentication outright.

It **fails closed**: a missing or short key throws, with no fallback to any other
secret, because a fallback would quietly reintroduce defect #1.

**The preview proxy** (`web/previewProxy.ts`) exists because Daytona shows a
warning interstitial on cross-origin browser requests, skippable only with a
request header an iframe cannot set. So previews are served from
`https://<slug>.<PREVIEW_DOMAIN>/`: the proxy resolves the slug to the project's
**stored, allowlisted** Daytona origin — SSRF-safe, it never forwards anywhere
else — and injects the header on every upstream request, HTTP and Vite HMR
websocket alike. Mounted before auth and before body parsing, host-scoped, and
completely inert when `PREVIEW_DOMAIN` is unset.

---

## 9. Configuration and graceful degradation

`server/config/env.ts` is the credential contract in one place: every secret the
server consumes, enumerated, grouped by the feature it powers, each with a plain
sentence about what turning it on gives you. Nothing there holds a value — only
the *shape* of what's needed. `describeConfig()` reports booleans, never secrets.

Exactly one class of failure is fatal: **boot-critical** (`DATABASE_URL`). The
process refuses to start with a clear message rather than failing obscurely on
the first request. Everything else degrades, and the degradation is the point:

| Missing | Behavior |
|---|---|
| `CLERK_*` | `/healthz` green, webhooks still accepted, `/api` returns a clear 503. A fresh service must be able to boot before its keys exist. |
| `CREDENTIALS_KEY` | App boots and watches; only storing or reading a credential fails. Deliberately *not* boot-fatal, so setting it later on a live deploy never means a crash loop. |
| Org fuel (and `ANTHROPIC_API_KEY`) | The deterministic path: template narration, mechanical brief. |
| `DAYTONA_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `GITHUB_TOKEN` | No build engine. An approved card simply waits — no inert half-run, no surprise spend. |
| `PREVIEW_DOMAIN` | Proxy inert; previews fall back to signed Daytona URLs. |
| APNs keys | Push-routed narrations are stored and fold into the brief; nothing is sent. |
| `EVAL_MODEL` | Nothing — reserved for a grader that doesn't exist yet (see §12). Setting it does not produce an independent check. |

**The daily model-spend cap** (`llm/budget.ts`) is per-org and enforced. Over the
cap does not error and does not silence the product — it drops the org to the
deterministic path for the rest of the day, which is the *same* degradation the
product already performs when a model is unreachable, so the failure mode is
exercised by every other path's tests. Sketch has its own separate budget.

Fuel resolution (`llm/factory.ts`) is per-org **at the moment of use** — BYO key
→ managed platform key → off — never once at startup. "Voice on" is a per-org
fact, not a global env check.

### Cron jobs (`jobs/cron.ts`)

| Cadence | Job |
|---|---|
| `*/15 * * * *` | Digest schedule (7:00-hour orgs); staged-upload sweep (30-min idle) |
| `* * * * *` | Health poll; Railway/Vercel deploy-state poll |
| `0 3 * * *` | Stall sweep; ensure event partitions; revalidate learned baselines |

---

## 10. The client

A single Vite-built SPA in `src/client`, served by the same Express process as
static files with an SPA catch-all. Clerk guards the whole tree; pages are
`Today`, `Work`, `TrackRecord`, `Workshop`, `Sketch`, `Connections`, `Projects`,
`Tray`, `PackEditor`, `Admin`, `Styleguide`.

There is **no streaming anywhere** — no SSE, no websockets except the preview's
HMR passthrough. The Workshop's liveness is polling against a log the sandbox
writes. That is adequate today and is a known, deliberate simplification.

Two client conventions worth preserving: the Workshop is the only wide layout
(two panes: conversation + preview) while every other page keeps the calm
single-column measure; and first sign-in from any browser teaches the org its
timezone so the brief lands at the owner's real 7am without a settings visit —
auto-detect never overrides an explicit choice, and the server enforces that too.

---

## 11. How this codebase is meant to be tested

**957 tests across 123 files**, all green, under `test/` — mirroring
`src/server`'s directories, plus `test/integration`, `test/client` and
`test/evals`. A full run takes about three minutes.

- **The honesty rules live in pure, isolated files** — `verdict.ts`, `risk.ts`,
  `observe.ts`, `machine.ts`, `ship.ts` — each tested on its own, and each
  load-bearing guard deliberately broken once to confirm a test catches it. If
  you add a guard, break it once.
- **The live seams are injected function arguments** — the probe, the rollback,
  the clock, the sleep, the sandbox exec, the check runner, the LLM client. The
  logic around every external service is provable without a network. `llm/fake.ts`
  and `push/fake.ts` are the in-repo stand-ins.
- **The database is real in tests** — PGlite gives genuine Postgres semantics
  in-process, so migrations, partitions and constraints are exercised rather
  than mocked.
- **Tenancy is a test, not a convention** — a suite fails the build when a new
  table lacks `org_id`.

`npm test` runs Vitest with coverage; `npm run typecheck` type-checks server and
client projects separately.

---

## 12. Deliberate constraints and known debt

Design tradeoffs that are chosen, and should be changed only on purpose:

1. **Single process.** Deploy-poller last-state, health-check debounce state and
   the staged-upload registry are in memory. A redeploy mid-upload means
   re-attaching. Horizontal scaling starts by moving these three.
2. **No streaming.** Polling a sandbox-written log fakes liveness in the
   Workshop.
3. **One GitHub PAT** for the build engine, a stopgap until per-repo GitHub App
   tokens replace it.
4. **`connector_credentials.provider` is free text**, with allow-lists in each
   route file rather than one registry.
5. **Sketch has no attachments** — the LLM seam carries one text string, no
   images.
6. **Auto-rollback posts twice** to the thread (the revert and the observer each
   speak). Cosmetic.
7. **Two cost ledgers** (§7) that must not be naively summed.

Built but **not yet verified against live APIs** (written to published docs,
unit-tested, no real call made from this environment): Railway provisioning,
Railway OAuth, Neon database creation, GitHub OAuth borrow-and-return, and APNs
sending. Every failure path there names what did and did not happen rather than
going quiet. See STATUS.md for the live picture.

---

## 13. Where the seams already are

Places designed to be extended, so the extension is a swap rather than a rewrite:

- **Model provider** — `llm/types.ts` is a narrow, single-string,
  structured-output-only seam. `FUEL_PROVIDERS` already lists
  `anthropic | openai | gemini | kimi` with only Anthropic implemented; Kimi
  speaks Anthropic's API format, so the same agent can run on it through a
  different endpoint.
- **Narration path** — `narrate(event, pack, decision)` is the contract. The
  routing decision's `intended_path` is reported even when collapsed, so a new
  narration implementation slots in behind routing untouched.
- **Host provider** — `connectors/host/*` is provider-shaped; Railway and Vercel
  already share the deploy poller.
- **Build engine** — `runner/daytona/factory.ts` is the single place live
  credentials are read; everything below it is injected, so an alternative
  sandbox provider is one factory.
- **Read-only planning** — the plan capability is retained in `build/agent.ts`,
  waiting for Sketch's "check this against the real code".

---

## 14. Reading order for a newcomer

1. `shared/types/event.ts` — the most important contract in the codebase.
2. `shared/types/pack.ts` + `docs/context-pack.schema.json` — what Selvedge knows
   about an app, and which sections humans versus machines own.
3. `config/routing-table.json` + `docs/routing-table.md` — the surface-vs-suppress
   decision, as data.
4. `server/resolution/ingest.ts` — the watching pipeline end to end.
5. `server/cards/machine.ts` + `server/cards/risk.ts` — the governance that must
   never be wrong.
6. `server/verify/verdict.ts` — the honesty heart.
7. `server/build/ship.ts` — where safety bites.
8. `server/web/app.ts` — how it is all mounted, and in what order, and why.
