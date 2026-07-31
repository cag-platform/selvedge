# MERGE REVIEW

**Written 31 July 2026. Read-only review — no code was changed.**

What was reviewed, and exactly which version of each:

- **selvedge** — the `main` branch (latest commit: the mute/unmute work). Important: this is
  NOT the branch the repository opens by default. See section 6c — this matters more than
  you may think.
- **toile** — the `main` branch (latest commit: "Remove daily/monthly spend-cap enforcement
  from builds").
- **sild** — the `main` branch (latest commit from 29 July).

Everything below comes from reading the actual code, not the READMEs. Where the
documentation and the code disagree, I say so.

---

## 1. WHAT EACH ONE DOES

### Selvedge — the watcher

**What it does today.** Selvedge connects to GitHub (the site where your code lives)
through an official "GitHub App" — the multi-user, permission-scoped way to connect,
where each customer installs it on their own account. When anything happens in a
connected repository — code pushed, a build passing or failing, a deploy — GitHub sends
Selvedge a message. Selvedge turns that raw message into a plain-English sentence, decides
whether it deserves a push notification, a line in tomorrow's brief, or silence, and once
a day composes a single morning brief per customer. The AI writes the prose; if the AI
fails for any reason, a plain mechanical version sends instead. The brief always sends.

It is genuinely multi-user: every table in the database is keyed by organization, login is
handled by Clerk (a login service), and there is a test that specifically proves one
customer cannot see another's data.

**Finished and solid:**
- The whole pipeline from GitHub message → sentence → morning brief. Tested end to end.
- The "context pack" — a structured description of each app (who uses it, what breaks
  cost, how to talk about it). The system enforces which parts a human may edit and which
  parts only the machine may write. This is the best data model in any of the three repos.
- The routing rules live in a data file (`config/routing-table.json` — the table saying
  "this kind of event, for an app of this importance, goes to push / digest / silence"),
  so rules change without redeploying code. That file's logic has 100% test coverage —
  every line is exercised.
- The honesty vocabulary: every AI sentence must carry a verdict — "users are affected,"
  "users are fine," or "can't tell yet" — and a "can't tell" must say what's being
  checked. The automated quality checks refuse to merge changes that break this.
- Memory: it learns per-app patterns, shows the user what it has learned, flags stale
  knowledge, and can export/import everything.
- Trust ledger: if Selvedge says "users are fine" and a hard failure arrives within 24
  hours, it records the mistake and corrects itself on screen the next day.
- Deleting or muting a project now survives a GitHub re-sync (this was a real bug, fixed
  in the newest commits, with tests).
- ~238 automated tests, real database migrations, and the events table is partitioned by
  month so it stays fast at scale.

**Half-built (honestly):**
- **Push notifications.** The Apple push-notification sender
  (`src/server/push/apns.ts` — the file that talks to Apple's servers) is written,
  tested against a fake, and says in its own comments that it has **never been run
  against Apple's real servers or a real phone**. Also, one path (the nightly "stalled
  work" sweep) can never push at all because the push machinery isn't handed to it.
- **The trust page.** The back end publishes Selvedge's own accuracy record
  ("I was certain 84% of the time…") but **no page in the app shows it**. It's an
  answer with no door to knock on. Same for the per-project memory view, the import
  button, and the "Ask a question about my stack" feature — the server side exists and
  is tested; the screens don't.
- **Four endpoints built for a native (phone) app that doesn't exist in this repo.**
- The "first day" version of the brief (for brand-new users) is specified, has a
  reference example, and is not implemented — the quality harness prints SKIPPED for it.

**Stubbed or dead:**
- Selvedge **never actually checks whether your app is up.** It infers health from GitHub
  build results. The event types for real runtime problems ("health check failing,"
  "error spike") exist, have routing rules, and are rendered nicely — but **no code ever
  produces them**. The routing file itself admits this in a comment. Selvedge today is a
  narrator waiting for a witness.
- Connector slots for Railway, Vercel, Supabase, the App Store, etc. are reserved in the
  type definitions but not built.
- The package is still internally named "silta" (the pre-rename name). Cosmetic.

### Toile — the builder

**What it does today.** You type what you want in a chat box. Toile spins up a sandbox —
a disposable cloud computer, rented from a company called Daytona — installs the Claude
Code agent inside it, and the agent writes the app there. You watch a live preview. One
button ("Ship") creates a private GitHub repository, pushes the code, and puts the app
live on Railway (a hosting company). It also watches a fleet of your existing apps with
real health checks and sends alerts by email, chat webhook, and browser push.

It is deliberately single-user: one shared passphrase, no accounts, and the code's own
comments say so ("Single-user app: exactly one row").

**Finished and solid:**
- Sandboxes. Creation, resume, self-healing when Daytona deletes one, secrets injected
  safely, idle shutdown. This is the core and it is mature.
- Checkpoints. Every agent turn is saved as a snapshot (using git, the standard
  version-history tool, inside the sandbox) — including failed and cancelled turns,
  deliberately. One click restores any snapshot.
- Diffs. Each run can show exactly what changed, derived from the snapshots.
- Ship and Deploy. Both are built to survive being interrupted halfway and re-run.
- Fleet health monitoring (`server/monitor/` — the folder that probes your apps on a
  timer). Real checks: fetch a page, open a network connection, look for a keyword.
  Two consecutive failures before an alert, so one blip doesn't page you. Recovery
  notices. **This is the strongest thing Toile has and Selvedge lacks.**
- The live build stream. If your connection drops mid-build, it reconnects and replays
  exactly the events you missed. Well engineered.
- Cost *tracking* (not capping — see below): every run's cost is recorded and charted.

**Half-built:**
- **Plan mode.** It exists, but it is only a sentence wrapped around your prompt
  ("do not touch files, produce a plan, stop"). There is no stored plan, no approve /
  reject / edit step. The plan is just chat text you read before typing "go ahead."
- **The "test-and-fix loop."** The name oversells it. After a build, Toile checks one
  thing: does the app's front page answer with a plain "OK"? If not, it tells the agent
  to fix it, up to 3 times. It **never runs any actual tests** — no test suite exists in
  the generated flow. And it only runs for brand-new web projects — never for imported
  projects, iPhone apps, or plan turns. If all 3 attempts fail, the run is still marked
  "succeeded," just tagged "unverified."
- **Post-deploy verification.** Ship waits for Railway to confirm the deploy succeeded
  (done well), and the fleet monitor can honestly say "unknown." But the build-time
  check has no "unknown": "we couldn't check" and "it is broken" land in the same
  "unverified" bucket.

**Stubbed, dead, or worse:**
- **Rollback does not exist.** More on this in section 3, because you listed it as a
  keeper.
- **The spend cap is a ghost.** The most recent commit on main deliberately deleted the
  only code that stopped builds when the daily budget was hit. The slider, the "Budget
  limit / Remaining" numbers, the red warning at 80%, the settings validation
  ("Daily budget must be at least $5"), and the line in the interface that literally
  says "then stops" — all still there. The README still describes the blocking behavior
  in detail. **The product now displays a limit it does not enforce.** (The removal had
  a real reason — the cost figure being capped was an estimate, not real billing — but
  the interface and docs were never updated.)
- The Render and Fly hosting adapters throw an error on every function. Intentional
  placeholders, but dead code.
- **There are zero automated tests in the entire repository.** None. The continuous
  integration check is "does it compile."
- There are no database migration files — the schema is pushed directly. Fine for one
  person; dangerous with customers.
- One more thing worth knowing: the coding agent inside the sandbox runs with **all of
  its permission checks switched off** (a flag literally named
  "dangerously-skip-permissions"). In a one-person sandbox that's a defensible
  trade-off. In the merged product it becomes exactly the problem section 5 is about.

### SILD — the translation app (the one part you care about, plus context)

SILD itself is the most finished of the three: a live chat platform for manufacturing
teams that translates between 18 languages, with video calls, document translation,
69 database tables, 31 test suites, and real operational discipline (append-only audit
logs, privacy-conscious logging, rate limiting that works across servers).

The part you care about is the **learning governance system**, and its state is the most
important single finding in this review:

- **The scaffolding is live and good.** New facts (glossary terms mined from chat,
  "knowledge pack" facts extracted nightly) always land in a pending queue. A human
  approves or rejects. Rejections are remembered forever so the same fact never comes
  back. Nothing auto-promotes, no matter how often it's seen.
- **The safety brain is written but not plugged in.** The risk classifier — the code that
  decides "this fact touches money/measurements/deadlines, treat it as dangerous" — sits
  at the top level of the repository, imported by nothing, with its tests never run by
  the test command. The live gate that consults risk therefore always sees "no risk."
  Full detail in sections 5 and 6a.

---

## 2. WHERE THEY OVERLAP

Both selvedge and toile do these jobs. For each: which version is better, and why.

**a) Describing a project.**
- Toile: one wide database row per project — status, which sandbox, which Railway
  service, cost this month. An operational record of a build pipeline.
- Selvedge: the "context pack" — a structured, schema-checked description of what the app
  *is*: who uses it, what downtime means in the owner's words, how technical the owner
  wants explanations, which parts a human may edit vs the machine.
- **Selvedge wins, clearly.** Every good downstream behavior (routing, tone, verdicts)
  feeds off the pack. But take three small things from toile: the columns that record
  hosting details (Railway service, sandbox id — as a separate table), the "businesses"
  grouping (selvedge can't group projects), and the star/pin flag.

**b) Watching app health. The one overlap where toile is better — and they're really
complements, not duplicates.**
- Toile actually knocks on the door: it fetches your app's pages on a timer, checks
  network ports, looks for keywords, waits for two consecutive failures, then alerts.
- Selvedge never knocks. It infers "healthy" from "the last GitHub build passed" —
  and its own routing file admits the real runtime signals have no source.
- **Port toile's monitor wholesale.** It is the witness selvedge's narrator is waiting
  for. Keep selvedge's *presentation* on top — its rule of never guessing calm ("no
  health signal yet" instead of a green light) is better product thinking than toile's
  raw up/down dot.

**c) Notes and memory about apps.**
- Toile: one flat list of notes the coding agent writes for itself. Searchable by
  substring. No screen shows it. Deliberately shared across all projects — which in a
  multi-user product would mean customers sharing a brain. Not portable, never goes
  stale, never reviewed.
