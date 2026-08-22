# Selvedge — what the product actually is, as built

*A rundown written by reading the code on 2026-08-22, not the docs. Where the
committed docs and the code disagree, the code wins and I've said so. Intended
as a briefing document for a design conversation about the landing page.*

---

## 0. The one-line problem with the existing material

Almost every prose document in the repo (`EXPLAINER.md`, `VENTURE-CASE.md`,
`docs/strategy/SELVEDGE-POSITIONING-MEMO.md`, the current landing page) describes
a **monitoring product**: "Selvedge keeps your apps running", a 7am brief in
plain English, watch/explain/fix/prove. That framing is *stale*. The last two
weeks of commits systematically dismantled it:

```
The daily brief is retired; status moves in with the projects
Delete the Work surface; make the Inbox's refusals visible
Take the wall down: any agent, any conversation, named in the sentence
Ask is gone, server side too
Silence where there is no signal, one chat per project, no plan checkbox
#references: one conversation can read another
An old history belongs to the account, not to a project
```

What's left is a different product: **one chat window that is the home for all
your AI conversations and coding sessions — across models, across tools, across
the history you already have somewhere else.** The monitoring machinery still
exists underneath, but it has been demoted from *the product* to *one thing the
sidebar can tell you about a project that happens to have code*.

The landing page has not caught up. Neither has the iOS app.

---

## 1. The shape of the thing

### The core claim, as the code now expresses it

You have AI conversations in five places — ChatGPT, Claude, Claude Code in a
terminal, Cursor, Codex — and none of them can see each other. The decision you
made with Claude last March is invisible to the agent building the thing this
morning. Selvedge is one window where all of it lives, where **any agent can join
any conversation mid-sentence**, and where the record survives the tab closing.

The strongest sentence in the codebase for this is in `src/shared/agents.ts`:

> There used to be a `kinds` field here, and a matching `kind` on a thread, and
> between them they walled talking off from building: to move a conversation from
> deciding what to build to building it, you had to start a second conversation
> and say everything twice. **That wall was the single biggest thing standing
> between this product and its own promise, so it is gone.**

And from `src/server/chat/turn.ts`, on why chat lives here rather than in a chat app:

> A decision made in a chat app is lost the moment the tab closes; a decision made
> here is still there in six months, next to the work it produced.

### The nouns

| Noun | What it is | Table |
|---|---|---|
| **Org** | The account. Clerk organization. Everything is org-scoped. | `orgs` |
| **Project** | A place that has code — a GitHub repo Selvedge knows about. | `packs` |
| **Subject** | A place that *doesn't* have code. A topic. Deliberately thin: a name and threads under it. | `subjects` |
| **Thread** | A conversation. The unit of work. Belongs to exactly one project *or* one subject. Archived, never deleted. | `threads` |
| **Agent** | Who is answering right now. Four: Claude Code, Codex, Claude, GPT. | `shared/agents.ts` |
| **Run** | One turn of a builder in a sandbox, with its real cost and what it changed. | `agentRuns` |
| **Pack** | What Selvedge understands a project to be — validated JSONB, the compounding memory. | `packs.pack` |
| **External session** | A coding session Selvedge *didn't* run, observed from the owner's own machine. Summary only, never a transcript. | `externalSessions` |

Projects and subjects are the same thing in the rail — "one of them has code" is
the only difference, and a subject deliberately gets **no status edge and no
health line**, because a status on a topic would be a claim about nothing.

---

## 2. The surfaces, as they exist

### Web — `/inbox` is the app

Signed in, `/` redirects to `/inbox`. Everything else is secondary. The Inbox is
a persistent three-pane workbench (`src/client/pages/Inbox.tsx`, 361 lines):

