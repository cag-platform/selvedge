# IRONCLAD 4 — Win the Multi-Tool Builder ("Be First at 1am")

**Thesis link:** The teardown exposed a contradiction — the moat (aggregation)
serves the *multi-tool* builder, but the old framing targeted the *non-technical*
builder, for whom single-platform native tooling is already enough. This brief
resolves it in the funnel: detect and win the multi-tool builder, and bend
onboarding + pricing + habit toward being the FIRST thing they open when
something breaks. If Selvedge is first, it's a company; if second, it's an add-on.

**Repos:** `selvedge` (detection, pricing, activation), `selvedge-mobile` (the
1am surface: push + widget), positioning/copy.

---

## The customer, precisely
Not "non-technical." The **multi-tool solo builder**: has outgrown a single
platform (runs 2+ of GitHub/Railway/Vercel/Neon/Supabase/a runtime), but hasn't
grown into an engineering team or Datadog. Technical enough that aggregation is
real for them; still wants plain English at their least-confident moments. Every
"non-technical" claim in old copy → "the builder who outgrew a single platform."

## Build

### A. Detect multi-tool-ness and lean into it
- On connect, count distinct platforms. A 1-platform user gets a gentle nudge
  ("connect your database and host so I can see the whole picture — that's where
  I'm most useful"); a 2+ user immediately gets the aggregated cross-stack brief
  that no single platform can give them.
- Instrument activation by platform-count: the value curve (and retention)
  should rise sharply at 2+. If it doesn't, the moat is weaker than assumed —
  this is the key metric to watch (ties to the memo's benchmark).

### B. Onboarding that reaches felt value in <2 minutes
- GitHub login → auto-draft packs → **offer architecture-doc upload** (Ironclad
  1's import) to pre-seed, since they have Claude-written docs. Non-empty memory
  on day one.
- Do NOT front-load the stakes interview. Draft stakes from the code/connectors,
  ask the user only to *confirm* (one tap: "this looks like it takes payments —
  right?"). Resolve the "I don't know my own infra" problem by having Selvedge
  guess and the user confirm — never making the user the expert on their setup.
- First brief within the session, even if thin: "Here's what I can see, here's
  what I can't yet, connect one more thing and tomorrow's is sharper."

### C. Be FIRST at 1am (the whole ballgame)
- **The panic button / "should I be worried?"** — a reactive, on-demand check
  (not just the scheduled brief). Something feels off → open Selvedge → it looks
  at everything now and answers in plain words whether they can go back to bed.
  This is the behavior that makes Selvedge the first tab, not the platform.
- **Native push + lock-screen widget** (from the iOS build) carry the glance so
  "is it okay?" is answered before they even open anything — and when they do
  open something in a crisis, it's Selvedge.
- Change→break correlation (Ironclad 3) is the payoff at 1am: it answers the
  exact question they'd otherwise open the build-platform to ask.

### D. Pricing — flat, predictable, solo-friendly
- One low flat monthly (benchmark band ~$24-29 where ObserveOne/Better Stack/
  Vibe App Scanner cluster; Pro target $12-19 already set — validate against
  this band). NO per-seat / per-contributor / per-host — those models are the
  exact thing that alienated indie users of Sentry/Better Stack/New Relic.
- Free tier that seeds the daily-brief HABIT (1 project, the brief, the panic
  button) — the habit is the conversion engine, so don't cripple the brief in
  free.
- Billing already built dormant (Phase 3); this brief sets the *shape* (flat,
  habit-seeding free tier), to switch on for the first outside user.

### E. Category language everywhere (kill the wrong words)
- Never "observability" or "dashboard" in product/marketing. Selvedge is a
  **narrator / standing interpreter / the brief**. Positioning line candidates:
  "The brief that tells you the truth about your apps." / "You built it across
  five tools. I watch all five and tell you what's happening — plainly, and
  honestly." Test against the multi-tool builder, not the pure non-coder.

## Acceptance
1. Connect-flow counts platforms; 2+ users get an aggregated first brief; 1-tool
   users get a specific nudge to add the highest-value next connector.
2. Activation dashboard segments by platform-count; the 2+ cohort's value/
   retention is measurable (the moat test).
3. New user reaches a first brief within one session without a jargon wall;
   stakes are Selvedge-drafted and user-confirmed, never user-authored cold.
4. The panic button returns a plain "you're fine / here's the one thing" answer
   on demand, drawing on the same engine as the brief.
5. Pricing is flat with a habit-seeding free tier; no per-seat/host/contributor
   dimension anywhere.
6. Zero occurrences of "observability" or "dashboard" in user-facing copy.

## Non-goals
No team/collaboration features (target is the solo multi-tool builder; Studio/
agency tier stays a later note). No aggressive lock-in (Ironclad 1's export
stands — trust posture over lock-in). No broad "non-technical everyone" targeting
that reopens the resolved contradiction.