- Selvedge: learned per-app patterns with staleness flags, a screen showing "watched
  your 9 apps for 38 days, learned 120 things," nightly re-checking, full export.
- **Selvedge wins, clearly.** Keep one idea from toile: the machine-friendly endpoint
  pattern it uses to let the agent read/write notes (a token-secured side door for
  robots) — selvedge will want that shape for its own agents.

**d) Talking to GitHub.**
- Toile: one personal access token (a single all-powerful password belonging to you)
  with the organization name "cag-platform" hardcoded in two places, plus a hardcoded
  fallback list of your repos. Cannot serve a second user, ever.
- Selvedge: a proper GitHub App with per-customer installations, signature-verified
  incoming messages, and scoped tokens.
- **Selvedge wins, no contest.** But toile can do two things selvedge can't: *create*
  a repository and *open* a pull request. Port those two functions onto selvedge's
  token system.

**e) Knowing about deploys.**
- Selvedge guesses: if a GitHub build's name contains the word "deploy," it treats it as
  a deploy. The code is honest that this is a heuristic.
- Toile *is* the deployer — it talks to Railway directly and knows the real state.
- **Toile wins here.** Fold toile's Railway connection in as selvedge's first real
  hosting connector — the slot for it already exists in selvedge's types, empty.

**f) Using AI.**
- These don't compete; they do different jobs. Selvedge calls the AI *service* to write
  prose, with a metering row on every single call, prices that round up when unknown,
  and a fallback to templates on any failure. Toile drives the Claude Code *agent* — a
  whole coding assistant living in the sandbox.
