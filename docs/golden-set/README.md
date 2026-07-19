# Golden set — Greg's hand-written reference briefs

The Phase 2 brief makes this directory a **hard prerequisite**: five
hand-written golden briefs, the measuring stick for the eval harness's
style-similarity report. They are deliberately not machine-written —
generating them here would make the harness grade the model's output
against the model's own taste. This is the /docs/golden-set/ location the
Phase 2 brief specifies; the eval runner reads it directly.

The five files (filenames matter — the runner picks them up by name):

- `quiet-day.md`
- `storm-day.md`
- `mixed-day.md`
- `degraded-trust-day.md`
- `first-day.md`

Each file: the brief exactly as it should read, plain text/markdown, no
front-matter needed. The moment these files exist, `npm run evals` starts
reporting model-graded style similarity against them (reported, never
gated — taste is Greg's call in review, not CI's). Until then the runner
prints a BLOCKED notice for the style report and scores only the
mechanical gates.
