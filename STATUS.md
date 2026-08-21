# Selvedge — build status

Plain-English map of what exists, what's switched on, what's waiting on a key,
and what's still only a plan. Written for a non-coder. **1,272 tests across 159
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
3. **The brief is the front door** (BUILD-BRIEF §"what not to build" — this
   line previously promoted the Migration Center to front door; that was this
   file drifting from the brief, not a decision). The Migration Center —
   *leaving* Replit/Lovable/Bolt/v0 and landing here, infrastructure in **their
   own name**, Selvedge as fireable caretaker — stays scoped and researched
   (`MIGRATION-CENTER.md`) as an acquisition channel, built after the loop
   proves itself with live customers.

The competitive line: not replacing Cursor or Replit at writing code — making
**health, status, and honest recovery** the thing that matters, in language a
founder actually speaks.

---

## Switched on right now (tryselvedge.com)

| Area | What works |
|---|---|
| **Landing page & sign-up** | What a stranger sees at tryselvedge.com: the decided words from EXPLAINER.md arranged around a sample brief that wears the real edge vocabulary. "Get started" leads to a real sign-up (`/sign-up`, cross-linked with `/sign-in`); a new account lands on a three-step getting-started checklist on Today — add an app, optionally connect a key, compose the first brief — with state derived from data, nothing to dismiss, gone once the first brief exists. Compose is never offered before a project exists. |
| **Sign-in** | Clerk, email+password. A solo owner is a tenant of one — never asked to create an "organization". |
| **Projects** | Create from an existing repo, or **create a brand-new private GitHub repo** in one step. New things start as a sandbox and land straight in the Workshop. |
| **Today / brief** | Daily digest per org at local 7am, composed by the model when fuel is connected, mechanical when not. Repeats collapse ("…today (3 times)"). |
| **Watching** | Health checks with two-failure debounce, deploy-state polling (Railway/Vercel), error-rate spikes, and correlation of a break to the change just before it. Putting an app online now **arms its health check** — until that was wired, the probe half watched nothing (deploy polling was unaffected). |
| **Work cards** | A change the loop is walking: proposal, estimate, cap, gate, approval. Sensitive diffs (payments/auth/user data) need a confirmed backup. Caps genuinely stop work. Cards that need you appear on Today; a project's own sit beside its conversation. Selvedge raises one itself the moment something breaks it could fix — there is no longer a separate Work page, because every part of one had a better home. |
| **Independent verdict** | With `OPENAI_API_KEY` set, every finished card's "did it do what was asked" is judged **by a different model than wrote the change** (default `gpt-5.6-luna`), reading the actual diff from the card's review branch. This unlocks the `verified` verdict; without the key, verdicts honestly top out at "probably". The card says when it happened: *"Checked by a different model than the one that wrote it."* Grading runs on its own daily budget, so it can never starve the brief. |
| **Workshop** | Persistent Daytona sandbox per project, Claude Code agent, live activity feed, live preview iframe, ship (commit+push), undo (real `git revert`), 12-minute post-ship watch with auto-revert on a confirmed break. Cost watch always visible. |
| **The Inbox** | The place to work: `/inbox` is one three-pane workbench — projects and their conversations on the left (with the morning brief pinned at the top), the thread in the middle, and context on the right (work cards, the app running live, what Selvedge understands about the project). A project can hold as many conversations as you like: **workshop** threads build in the sandbox, **general** threads are plain chat with no sandbox and nothing to ship — for deciding what to build before anything is built. Threads are renameable and archiveable, never deleted. Cmd+K jumps, Cmd+J switches agent, Cmd+N starts a thread; everything is also reachable by pointer. |
| **Switching agents mid-task** | Tap the chip in the composer, pick, keep typing. A chat thread just changes the model behind it, history intact. A workshop thread composes a **handoff** — what the project is, what's been done, where the work stands, and the ask — and starts the new builder with it, so nothing is re-explained. The thread records the switch in one line with the real size of what was handed over and what carrying it cost: *⇄ continued with Codex — handoff 1.8k tokens, about $0.004*. |
| **Break → the work behind it** | When something breaks, Selvedge doesn't just say a change landed first — it says *whose work* that change was: *"This began after the change from Monday's Codex session (let people check out as a guest)."* It gets there through the commit: a session stamp Selvedge's own ships write into the commit message, or the commit the companion saw land while a terminal session was open. The conversation and the diff are one click away, in the brief and on the project's history. And when two changes could equally be behind it, it names both and says plainly that it can't tell which — a coin toss dressed as an answer is the one thing it won't do. |
| **The record, visible** | Every project has a **history**: one scrollable list of what happened to it — what you asked for, work starting, ships, undos, handovers between agents, verdicts, and what the watching saw — each in one plain sentence with its status edge and the evidence one click beneath. Click a project in the rail to read its own history, or open **History** beside a conversation. **Search inside a project** finds what was said in any thread, any ask, and anything the watching reported. And the line under it is true: this is the same history your JSON export carries, in the same words. |
| **Decide, then build** | A conversation can become a **decision** — a short written note of what was decided, why, what it must not break, and what is still open — and that decision opens a second thread that builds it. The two stay paired: each shows the other. The part that matters is that the decision **knows how old it is**. It records exactly what it was written from, and the moment anything is said in the thinking afterwards it says so, in red, on both sides. If you try to build from one that's fallen behind, Selvedge stops and tells you what's changed; you can refresh it, or say you know and go ahead — and the thread records that you did. Open questions travel to the builder with an instruction not to answer them itself. |
| **Subjects** | Somewhere to put work that isn't a codebase — pricing, hiring, an old chat log. A subject is a name with conversations under it and nothing else: no health, no edge, no watching. There's nothing there to monitor, so it never looks as though there were. |
| **Bring in an old history** | Upload the export ZIP that ChatGPT, Claude or Gemini already gives you and those chats become ordinary conversations here — searchable, part of the record, every one marked as imported because none of it was said to Selvedge. Nothing is connected and nothing keeps reading: it happens once, from a file you chose. Whatever couldn't be read is listed with a reason, beside the count of what came in — and so is what the format itself can't carry (Google's export records what you asked Gemini, not what Gemini answered). Importing the same file twice can't double your history. |
| **The loop** | Work you do in your own terminal doesn't vanish. A small program on your machine (`selvedge watch`) reads your Claude Code and Codex sessions — and, marked plainly as unproven, Cursor and Gemini CLI and sends Selvedge a **summary** of each one — what you asked for, which files it touched, how it ended, the commit that landed, what it cost. Never the conversation, never your code; `selvedge watch --dry-run` prints exactly what would be sent. Those sessions turn up on the project's history and in the next morning's brief, always marked as **observed from outside** — Selvedge didn't run that work and doesn't claim to have checked it. And a session it *couldn't* read is said out loud rather than quietly skipped. |
| **Context, served anywhere** | The same program is an MCP server (`selvedge context`) that any agent can mount — Claude Code, Codex, anything that speaks MCP. Three read-only tools hand over what this project is, what changed lately, and what's open, so a fresh session anywhere starts knowing the project instead of asking you again. Read-only on purpose: agents consume context here, they never edit what Selvedge believes. Set up under **Connections → Your machines**; the how is in `docs/companion.md`. |
| **The flight record** | Every run keeps a durable, structured record of what the agent actually did — each tool step with its outcome (did the edit apply, did the test pass), the files changed, the cost, the model — bounded, and joined to the thread. "The full record" opens under the activity feed; ships record the exact diff the risk gate judged; undos get their own row; a finished card's history is one click on Record. The raw log dies with the sandbox in minutes — this is the evidence that outlives it. |
| **Attachments** | Screenshots inline (paste, pick, or drop); files/zips up to **300MB** streamed to disk and into the sandbox. Zips auto-extract. |
| **Think it first** | A checkbox on the Workshop composer runs the same agent read-only: it explains in plain English what building the idea would involve, flags risks and cost, and changes nothing. Replaced the separate Sketch room — one conversation, one place, no hand-off. |
| **Ledger / Record** | Every run's real cost in cents, verdicts, track record, learned baselines ("last time this cost about $6"). |
| **Connections** | BYO model key, host tokens, Supabase token. AES-256-GCM vault, bound to org *and* provider. |
| **Portability** | Export everything Selvedge knows as JSON — the project packs, the learned meanings, and now the timeline: what happened to each project, in the same sentences the product shows you. Being able to leave is what makes people stay. |

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
| **Login with Railway** | Railway OAuth app + `RAILWAY_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Route and button are now written; without the keys the button says so and points at the paste-a-token field, which still works. |
| **Push notifications** | APNs keys | Alerts still fold into the brief. |
| **GitHub App events** | App id / key / slug / webhook secret | Repos can be worked on, but pushes and deploys don't flow into the brief. |

---

## Built but NOT verified against live APIs

Written to published docs and unit-tested; no call made against the real service
from this environment:

- **The companion's log parsers** — Claude Code's and Codex's session files are
  read from fixtures that match the shapes seen in the wild, not from the live
  tools on a real machine. The failure mode is deliberately loud: a log the
  parser doesn't recognise is reported as unreadable and leads the next brief,
  rather than being skipped. The rest of the loop — ingest, storage, the
  timeline, the brief line, the MCP — is tested end to end over real HTTP.
- **The Cursor and Gemini CLI readers go further than that, and say so.** They
  were written against those formats *as understood* — no log from either tool
  has been seen by this codebase, not even a fixture copied from a real one.
  They are shipped labelled unverified in `docs/companion.md`, in the code and
  in the type. What is tested is that the guess fails safely: they never throw,
  never invent a session id, and report every log they can't read. Because
  finding nothing looks identical to a quiet week, `selvedge watch --dry-run`
  prints where it looked, and each tool's directory can be corrected — or
  turned off — in `~/.selvedge/config.json`.
- **The consumer-history import** — the ChatGPT, Claude and Gemini export
  parsers are tested against the documented shapes of those archives, not
  against an export downloaded from a real account. Anything a parser can't
  read is reported with a reason rather than dropped, so a format that has
  moved shows up as "I couldn't read these" instead of a short list that looks
  complete.
- **Codex as the second builder** — the CLI's install, its command, and its
  JSON event stream (session id, outcome, token usage, tool activity). The
  stream is undocumented and has changed shape between versions, so the parsers
  accept the shapes seen in the wild and **fail a turn they cannot read rather
  than passing it**. The rest of the path — the switch, the handoff, the record,
  the pricing — is tested end to end with the CLI's output stubbed.
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

- **Model picker** (Claude / Codex / Kimi). Was cut in Aug 2026 — OpenAI arrived
  as the *grader*, where a different provider is the feature, not as selectable
  fuel. **Reopened and built** (INBOX-LOOP-BRIEF.md Phase 1) on a different
  argument: not "a second model as decoration" but *switching builders mid-task
  without re-explaining*. Codex now installs into the same sandbox beside
  Claude Code, and OpenAI is live fuel for chat threads. Kimi and Gemini stay
  declared and not built.
- **Mobile app** — `cag-platform/Selvedge-mobile`, native SwiftUI. **Scope decided
  (Aug 2026): deliberately thin** — APNs push for the brief, a WidgetKit glance,
  and a read-only brief view. The Workshop and go-live stay web-only; a phone is
  where you hear the news, not where you steer the machine.
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
5. `connector_credentials.provider` is free text; the per-surface allow-lists
   now derive from one table (`connectors/registry.ts`). Provider id strings are
   encryption-bound (AES-GCM AAD) and must never be renamed.

---

## What it costs to run

- **Sandboxes** stop themselves after 15 idle minutes — walking away is free.
- **Agent turns** ~$0.05–0.30 (a think-it-first turn runs the same agent
  read-only, same price). **Grading** costs a fraction of a cent per card, on
  its own budget so it can never turn tomorrow's brief mechanical.
- **Hosting and databases** are the customer's own accounts and their own bill —
  zero hosting COGS by design, and Railway's template kickback (15–25% of ongoing
  usage) makes the freedom model revenue-positive rather than a cost centre.

---

## What landed with the Inbox (Aug 2026)

Phase 0 of INBOX-LOOP-BRIEF.md is in, and by design **nothing looks different**.
Three load-bearing pieces, laid before the room is built on them:

- **Every ship now stamps its commit** with the conversation it came from —
  `Selvedge-Session: <thread id>`, a real git trailer. Selvedge always knew
  which conversation asked for a change; now the repository knows too, which is
  what will let a future brief say "Tuesday's errors began after the change from
  Monday's session" and mean it.
- **A project can hold many conversations.** The `threads` table exists, and the
  Workshop conversation each project already had became its thread #1 — same
  history, same place, now with a name it can be listed under. Nothing in the
  product offers a second thread yet; the Inbox does that.
- **The handoff is written and tested.** Given a project and a conversation, a
  pure function composes what a *different* agent would need to pick the work up
  — what the app is, what breaking it costs, what's been done, where it stands,
  and the ask itself. On a thread with real history it costs under a tenth of
  what pasting the conversation would.

Then the room itself: the Inbox and the switcher above, general threads beside
coding ones, and Codex in the same sandbox. Two things are deliberately NOT
claimed. The Codex CLI has not been run against the real tool from here (it's
in the unverified list). And the dogfood gate — a whole working day inside
Selvedge, switching builders mid-task without re-explaining anything — needs a
person and a live sandbox; the machinery is tested, the day hasn't been had.

### And then the gated things, built early on request

Paired threads, subjects, the history import and the Cursor/Gemini CLI readers
were all held behind evidence in INBOX-LOOP-BRIEF.md §8, and were built anyway
at the owner's direction so they can be tried. That is worth writing down
rather than smoothing over: they are in the product before the evidence that
was supposed to justify them.

One part of §8 was not waived. It says the decision brief's stale-brief problem
"must be solved with evidence-dating before it ships" — that is a rule about
never printing something false, so it is the feature's spine rather than a
guard bolted beside it. A decision records what it was written from; anything
said afterwards makes it stale, loudly, on both sides; and the building thread
refuses to run on a stale one until a person says they know.

---

## The next three things

1. **Go live for real (Phase 0 gate).** Register the Railway OAuth app
   (redirect `https://tryselvedge.com/railway/callback`), set the keys
   (`PREVIEW_DOMAIN`, `GITHUB_ORG`, `NEON_API_KEY`, APNs), then: one project
   created through the product, put online, broken on purpose, caught by the
   watcher, rolled back — with a push landing on a real phone.
2. **Switch on the independent grader (Phase 1 gate)** — the runbook below.
3. **Neon claimable projects** — provision with no signup, hand over, they claim.

### Switching on the grader — the runbook

1. **Sanity-check the key first**, no deploy needed:
   `OPENAI_API_KEY=sk-... npx tsx scripts/grade-once.ts` — runs the real prompt
   on the real client against two built-in fixtures. Expect the first to
   `pass` and the second to `fail`; that disagreement-in-miniature is the
   whole point.
2. **Set `OPENAI_API_KEY` on the deploy.** Nothing else — `EVAL_MODEL`
   defaults to `gpt-5.6-luna`. The boot log's `evaluator` feature flips on.
3. **Run one card to done.** Expect: verdict **verified**, the card line
   *"Checked by a different model than the one that wrote it."*,
   `cards.graded_by = 'independent'`, and an `llm_usage` row with
   `purpose='grade'`, `provider='openai'`.
4. **Prove the inversion.** Unset the key, redeploy, run another card:
   verdict **probably**, no grader line, `graded_by = 'ungraded'`. The absence
   of a grader must never read as a pass.
5. **The gate: manufacture a disagreement.** Ask for something with a strict
   criterion the agent plausibly fudges — "remove the newsletter signup from
   *every* page", or a two-part ask where one part is easy to skip. Claude's
   own smoke/regression checks pass; the grader should fail (or cannot_tell)
   the acceptance. If they never disagree after a few tries, set
   `EVAL_MODEL=gpt-5.6-terra` — correlation, not agreement, is the failure
   being hunted.

Then **dogfood the Inbox and the Loop** (INBOX-LOOP-BRIEF.md §3 and §5's
gates): run a real day inside it — plan in a general thread, build in a workshop thread, switch
builders at least once mid-task without re-explaining anything, and check that
every message, switch and cost is visible in the record. That day is also the
first real test of Codex's CLI, and the first real read of a project's history
with months rather than fixtures behind it. After it: **the Loop** (a local
companion that reads terminal sessions in, and a pack-serving MCP that hands
context out) — both now built, so what remains for them is the day itself:
install the companion, work a day in the terminal, and check that the next
morning's brief narrates it correctly. Then **Fusion** (Phase 4: break → the
change before it → the session that produced it, in one plain sentence), and
after that the Migration Center, Replit first.

---

## How to read the code

- The **honesty rules** live in pure, isolated files — `verdict.ts`, `risk.ts`,
  `observe.ts`, `machine.ts`, `ship.ts` — each tested on its own, and each
  load-bearing guard deliberately broken once to confirm a test catches it.
- The **live seams** are injected function arguments, so the logic around them is
  provable without the network.
- The **cards table is the ledger** — nothing about your history is stored twice.
- Every table carries `org_id`, and a test fails the build if a new one forgets.