- **Keep both.** Selvedge's layer for narration, toile's runner for building. Merge the
  cost reporting into selvedge's metering so there is one spend ledger.

**g) Database and auth.**
- Selvedge: real migrations, monthly partitioning, every table org-scoped, tests run
  against a real in-memory Postgres.
- Toile: no migration files, no users table, no tenant column on any of 14 tables, one
  shared passphrase whose session literally says "owner."
- **Selvedge wins both. No contest.**

**h) Notifications.**
- Selvedge has the brains (a full routing table deciding push vs digest vs silence,
  quiet hours, per-app thresholds) but only one channel — Apple push — which has never
  been tested against a real device.
- Toile has no brains (alert on every incident) but three working channels: email,
  chat webhook, browser push — all running in production today.
- **Combine: selvedge's routing, toile's channels.**

---

## 3. WHAT MOVES OVER

Your keep-list, checked against reality:

| You said keep | Verdict |
|---|---|
| Sandboxes | **Yes.** Finished, mature, the crown jewel. |
| Plan mode | **Yes, but know what it is** — a sentence wrapped around the prompt, not a real propose-approve step. Keep it as the seed; section 5's design is what it should grow into. |
| Diffs | **Yes.** Simple and working. One catch: diffs are computed inside the sandbox, so once a sandbox is gone, old diffs are unviewable. Worth fixing during the port (store the diff text). |
| Checkpoints | **Yes.** Pure git, portable, well designed (snapshots even failed turns). |
| Test-and-fix loop | **Yes, but rename it in your head** — today it's a "does the front page load" loop, three tries, new web projects only, and it never runs tests. Keep it as the skeleton and grow real checks into it. |
| Deploys | **Yes.** Ship and Deploy are both solid and interruption-safe. |
| Rollback | **You've got this backwards — it doesn't exist.** Toile can restore a *sandbox* to a snapshot, and it shows a read-only "deployment history" list, but there is no button and no code path that puts a previous version back live. The only production action is "restart current version." A real rollback (redeploy checkpoint N) must be **built**, not moved. The good news: the checkpoints make it very buildable. |

