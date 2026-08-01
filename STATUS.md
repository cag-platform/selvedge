# Selvedge — build status

Plain-English map of what's built, what's left, and what it takes to finish the
last part. Written for a non-coder. Updated at 743 tests across 103 files, all
green.

## The one-line version

Every phase's **deterministic core is built and tested** — the parts that decide,
gate, cap, verify, and remember. What's left is a single frontier: the **live
layer** that actually changes code and talks to real accounts, which needs real
infrastructure (a sandbox provider and model keys) to build and verify. It's
wired to clean plug-in points, not missing.

## What's done, phase by phase

- **Phase 0 — Foundations.** Every table is org-scoped (a test fails the build if
  a new table forgets its tenant). Migrations are one clean chain. The three
  "inert guards" that displayed a limit without enforcing it are fixed — the caps
  now actually stop.

- **Phase 1 — The connected app.** Connect GitHub, a host (Railway *or* Vercel),
  Supabase, and your own AI model key (you bring the fuel; Selvedge charges for
  the layer, not the model). All from the Connections screen. Each app gets a
  plain-English protection brief, honest about what it can't yet see.

- **Phase 2 — The watched app.** Selvedge watches whether your apps are up
  (two failed checks before it ever cries wolf), turns real deploy state into
  events, catches error-rate spikes, and shows it all as calm situation cards at
  three levels of detail. When something breaks, it lines the break up against
  the change that came just before it: "this started right after new code went
  live."

- **Phase 3 — The worked app.** Every ask — whether Selvedge raised it or you
  typed it — becomes the same card: a plain proposal, a cost estimate, a
  stop-point, an approval. Sensitive changes (payments, logins, customer data)
  can't be approved without confirming a backup. The cap genuinely stops work;
  large work pauses at checkpoints. You see it all on the Work screen.

- **Phase 4 — The verified app.** Every change ends with an honest verdict:
  *verified*, *probably working*, *I can't tell*, or *it didn't work* — it never
  inflates, and "I can't tell" is a real answer. A change that passes its checks
  is watched briefly in production and **rolled back if it breaks the app**.

- **Phase 5 — The remembered app.** Every finished change is recorded. The
  estimate for a new change is learned from what similar past ones actually cost
  (the second time is cheaper). A repeat problem carries last time's outcome:
  "I've seen this one before — last time I sorted it for about $6." The Record
  screen shows the whole history, misses included.

## The one thing left: the live layer

Three connected pieces, all needing real infrastructure to build and verify:

1. **The agent + sandbox** (the runner's injected `sandbox`/`agentStep`) — the
   part that provisions an isolated workspace and actually edits the code. Needs
   a sandbox provider (Daytona) account.
2. **The evaluating-model check runner** — today the deterministic checks (is the
   app up? did anything break?) run for real; confirming *"did it do exactly what
   was asked"* needs a model call, judged on a different model than wrote the
   change so it never grades its own work.
3. **Live deploy / rollback and token verification** — the host API calls are
   written and safe-by-default (anything unverified degrades to "can't tell,"
   never a false alarm), but haven't been run against real accounts.

Everything above these plugs into named seams that are already built and tested.
Lighting the layer up is connecting real providers to those seams — not more
core.

## How to read the code

- The **honesty rules** live in pure, isolated files with names like `verdict.ts`,
  `risk.ts`, `observe.ts`, `machine.ts` — each one tested on its own, and each
  load-bearing guard deliberately broken once to confirm a test catches it.
- The **live seams** are always injected function arguments, so the logic around
  them is provable without the network.
- The **cards table is the ledger** — nothing about your history is stored twice.