```
┌───────────────┬──────────────────────────────┬─────────────────┐
│ RAIL          │ THREAD                       │ CONTEXT PANEL   │
│               │                              │  (collapsible)  │
│ one row per   │ the conversation, and        │  Now            │
│ place, one    │ everything you do to it —    │  History        │
│ conversation  │ ship, preview, approve,      │  About          │
│ each, ordered │ the agent's live activity    │                 │
│ by what needs │ inline                       │  collapsed by   │
│ you           │                              │  default <1280  │
└───────────────┴──────────────────────────────┴─────────────────┘
```

- Below 768px the three panes become a drill: rail → thread → context.
- **Liveness is polling** — 3s while an agent works, 12s otherwise. No SSE, no
  websockets. Deliberate ("the thread's own text is what moves").
- The rail shows *one* conversation per place, not a nested tree. Nesting split
  by agent in practice ("GPT Workshop" above "CC Workshop") — the same wall,
  redrawn in the navigation.

Nav carries five items: **Inbox · Record · Projects · Connections · Admin**.
Dead addresses redirect rather than 404: `/today` → `/projects`, `/work` → `/`,
`/tray` → `/admin`, `/projects/:id/workshop` → the thread it meant.

### Web — the other pages

| Route | What it is |
|---|---|
| `/record` | Track record — trust incidents, what held and what didn't |
| `/projects` | The project list; status moved here when the brief was retired |
| `/projects/:id/edit` | Pack editor — correct what Selvedge thinks the project is |
| `/connections` | Connectors + **fuel** (your own API keys) |
| `/admin` | Org settings, unsorted sources, import, companion keys |
| `/styleguide` | Public, no auth — the design contract, screenshot-testable |

### Mobile — stale, and the gap is structural

`Selvedge-mobile` is a native SwiftUI app, last touched **2026-07-21** — a month
before the reframe. Its tab bar is:

```
Today · Projects · Ideas · Ask
```

Two of those four no longer exist on web. **Today** is the retired daily brief.
**Ask** was deleted outright ("Ask is gone, server side too") — there is no
`/api/ask` any more. The iOS app is a phone client for the *previous* product.

The signed-out screen (`SignInView` in `App/RootView.swift`) is a bare gate:
mark, wordmark, "Sign in to see today's brief.", one button into Clerk's
prebuilt `AuthView`. It is not a landing page in any meaningful sense, and the
one sentence it does say points at the retired brief.

---

## 3. The mechanics that make it distinctive

These are the things worth putting on a landing page, because they're real, they're
built, and nobody else does them this way.

### `@` chooses who answers. `#` chooses what we're talking about.

Two sigils, deliberately separate (`shared/mentions.ts`, `shared/references.ts`):

- **`@claudecode ok build it`** — one name is *direction*. This turn is answered
  by that agent. Because that's a switch, it's priced and recorded like any other.
- **`@claude @gpt what do you think?`** — two or more names is a **consultation**.
  Everyone named answers the same question, and **the conversation does not change
  hands**. Asking two people what they think is not handing the work to either.
- **`how does #loom handle refunds?`** — brings another conversation, project, or
  subject into this one. Max 3 per message. Resolved server-side from the stored
  text.

Why two sigils and not one namespace: name a project "codex" and `@codex` becomes
permanently ambiguous between an agent and a place, with no honest way to pick.

Picking from the `@` menu **inserts the text** rather than switching behind your
back — so the choice is visible in the sentence, costs nothing until you send,
and comes back with one press of backspace.

### The consultation actually answers as itself

When you ask `@claude` and `@gpt` the same question, each is told it *is* that
model answering inside Selvedge. This was a bug fix with a good story: handed the
generic prompt, the Anthropic-backed one opened with *"I'm not Claude or GPT, just
me here"* — false, and the opposite of what was asked for. Every reply carries
`answered_by`, because asking two agents is pointless if both answers come back
signed the same way.

A builder (`@claude-code`) asked for its *opinion* answers on its model with no
sandbox attached, and the conversation says so out loud rather than letting the
distinction pass.

### Your own history imports as ordinary conversations