Your drop-list, checked:

| You said drop | Verdict |
|---|---|
| The code editor | **Agree.** It's finished and decent, but it's the tool for a product thesis (you hand-edit code) that the merged product doesn't have. It unplugs cleanly. Consider keeping the *terminal* (the type-commands window) behind an "advanced" door — it's separate code and occasionally a lifesaver. |
| Chat as the main screen | **Half backwards.** Drop chat as the *home screen* — selvedge's Today brief is a better front door. But do not delete the chat machinery: the chat thread, its live streaming, and its reconnect-and-replay engine ARE the build experience. You still need a place to tell the agent what to build and watch it work. Demote chat from the lobby to a room; don't demolish it. |
| Anything selvedge does better | **Right, with one exception you'd regret: toile's health monitor is not a duplicate — it's the organ selvedge is missing** (section 2b). It must survive the merge. Everything else on the duplicate list — toile's project rows, notes, GitHub token code, auth, alert-everything notifications — dies rightly. |

Also worth taking (not on your list): the email and webhook alert channels; the
machine-endpoint pattern (2c); the businesses grouping and star flag; the live-stream
replay engine; the boot-time cleanup that recovers builds orphaned by a server restart.

Throw away beyond your list: the Render/Fly placeholder adapters; the hardcoded repo
fallback list; toile's settings-singleton; the cost dashboard's budget UI **until** a
real cap exists behind it (shipping a fake brake pedal is worse than shipping none).

---

## 4. HOW HARD IS THE MERGE

The honest headline: **the features are portable; the plumbing is not.** Toile's best
parts (sandbox lifecycle, checkpoints, runner) don't care who the user is. Everything
around them assumes one user, one org, one token.

Piece by piece:

**1. Accounts and tenancy — the big one. 1–2 weeks.**
Toile has no users table and no owner column on any of its 14 tables. Every table that
survives the merge needs an organization column, and every one of roughly 22 route files
needs its queries scoped ("...and belongs to this org"). Today the only thing stopping
cross-access is that IDs are unguessable — there is no actual ownership check. This is
mechanical work, but it touches everything, and toile has no tests to catch mistakes.

**2. GitHub: personal token → GitHub App. 3–5 days.**
The API calls live in one 200-line file — a contained rewrite onto selvedge's existing
App machinery. The hidden cost: toile smuggles the personal token *into each sandbox* so
the agent can push code. App tokens expire after one hour, and sandboxes live longer, so
the credential handoff needs a refresh design, not just a swap. The hardcoded org name
also appears in the client code and in generated READMEs.

**3. Railway. About 1 week.**
Half of the Railway code is already behind a clean adapter interface (status, logs,
restart, deploy) — that ports easily. The other half — creating services, first deploy,
minting domains — is raw Railway calls spread across four route files, with three
Railway-specific columns baked into the projects table. And a product question you must
answer before the code question: **whose Railway account do customer apps deploy to?**
(Yours, platform-owned? Theirs, connected per-org? The `provider_credentials` table
exists but is global.) The code follows the answer.

