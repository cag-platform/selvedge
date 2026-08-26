# Selvedge

**All your AI projects in one place, working together.**

Selvedge keeps a project's context, decisions, evidence, language, history and
open questions intact while conversations, tools and agents change. The core
product rule is simple:

> The work belongs to the project, not the agent.

Claude, GPT, Gemini and the other thinking agents can examine the same project.
Claude Code and Codex can work in the same sandbox. Changing who answers does
not mean starting the project again.

## Product surfaces

| Surface | Route | Purpose |
|---|---|---|
| Landing | `/` while signed out | Explain the product through an interactive, deterministic walkthrough. |
| Home | `/` while signed in | Begin with an outcome, suggest the best existing project, and show where the work will be kept. |
| Work | `/inbox` (`/work` is an alias) | The conversation workbench: projects and threads, the current conversation, and relevant project context. |
| Projects | `/projects` | See the portfolio and its current health in one place. |
| Project Memory | `/projects/:projectId` | Review durable context, observed behavior, language, evidence, open questions and history. |
| Search | `/inbox?search=1` | Open the global conversation/project command palette. |

Record, Your apps, Connections, Billing, Preferences and Under the hood are
secondary account surfaces under `/admin`. Their previous routes still
redirect so old bookmarks continue to work.

### Home starts with intent

The signed-in home page begins with the outcome rather than a tool or agent. The
native Home uses the plain prompt **“What’s the next project?”** Selvedge
deterministically suggests an existing project from project and thread language, shows the
destination and available context, and reuses that project when appropriate.
A subject is created only when the work genuinely has no project yet.

Needs you, running work, recent conversations and a compact memory summary stay
available, but they do not compete with the composer.

### Work keeps the whole project in the room

The web workbench is a resizable three-pane layout:

1. projects, subjects and conversations;
2. the active conversation and composer;
3. Memory, Preview, History and About.

On narrow screens the same information becomes a rail → conversation → context
drill-down. The native iOS app follows that drill-down instead of squeezing
three desktop columns onto a phone.

Mentioning one agent hands the conversation to that agent. A builder receives
a measured project handoff and continues in the shared checkout. Mentioning two
or three agents asks them for opinions in parallel without changing the current
builder. Exactly two complete, correlated answers can render side by side on a
roomy web pane; the phone presents the same pair one answer at a time under an
explicit **Two perspectives** control.

### Project Memory is a view, not a second truth

Project Memory is derived from the same context pack, graduated observations,
conversation record, timeline and current builder state used by the workbench,
handoffs and MCP context. It is not a disconnected UI-only memory database.

The current governing understanding comes from the project's grounded context.
Learned behavior, accepted language, evidence, open items and recent history are
shown with freshness. Context export remains organization-wide. Decision briefs
are preserved and used by paired conversations, but are not yet exposed as a
standalone list on the Project Memory page.

### Preview means the sandbox copy

Preview is explicit in the thread header and the right-hand Preview tab. It
keeps two destinations separate:

- **Preview app** opens the current sandbox copy being changed.
- **Live app** opens the deployed address, when the project has one.

An imported web repository can be previewed before the first agent turn.
Selvedge starts the configured development script or the nearest static index,
reports an honest unavailable state for non-web repositories, and leaves the
live address usable when sandbox startup fails. Preview environment values are
encrypted; only their names are returned to the client.

### Full and Simple detail

Technical detail defaults to **Full** at the account level. **Simple** keeps
answers intact while summarizing command output, activity and handoff receipts
in plain language. It never rewrites an agent's answer or deletes the underlying
run record. Each conversation may inherit the account setting or override it.

The web theme is light-first warm mineral and pale sage. **Night Weave** is the
semantic dark treatment rather than an inverted light theme. Light, Night and
System are stored per browser and reduced-motion/transparency preferences are
respected. The native app uses the same semantic palette and follows the system
appearance.

## Architecture at a glance

Selvedge is a multi-tenant TypeScript application: one Express process serves
the React SPA and API, runs the schedulers and pollers, and stores durable state
in Postgres. Clerk supplies user and organization identity. External systems
enter through connector boundaries; routing, risk, caps and verification remain
deterministic. Models narrate decisions and answer questions, but do not decide
whether a change is safe.

The native SwiftUI client uses the same Clerk organization and the same API; it
does not have a parallel mobile data model.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the contracts and dependency
boundaries, [STATUS.md](./STATUS.md) for what is live, and
[docs/ui/DESIGN-NOTES.md](./docs/ui/DESIGN-NOTES.md) for the visual system.

## Local development

Requirements:

- Node.js 22 or newer
- Postgres
- Clerk keys for signed-in product flows

```sh
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

`DATABASE_URL` is the only boot-critical variable. Without Clerk keys the
service can still answer health checks and webhooks, but `/api` returns a clear
configuration error. Vite runs on `http://localhost:5173` and proxies API calls
to the Express server on port 3000.

Production uses the built client and server. `npm start` runs migrations before
starting the process.

### Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests use Vitest, Supertest and PGlite so database behavior, migrations and
tenancy contracts run against Postgres semantics rather than mocks.

## Northstar demo and screenshot account

The guarded Northstar Studio seed supports repeatable web and iOS captures. It
contains five fictional projects—Morrow, Relay, Parcel, Juniper and Fieldnote—
with seven conversations, two proposed fixes, a correlated two-agent design
consultation and a visible Claude Code → Codex handoff.

Run the seed only in the intended configured environment:

```sh
DEMO_SEED_CONFIRM=northstar-studio npm run db:seed:demo
```

Create one five-minute, single-use login from an interactive terminal:

```sh
DEMO_LOGIN_CONFIRM=northstar-studio DEMO_LOGIN_TARGET=web npm run demo:login
DEMO_LOGIN_CONFIRM=northstar-studio DEMO_LOGIN_TARGET=ios npm run demo:login
```

The command is operator-only and fail-closed against the exact demo identity
and organization. Treat its output as a password: open it off-camera, never
paste it into chat or documentation, and never save it. The iOS ticket route is
compiled only in DEBUG builds. Use a normally signed simulator build so Clerk
can persist its device credential in Keychain.

Recommended capture sequence:

1. Home with Morrow selected;
2. Morrow's bounded booking-confirmation fix (do not approve it);
3. Juniper's Claude Code/Codex design comparison;
4. Morrow Project Memory;
5. the five-project portfolio;
6. optionally, Parcel's Claude Code → Codex handoff.

The seed intentionally has no live connectors or sandboxes. It is right for the
product, memory and collaboration story, but not for a staged Preview or Put it
online demonstration. The public landing page's interactive ProductDemo is a
deterministic client-side walkthrough; it is not the Northstar account and does
not pretend to run a live agent.
