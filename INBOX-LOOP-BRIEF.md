# Selvedge — Build Brief: The Inbox and The Loop

**Date:** 20 Aug 2026. **Status:** approved direction, phased plan with UI spec.
**Companion docs:** STATUS.md (what's on), ARCHITECTURE.md (how it's built),
BUILD-BRIEF.md (the original brief — this extends it, nothing there is
revoked), docs/ui/DESIGN-NOTES.md (the locked look — §6 here records what
bends and what holds).

---

## 1. Why this brief exists

The origin is a real, loudly-stated pain: people bounce between AI agents and
every agent starts stupid — no shared context, endless re-explaining. Selvedge
already owns the two hardest ingredients: a per-project context pack grounded
in real outcomes, and the watching/verification layer that knows whether work
actually held up in production. What's missing is (a) the pipes that move
context in and out, and (b) the place to work.

Two layers, built in this order:

- **The Inbox** — the place to work. Threads per project, quick agent
  switching, general chat alongside coding chat. UI quality is tantamount.
- **The Loop** — the engine. A local companion reads coding-agent sessions in;
  a pack-serving MCP hands current project context out to any agent, anywhere.

**The governing design test for every feature in this brief:** does it make
Selvedge meaningfully smarter after six months of history than it was on day
one? If a feature only decorates the timeline, it doesn't ship.

**Honest framing carried from research:** the moat is a hypothesis — intent,
reliably linked to outcomes — that only accumulated live use can confirm.
Nothing below claims otherwise.

---

## 2. Phase 0 — Groundwork (small, ship first)

Everything later depends on this; none of it changes the UI.

1. **Commit stamping.** Every Workshop ship writes a git trailer on the
   commit: `Selvedge-Session: <session-id>` (alongside the existing flow).
   This makes provenance→runtime joins deterministic later. Zero cost now.
2. **Threads schema.** Migrate the one-conversation-per-project model to
   threads: `threads(id, org_id, project_id, kind, title, agent, model,
   created_at, archived_at)` with messages attached to a thread. `kind` is
   `workshop` (sandboxed coding) or `general` (API chat, no sandbox). The
   existing Workshop conversation becomes thread #1 of its project. Every
   table keeps `org_id`; the existing schema test must still pass.
3. **Handoff payload seam.** A pure function, no network:
   `composeHandoff(pack, thread, targetAgent) → payload`. Reuses the digest
   composer's machinery. Target: payload under 10% of full-transcript tokens.
   Tested against the golden set before any UI uses it.

**Gate:** one commit lands with the trailer; migration runs against the live
DB; composeHandoff passes fixture tests. No visible product change.

---

## 3. Phase 1 — The Inbox (one coherent build; the big one)

The place to work. Built as one phase because it's one UI, and half a
thread-inbox is worse than none. The full UI spec is §6; the functional
scope is here.

1. **Thread list per project.** Left rail: projects → threads (named, dated,
   most-recent-first), morning brief pinned at top. New thread is one tap:
   pick kind, pick agent, type. Threads are renameable and archiveable.
2. **General threads.** Same thread UI, no sandbox. Direct API calls through
   the existing model seam (Anthropic already wired; OpenAI already present as
   the grader — expose both as chat fuel; the FUEL_PROVIDERS seam stays the
   registry). Costs land in the existing ledger like everything else. This is
   "born in Selvedge" in its minimal form — work chats start here because
   here they join the record.
3. **Agent switcher.** Per-thread picker. For `general` threads: switch =
   change the model behind the same thread, full history carried (it's all
   API calls). For `workshop` threads: Codex CLI installs into the same
   Daytona sandbox next to Claude Code; switching builders mid-thread
   composes a handoff payload (Phase 0.3) and starts the new agent with it —
   the thread continues, the record notes the switch and its cost.
4. **Speed rule (the tantamount part).** Switching is: tap picker → pick →
   keep typing. No modal, no confirmation, no page change. If a sandbox agent
   needs warm-up, the thread says so honestly and queues the message rather
   than blocking the composer.