**4. Daytona sandboxes. 1–2 days — if you make the pragmatic choice.**
The Daytona coupling is the deepest in the codebase — its SDK types thread through ~14
files and even leak into the database and the client. Abstracting it away properly would
take weeks. **Don't.** Sandboxes are platform infrastructure, not customer-facing
choice: keep one platform Daytona account, tag each sandbox with the owning org, add a
per-org quota. That's days, not weeks.

**5. The AI agent. 2–3 days of plumbing, plus one business decision.**
The runner is cleanly isolated (three files plus prompt templates). But it authenticates
with *your personal Claude subscription token*. A multi-user product cannot run customer
builds on your personal plan — you need a platform API key and therefore real per-run
costs, which is also why the cost-cap question (section 7) stops being optional.

**6. Database fold-in. 2–3 days.**
Toile has no migration history to port — write fresh migrations adding its surviving
tables (health checks, health events, build runs, businesses…) into selvedge's chain,
org columns included from birth.

**7. The user interface. 1–2 weeks.**
Same stack on both sides (React + Vite + Tailwind), which helps. But toile's screens
assume toile's design system and toile's "chat is home" shape. Budget for rebuilding the
project workspace (chat + preview + runs) inside selvedge's shell and design tokens.

**8. Tests for what you port. About 1 week, non-negotiable.**
Everything arriving from toile arrives untested into a repo with 238 tests and a CI gate.
Write tests for the monitor and the runner as part of the port, not after.

**Rough total: 5–8 weeks of focused work** before the merged product does what both did
separately. The order that de-risks it: tenancy first (1), then GitHub (2), then monitor
+ Railway (3), then the builder surface (4–7).

---

## 5. THE SILD PATTERN

**Where it lives.** The design spans two layers in the SILD repo:

- Live and running: `server/lib/translationRuleLifecycle.ts` (the policy engine — the
  "shadow evaluator" and the graduation gate), `server/translationGovernanceRoutes.ts`
  (the switch an admin flips between modes, and the server-side check that refuses the
  flip too early), `server/captureTerms.ts` (mines new glossary terms from chat),
  `scripts/kpack-extract.ts` (extracts "knowledge pack" facts nightly), and the two
  human review screens.
- Written but **never plugged in** (sitting at the top level of the repo, imported by
  nothing): `translationRuleClassification.ts` (the risk classifier),
  `translationRuleLifecycle.ts` (a newer superset of the live policy engine, adding
  per-category tracking), and `graduateKpackCandidate.ts` (the shared approval writer).
  Two instruction files, `APPLY.md` and `APPLY-PHASE2.md`, describe how to wire them
  in. Nobody ever did.

**How it's designed to work — the full lifecycle:**

1. **A fact appears.** Chat activity triggers a miner that pulls out term pairs
   ("this English word ↔ this Japanese word"), or the nightly job proposes facts about a
   workspace. Everything below a 70% confidence score is discarded on the spot.
2. **It waits in a queue.** Nothing auto-saves. Being seen repeatedly only moves a fact
   up the review queue — it never promotes it. Human rejections are recorded permanently
   so a rejected fact can never sneak back.
3. **Risk is assessed.** The classifier sorts each fact into three bins:
   **money-critical** (it mentions measurements, prices, quantities, deadlines, or
   commitments — detected by pattern-matching in English, Japanese, and Chinese),
   **terminology** (ordinary word choices), or **stylistic** (tone and phrasing). The
   stated philosophy is exactly right: *flag aggressively, because a false alarm just
   keeps a human in the loop, while a miss auto-writes a wrong price.*
4. **Only the safest bin may ever be automated.** Auto-approval is allowed only for
   stylistic facts, and only with ≥85% confidence, at least two pieces of evidence, no
   conflicts, and no risk flags.
5. **New enforcement runs silently first.** Each organization is in one of three modes:
   Disabled → **Shadow** → Enforce. In shadow mode, the safety evaluation runs and its
   verdict is logged, but nothing is blocked. The organization may only switch to
   Enforce after a 30-day window shows **at least 20 evaluations with a 95%+ pass rate
   and zero risk flags** — the server refuses the switch otherwise, and the button is
   greyed out in the interface.

**Now the catch — and it's the finding of this whole review.** In the running system,
the evaluator's five safety conditions are **all unreachable**:

