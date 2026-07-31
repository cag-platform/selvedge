# IRONCLAD 3 — Change→Break Correlation ("What You Changed, What Broke")

**Thesis link:** The sharpest expression of "the truth your build-tool won't tell
you." Every vibe-coder horror story is the same shape: *"it worked for weeks,
then I asked the AI to add a thing, and something else broke — and I have no idea
they're connected."* Nobody sells the calm answer to that. Selvedge already
ingests the changes (commits/deploys) AND the breaks (errors/health) — it is
uniquely positioned to draw the line between them.

**Repos:** `selvedge` (the correlation engine + narration), `selvedge-mobile`
(renders the correlated story). Depends on Phase 3 connectors + runtime errors.

---

## Why this is the feature that makes it a company
The research is unambiguous: this is the #1 most-common, most-painful,
least-served vibe-coder problem. Platform-native tools narrate incidents but
rarely say *"the deploy you made at 3pm is why this started at 3:04."* It's the
single clearest demonstration that Selvedge tells you something your build-tool
won't — and it's only possible because Selvedge holds changes and breaks in one
timeline.

## Build

### A. The unified timeline (foundation)
- All events already flow through one envelope. Ensure changes (commit merged,
  deploy started/succeeded, config/env change, dependency bump) and breaks
  (new/spiking error signature, health-check failure, integrity anomaly) sit on
  ONE per-project ordered timeline with precise timestamps.
- Capture "change surface area" where available: which files/routes a deploy
  touched (from the diff via GitHub), so correlation can be *specific* ("the
  order route changed") not just temporal ("something changed").

### B. The correlation engine (deterministic first, LLM to explain)
- **Temporal proximity:** a new or spiking break within a tuned window after a
  change is a candidate correlation. Window scales by stakes (tighter for
  live_critical).
- **Surface overlap (the strong signal):** the break's route/component
  intersects the change's touched files/routes → high-confidence correlation.
  ("The deploy changed `orders/validate.ts`; the new error is on `POST /orders`.")
- **Baseline break:** the break is new relative to the learned baseline (this
  error never fired before this change) → strong novelty signal.
- Deterministic scoring produces a correlation confidence (grounded / inferred /
  coincidental-possible). The LLM only *explains* the established link in plain
  English — it never invents the causal claim. Same discipline as everywhere:
  code decides, model narrates.

### C. The narration (verdict-first, causal, honest about confidence)
- Grounded: *"The change you shipped at 3:02pm touched the order form, and orders
  started failing at 3:04. These are almost certainly connected. One order was
  affected. Here's the exact rule that changed."*
- Inferred: *"Something you changed around 3pm lines up with this error starting
  — I can't prove they're linked, but the timing is close. Worth a look."*
- Explicitly resist false causation: if timing is loose and surfaces don't
  overlap, say "probably unrelated, but noting both." Correlation stated as
  causation is this feature's version of false-calm — forbidden.

### D. The rollback pointer (don't fix, point)
- When a change is the grounded cause, name the specific change and — where the
  platform supports it — link to *its* rollback (Railway/Vercel redeploy of the
  prior version, the git revert target). Selvedge doesn't fix (non-goal), but it
  hands the user the exact undo. For the "AI broke it and I don't know what
  changed" user, "revert this specific deploy" is the most valuable sentence
  possible.

### E. Routing (new group, or extend H)
- A grounded change→break on a live_critical/money-path app is a ⚡ push:
  "a change you made is breaking live orders — here's the change and the undo."
- Ungrounded/coincidental correlations fold into the digest, never push.

## Acceptance
1. A test sequence (deploy touching a route → error on that route) produces a
   grounded correlation naming the change, the break, the overlap, and the undo.
2. A deploy + an unrelated error with no surface overlap and loose timing is
   narrated as "probably unrelated," NOT as causation.
3. Correlation confidence renders visibly (grounded/inferred) per Ironclad 2.
4. A grounded live-critical change→break pushes with the change + rollback
   pointer; coincidental ones stay in the digest.
5. The correlation is drawn from the unified timeline, not a single source
   (proven by a test spanning a GitHub change + a Railway/runtime break).

## Non-goals
No auto-rollback or auto-fix (point, don't act). No multi-change blame
attribution beyond naming the most-likely change + noting others (don't
over-claim which of several changes did it — offer the ranked candidates). No
cross-project causation yet (a change in app A breaking app B) — that's a later
extension once single-app correlation is trusted.