**What not to build here:** paired threads / decision brief (gated, Phase 7),
consumer-app import (Phase 7), streaming (the existing polling pattern is
adequate; don't let SSE sneak into this phase).

**Gate (dogfood):** run a real project's day entirely inside Selvedge —
plan in a general thread, build in a workshop thread, switch agents at least
once mid-task without re-explaining anything, and have every message, switch,
and cost visible in the record. If switching feels like ceremony, the phase
isn't done. Plus the three look-specific checks in §6.9.

---

## 4. Phase 2 — Visible Memory (small-medium)

The record already exists (ledger, events, flight records, verdicts); make it
something the owner can see and trust.

1. **Per-project timeline.** One scrollable view merging: asks, threads,
   ships, deploys, breaks, fixes, verdicts, agent switches — each entry one
   plain sentence, expandable to its evidence. Selvedge-edge status color
   down the left, consistent with the brief's vocabulary.
2. **Search within a project.** Text search across threads and timeline.
   Nothing fancy — Postgres full-text is enough at this scale.
3. **Export unchanged, now visible.** The timeline is the human face of the
   same data the JSON export carries. Say so in the UI: this is yours.

**Gate:** answer "what happened to this project in the last two weeks?" from
the timeline alone, without opening a thread. Timeline of a 3-month-old test
project loads fast and reads clean.

---

## 5. Phase 3 — The Loop (medium; read + write shipped together)

The engine. Two halves of one loop, one phase, because either alone is half a
product: the daemon without the MCP is an archive; the MCP without the daemon
serves a stale pack.

1. **Companion daemon (read).** A small local CLI (`selvedge watch`) that
   tails Claude Code (`~/.claude/projects/*/*.jsonl`) and Codex
   (`~/.codex/sessions/**/rollout-*.jsonl`) session files. On session end it
   ships a **summary only** — intent, files touched, tools run, outcome,
   linked commit SHA, cost — to a new authenticated ingest endpoint. Raw code
   and full transcripts never leave the machine; say this loudly in the docs.
   Repo matching: by the session's working directory ↔ project repo. Formats
   are undocumented and version-fragile — parse defensively, fail loudly into
   the brief ("I couldn't read yesterday's Codex sessions"), never silently.
   Cursor and Gemini CLI are explicitly deferred (unstable formats).
2. **Pack-serving MCP (write).** `selvedge-context`, an MCP server any agent
   can mount (Claude Code, Codex, Cursor). Tools: `get_project_context`
   (the composed pack: what this is, stakes, topology, decisions, recent
   outcomes, known failure modes), `get_recent_changes`, `get_open_issues`.
   Read-only in v1 — agents consume context, they don't write memory. The
   pack served is the same object the brief and Workshop already use; one
   source of truth.
3. **Ingested sessions join the record.** Daemon summaries appear on the
   timeline and in the morning brief ("Yesterday: two Claude Code sessions on
   loom — checkout refactor shipped, one session abandoned"). They carry a
   distinct mark: observed from outside, not run by Selvedge — the honesty
   rules apply (no claiming verification of work Selvedge didn't gate).

**Gate:** work a full day in the terminal, never opening Selvedge — and the
next morning's brief correctly narrates what happened; then open a fresh
Codex session with the MCP mounted and have it answer "what is this project
and what changed last week?" correctly with zero re-explaining.

---

## 6. The Workbench Register (Phase 1 UI spec)

Extends `docs/ui/DESIGN-NOTES.md` — nothing there is revoked. The locked
language was designed for a reading product: one gentle arrival, then
stillness. The Inbox makes Selvedge a working product: dense, fast, lived-in
for hours. Same cloth, new room. Every existing rule sorts into **holds** or
**bends**, plus the few new rules the workbench needs.

### 6.1 What holds (do not renegotiate)

- **The token system.** `tokens.css` stays the single source of truth. Every
  new workbench value is a token; the no-raw-values grep still passes.
- **Color rationing.** `--thread` red still appears only for what needs the
  user. A forty-row thread list makes this rule more valuable, not less.
- **The edge vocabulary.** Verdict→edge mapping is unchanged. The
  stranger-reads-health-from-edges test now includes the thread rail.
- **`cannot_tell` is dashed.** Shape-distinct everywhere, including thread
  rows.
- **Glass budget.** Still at most two backdrop-filter layers per screen,
  never nested. The three-pane layout does not earn a third: panes are solid
  `--panel` on paper.
- **Accessibility floor.** Color never the only signal; brass focus rings;
  real landmarks; `<details>` for disclosure; the contrast rules as written.
- **Voice in the chrome.** Empty states invite, errors speak plainly, no
  infrastructure nouns at plain register.
- **Honest liveness.** Nothing claims progress it can't see.

### 6.2 Navigation: pages become panes

Today, Projects, Workshop, Work, and Tray collapse into **one persistent
three-pane layout**:

```
┌──────────┬────────────────────────┬──────────────┐
│ RAIL     │ THREAD                 │ CONTEXT      │
│          │                        │              │
│ projects │ messages, composer,    │ work cards / │
│  └threads│ agent activity         │ preview /    │
│          │                        │ timeline     │
│ brief    │                        │ (tabbed)     │
│ pinned   │                        │              │
└──────────┴────────────────────────┴──────────────┘
```

- **Rail** (left): projects with their edges; threads nested under each,
  most-recent-first; the morning brief pinned at top. The Tray's unsorted
  count appears here as a quiet line, not a destination.
- **Thread** (center): the conversation — workshop or general — with the
  composer fixed at the bottom. The Workshop's activity feed, preview link,
  and ship controls live *in the thread*, where the work happens.
- **Context** (right): tabbed panel — Work cards, Preview, Timeline (Phase
  2), Pack. Context for the thread in focus, not places you go. Collapsible;
  collapsed is the default under 1280px.
- **Today survives as the front door**: signed-in landing is still the brief.
  One tap on any sentence in the brief opens the workbench focused on the
  relevant thread or timeline entry. Read first, then work — the order is
  the product thesis in navigation form.
- Connections, Track Record, Pack Editor, Admin stay as pages — settings, not
  work.

### 6.3 Density: two settings of the same cloth

New tokens, not new colors: `--space-read` (current values, unchanged) and
`--space-work` (compact). Reading surfaces — Today, the brief, the timeline —
keep the airy register. Working surfaces — rail, thread list, thread, context
panel — use the compact register.

- **Fraunces does not appear in the workbench** except the pinned brief
  headline. Thread rows, thread titles, and panel headers are Inter Tight.
  Fraunces is the note's voice; lists are not notes.
- Mono stays the technical register only: agent chips, session ids, costs,
  file paths, activity lines.
- Compact row height target: ~10–12 thread rows per rail screen without
  feeling like a spreadsheet. Padding shrinks; type size does not go below
  the AA-passing sizes already in the system.

### 6.4 A second motion register — barely

"One gentle arrival, then stillness; nothing loops, nothing pulses" holds
for everything **except** one new, narrow allowance:

- **Liveness is textual.** While an agent runs, the pulse is the activity
  line itself updating ("editing checkout.ts…", "running tests…") in mono.
  Content moves; chrome does not.
- One static **working mark** may sit on the active thread's row and chip: a
  small solid dot in `--ink-dim`. It appears and disappears with `--settle`;
  it does not animate while present. No spinners, no shimmer, no progress
  bars that guess.
- `--settle` remains the only duration in the app.

### 6.5 Agent identity: a new, non-color system

Status colors are spoken for. Agent identity must never borrow them.

- **Mono chips**: two-to-three character marks in JetBrains Mono on a
  `--panel` field with a 1px `--ink-faint` border — `CC` (Claude Code),
  `CX` (Codex), `CL` (Claude chat), `GPT`. Text carries the identity; the
  chip is just a container. New agents get chips from the same recipe —
  no logos, no brand colors, ever. Providers are metadata; the chrome says
  so.
- Chips appear: on each thread row (current agent), in the composer
  (switcher), and on any message where the agent changed mid-thread.

### 6.6 The switcher (the tantamount interaction)

- Lives **in the composer**: the current agent's chip sits left of the input.
  Tap (or Cmd+J) opens an inline list — chips + names + a one-line honest
  cost note ("runs on your API key, ~$0.05–0.30/turn" or "uses your
  subscription"). Pick, list closes, focus returns to the input, keep typing.
  No modal, no page change, no confirmation.
- **Mid-thread switch on a workshop thread** composes the handoff payload
  (Phase 0.3) automatically. The thread records it as one quiet system line:
  `⇄ continued with Codex — handoff 1.8k tokens, $0.02` in mono. That line
  is the feature demo; it must always state the real token count and cost.
- If the target agent needs sandbox warm-up, the composer stays live, the
  message queues, and the thread says so plainly: "Codex is getting ready —
  your message is queued." Never a blocked input.

### 6.7 Keyboard (new; a workbench requirement)

- `Cmd+K` — jump: threads, projects, actions, one palette.
- `Cmd+J` — switch agent in the focused thread.
- `Cmd+N` — new thread in the current project (then `Tab` toggles
  general/workshop).
- `j / k` (rail focused) — next/previous thread; `Enter` opens.
- `Esc` — collapse context panel / close palette.
- Every shortcut is discoverable: the palette lists them, and hover titles
  name them. None is the only path to anything (accessibility floor).

### 6.8 Mobile note

The three-pane layout is desktop/tablet. On phone widths the panes stack
into a drill: rail → thread → context as pushed views. The native app's
decided scope (thin: push + read-only brief) is unchanged; the responsive
web workbench is the phone fallback for now.

### 6.9 Acceptance bar for the Phase 1 UI

The dogfood gate in §3, plus three look-specific checks:

1. A stranger reads every project's health from the rail edges alone —
   the original test, passed in the new room.
2. Switching agents mid-task is: tap chip → pick → typing again. Under two
   seconds of user attention, message queued if the sandbox is cold.
3. Screenshot test: a full workbench with six projects and thirty threads
   still reads as calm — red appears only if something genuinely needs you,
   and the brief's voice is the loudest thing on screen.

---

## 7. Phase 4 — Fusion (medium; the differentiator)

Break → preceding commit → the session that produced it → one plain sentence.

1. **The join.** Extend the existing correlate step: when a break correlates
   to a change, resolve the change's commit to its session — via the
   Phase 0 trailer (Selvedge's own ships) or the daemon's commit↔session
   mapping (external work).
2. **The sentence.** In the brief and on the break's timeline entry:
   "Tuesday's checkout errors began after the change from Monday's Codex
   session (the guest-checkout work)." With a link to the session summary and
   the diff.
3. **Honesty holds.** The existing rule extends unchanged: no session in the
   window, no story invented. Multiple candidates get named as candidates —
   "began after these three changes; I can't tell which" is a correct and
   shippable output. The impressive sentence appears only when the evidence
   supports it. Marketing adjusts to the feature, never the reverse.

**Gate:** manufacture it — break a test project on purpose from an external
Codex session; the brief must trace the break to that session, in plain
English, unprompted. Then manufacture ambiguity (two plausible culprits) and
confirm the brief refuses to pick one.

---

## 8. Phase 5 — Gated and deferred (build only on evidence)

- **Paired threads + decision brief.** The thinking-thread/building-thread
  concept with an extracted, human-editable decision brief between them.
  Gated on Phase 4 proving out: build it only if the fused timeline is
  demonstrably loved in use. Its known hard problem — a stale brief producing
  a confidently wrong verdict — must be solved with evidence-dating before it
  ships, or it violates the one unforgivable rule.
- **Consumer-history import.** ChatGPT / Claude / Gemini export-ZIP importer,
  filing old chats under projects/subjects. Useful, never urgent, one-time
  value. Live capture of the native apps stays refused permanently.
- **Cursor + Gemini CLI daemon readers.** After the Claude Code + Codex
  readers survive a few tool updates.
- **Subjects (non-repo grouping).** General threads attach to projects in
  Phase 1; a standalone Subject object for non-code work waits until real use
  shows threads that genuinely belong to no project.

---

## 9. Refused (unchanged from research)

Live scraping of consumer chat apps. A generic standalone memory server. A
raw chat viewer. Competing on context storage alone. Streaming rewrites for
their own sake.

## 10. Sequencing rationale, in one paragraph

Phase 1 before the Loop because the founder is the first user: the inbox
makes Selvedge the daily workplace, which starts the history compounding
and dogfoods the handoff machinery the Loop will reuse. The Loop before
Fusion because fusion needs the daemon's commit↔session mapping to say
anything about work done outside. Paired threads last — behind evidence —
because it demands new user behavior before the differentiated thing is
proven, and its sync problem threatens the honesty rule. Small Phase 0
first because stamping and the thread schema are load-bearing for
everything and cost almost nothing.

---

## 11. Build log

What has actually been built against this brief, and what the build learned.
Kept here so the plan and its execution stay in one place.

### Phase 0 — Groundwork: **done** (Aug 2026)

- **Commit stamping.** `provenance/trailer.ts` — pure, dependency-free, so
  ship (layer 5) writes it and correlation (layer 3) can read it without
  either importing the other. Every Workshop ship's commit now carries
  `Selvedge-Session: <thread id>` as a real git trailer. The session id is the
  *thread*: the conversation is the session, which is what makes the Phase 4
  sentence ("the change from Monday's session") resolvable to something a
  person can open. Stamping is evidence, never a gate — a ship whose thread
  can't be resolved still ships, unstamped.
- **Threads schema.** Migration 0022, exactly the columns named in §2.2, plus
  `thread_id` on `agent_messages` and `agent_runs`. Each project's existing
  conversation became its thread #1, dated by the oldest thing it holds and
  carrying the model the project was actually running under. Backfilled ids
  are derived from (org, project), so the whole migration is re-runnable and
  every legacy row maps to exactly one thread by construction. The tenancy
  test passes unchanged, and a new structural test (`test/threads/contract`)
  fails the build if any writer forgets to name a thread — the columns are
  nullable on purpose, so a forgetful writer would otherwise fail silently.
- **Handoff seam.** `handoff/compose.ts`, pure. Carries what a new agent
  cannot work out for itself: what the project is and what breaking it costs,
  the story so far, where the work stands, and the unanswered ask verbatim. It
  deliberately omits the standing agent rules (already sent every turn) and
  the code (the repository is the truth).
  - **Size target, honestly reported.** Under 10% of the transcript is met
    from roughly twenty rounds of real work onward (8.7% at twenty, 2.8% at
    sixty), by way of an absolute cap rather than a ratio: a year-long thread
    hands over for the price of a week-old one. On a very short thread the
    payload is *larger* than the transcript, because the project context is a
    fixed cost and a four-message conversation has nothing to compress. That
    is the right trade and it is recorded rather than averaged away.
- **Agent registry.** `shared/agents.ts` — the table the switcher, the thread
  store and the handoff all read: id, mono chip, thread kinds, provider,
  honest cost note, and `live`. Codex, Claude chat and GPT are declared and
  **not live**; the seam is honest about the roadmap without offering a
  picker entry that would fail on first use.
- **No visible product change**, as the gate requires: the Workshop looks and
  behaves exactly as it did, writing into the thread it always had.

### Phase 1 — The Inbox: **built** (Aug 2026)

The room, and the machinery under it. What landed, and what is honestly not
yet proven:

- **Threads per project, on a real surface.** `/inbox` is one persistent
  three-pane workbench — rail (projects with their edges, threads
  newest-first, the brief pinned), thread (the conversation, the activity
  feed, the ship controls, the composer), context (work cards, the live
  preview, the pack). The Workshop page is gone; `/projects/:id/workshop`
  redirects into that project's workshop thread, so no old link breaks.
- **General threads.** A second kind of conversation with no sandbox anywhere
  near it: direct model calls on the existing LLM seam, metered as purpose
  `chat` against the thread, on the thinking side of the budget split that
  retired Sketch left behind — an afternoon of thinking can never turn
  tomorrow morning's brief mechanical. OpenAI is now live fuel beside
  Anthropic (the client already existed as the grader's), so a chat thread
  runs on whichever the owner connected, and says plainly when neither is.
- **The switcher.** In the composer, on the chip, on Cmd+J: tap, pick, keep
  typing — no modal, no page change, no confirmation, focus back in the input.
  A general switch carries the history as it is. A workshop switch composes
  the Phase 0 handoff, parks it on the thread as one mono line —
  `⇄ continued with Codex — handoff 1.8k tokens, about $0.004` — and the next
  turn starts the new agent with it. The number is the payload's measured
  size; the price is what carrying it costs at the incoming agent's published
  input rate, and when that rate isn't in the pricing table the line says the
  size and stops rather than quoting a figure nobody can stand behind.
- **Codex in the same sandbox.** `runner/agents/driver.ts` makes "which
  builder" a parameter: one command and three parsers per agent, everything
  else — the polling loop, the live feed, the flight record, the cost
  accounting — shared. Both builders work the same checkout and keep separate
  CLI sessions.
- **Keyboard.** Cmd+K jump, Cmd+J switch, Cmd+N new thread (Tab toggles
  build/talk), j/k through the rail, Esc closes. All of it listed in the
  palette, none of it the only path to anything.

**Honestly not done, and not claimed:**

- **The Codex CLI is unverified against the live tool.** Its event stream is
  undocumented and has changed shape between versions; the parsers accept the
  shapes seen in the wild, refuse to guess at anything else, and fail a turn
  they cannot read rather than passing it. It is listed with the other
  built-but-unverified integrations in STATUS.md until someone runs it with a
  real key.
- **The dogfood gate (§3) has not been run.** It needs a live sandbox, a real
  project and a working day — a person, not a test suite. The three
  look-specific checks in §6.9 have been run: the rail's edges carry health at
  six projects and thirty threads with red appearing only on the one that
  needs you (`npx tsx scripts/shoot-workbench.ts`), and switching is a tap and
  a pick with the composer never blocked.
- **The timeline tab is Phase 2**, so the context panel carries Work, Preview
  and Pack and does not pretend otherwise.