`POST /api/import/history` takes a ChatGPT / Claude / Gemini export — a `.zip` or
a bare `conversations.json`, up to 500MB — and files it. Real parsing work, not a
stub:

- **ChatGPT** exports a *tree*, not a list, because you can edit and branch. The
  importer walks `current_node` back to root — the branch that survived — because
  stitching all branches in timestamp order produces a transcript that never
  happened.
- **Claude** has two text shapes in the wild (old `text` string, new typed
  `content` blocks); it reads both and prefers the blocks.
- Uniquely indexed on `(imported_from, import_source_id)` so **importing the same
  export twice cannot double your history** — enforced by the database, not the
  importer's memory.
- The response says what came in **and what couldn't be read, at the same
  volume**. "An import that reports 1,204 successes and silently drops 300 entries
  is the same shape of lie as a confidently wrong all-clear."

Imported chats become ordinary threads — so a conversation you had somewhere else
last March is `#`-referenceable exactly like the one you're in now. That is the
single most concrete expression of the new positioning.

Note: a recent commit moved imported history to belong to *the account*, not to a
project ("An old history belongs to the account, not to a project").

### The companion: terminal sessions reach the same window

`npx selvedge` (`src/cli/`) is a local daemon + MCP server that watches session
files from **Claude Code, Codex, Cursor, and Gemini CLI** and posts *summaries* to
Selvedge. It authenticates with a bearer token (SHA-256 hashed, shown once), not a
browser session.

The honesty constraint is baked into the table shape: `external_sessions` holds
intent, files touched, tools run, outcome, the commit it lines up with, and cost —
**and there is nowhere in it to put a transcript**. Raw code and full
conversations stay on the machine they happened on. Cursor and Gemini CLI readers
ship *marked unverified*.

### Money is quoted before it's spent, and it stops

- **Fuel** = the owner's own API keys (Anthropic, OpenAI), encrypted in a vault,
  verified with a real ping against the cheapest model before Selvedge says
  "connected".
- Every agent in the switcher carries a `costNote` — comparative, not a fake
  precise number, because "what it costs depends on the turn, and a precise figure
  we can't stand behind is worse than an honest comparison."
- A conversation has a **spend ceiling**. Hitting it returns a 409 carrying
  `spent_cents`, `cap_cents`, and `raises` — so the refusal is a *pause* with the
  real number in front of you and one word that continues. The step is one cap's
  worth, never a doubling. "A ceiling nobody can see is the same as no ceiling."
- When an agent doesn't report what a turn used, the cost is recorded as
  **unknown**, not zero. There's a commit named `$0.000 is not a price`.

### Building still works, in the same window

A thread whose agent `changesFiles` runs in the project's **Daytona** sandbox:
plan or build, stage changes, preview on a real URL, ship, roll back. Two drivers
today (Claude Code, Codex) behind one seam — "adding a third builder is a file
next to `codexCommand.ts` and a case here." Turns can be **stopped**.

---

## 4. The design system (shared, and load-bearing)

Both platforms share tokens. Web: `docs/ui/DESIGN-NOTES.md` +
`src/client/styles/tokens.css`. iOS: `docs/ios/DESIGN-NOTES.md` +
`DesignSystem/Theme.swift`.

| Role | Light | Dark |
|---|---|---|
| paper | `#E9EDF1` | `#12161B` |
| panel | `#FBFCFD` | `#1C2127` |
| ink | `#28303A` | `#E9EDF1` |
| hairline | `#D7DEE4` | `#2C333B` |
| **thread** (rust) | `#D2442E` | needs-you **only** |
| **brass** | `#B07E22` | working / the accent |
| **healthy** | `#4F926F` | healthy |

Type: **Fraunces** (display), **Inter Tight** (body), **JetBrains Mono**
(technical register only). Radii 20 / 13 / 9.

Four rules that constrain any redesign:

1. **Color rationing.** Rust means "needs you" and nothing else. Never reach for
   it to make something pop.