- The risk flag is never computed, because the classifier was never wired in. It is
  always empty. (The classifier's own header comment admits this is why it was written.)
- The conflict count is never supplied. Always zero.
- "Human review happened" is hardcoded to true at both places the evaluator is called —
  true today, but it means the check can never fire.
- The "confidence below 70" check can't fire, because everything below 70 was already
  discarded at step 1. The threshold checks a floor the data already stands on.
- The "no evidence" check can't fire either — everything in the queue has evidence by
  construction.

So the evaluator returns "passed" for every real candidate. An organization sails to a
100% pass rate, is declared "ready for enforcement," flips the switch — and Enforce
blocks nothing, because the same evaluator still passes everything. **The three-stage
ladder is, today, cosmetic.** Three aggravations: the measurement only samples facts a
human already approved (so the pass rate is biased upward by construction and never
learns from rejections); organizations that chose "Disabled" still quietly accrue
"readiness"; and a single server-wide environment setting can force Enforce for every
customer, skipping the readiness gate entirely.

**Would the idea work for deciding which code changes an AI agent may make alone?**

**Yes — the design maps almost one-to-one, and it fixes the exact hole in your merged
product** (remember: toile currently runs its agent with permission checks switched
off, and its plan mode is just prose).

- *Facts → proposed changes.* The unit becomes an agent-proposed change (a diff — you
  already have diffs and checkpoints from toile).
- *Risk bins → change classes.* Money-critical becomes: touches payments, login/
  security, data deletion, dependency versions, or deploy configuration. Terminology
  becomes ordinary logic changes. Stylistic becomes copy, styling, comments, docs.
  Detection is the same trick — pattern-matching on file paths and diff contents — and
  SILD's "flag aggressively" asymmetry is exactly right for code too.
- *Shadow mode → the probation period.* The agent proposes; you approve everything, as
  today; the system silently records what it *would* have auto-approved. After weeks
  you compare its would-have-dones against your actual decisions, per category.
- *Graduation → earned autonomy.* Only the safest category graduates to auto-apply, only
  after N agreements at a high rate, and one bad outcome demotes it instantly (SILD's
  "one complaint retires it permanently" rule, from selvedge's library, is the right
  severity).
- *One improvement code makes possible:* SILD's measurement is circular because
  translation has no ground truth short of a human. **Code has one** — tests pass, the
  deploy verifies, the health checks stay green. Wire the outcome, not just the human's
  mood, into the pass rate, and you fix the survivorship bias that undermines SILD's
  version.

**Copy the design. Do not copy the code** — the code is the cautionary tale. Three rules
from the autopsy: compute the risk *at the decision point* (never accept it as an
optional input someone can forget to pass — that's precisely how SILD's died); count
rejections in the measurement, not just approvals; and no global override that skips the
gate.

---

## 6. THREE THINGS YOU'RE WORRIED ABOUT

### 6a. Safety checks that are written but do nothing — the full sweep

I had every guard, gate, threshold, and limit in all three repos traced to its call
sites. Here is everything that is declared but inert, worst first.

**SILD:**
1. **The protected-term risk flag** — never computed, so the readiness gate's "zero risk
   flags" condition is permanently satisfied and can never block promotion to Enforce.
   The full story is section 5. This is the one you remembered, and it's the worst.
2. **All five of the shadow evaluator's conditions** are unreachable (section 5) — the
   entire evaluator returns "passed" for every real candidate.
3. **Three orphaned modules at the top of the repo** (the classifier, the newer policy
   engine, the shared approval writer) with two test files that can never run — one is
   outside the test command's search path, the other literally lacks the file extension
   the test runner looks for. The dead-code detector can't see any of them because its
   configuration only scans the `client`, `server`, and `shared` folders.
4. **Six enforcement switches, all off, nothing anywhere turns them on:** request
   validation (login and registration requests are checked, failures logged as "would
   reject," then let through anyway), the bot-check (doubly off — no secret key AND no
   enforce flag), the browser security policy (report-only), the AI budget (doubly off —
   no cap set AND no enforce flag, so the four places that ask "are we over budget?"
   can never hear yes), database encryption enforcement (warns, boots anyway), and the
   enterprise data-retention attestation (warns, boots anyway). To be fair: the
   architecture doc openly describes this as a "monitor first" rollout strategy. But
   nothing in the repo ever finishes the rollout.
5. **The paid workspace limit** — defined (free: 1, pro: 3), priced, sent to the
   client — and enforced nowhere. The client-side check has zero callers; the server
   never counts.
6. **A quiet login downgrade:** if the database read that asks "does this user have
   two-factor auth?" fails, the answer is treated as "no," and login proceeds on
   password alone.

**Toile:**
7. **The spend cap** — enforcement deliberately deleted in the latest commit; slider,
   meter, warnings, the words "then stops," and two docs still claim it. Detailed in
   section 1.

**Selvedge — the cleanest of the three.** Every named guard traces to a live, fail-closed
call site: webhook signatures verified, org checks on every request, pack validation that
throws, and missing configuration produces refusals rather than silent passes. Three
honest items:
8. **The daily AI budget flags but doesn't block** ($0.15/day, admin screen turns the
   row orange). The code says so openly — "flag, don't block" — so it isn't lying, but
   it means selvedge has no spend brake either (see 7).
