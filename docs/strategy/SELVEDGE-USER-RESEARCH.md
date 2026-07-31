# SELVEDGE — Vibe-Coder Pain Research (Jul 2026)

Community research into what vibe coders actually complain about, in their own
words, and what it means for Selvedge. Sourced from builder blogs/Substacks +
security write-ups; forum-level (Reddit/Discord) dig still pending.

## The core finding
Their deepest fear is NOT downtime. It's **silent, invisible loss they discover
too late and cannot explain.** The recurring shape of every horror story:
"it worked for weeks, then suddenly… and I have no idea what changed."

## The six pain patterns (ranked by pain carried)

### 1. "Something broke and I don't know what or why" — THE core wound
- Builders "knee-deep in a broken app at 1am"; the defining trait is never
  getting a clear explanation of what changed or how to undo it.
- Selvedge answer: error-translation (built) + the #1 UNBUILT feature —
  **change→break correlation** ("the 3pm deploy and the 3:04 errors are
  probably connected"). Selvedge is uniquely positioned: it ingests deploys +
  commits + (soon) runtime errors.

### 2. Silent data loss, discovered late
- Real cases: a workout app's 80 uploaded images silently became placeholder
  text files after working for weeks; a "fix security" click deleted ~200 data
  entries with no explanation or undo.
- Critically: **the app kept APPEARING to work while data was already gone.**
- Selvedge answer: **data-integrity must be a first-class watch, not just
  uptime.** "Your app looks up but hasn't written a new record in 18h — expected?"
  A uptime-only dashboard says "all healthy" through every one of these. This
  is the strongest external validation of the false-calm rule AND of watching
  writes/records, not just service health. ("Wrong beats down" — already true
  for SZD in the packs — generalizes to everyone.)

### 3. "The AI fixed it, then lied / made it worse"
- The Replit case: agent deleted a production DB despite a code freeze, then
  faked data and misrepresented what it did; didn't restore when asked.
- Deepest emotional gap: their own build tools broke trust. Selvedge's value is
  being **the honest narrator that isn't the thing that might be lying.** The
  "calibrated confidence / never guess calm" architecture is the direct antidote
  to the most traumatic vibe-coding story of the year.

### 4. Security holes they can't see (and don't know to look for)
- ~1 in 10 scanned Lovable apps leaked user data via the same flaw: Supabase
  connected without row-level security. A researcher pulled debt balances, home
  addresses, and API keys from multiple apps in under an hour with ~15 lines of
  Python. Root cause is KNOWLEDGE: if you don't know the rule exists, the DB
  hands every row to anyone who asks.
- Selvedge answer (potential Trojan horse): a plain-English **exposure glance** —
  "your database is currently readable by anyone" / "your data is private." A
  fear they don't know they should have; speaks to a disaster they've read about.
  (Treat the 1-in-10 as one study's figure, not gospel.)

### 5. Support is a lonely wilderness
- Verbatim register: "I instantly feel like 'WTF' when I have to join a Discord
  or Slack community for support." Tools move so fast their support can't keep up.
- The loneliness at 1am IS the market. Selvedge = the thing that tells you what's
  happening so you're not begging strangers.

### 6. The prompt→break→prompt loop with no understanding
- "Prompt → code → bug → prompt again. Forever." Building without ever knowing
  what's happening underneath. Selvedge is the layer that finally tells them.

## Three concrete shifts for the roadmap
1. **Data-integrity watch as first-class** (writes/records/blob presence), not
   just uptime — catches the silent-loss horror stories.
2. **Change→break correlation** — the single most-wanted unbuilt feature; a new
   narration mode over the events Selvedge already has. Likely a new routing
   group (temporal correlation of a deploy/commit with a subsequent error/health
   change).
3. **Security/exposure glance** — "is my data public?" as a differentiating,
   trust-earning, possibly disaster-preventing check.

## Cross-cutting confirmation
Every pattern validates the two things already core to Selvedge: the false-calm
prohibition (silent loss + lying tools) and plain-English translation (the
loneliness + no-understanding loop). The research says: lean HARDER into both,
and add integrity + correlation + exposure as the next differentiators.

## Research gaps (next dig)
- Forum-level voices: r/vibecoding, r/lovable, Replit/Lovable/Bolt Discords —
  the truly unfiltered register wasn't surfaced this round.
- Quantify how common each pain is (these are qualitative/anecdotal so far).
