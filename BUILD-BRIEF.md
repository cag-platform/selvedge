# SELVEDGE — BUILD BRIEF

**31 July 2026.** One view of the whole build, after the merge review, the viability
review, and the founder decisions in §19–§25. This document assumes those debates are
closed. It describes what gets built, in what order, from what.

---

## 1. THE PRODUCT, SETTLED

**Selvedge is the natural resting place after the big AI builders** — where an app with
real users is understood, watched, changed, repaired, verified, and remembered, for a
flat price well under what the builders charge.

Five decisions that define it:

1. **Care is the surface; the builder is the engine.** One interface. Every ask returns
   the same card — what I'd do, what it costs, where I'll stop, approve — whether it's a
   $6 fix or a $200 feature. No builder mode, no second tab, no capability wall.
2. **No refusals.** "Too big for me" gets the app deleted. Big work gets staged budgets
   and more checkpoints, never a bounce.
3. **Tiers meter volume, never capability.** A paywall is a refusal wearing a price tag.
4. **Price the layer, not the tokens.** Model access is a connection the customer brings
   (BYO) or buys from us (managed). The product is everything around the model.
5. **Honesty is the mechanism, not the marketing.** Verdicts that can say "I don't know."
   A ledger that records our own misses. Caps that actually stop.

**Who it's for, in build order:** owners of live AI-built apps spending $200+/month on
platform fees, technical enough to hold an AI subscription (BYO), reachable at the moment
of bill-shock or breakage. Managed fuel opens the nontechnical market later; agencies are
market #2.

---

## 2. THE SYSTEM — ONE PRODUCT FROM THREE CODEBASES

| Source | Contributes | Status |
|---|---|---|
| **Selvedge** | The spine: multi-tenant orgs, GitHub App, context packs, routing table, narration + verdict discipline, the brief, trust ledger, memory, push, the design system | Base — everything merges *into* here |
| **Toile** | The engine: sandboxes, agent runner, plan mode, checkpoints, diffs, ship/deploy, health monitor, Railway/Neon provisioning, live build streaming | Ported under Selvedge's tenancy |
| **SILD** | One pattern only: the risk-tiered governance ladder (classify → shadow → graduate). **No code moves.** | Design reference |

**Seven layers, top to bottom:**

1. **Connect** — GitHub App (per-org installs), host (Railway → Vercel), database, and
   *fuel* (BYO Claude/GPT/Gemini/Kimi, or managed).
2. **Understand** — one context pack per app: what it is, who it serves, what breakage
   costs, stakes tier, topology, baselines. Human-owned and machine-owned sections stay
   separated.
3. **Observe** — webhooks (code, deploy) + probes (health, ported from Toile) + error
   ingest, normalized into one event envelope on one per-app timeline.
4. **Decide** — deterministic first: the routing table decides surface-vs-suppress; the
   risk classifier decides autonomy tier; the estimator quotes from ledger history. The
   model narrates decisions; it does not make them.
5. **Work** — sandbox → plan → author → test → deploy, with staged budget checkpoints.
   Toile's machinery under Selvedge's approval grammar.
6. **Verify & record** — five-value verdict, post-deploy observation, append-only
   intent→outcome ledger, calibration.
7. **Surface** — the rail, the brief, the cards, three registers (plain / plain+why /
   technical), one approval grammar.

---

## 3. BUILD ORDER

Sizes assume the founder working with agents, not a team. They are sequencing guidance,
not commitments. Each phase is independently useful — you could stop after any of them
and have something real.

### Phase 0 — Foundations (~2–3 weeks)
The unglamorous prerequisites. Nothing customer-visible.

- Make `main` the default branch. *(Five minutes. It currently isn't, and every new
  session starts on stale code.)*
- **Tenancy**: org scoping on every table Toile contributes; ownership checks on every
  route. Toile has no user model to extend — this is the single largest mechanical job in
  the build.
- Migration chain: fold Toile's surviving tables into Selvedge's versioned migrations.
- **Fix the three inert guards** before building on top of them: Toile's spend cap that
  displays a limit it no longer enforces, Selvedge's budget constant that flags without
  blocking, and SILD's evaluator pattern that passes everything. These are the reference
  implementations of what not to ship.