9. **The "quiet and healthy" line doesn't check health.** The morning brief tells you
   important apps that had no events "were quiet and healthy." The code comment claims
   it checks health; the code checks only quiet. An app whose connector died gets
   described as healthy *because* no news arrived. A sibling line ("X is healthy — {gap}")
   has the same unconditional "healthy." Both contradict the fix that was correctly
   applied to the projects screen one commit earlier — the digest lines were missed.
10. **One feedback dead-end:** when an AI narration failed over to a template, the
    stored record omits its fingerprint — so tapping "didn't help" on it logs the
    complaint but silently retires nothing.

### 6b. Does selvedge treat "didn't complain" as "was happy"? — Yes. On purpose. And it compounds.

The design is explicit, stated in three places in the code: there are exactly two
feedback buttons, both negative ("didn't help," "explain differently"), and **"no
thumbs-up exists by design — absence of complaint is the positive signal."** There is no
read-tracking, no open-tracking, nothing that knows whether you ever saw a sentence.

Where that actually bites, in increasing order of concern:

1. **Phrasings become permanent on silence.** A generated phrasing "graduates" into the
   permanent, reused-across-all-customers library after being *emitted* 3–5 times with
   zero complaints. Emitted — not read. Nobody ever affirmed it. Five occurrences of the
   same flaky build in one afternoon graduates a phrasing globally.
2. **The trust summary ignores your feedback entirely.** The self-published track record
   ("I was certain 84% of the time…") is computed from the AI's *own* confidence
   self-ratings. Your "didn't help" taps are collected, counted — and never passed into
   the sentence. Fifty complaints; same rosy summary.
3. **"No false all-clears" really means "no *detected* false all-clears."** The tripwire
   only catches an all-clear contradicted by a machine event within 24 hours. If the
   system says "users are fine," is wrong, and no event ever arrives — because, per
   section 1, selvedge has no probes — the mistake is invisible, and the absence is
   printed as an accuracy claim.

The philosophy ("quiet product, don't beg for stars") is defensible for *tone*. It stops
being defensible where silence *promotes content* and *inflates a published accuracy
number*. The fixes are small: require at least one probable-read before an emission
counts toward graduation; put the complaint count into the track-record sentence; and
say "no false all-clears *detected*" until real probes exist. (Porting toile's monitor —
section 2b — is what makes the trust ledger honest for real.)

### 6c. The branch mess — main is not stale; main is AHEAD

I checked the actual history, and the situation is backwards from what you might expect:

- The repository's default branch (`claude/new-session-n6dkt1` — the branch you get when
  you open the repo) is **old**. Its only unique commit is an upload of
  `selvedge-strategy.zip` on 20 July.
- **`main` exists and has all the real recent work** — it is 8 commits ahead: the four
  native-app endpoints, project delete, the health-line fix, the entire trust system,
  the entire push send path, the memory system, and mute. About 4,700 lines, all
  tested.
- So every new session, clone, or tool that opens the default branch — **including the
  session that wrote this review** — starts from code missing all of that. This review
  read `main` directly to compensate.

**What it takes to make main correct: one settings change, no code.** In the GitHub
repository settings, change the default branch to `main`. Then decide about the zip:
copy that one commit onto main if you want the strategy docs in the repo (they arguably
belong outside it), and delete the old branch either way so nobody lands on it again.
Five minutes of work; it ends a trap that already caught this session.

---

## 7. WHAT'S MISSING

