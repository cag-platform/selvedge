# Selvedge — build status

Plain-English map of what exists, what's switched on, what's waiting on a key,
and what's still only a plan. Written for a non-coder. **917 tests across 120
files, all green.**

---

## What this is aiming to be

**A calm place to own software you didn't write by hand.**

Three promises, in order of how much of the product they are:

1. **The watching is the product.** One morning brief in plain English, honest
   about what it can't see. Never a dashboard, never a false all-clear. A
   confidently-wrong "everything's fine" is the one unforgivable output.
2. **The Workshop is the engine.** Say what you want in plain words; it gets
   built in a sandbox, previewed, and shipped deliberately — the safety gates
   bite at ship rather than while you're building.
3. **The Migration Center is the front door.** *Leaving* — Replit, Lovable,
   Bolt, v0, Base44 — and Selvedge is where you land. Their infrastructure ends
   up in **their own name**, with Selvedge holding the keys as caretaker. They
   can fire Selvedge and everything keeps running, which is exactly why they
   won't.

The competitive line: not replacing Cursor or Replit at writing code — making
**health, status, and honest recovery** the thing that matters, in language a
founder actually speaks.

---

## Switched on right now (tryselvedge.com)

| Area | What works |
|---|---|
| **Sign-in** | Clerk, email+password. A solo owner is a tenant of one — never asked to create an "organization". |
| **Projects** | Create from an existing repo, or **create a brand-new private GitHub repo** in one step. New things start as a sandbox and land straight in the Workshop. |
| **Today / brief** | Daily digest per org at local 7am, composed by the model when fuel is connected, mechanical when not. Repeats collapse ("…today (3 times)"). |
| **Watching** | Health checks with two-failure debounce, deploy-state polling (Railway/Vercel), error-rate spikes, and correlation of a break to the change just before it. Putting an app online now **arms its health check** — until that was wired, the probe half watched nothing (deploy polling was unaffected). |
| **Work** | Every ask becomes a card: proposal, estimate, cap, gate, approval. Sensitive diffs (payments/auth/user data) need a confirmed backup. Caps genuinely stop work. |
| **Workshop** | Persistent Daytona sandbox per project, Claude Code agent, live activity feed, live preview iframe, ship (commit+push), undo (real `git revert`), 12-minute post-ship watch with auto-revert on a confirmed break. Cost watch always visible. |
| **Attachments** | Screenshots inline (paste, pick, or drop); files/zips up to **300MB** streamed to disk and into the sandbox. Zips auto-extract. |
| **Sketch** | A cheap room to think an idea through before building. Structured replies make "ready" real data; one button hands the brief to the Workshop. Its own daily budget, so thinking can never starve the brief. |
| **Ledger / Record** | Every run's real cost in cents, verdicts, track record, learned baselines ("last time this cost about $6"). |
| **Connections** | BYO model key, host tokens, Supabase token. AES-256-GCM vault, bound to org *and* provider. |
| **Portability** | Export everything Selvedge knows as JSON. Being able to leave is what makes people stay. |

**Agent standing rules (new).** The building agent now knows who it's building
for on every turn: no terminal, doesn't read code, never hand over a command
checklist, do the setup work yourself, the platform serves :3000 and installs
dependencies itself, secrets come from env vars and get recorded in
`.env.example`. Delivered via `--append-system-prompt`, so the rules never land
in the customer's repo.

---

## Built, waiting on a key or a setup step