- Tests for everything ported. Toile arrives with none.

### Phase 1 — The connected app (~2 weeks)
*Definition of done: connect in under ten minutes, receive a brief worth showing someone.*

- GitHub App migration for Toile's write operations (repo create, PR open); design the
  credential handoff into sandboxes — App tokens expire hourly, sandboxes live longer.
- Host connector: Railway first (port Toile's provider), Vercel next.
- Database connector (read-only posture to start).
- **Fuel connector**: BYO subscription/API key, per-org, revocable.
- Context pack drafting from the repo; stakes confirmed by the owner, never authored cold.
- The protection brief, including honest unknowns.

### Phase 2 — The watched app (~2 weeks)
*Definition of done: the customer stops reading logs.*

- Port Toile's monitor (probes, poller, two-failure debounce, alerts) into Selvedge's
  event pipeline. **This is the highest-value single transfer in the merge** — Selvedge's
  runtime event types are already built and routed, with no source producing them.
- Railway deploy events replace the "workflow name contains 'deploy'" heuristic.
- Error ingest.
- Situation cards, the Today surface, the three registers, the rail.
- Change→break correlation: the timeline is already unified once the above lands.

### Phase 3 — The worked app (~4–6 weeks) — *the largest phase*
*Definition of done: one approval takes a change from ask to live.*

- Toile's sandbox lifecycle and agent runner under Selvedge tenancy. Keep Daytona
  platform-owned with per-org quotas — do not abstract it; that's weeks for no customer
  benefit.
- **The card grammar**, one path for both triggers: incident-initiated ("orders are
  failing, I can fix it") and owner-requested ("make the gift note optional"). Same
  propose → estimate → cap → approve → work → verify loop.
- **Risk tiering, wired at the decision point**: payments/auth/user-data → hard gate plus
  verified backup; ordinary logic → normal approval; copy/styling → near-frictionless.
- **Staged budget checkpoints** for large work: "40% in, $58 of $150, continue?"
- Plan mode surfaced as a plain-English proposal, not a numbered technical spec.

### Phase 4 — The verified app (~2 weeks)
*Definition of done: every change ends with a verdict you can trust, including "I can't tell."*

- The five-value verdict: verified / probably / inconclusive / didn't work / stopped.
- Generated smoke checks (most of these apps have no test suite).
- Regression checks: everything that worked before still works.
- Acceptance check derived from the request itself, for net-new work.
- Post-deploy observation window; rollback on failure.
- **Authoring model separated from evaluating model.**

### Phase 5 — The remembered app (~1–2 weeks)
*Definition of done: the second occurrence is measurably cheaper and faster than the first.*

- Append-only intent→outcome ledger: what was asked, what was done, what it cost, what
  happened, what was learned.
- Per-failure-class cost distributions — these power the estimates in Phase 3.
- The track-record page (the API exists today with no page).
- Memory surfaced in the brief: "I've seen this before."

**Total: roughly 13–17 weeks**, phased so value lands from week 4 onward.

---

## 4. DISCIPLINES THAT MUST NOT GO INERT

Every one of these has already failed once inside these three repositories. They are not
principles; they are regression tests.

| Discipline | The in-house failure it prevents |
|---|---|
| Every cap **blocks**, and a test fails if it stops blocking | Toile's spend cap: enforcement deleted, slider and "then stops" copy still shipped |
| Every gate **computes its input at the decision point** | SILD: risk flag never computed → readiness guard permanently true → three-stage ladder cosmetic |
| Every verdict can say **unknown** | Selvedge's own digest: "quiet and healthy" printed for apps with no health signal |
| **Authoring ≠ evaluating** | Once Selvedge builds most of the app, "who broke it" is almost always us |
| **Nothing ships backend-only** | Four finished, tested systems in Selvedge today have no user-facing surface |
| Silence is **not** consent | Phrasings graduate to permanent on "nobody complained"; the track record publishes accuracy it never measured |

---

## 5. WHAT NOT TO BUILD

- The code editor as a primary surface. *(Keep the terminal behind an advanced door.)*
- Chat as the home screen. Keep the chat machinery — it is the build experience — but the
  brief is the front door.
- A separate builder mode of any kind.
- Human escalation as a revenue line. Partner or refer; do not become an agency.
- More than one model provider until one works well. Build the seam; ship one.
- Agency, team-governance, and portfolio features. Market #2, not v1.
- The Context Compiler as general infrastructure. One stack's context pack is enough.
- Multi-repo and multi-environment support. Refuse loudly, in v1 only.

---

## 6. THE GATE

Sixty days from first paying customer.

| Measure | Pass |
|---|---|
| Paying accounts | ≥10 |
| Write-access permission granted | ≥50% of connects |
| Change/repair convergence under caps | ≥60–70% |
| Cost per successful task (BYO: infra only) | ≤$10 blended |
| Day-60 retention | ≥75% |
| **Tasks requested per app per month** | ≥3 (the number that proves the quiet months aren't quiet) |
| Interface | Approvals made without expanding to technical detail; a full cycle completed without the customer opening Cursor |

**Kill or narrow if:** permission grants <25% after a visible track record; convergence
<45%; quiet-month cancellations >40%; or CAC extrapolates above $500 with no channel
hypothesis left.

---

## 7. OPEN QUESTIONS

1. **Provider terms (pre-launch blocker).** May a multi-tenant service orchestrate a
   customer's AI *subscription* credential? Confirm directly with each provider. Fallback:
   customer-supplied API keys — legally clean, but the heavy-user arbitrage narrows.
2. **Managed-fuel economics.** BYO reaches ~$12M ARR at excellent margins but caps ARPU
   and excludes owners without an AI subscription. Whether managed fuel works at scale is
   the gating question for the venture-scale case — not a later pricing detail.
3. **Whose hosting account?** Platform-owned or customer-connected. This decides the
   Railway work in Phase 1 and the custody liability that comes with it.
4. **Migration friction.** Moving an app is the real acquisition cost. It must be
   productized in Phase 1 or it becomes manual services.
5. **The window.** Replit shipped monitoring plus agent investigation in April 2026;
   Lovable can ship monitoring whenever it chooses. Six to fifteen months before the
   platform-native versions close in. Phases 1–3 are the ones that must land inside it.

---

*Foundation closed. What remains is build, and the ten customers who will tell you whether
the quiet months are quiet.*

---

## ADDENDUM (31 Jul 2026) — The Migration Center

Founder decision: migration is a product surface, not an onboarding step. One
Migration Center, two exit doors, and the doors are a funnel rather than
alternatives:

1. **"Get my app into my own hands"** — export from the builder → a repo in the
   customer's own GitHub → deployed on the customer's own Railway → running
   independently of the platform that built it. Priced as a job. Ends with:
   "It's yours now. Want me to keep watching it?"
2. **"…and take care of it"** — everything in door one, plus connect, the
   protection brief, and the care plan. The full resting place.

Why door one is load-bearing even though door two is the business: it is the
trust-first version of the funnel. Selvedge's first act for a stranger is to
FREE their app onto infrastructure they own — the anti-lock-in posture
(IRONCLAD-1's export principle) made into an acquisition motion — and the
access grant happens *during* a migration the customer asked for, which
structurally defuses the permission cliff (the riskiest number in the 60-day
gate). The destination infrastructure is exactly what Selvedge connects to
natively, so door one's deliverable is door two's prerequisite.

Discipline (the services trapdoor lives here): the Center supports **named
source platforms with automated paths only**, starting with exactly one —
Lovable → GitHub → Railway, the cleanest export in the market — and refuses
everything else loudly, with a waitlist that doubles as demand measurement per
platform. A refused migration costs nothing; a hand-done one costs the week.

Build placement: the Center is Phase 1 work (it IS the connect flow, with the
export/deploy steps ahead of it) and its Railway half is the same provider
port already scheduled. Sequence inside Phase 1: fuel + GitHub + Railway
connectors first, then the migration path as the front door onto them.
