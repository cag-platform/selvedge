# IRONCLAD 1 — Make the Memory Visible & Portable ("The Moat You Can See")

**Thesis link:** Memory is the moat. But a moat nobody can see doesn't create a
felt switching cost, and a moat that silently rots is worse than none. This
brief makes the compounding context *visible to the user* (so they feel it
deepening) and *durable* (so it never quietly degrades).

**Repos:** `selvedge` (owns it), `selvedge-mobile` (renders it).

---

## Why this is #1
Anyone can copy Selvedge's narration in a sprint. What compounds is the per-app
context pack + `error_knowledge` dictionary + baselines. Today that value is
invisible — it works silently in the background. If the user can't *see* it
deepening, they don't perceive the switching cost, and Selvedge feels as
replaceable as any dashboard. Make the memory a visible, growing asset.

## Build

### A. "What Selvedge has learned" — the memory surface
- A per-project view that shows the accumulated intelligence in plain English:
  "I've learned 14 of Loom's error types, know its normal deploy rhythm
  (~weekly), and recognize 3 checks that are flaky-but-fine." Not a raw dump —
  a plain-language summary of depth.
- A stack-level roll-up on the profile: "Selvedge has watched your 9 apps for
  38 days and learned 120 things about how they behave." A visible, growing
  number that IS the switching cost, made legible.
- Every graduated error signature, baseline, and glossary override is listed
  with its plain meaning and when it was learned. The user should think: "I'd
  lose all of this if I left."

### B. Memory freshness / anti-rot
- Each learned item carries a confidence + last-confirmed date. Items that
  haven't recurred in a long time are marked "possibly stale, still assumed."
- A background job re-validates baselines (deploy cadence, flaky sets) on a
  rolling window so "normal" tracks reality; when normal shifts, the memory
  updates and the brief can note it ("your deploy rhythm changed this month").
- Never silently trust dead knowledge: a graduated meaning whose code_ref no
  longer exists in the repo is flagged for re-grounding, not served blindly.

### C. Portability (turn a lock-in into a trust play)
- **Export**: the user can download their full context (packs, learned error
  dictionary, baselines) as JSON/markdown. Counterintuitively, being able to
  *leave* increases trust enough to make them *stay* — and it's the honest,
  anti-lock-in posture that fits the independent-auditor position.
- **Import / seed**: accept an architecture doc (they all have Claude-written
  ones) to pre-seed a pack on day one — the fastest path to felt value, and it
  makes the memory start non-empty. (This was the "upload your architecture doc"
  onboarding idea; formalize it here.)

### D. Make the brief reference its own memory
- The narrator should occasionally surface the depth: "I've seen this Neon
  warning before — last time it cleared on its own within an hour," or "this is
  a new error type for Loom; first time I've seen it." Referencing accumulated
  memory in the daily brief is what makes the compounding *felt* every morning,
  not just visible in a settings page.

## Acceptance
1. A user can open a project and read, in plain English, what Selvedge has
   learned about it, with learned-on dates.
2. The profile shows a growing stack-level "things learned" count that increases
   as dogfding continues.
3. Export produces a complete, re-importable context bundle; import from an
   architecture doc pre-seeds a usable pack.
4. A stale/oprhaned learned item (code_ref gone) is flagged, not served.
5. At least one brief per week references prior memory ("seen this before" /
   "new for this app") when the data supports it.

## Non-goals
No ML personalization beyond the existing graduation mechanics. No cross-user
learning yet (each org's memory is its own; shared-library graduation stays
internal and privacy-safe). Portability is per-user export, not a public format.
