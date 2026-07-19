# Routing Table — v1

The router is Layer 3: deliberately boring, deterministic, unit-testable code. It reads an
event plus the project's context pack and outputs two decisions:

**Narration path** — how the sentence gets made:
- `SILENT` — no narration; event is logged to memory only
- `TEMPLATE` — slot-filled known phrasing, no LLM
- `LIB` — graduated-library lookup first, falling back to `LLM` on miss
- `LLM` — full Claude call with the context pack
- `LLM+VERDICT` — Claude call that MUST return a users-affected verdict (or an honest "can't tell yet")

**Delivery** — where it lands:
- `NONE` — memory only
- `DIGEST` — folds into the next morning brief
- `PUSH` — immediate notification (still respects quiet hours except where marked ⚡, which overrides them)

Stakes tiers: `SBX` sandbox · `PER` personal · `LS` live_small · `LC` live_critical.
`voice.notify.push_threshold` caps delivery downward (a `never` project can't push, period).
`PUSH` always implies the item also appears in the next digest.

---

## Group A — Code events (source: GitHub / source_of_truth)

| # | Event | SBX | PER | LS | LC | Notes |
|---|---|---|---|---|---|---|
| A1 | commit pushed to non-default branch | SILENT/NONE | SILENT/NONE | SILENT/NONE | SILENT/NONE | Raw commits are noise; they roll up into A4/A5 summaries |
| A2 | commits land on default branch (direct or merge) | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LIB/DIGEST | LIB/DIGEST | Digest line summarizes the day's merged work per project, not per commit |
| A3 | PR opened | TEMPLATE/DIGEST | TEMPLATE/DIGEST | TEMPLATE/DIGEST | TEMPLATE/DIGEST | "New work started: <plain gist>" — gist generated once (LLM), cached on the in_progress item |
| A4 | large merge / phase-milestone-sized change (Δ above baseline norm) | LIB/DIGEST | LIB/DIGEST | LLM/DIGEST | LLM/DIGEST | The **mid-build progress narration**: "SZD's hardest piece — the measurement worker — moved forward today: <layman gist>". This is how mid-project apps get storyline, not just status |
| A5 | branch/PR crosses stall threshold (default 14d quiet) | TEMPLATE/DIGEST | TEMPLATE/DIGEST | TEMPLATE/DIGEST | TEMPLATE/DIGEST | Gentle, max once per item per 2 weeks: "still want this?" Feeds Ideas surface |
| A6 | activity on a **dormant** project (any push/PR) | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LIB/DIGEST | LIB/DIGEST | Dormancy inverts novelty: the activity itself is the news |

## Group B — Build & deploy events (source: host / CI)

| # | Event | SBX | PER | LS | LC | Notes |
|---|---|---|---|---|---|---|
| B1 | build started | SILENT/NONE | SILENT/NONE | SILENT/NONE | SILENT/NONE | Unless it becomes B4/B6, nobody cares |
| B2 | build succeeded, deploy succeeded | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LIB/DIGEST | LIB/DIGEST | "Your update went live cleanly." Dormant modifier (A6) upgrades wording, not channel |
| B3 | build running > 2× typical_build_seconds | SILENT/NONE | SILENT/NONE | TEMPLATE/DIGEST | TEMPLATE/PUSH | Slow-build watch only matters when someone's waiting on prod |
| B4 | build failed (never reached deploy) | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LIB/DIGEST | LLM+VERDICT/PUSH | LC verdict is usually "nothing users see changed" — that's the sentence that kills the panic |
| B5 | build failed matching known_flaky pattern | SILENT/NONE | SILENT/NONE | TEMPLATE/DIGEST | TEMPLATE/DIGEST | "The flaky check failed again — usually passes on retry." Never pushes |
| B6 | deploy failed, previous version still serving | TEMPLATE/DIGEST | LIB/DIGEST | LLM+VERDICT/DIGEST | LLM+VERDICT/PUSH | The signature moment: "Your update couldn't go live. The previous version is still running — users are fine. Here's the one thing to fix." |
| B7 | deploy failed, nothing serving (first deploy or replaced-then-died) | LIB/DIGEST | LLM/DIGEST | LLM+VERDICT/PUSH | LLM+VERDICT/PUSH ⚡ | The only build-class event that can break quiet hours, and only at LC |
| B8 | deploy on a no-CI/no-test project (pack stack_summary flag) | — | — | escalate one path level | escalate one path level | Modifier row: e.g. CAG's migrations-on-boot + no tests makes B2 → LIB/DIGEST with a watchful tone, B6 → PUSH |

## Group C — Runtime & data events (source: host / DB)

| # | Event | SBX | PER | LS | LC | Notes |
|---|---|---|---|---|---|---|
| C1 | health check failing / service down | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LLM+VERDICT/PUSH | LLM+VERDICT/PUSH ⚡ | Uses downtime_translation verbatim: "your retailers can't submit orders" |
| C2 | service recovered | TEMPLATE/DIGEST | TEMPLATE/DIGEST | TEMPLATE/PUSH | TEMPLATE/PUSH | Recovery pushes iff the outage pushed. Closes the loop — never leave a red push unanswered |
| C3 | recovered, but pack notes a hidden dependency (e.g. Postgres-as-queue) | — | — | LLM/DIGEST addendum | LLM/PUSH addendum | "The site's back — worth checking that queued background work resumed." Pack notes make this sayable |
| C4 | DB migration failed | TEMPLATE/DIGEST | LIB/DIGEST | LLM+VERDICT/PUSH | LLM+VERDICT/PUSH ⚡ | Data events skew critical: schema half-applied is scarier than a bad deploy |
| C5 | DB resource warnings (storage, connections, compute limits) | SILENT/NONE | TEMPLATE/DIGEST | TEMPLATE/DIGEST | LIB/PUSH | Predictive, not reactive: "Neon is at 85% storage — worth a look this week" |
| C6 | data-integrity signal on a correctness-critical project (pack flags "wrong > down") | — | — | LLM+VERDICT/PUSH | LLM+VERDICT/PUSH ⚡ | SZD's rule: wrong measurements outrank downtime. Pack-driven override, not tier-driven |
| C7 | error-rate spike above baseline (when error connector exists) | SILENT/NONE | TEMPLATE/DIGEST | LLM/DIGEST | LLM+VERDICT/PUSH | v1 ships without an error connector; row reserved |

## Group D — Store events (App Store Connect / Play, later phase)

| # | Event | LS | LC | Notes |
|---|---|---|---|---|
| D1 | review status changed (in review / approved / rejected) | TEMPLATE/PUSH | TEMPLATE/PUSH | Approval and rejection both push — owners refresh this screen obsessively; being told first is pure delight |
| D2 | new version live in store | TEMPLATE/PUSH | TEMPLATE/PUSH | |
| D3 | crash-rate trend worsening | LLM/DIGEST | LLM+VERDICT/PUSH | |
| D4 | beta feedback / TestFlight events (SILD's current mode) | TEMPLATE/DIGEST | TEMPLATE/DIGEST | Beta-phase apps: store narration is about testers, not the public |

## Group E — Trust & connector events (self-monitoring)

| # | Event | Any tier | Notes |
|---|---|---|---|
| E1 | connector auth failed / disconnected | TEMPLATE/PUSH | The one event class that always pushes regardless of tier: a silently blind dashboard is worse than no dashboard |
| E2 | source goes stale_suspected (quiet while sibling source changes) | TEMPLATE/DIGEST | "Your repo looks out of date with what's live — I'm narrating from the host side for now" |
| E3 | overall_confidence drops to partial/low | (modifier) | Not its own message: prepends honest hedging to every narration of that project until resolved |
| E4 | unmappable events accumulating in the unsorted tray | TEMPLATE/DIGEST | Weekly at most: "3 events I couldn't match to a project — 30 seconds to sort?" |

## Group F — Cross-project events (serves / consumes edges)

| # | Event | Rule | Notes |
|---|---|---|---|
| F1 | project X down and Y.consumes includes X | Y inherits an addendum at Y's own tier/delivery | "Loom's outage may lag order sync into Smith Bespoke." Never a separate push — riders on the X narration or Y's digest |
| F2 | X's in_progress item is named in Y.capability_gaps or blockers | LIB/DIGEST on Y | The cross-dot sentence: "SZD's tenant work moved this week — that's what YOKE's real scan is waiting on" |
| F3 | internal-tool X (personal tier) down, X.serves nonempty | TEMPLATE/DIGEST framed by consequence | Toile's rule: "doesn't affect any users, but builds are paused until it's back" |

## Group G — Standing narration (no triggering event; digest composer only)

| # | Condition | Path/Delivery | Notes |
|---|---|---|---|
| G1 | capability_gaps present on a live project | LIB/DIGEST, cadence decays (daily → every 3 days → weekly) | The YOKE drumbeat: "yokeshirts.com is healthy — day 12 of visitors being unable to buy." Decay prevents nagging; any gap-related activity resets cadence |
| G2 | project quiet N days but tier ≥ LS and healthy | TEMPLATE/weekly DIGEST | "Smith's site: quiet and healthy, as usual." One reassurance line, not silence — silence is ambiguous |
| G3 | weekly retrospective (Sunday digest) | LLM/DIGEST | "This week you shipped X, moved Y forward, and Z stayed stalled." The memory product |
| G4 | mid-build storyline for doc-informed packs | LLM/weekly DIGEST | For SZD/Mirror-mode projects: progress against the *hard pieces* the pack knows about, in layman's terms — "the part that turns photos into measurements got two of its three open problems closed this week" |

---

## Global modifiers (apply after the table row is chosen)

1. **push_threshold cap** — voice.notify caps delivery: `never` → max DIGEST; `critical_only` → only ⚡ rows and C1/C4/C6 may push; `everything` → any DIGEST row the user opts up.
2. **Quiet hours** — PUSH defers to morning except ⚡ rows.
3. **Trust hedge (E3)** — partial/low confidence prepends disclosure to all narration for that project.
4. **Dormancy inversion** — deploy_cadence: dormant upgrades wording ("first update in two months") but never upgrades delivery except C1/C4.
5. **Known-flaky downgrade** — matching pattern demotes any B/C row one delivery level and forces TEMPLATE.
6. **Storm collapse** — >5 push-worthy events on one project within 15 min collapse into ONE push ("several things are failing on X — one summary coming") and the digest composer takes over. Never machine-gun the user.
7. **Verdict honesty** — any LLM+VERDICT unable to determine impact must say "can't tell yet" + what it's checking. Guessing calm is prohibited (SILD lesson: confidently wrong destroys the product).

## What v1 actually implements

Groups A, B, C1–C5, E, G1–G3 — GitHub + host + DB connectors. Group D waits on App Store phase; C6/C7 wait on packs that flag correctness-critical and an error connector; G4 waits on doc-ingested packs. The table is data (a JSON rules file), not code — new rows ship without deploys.
