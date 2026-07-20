# Selvedge — Design Notes ("The Look")

The design direction is locked by the approved Today-screen prototype and
implemented as a token system. This file records the rules, the budgets,
and the honest tensions.

> Note: the approved prototype (`/docs/ui/selvedge-today.html`) referenced
> by the build prompts was not present in the repository when the system
> was built; every value was implemented from the prompt set's enumerated
> tokens. When the prototype file lands, verify tokens against it.

## The thesis

Selvedge sells calm. "Cloth and light": a chalk-paper daylight ground,
frosted panes, and one signature element — the **selvedge edge**, a
status-colored seam down the left of the brief and every project card.
The acceptance bar: *a stranger reads the whole stack's health from the
edges alone.*

## Tokens

`src/client/styles/tokens.css` is the single source of truth. The Tailwind
theme (`tailwind.config.js`) only references the custom properties — no
raw value exists anywhere else, enforced by review and by grep (no
`slate-`/`amber-`/hex literals in `src/client`). `/styleguide` (public,
tokens only) renders every token and is the living contract.

## Color rationing (load-bearing)

- `--thread` (selvedge red) appears **only** for what needs the user.
  It is never decorative, never a hover, never a chart color.
- The needs edge carries the app's **only glow**.
- `cannot_tell` / unverifiable renders as `--ink-faint` **dashed** —
  shape-distinct from every solid edge so "I can't see this" can never be
  misread as "fine", including by colorblind users.
- Verdict → edge is fixed vocabulary: `users_fine`→healthy,
  `users_affected`→thread, `cannot_tell`→unknown-dashed.

## Type registers (load-bearing)

Three faces, three jobs: Fraunces for the note's voice (headline, close),
Inter Tight for plain language, JetBrains Mono **only** for the technical
register. Drill-down *shifts typeface* (body → mono) — the technical
register is a different material, not a smaller font.

## Accessibility floor

- **Color is never the only signal.** Every edge is accompanied by plain
  text that carries the same information (health lines on cards, verdict
  sentences in the brief); the unknown state is additionally
  shape-distinct (dashed). Edges and dots are `aria-hidden` decoration
  over that text.
- **Focus**: brass focus rings (`outline-brass`) on every interactive
  element; `:focus-visible` so pointer users aren't shouted at.
- **Landmarks**: `<header>`, `<nav aria-label="Primary">`, `<main>`,
  `<section>` with labels where content warrants.
- **Disclosure** is a real `<details>` (`Reveal`) — keyboard and screen
  reader behavior for free.
- **Contrast**: `--ink` (12.6:1) and `--ink-dim` (5.6:1) on paper pass AA
  for body text. `--ink-faint` (≈2.9:1) does **not** pass for body copy —
  by rule it is restricted to non-essential, duplicated, or decorative
  text (eyebrows, meta lines, disabled affordances) and may never be the
  sole carrier of information. This is a deliberate tension in the locked
  palette, documented rather than silently "fixed".

## Glass performance budget

- Glass is progressive enhancement: solid `--panel` by default;
  translucency + blur exist only inside
  `@supports (backdrop-filter: ...)`. Readability never depends on blur.
- **At most two** simultaneous `backdrop-filter` layers per screen: the
  nav bar and the brief pane. Cards, panes, tray rows are solid `--panel`
  by design — they sit on flat paper where blur buys nothing.
- **Never nest** a blurred element inside another blurred element.
- `prefers-reduced-transparency` collapses all glass to solid fills.

## Motion

One token: `--settle` (560ms, gentle ease). One gentle arrival, then
stillness — nothing loops, nothing pulses. All transitions and the
compose-in animation use the token's duration, and the token collapses to
0ms under `prefers-reduced-motion`, so every animation (including hover
transitions) disables itself automatically. No animation may use any
other duration.

## Voice in the chrome

Empty states invite action in the product's voice ("Nothing unsorted —
every event has a home."). Errors speak plainly, no infrastructure nouns
at plain register (composer doc §9 lexicon). The unsorted tray is calm by
design — unknown-dashed edges, "tell me once where these belong", never
an error state.