2. **The SelvedgeEdge.** A solid vertical status seam on the leading edge of a
   surface — the product's face everywhere, down to the lock-screen widget. Four
   states, and `unknown` is **dashed, not just a different color**, so a
   colorblind reader or a monochrome render can never read "I can't see this" as
   "this is fine."
3. **The false-calm rule.** Any path that can't determine a verdict defaults to
   `unknown`, never to healthy. *Guessed calm is the one unforgivable output.*
4. **Glass budget.** Two blurred layers per screen, maximum. The Inbox panes are
   solid panels on flat paper because the nav already spends the budget. One
   motion token: panes settle, then hold still.

**Agent identity is text, never color or brand** — a two-to-three character mono
chip (`CC`, `CX`, `CL`, `GPT`) on a plain field. No logos, no brand colors, ever,
including for agents added later. Status color is spoken for.

---

## 5. Stack and architecture, briefly

**Web** (`cag-platform/selvedge`) — TypeScript throughout.

- **Client**: React 18, Vite, React Router 6, Tailwind, Clerk React.
- **Server**: Express 4, Clerk Express, Drizzle ORM → Postgres, `node-cron`.
- **Models**: `@anthropic-ai/sdk` + `openai`, behind one `LlmClient` seam with
  structured output, metering, and a budget gate. Adding a provider is one file.
- **Sandbox**: Daytona (`@daytonaio/sdk`). Present only when Daytona + tokens are
  configured; absent, an approved card simply waits — no inert half-run.
- **Connectors**: GitHub (App + webhooks), Railway, Vercel, Neon, Supabase.
- **Also**: MCP server, error beacon, preview proxy, push (APNs), 30 route
  modules, ~39 test directories, Vitest + Playwright.
- Deploy: Railway (`railway.json`); migrations run on `start`.

**Mobile** (`cag-platform/Selvedge-mobile`) — native SwiftUI, Swift 6, iOS 18 +
iOS 26 Liquid Glass with a `GlassKit` swap seam. Clerk via ClerkKit/ClerkKitUI.
Widget extension. Bundle `com.tryselvedge.Selvedge`, 1.0 (1). TestFlight-ready
(`ITSAppUsesNonExemptEncryption` set); **no App Store metadata exists anywhere in
either repo**.

### Degradation is designed, not accidental

A recurring pattern worth knowing, because it's a product value and not just
engineering hygiene: every optional dependency has a defined honest failure.
No Clerk keys → `/api` returns a clear 503, the process still boots and accepts
webhooks. No Daytona → cards wait. No fuel → the agent says which key isn't
connected rather than quietly answering as someone else. An agent that's wired
but unfuelled **stays visible in the picker and says why**, because "hiding a
wired agent teaches people the product is smaller than it is."

---

## 6. What's live vs. what's vestigial

This matters for a landing page — several impressive-sounding subsystems are no
longer surfaced.

**Live and central:** the Inbox (rail / thread / context), threads, subjects,
agents + `@` switching + consultation, `#` references, consumer-history import,
the companion loop, fuel + spend ceilings, the sandbox build/ship/preview/rollback
path, packs, the timeline, the track record.

**Live but demoted:** projects and their health status (now a line in the rail and
a tab in the context panel, not a product); cards/decisions (folded into the
thread where approving happens); connectors and monitoring (still polling on cron,
still ingesting — but they inform a sidebar, not a front page).

**Retired but still in the tree:** the daily digest/brief (cron still composes it,
`/api/today` still answers, no UI routes to it); the Work surface (deleted,
address redirects); Ask (deleted, server side too); Sketch (retired, `sketches` /
`sketch_messages` tables still present); the narration library and push
narrations, which existed to serve the brief.

**Stale documentation** — treat as historical: `EXPLAINER.md`, `VENTURE-CASE.md`,
`BUILD-BRIEF.md`, `STATUS.md`, `docs/strategy/*` (including the positioning memo
and all four IRONCLAD docs), `docs/golden-set/*`. The design notes on both
platforms are the exception — those are current.

