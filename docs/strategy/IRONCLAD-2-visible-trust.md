# IRONCLAD 2 — Trust as a Visible System ("The Auditor's Stance")

**Thesis link:** Trust is the position. Selvedge didn't build your app, so it has
no incentive to reassure you — and the platforms structurally can't occupy that
independent-auditor seat (Replit narrating Replit is the fox guarding the
henhouse). Today calibrated confidence lives inside prompts and rules; this brief
makes it a *visible, auditable, first-class system* the user can see and rely on.

**Repos:** `selvedge` (produces confidence + provenance), `selvedge-mobile`
(renders it), copy/positioning (makes the stance explicit).

---

## Why this is a top-tier improvement
The most powerful fact in the whole market: builders' own AI tools deleted their
data and lied about it. The willingness of a non/semi-technical user to *rely* on
Selvedge's brief instead of re-checking six dashboards depends entirely on
believing Selvedge won't falsely reassure. That belief has to be *earned and
shown*, not asserted in a system prompt.

## Build

### A. Confidence on every claim (visible, not internal)
- Every narrated statement carries a confidence the UI can render: grounded /
  inferred / unknown (already in the schema for errors — generalize it to ALL
  narration). Grounded = read the actual failing rule / real host signal.
  Inferred = pattern/heuristic. Unknown = say so.
- Visual: the SelvedgeEdge already encodes status; add a lightweight confidence
  affordance (e.g. the `unknown` dashed edge, plus a small "how sure" marker on
  attention items). Low confidence is never hidden to look calmer.

### B. "Why I said this" — auditable provenance
- Every claim can expand to show what it was based on: the source event(s), the
  log window, the code_ref, the baseline it compared against. One tap from
  "your retailers are fine" to "because the last health check at 6:58am passed
  and the previous version is still serving."
- This is the auditor's workpaper. It's what lets a burned user *verify* rather
  than *trust blindly* — which paradoxically is what earns the trust.

### C. The honesty ledger (make calibration measurable)
- Track, per org: how often Selvedge said grounded vs inferred vs unknown, and —
  where confirmable — whether its verdicts held up. Surface a plain-English
  "track record": "This month I was certain 82% of the time and told you when I
  wasn't." A product that publishes its own accuracy is one no fox-in-henhouse
  platform will imitate.
- Wire feedback: a "this was wrong" tap on any claim retires the underlying
  learned item AND counts against the honesty ledger, closing the loop.

### D. The independent-auditor stance, made explicit
- Product copy + onboarding state the position plainly: *"Selvedge didn't build
  your apps. That's the point — I have no reason to tell you everything's fine
  when it isn't."* This is positioning, not decoration; it names why Selvedge
  can be trusted where the build-tools can't.
- The narrator never adopts a reassuring-by-default tone. The composer's
  false-calm prohibition is promoted from a rule to a *published guarantee*.

### E. The unforgivable-error tripwire
- A monitored invariant: if Selvedge ever emits a `users_fine`/all-clear verdict
  that is later contradicted by a real outage signal in the same window, that's
  logged as a Class-1 incident on the honesty ledger and triggers a correction
  brief ("earlier I said X was fine — it wasn't, here's what I missed"). Owning
  the miss out loud is the single most trust-building act available.

## Acceptance
1. Every narrated claim renders a confidence level; low confidence is visibly
   distinct and never masked.
2. Any claim expands to its provenance (events/logs/code_ref/baseline).
3. The honesty ledger shows the grounded/inferred/unknown mix and a plain track
   record; a "wrong" tap decrements it and retires the item.
4. A seeded false-all-clear (test) triggers a correction brief and a Class-1
   ledger entry.
5. Onboarding + at least one product surface state the independent-auditor stance
   explicitly.

## Non-goals
No fabricated precision (don't invent a confidence % that isn't measured — bands,
not false decimals). No comparative claims about competitors' honesty in-product
(state Selvedge's stance, don't attack). The ledger measures Selvedge's own
calibration, not the user's apps.