| Feature | Needs | Without it |
|---|---|---|
| **Preview proxy** (kills the Daytona interstitial) | `PREVIEW_DOMAIN` + wildcard DNS | Falls back to signed Daytona URLs, warning page included. |
| **New repos land in your org** | `GITHUB_ORG=cag-platform` | Repos are created under the token's own user account. |
| **Put it online** | Customer connects Railway; `NEON_API_KEY` for databases | The button says so plainly and explains why owning it is the good outcome. |
| **Login with Railway** | Railway OAuth app + `RAILWAY_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | **Module built and tested; connect route and button NOT written yet.** |
| **Push notifications** | APNs keys | Alerts still fold into the brief. |
| **GitHub App events** | App id / key / slug / webhook secret | Repos can be worked on, but pushes and deploys don't flow into the brief. |

---

## Built but NOT verified against live APIs

Written to published docs and unit-tested; no call made against the real service
from this environment:

- **Railway provisioning** — create service, set variables, mint domain, wait for
  deploy. Ported from Toile's working implementation, both schema-drift fallbacks
  included.
- **Railway OAuth** — token exchange and refresh.
- **Neon** — database creation.
- **GitHub OAuth** — borrow-and-return repo creation.
- **APNs** — push sending.

The first real go-live is the true test of the first three. Every failure path
names what did and did not happen rather than going quiet.

---

## Scoped and designed, zero code

### The Migration Center (`MIGRATION-CENTER.md`, 304 researched lines)

- **The decision:** customer-owned infrastructure, Selvedge-orchestrated. Railway's
  fair-use policy prohibits reselling compute; Vercel's terms prohibit third-party
  access. An umbrella is a contract violation *and* would only move the hostage.
- **Ease of use comes from consent design, not custody:** "Login with Railway"
  OAuth; the GitHub borrow-and-return trick (broad scope for seconds, one repo
  created, authorization self-revoked, receipted); Neon **claimable** projects —
  provisioned with no signup, claimed within 72h, *connection string unchanged*
  so a running app survives the handoff.
- **Five stages:** Survey (free, read-only) → Prepare → Parallel Build → Cutover
  (quiet hours, reversible, DNS repoint) → Decommission + handoff.
- **Launch order:** Replit first, then Lovable, then Bolt/v0; Base44 waitlisted
  (its exit needs the data layer rewritten).
- **Cursor is explicitly not a migration** — the code already lives in their repo.
  *"Already own your code? Skip to Connect."*
- **The vocabulary rule:** no infrastructure nouns at plain level — "your app's
  new home", "your app's memory", "the practice copy".
- **Biggest unknown:** Replit's Helium database isn't externally reachable and the
  export path is undocumented — flagged as empirical test #1.

### Also scoped, not built

- **The independent verdict.** Previously listed above as "built, waiting on a
  key" — it is not built. `src/server/verify/` never calls a model at all. The
  acceptance check is generated with `via: 'manual'` and short-circuits to
  `could_not_run`, so **no change can currently reach the `verified` verdict**;
  the honest ceiling today is `probably`. That is the machinery working as
  designed — it refuses to claim success it can't evidence — but the second
  model that would supply the evidence does not exist yet. `EVAL_MODEL` is
  reserved for it and, until it ships, changes nothing.
- **Model picker** (Claude / Codex / Kimi). The seam exists: `FUEL_PROVIDERS`
  already lists `anthropic | openai | gemini | kimi` with only Anthropic
  implemented, and Kimi speaks Anthropic's API format, so the same agent could run
  on it through a different endpoint.
- **"Check this against the real code"** in Sketch — the read-only plan capability
  is retained in `agent.ts` waiting for it.
- **Mobile app** — `cag-platform/Selvedge-mobile`, native SwiftUI, mirrors the old
  watcher only. None of Workshop / Sketch / go-live is ported.
- **True streaming** — no SSE anywhere; the Workshop fakes liveness by polling a
  log the sandbox writes. Adequate today.
- **GitHub App per-repo tokens**, to replace the single-PAT stopgap.

---

## Known debt and honest caveats

1. A stray card may sit "Approved" on the Work page from an earlier code path.
   Harmless; it ages out.
2. Auto-rollback posts twice to the thread (the revert and the observer each
   speak). Cosmetic.
3. In-process state: deploy-poller last-state and staged uploads live in memory —
   a documented single-process tradeoff. A redeploy mid-upload means re-attaching.
4. `agent_runs.cost_cents` and `llm_usage.cost_usd` are two separate ledgers
   (sandbox work vs model calls). Deliberate — don't add them together carelessly.
5. Sketch has no attachments: the LLM seam carries one text string, no images.
6. `connector_credentials.provider` is free text, with allow-lists in each route
   file rather than one registry.

---

## What it costs to run

- **Sandboxes** stop themselves after 15 idle minutes — walking away is free.
- **Agent turns** ~$0.05–0.30; **Sketch turns** ~$0.02, on separate budgets so
  thinking can never turn tomorrow's brief mechanical.
- **Hosting and databases** are the customer's own accounts and their own bill —
  zero hosting COGS by design, and Railway's template kickback (15–25% of ongoing
  usage) makes the freedom model revenue-positive rather than a cost centre.

---

## The next three things

1. **The Railway connect route + button**, so "Login with Railway" is reachable
   and go-live works end to end. Needs a Railway OAuth app registered with the
   redirect URI `https://tryselvedge.com/railway/callback`.
2. **Neon claimable projects** — provision with no signup, hand over, they claim.
3. **The Migration Center**, Replit first, all five stages.

Then the model picker.

---

## How to read the code

- The **honesty rules** live in pure, isolated files — `verdict.ts`, `risk.ts`,
  `observe.ts`, `machine.ts`, `ship.ts` — each tested on its own, and each
  load-bearing guard deliberately broken once to confirm a test catches it.
- The **live seams** are injected function arguments, so the logic around them is
  provable without the network.
- The **cards table is the ledger** — nothing about your history is stored twice.
- Every table carries `org_id`, and a test fails the build if a new one forgets.