---

## 7. The two things being redesigned

### The web landing page — `src/client/pages/Landing.tsx`, 197 lines

What a signed-out visitor sees at every path except `/sign-in` and `/sign-up`.
Current structure:

1. **Hero** — eyebrow "The tailor for software you didn't write" / h1 "Selvedge
   keeps your **apps running**." / a hand-authored sample morning brief with four
   rows wearing real SelvedgeEdge states.
2. **The second job** — building vs. running an app.
3. **How it works** — It watches / It fixes / It proves.
4. **Why you can believe it** — flat price, no stake, admits what it doesn't know,
   it stops.
5. **Who it's for** — "You built an app and now people depend on it."
6. Footer — the selvedge etymology (self + edge: the woven border that finishes
   itself and cannot fray).

Its own header comment says every sentence is "decided language from
`EXPLAINER.md`, arranged, not invented" — which is exactly why it's stale now:
it's faithful to a document describing a product that no longer exists. The
sample-brief hero visual demonstrates the retired daily brief.

Worth keeping regardless of framing: the etymology, the edge vocabulary as a
device, the "I can't tell" honesty position, and the flat-price / no-stake
arguments — which survive the reframe intact and arguably get *stronger*, since
the new product is explicitly the neutral ground between four vendors' agents.

The sign-in and sign-up pages carry their own stale sub-copy in `App.tsx`
("One morning brief; the important things, first." / "bring an app you already
own — the walkthrough takes it from there").

### The mobile landing — `SignInView` in `App/RootView.swift`

A gate, not a landing. Reframing it means deciding what a signed-out phone
visitor should understand before they authenticate — and, separately, whether
the whole tab structure (`Today · Projects · Ideas · Ask`) gets rebuilt around the
Inbox model. **The second is the larger question and it is not a landing-page
question.** Two of those four tabs are backed by things that no longer exist.

---

## 8. Open questions worth deciding before design starts

1. **What is the hero claim?** The code supports at least three honest ones:
   *one window for every AI conversation you have* / *any model, mid-sentence,
   without starting over* / *the record that outlives the tab*.
2. **Does the monitoring story appear at all,** or does it become a quiet
   third-section capability? It's real, it's built, and it's now a sidebar.
3. **Is import the wedge?** "Bring your ChatGPT and Claude history" is a concrete,
   demonstrable, unusually sticky first action — and it's fully built.
4. **How is the competitive position stated** now that Selvedge sits *on top of*
   Claude, GPT, Codex and Cursor rather than beside them? The old memo's
   "trust arbitrage — it didn't build your app" argument needs restating for a
   product that runs the builders.
5. **Does the phone get the Inbox,** or a deliberately narrower companion? This
   decides whether the mobile landing is a small copy change or the front of a
   rebuild.
6. **What does the sample visual show** now that the sample brief is retired? The
   obvious candidate is a thread with two agents answering the same question and a
   `#reference` pulling in an imported ChatGPT conversation — which demonstrates
   the whole thesis in one frame.

---

## 9. Voice notes, if any copy gets written

The house style is unusually consistent and worth preserving — it's visible in the
commit subjects, which read as sentences rather than changelog entries ("Take the
wall down: any agent, any conversation, named in the sentence").

- Plain English. Short sentences. No jargon, no infrastructure nouns at the plain
  register. No "observability". No "dashboard" as a promise.
- Say what a thing *does*, not what it *needs*.
- Admitting a limit is a feature, stated plainly: "I can't tell yet" is a real
  answer, and a confidently wrong all-clear is the one unforgivable output.
- Never claim "nobody does this". The honest, stronger version: the pieces exist,
  fragmented and mispositioned; nobody has put them together for this customer.
- Describe a competitor's *incentive*, which is verifiable — never their honesty.
