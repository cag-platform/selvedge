# Strategy documents — historical

These six memos were written before the July 2026 review cycle. They are preserved
because the reasoning is useful and some of it still holds, but **they are not the
current thesis.**

Superseded in material ways by `SELVEDGE-VIABILITY-REVIEW.md` §19–§25 at the repo root:

| Memo says | Now |
|---|---|
| "Point, don't act" — no auto-fix, no rollback; Selvedge names the change and hands you the undo | Selvedge authors, tests, deploys and verifies changes. Full builder behind the care surface (§25.1) |
| Selvedge is the *independent auditor* — "it didn't build your app, so it has no incentive to reassure you" | Retired. Once Selvedge builds most of what's in the app, alignment comes from flat pricing and a published ledger, not from abstinence (§25.1) |
| Pricing ~$12–29/month flat | Layer pricing over customer-supplied model access; managed fuel as the second option (§25.3) |
| Target: the multi-tool solo builder | Owners of live AI-built apps spending $200+/month on platform fees; agencies as market #2 (§19–20) |
| Aggregation is the wedge, memory is the moat | The wedge is bounded change (incident- or owner-initiated); the moat is earned calibration plus incentive alignment (§22) |

Still current and worth reading:

- **The false-calm prohibition** and calibrated confidence — now the product's
  constitutional rule, extended to repair verdicts.
- **Change→break correlation** (IRONCLAD 3) — still the sharpest single feature, and
  Phase 2 of `BUILD-BRIEF.md` delivers the timeline it needs.
- **Visible, portable memory** (IRONCLAD 1) — built, though the per-project view and
  import still have no user-facing surface.
- **The trust ledger** (IRONCLAD 2) — built server-side; the page does not exist yet.
- **The user research** — the six pain patterns held up against independent market
  research in July 2026, with one correction: complaints are not demand, and the
  recurring-care behaviour they imply is still unproven.

Read these for the reasoning. Read `BUILD-BRIEF.md` and `EXTRACTION-CHECKLIST.md`
for what is actually being built.