The four things you asked for, against what exists:

**1. A cost estimate before a run — exists nowhere. Build from scratch.**
Both repos only know cost *after* the fact. Toile's only "estimate" ever was a flat one
cent per run, and it was deleted with the cap. Selvedge prices calls only after the
tokens are counted. What to build: before a run, show a figure from (a) this project's
recent average cost per turn — toile already stores every run's cost, so the data
exists — and (b) the size of what's being sent. Rough is fine; the point is consent.

**2. A spending cap that actually stops — exists nowhere. Both repos back away from it.**
Toile deleted its brake (for the semi-honest reason that the number it capped was
notional under a personal subscription). Selvedge chose "flag, don't block" from the
start. Here's the thing: the moment the merged product runs customer builds on a
platform API key (section 4, item 5), the cost becomes *real billed money*, toile's
excuse evaporates, and a real brake becomes table stakes. The good foundation is
selvedge's metering — every call writes a usage row, success or failure, and unknown
models are priced at the *most expensive* rate so spend is never undercounted. Add one
check before each run: projected spend over cap → refuse, say why, show the override.
And un-ghost or remove toile's budget UI (section 1) so the interface stops promising a
stop it doesn't perform.

**3. A stop when the AI keeps failing the same way — exists nowhere. The parts are lying around.**
Toile retries 3 times and hard-stops on a 20-minute timer — but never compares attempt 2's
failure to attempt 1's; three identical failures and three different ones look the same.
Selvedge writes down every AI failure reason and every fallback — and no code ever reads
two of them side by side. What to build: fingerprint each failure (selvedge already
fingerprints narrations; SILD deduplicates facts by signature — same trick), and stop
the loop on the *same* fingerprint twice, with "I'm stuck in a loop, here's what keeps
happening," rather than burning the third attempt and the budget.

**4. A post-deploy check that can say "I don't know" — the one that half exists, and the halves are in different repos.**
Selvedge owns the *vocabulary*: "can't tell yet" is a first-class verdict, ranked, and
enforced — the AI is refused if it says "can't tell" without naming what's being
checked. But selvedge has no probes, so it can rarely *earn* "users are fine."
Toile owns the *checking*: real probes, and its fleet status does honestly say
"unknown" when a probe couldn't run. But its build-time verdict is binary — "couldn't
check" and "confirmed broken" collapse into the same "unverified." The merge is the
fix, and it's the most natural join in this whole plan: toile's probes and Railway
deploy status become the events; selvedge's verdict discipline becomes the mouth. Add
"unknown" to the build-verify result, and the merged product can do the thing neither
can alone — deploy, check, and tell you the truth about what it found, including
nothing.

**Bottom line for section 7:** you have the honesty vocabulary (selvedge), the probes
(toile), a complete spend ledger (selvedge), and per-run cost history (toile). You are
missing all four *decisions*: estimate, stop, break the loop, admit unknown. All four
are gates, and after reading three repos in one sitting, the pattern to respect is that
all three codebases are better at recording than at refusing. Every gate you build,
build it the way section 5 concludes: computed at the decision point, measured against
outcomes, no silent bypass.

---

## Appendix: where the biggest claims live

For anyone (including a future agent) who wants to verify:

- Toile spend-cap removal: commit `fd4ae34` on toile `main`; UI still claiming a cap:
  `client/src/components/CostDashboard.tsx` (the cost screen); README section "Daily
  spend cap" (now wrong).
- Toile no-rollback: the publish routes expose history read-only; the only production
  action is restart-current. No redeploy-a-previous-version path exists.
- SILD inert risk flag: live evaluator `server/lib/translationRuleLifecycle.ts`; its two
  callers omit the risk input; unwired classifier `translationRuleClassification.ts` at
  repo root (its header comment names the bug); wiring instructions in `APPLY.md`,
  unexecuted.
- Selvedge feedback-by-silence doctrine: stated in the feedback table definition, the
  feedback route, and the Today page component; graduation rule in
  `src/server/narration/library.ts` (the phrasing library).
- Selvedge "quiet and healthy" without a health check:
  `src/server/digest/standing.ts` (builds the brief's standing lines).
- Selvedge branch state: default branch is `claude/new-session-n6dkt1`; `main` is 8
  commits ahead of it; the default's only unique commit adds `selvedge-strategy.zip`.
