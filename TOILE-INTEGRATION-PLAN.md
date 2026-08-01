# Bringing Toile in — the plan

Written after surveying the Toile codebase and verifying the Daytona engine
live. Plain-English, for the founder. This is a plan to react to, not a finished
decision.

## The reframe (what changed)

- **The clear, simple status is the main feature.** Selvedge's home stays the
  calm watch: the morning brief, situation cards, "is my stuff okay." That's
  built and deployed. Nothing about it changes.
- **The fix/build engine gets Toile's actual interface**, restyled for Selvedge —
  not the thin "approve a card" flow. When you want to change or fix a project,
  you enter its builder: chat with the agent, watch it work, see a live preview,
  and ship. That IS Toile's ProjectView, made to look and behave like Selvedge.
- So the earlier "every ask is just a card" idea is the thing we rethink. The
  card governance (caps, gates, verdict, ledger) survives — but as the safety
  layer around Toile's builder, not as the builder itself.

## The product shape

```
Selvedge
├── Status (home)            ← the main feature. Watch, brief, situation cards. DONE.
│     "Is everything okay?"    Calm, plain, glanceable.
│
└── Builder (per project)    ← Toile's interface, restyled for Selvedge.
      "Fix / change this."     Chat · live preview · files · terminal · ship.
                               Entered from a project when something needs doing.
```

One product, two moods: the resting place, and — when you need it — the workshop.

## What's already verified (the good news)

Against the real Daytona account (your keys), live, this session:
- Sandbox create / run commands / delete — works.
- The base image has Node 25 and the Claude Code CLI (v2.1.19) already — no
  Node downgrade needed (a bug I'd have shipped: my setup only re-installed Node
  when it was *below* 20).
- `/workspace` needs `sudo` to write — and passwordless `sudo` works, so the
  Toile-style setup is correct. (Fix to apply: my simple provider path assumed a
  writable `/workspace`; use the sudo fallback, which is verified.)
- Token-based `git clone` path is wired (needs the workdir created first).

So the engine mechanics are real, not faith. The only unverified bit left is the
`claude -p` agent turn itself (needs the Claude token, which production has).

## What we pull from Toile

**Backend (the engine):**
- `sandbox/` — persistent per-project sandbox: lifecycle, **preview** (the live
  URL), terminal, files, checkpoint.
- `agent/` — the Claude Code runner, **stream parser** (watch it work), the
  reflection/repair loop, CLAUDE.md/workspace setup.
- routes — `messages` (chat + SSE stream), `builds`, `preview`, `ship`,
  `deploy`, `files`, `terminal`.
- `providers/` (Railway adapter — Selvedge already has this).

**Frontend (the interface):**
- `ProjectView` and its panels: `Composer` (chat), the streaming activity thread,
  `PreviewPane`, `FilesPanel` / `CodeEditor` / `DiffView` / `FileTree`,
  `TerminalPane`, `ShipPanel` / `PublishPanel`, `BuildStrip` / `RunsList`,
  `CostDashboard`, and the database/secrets panels.
- The SSE stream hook.

## The hard parts (where the real work is)

1. **Tenancy.** Toile is single-user — one passkey, one settings row, no orgs.
   Every Toile table (`projects`, `messages`, `build_runs`, health tables…) and
   every route must be org-scoped to Selvedge's tenant model. This is the single
   biggest job — the same shape as Selvedge's original Phase-0 tenancy work, done
   again for Toile's ~11 tables.
2. **Two "project" models.** Selvedge has `packs` (what a project *is* + its
   watch config). Toile has `projects` (build state: sandbox id, session, repo).
   Decision needed: merge into one, or keep the pack as the identity and attach
   Toile's build state to it. (Recommend: one project row, Selvedge's, with
   Toile's build fields added.)
3. **Design restyle.** Toile's components wear Toile's look; they need Selvedge's
   design system (Fraunces/Inter, the calm tokens, the selvedge edge). Mechanical
   but broad.
4. **Governance weave.** Where do the cap / risk-gate / verdict / ledger apply?
   Recommendation: **building in the sandbox is free-form** (it's a throwaway
   sandbox, no production impact) — you chat and iterate freely. Governance bites
   at **ship**: a sensitive change (payments/auth/data) needs the verified-backup
   gate; spend is capped and checkpointed; the change is verified before it goes
   live and watched after, with rollback. So Toile's freedom + Selvedge's safety,
   at the one moment it matters.
5. **Sandbox model.** Adopt Toile's persistent-per-project sandbox (verified
   working). Selvedge's ephemeral runner is retired as the builder; its cap /
   checkpoint / verdict logic is reused as the ship-time governor.

## What of my recent work survives

- **Keep as governance:** the cap that stops, risk tiering, the five-value
  verdict, the observation window + rollback, the ledger/track-record, cost
  learning. These wrap Toile's builder at ship time.
- **Rethink:** the card-as-builder UI and the ephemeral runner. The card becomes
  (at most) the *record* of a shipped change in the ledger, not the way you build.

## Proposed build order

- **A — Engine under tenancy.** Port Toile's `sandbox/` + `agent/` + the chat/
  build routes into Selvedge, org-scoped, headless. Builds on the verified
  Daytona work. *Deliverable: a project can run an agent turn with streaming and
  a live preview, via the API, scoped to your org.*
- **B — The builder interface.** Port `ProjectView` (chat + streaming + preview),
  restyled. *Deliverable: you open a project, chat, watch it build, see it live.*
- **C — Ship + governance.** The ship flow (deploy), with the backup gate, cap,
  verify, observe/rollback, ledger woven in. *Deliverable: one button takes a
  change live, safely, recorded.*
- **D — Depth.** Files/editor/diff/terminal, database + secrets panels, build
  history. *Deliverable: the full workshop.*

## The decisions I need from you

1. **Governance model:** free-form building, safety at ship (my recommendation) —
   or every change gated up front?
2. **Projects:** one merged project row (recommend), or keep pack + linked build
   state?
3. **v1 scope:** is A→B→C (chat, preview, ship — the core loop) the first real
   milestone, with D (files/terminal/db panels) after? Or do you want a specific
   panel sooner?
4. **Fleet vs Status:** Toile has its own Fleet (health/ops) view that overlaps
   Selvedge's Status. Fold Toile's ops actions (restart/redeploy) into Selvedge's
   Status, and drop Toile's Fleet page? (Recommend: yes.)
