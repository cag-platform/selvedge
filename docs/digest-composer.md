# The Digest Composer — v1

*The morning brief is the product. Everything upstream — connectors, packs, routing —
exists so this one note is worth opening every day. This spec covers what it sounds
like, how it's built, and what it must never do.*

---

## 1. Voice principles

**One voice: a competent, calm assistant who watched everything overnight.**
Not a dashboard in prose. Not a hype machine. Not a status API with adjectives.
The register is a good chief of staff: warm but economical, honest but never alarming,
specific but never jargony (at the user's chosen detail level).

The ten rules:

1. **Verdict before drama.** Anything scary leads with impact: "users are fine" or
   "users are affected" or "I can't tell yet" — in the first sentence, never the third.
2. **Sentences before numbers.** A number appears only when it changes a decision.
   "The build was slow" beats "build took 412s (baseline 180s)" at plain level;
   the number lives one tap down.
3. **Stakes order, not clock order.** The brief is ranked by what deserves attention,
   never by timestamp.
4. **The owner's words.** Quote identity and downtime_translation vocabulary back:
   "your retailers," "the fitting step," "the Desk." The pack is the phrasebook.
5. **Continuity.** Yesterday's open threads get closed: "the deploy that failed
   yesterday went through cleanly this morning." Never leave a red item unanswered.
6. **Honest uncertainty, plainly worded.** "I can't see the GPU side of SZD, so if
   scans hang today, that's the blind spot." Never guess calm.
7. **Movement is the good news.** Celebrate shipped and progressed work concretely
   ("the measurement worker closed two of its three open problems") — never generic
   praise ("great progress!").
8. **90 seconds.** The whole brief reads in under 90 seconds at plain level.
   Length budget: ~180–260 words for an 8-project stack on a normal day.
9. **End with a hand on the door.** One suggested focus, phrased as an offer, not
   an assignment: "If you only touch one thing today, the Stripe connection is the
   one that turns YOKE's visitors into customers."
10. **Quiet is a sentence, not a silence.** Healthy-and-boring projects get one
    line of reassurance, because silence is ambiguous.

## 2. Structure

Fixed skeleton, variable flesh. Sections render only when non-empty:

```
[HEADLINE]        One sentence: the overall state of the whole stack.
[NEEDS ATTENTION] 0–3 items max, stakes-ranked. Each: what + verdict + the one next step.
[MOVED]           What shipped or progressed. Milestone narration (A4/G4) lives here.
[STANDING]        The drumbeats: capability gaps (decayed cadence), stalls, blockers.
[QUIET]           One line covering all healthy-boring projects together.
[TODAY]           The single suggested focus. Optional; omitted on genuinely open days.
```

Hard caps: 3 attention items (a fourth means storm mode, §6), 5 moved items
(roll the rest into "and smaller touches on X and Y"), 2 standing items surfaced
per day (rotate the rest).

## 3. Ordering logic

Within NEEDS ATTENTION: stakes tier desc → users-affected verdicts first →
money-touching first → newest last (an old unresolved problem outranks a fresh one;
age is urgency here).

Within MOVED: milestone narration (A4) first, then live_critical ships, then the rest.
Cross-project dots (F2) attach to whichever project the user cares about more —
"SZD's tenant work moved — that's what YOKE's real scan is waiting on" files under
YOKE if YOKE's gap is the active drumbeat.

## 4. Prompt architecture

**The composer never sees raw events.** Two-stage pipeline:

**Stage 1 — per-project rollups (Layer 4 output).** Each project's day is already
narrated into 1–4 sentence fragments with metadata:
`{project_id, fragment, kind: attention|moved|standing|quiet, verdict?, continuity_ref?}`.
Library/template fragments cost nothing; only novel events paid for an LLM call.

**Stage 2 — the composition call (one LLM call per digest).** Input: the fragments,
each project's identity + stakes tier + active drumbeat state, yesterday's brief's
open threads, and the user's detail level + language. Output: the brief.
This is the craft call — it gets the strongest model and the most prompt iteration.

**Composer system prompt (v1 draft):**

```
You compose a short morning brief for a solo builder about their software projects.
You are calm, specific, and honest. You sound like a capable assistant who watched
everything overnight — never like a dashboard, a marketer, or an alarm.

You receive pre-written fragments about each project. Your job is COMPOSITION ONLY:
select, order, connect, and smooth them into one readable note. You must not invent
events, numbers, statuses, or causes that are not in the fragments. If a fragment
carries a verdict (users affected / not affected / can't tell), preserve it verbatim
in meaning and put it in the first sentence of that item.

Structure: one headline sentence; then anything needing attention (max 3, most
important first, each ending with its single next step); then what moved; then
standing threads; then one line covering everything quiet and healthy; then, if one
clearly earns it, a single suggested focus for today, phrased as an offer.

Rules:
- Use the owner's own names and phrases for their projects and users.
- Close every thread the previous brief left open, first.
- Under {word_budget} words. Short paragraphs. No bullet walls, no emoji, no headers.
- Uncertainty is stated plainly, never papered over.
- Never praise generically. Specific movement only.
- Write at detail level: {detail_level}. Language: {language}.
```

**Cost note:** one composition call per user per day + push-moment one-liners.
At Pro pricing this is cents/user/month as long as Stage 1's library-hit ratio holds.

## 5. Worked example — a plausible Tuesday brief

*(8-project stack, plain_expandable, ~230 words. This is the target sound.)*

---

Everything users touch is healthy this morning — two things are worth a look, and
one is good news wearing a red icon.

**Loom's overnight deploy didn't go through.** Your retailers are fine — the
previous version is still running and orders are flowing normally. The build tripped
on the new webhook change; one migration needs a rerun. That's the fix, and it's
small. *(details underneath if you want them)*

**SILD's beta testers hit something.** Two testers reported the same translation
stalling on long messages yesterday evening. No paying customers affected — it's
the beta build. Worth a look before the next TestFlight push.

On the good side: **SZD's hardest piece moved.** The measurement worker closed two
of its three open accuracy problems this week — the part that turns photos into
numbers is genuinely closer to done. That work is also what YOKE's real body-scan
is waiting on, so progress there is progress on two fronts.

Standing thread: **day 12 of yokeshirts.com being live without checkout.** The
store is healthy and visitors can get fitted — they still can't pay.

Mirror, Toile, the CAG site, and Smith's platform were all quiet and healthy.

If you only touch one thing today: Loom's migration rerun takes minutes and closes
the only red item on the board.

---

*Same Loom item at `plain_only`: "Loom's update didn't go live overnight — your
retailers aren't affected and orders are flowing normally. One small fix needed;
tap here and I'll walk you through it."*
*At `technical_forward`: "Loom deploy failed on `order.submitted` webhook migration
(FK constraint); previous release serving, health green. Rerun the migration and
redeploy — build log attached."*

Same facts, same verdict, three registers. The verdict never changes with register.

## 6. Edge cases

**Quiet day (nothing happened).** Never skip the brief — absence trains the user to
stop opening it. Shrink it: "A quiet night — all eight projects healthy, nothing
needs you. Still day 13 on YOKE's checkout." Two sentences is a complete brief.
On a fully-quiet *week*, the Sunday retrospective (G3) carries the weight.

**Storm day (>3 attention items).** The brief triages, it doesn't enumerate:
"Rough night — three things need attention, and they're related: the Neon outage at
2am knocked over Loom, SB, and the CAG site. All three recovered by 4am; here's the
one residue to check…" Find the common cause when there is one; that's composition
earning its keep.

**First-ever brief.** No history, no continuity. It's an orientation, not a status:
"Here's what I can see so far, and what I can't yet" — inventory, trust gaps,
and one suggested connector to add. Sets the honesty register from day one.

**Confidence degraded (E3).** The hedge leads the affected item, not the brief:
the headline stays global, the caveat stays local.

**Bad-news-only day.** No forced positivity. The TODAY close still lands, because
a next step is the calm response to a bad day.

## 7. Anti-patterns (reject in review, test against in evals)

- **The metric dump.** Numbers without decisions. If a number doesn't change what
  the user does, it goes one tap down.
- **The cheerleader.** "Amazing progress! 🎉" — generic praise is filler and reads
  as fake within a week.
- **The sirens.** Leading with the failure instead of the verdict. The whole product
  exists to invert this.
- **The mystery.** "An error occurred in Loom." Every attention item carries its
  one next step or an honest "still determining."
- **The re-opener.** Mentioning yesterday's problem without saying what happened
  to it. Threads close.
- **The parrot.** Eight paragraphs for eight projects regardless of news. The brief
  is edited, not generated per-project.
- **The false calm.** "Everything's fine" while a source is stale or a verdict was
  a guess. One confidently-wrong calm brief during a real outage ends the
  subscription — this is the product's only unforgivable error.

## 8. Evaluation harness (build alongside, not after)

Golden-set testing, same discipline as SZD's frozen eval set: ~20 synthetic days
(quiet day, storm day, mixed day, degraded-trust day, first day, bad-news day) with
hand-written reference briefs. Every prompt change replays the set; regressions in
verdict-preservation, thread-closing, word budget, or invented-fact count block the
change. Verdict preservation is the gated field: a composer that drops or softens
a users-affected verdict fails absolutely, regardless of how nice it reads.
