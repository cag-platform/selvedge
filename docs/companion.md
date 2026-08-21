# The companion — `selvedge watch` and `selvedge context`

One small program that runs on your own machine and closes the loop in both
directions:

- **In** — it reads the coding sessions you run in your terminal (Claude Code,
  Codex) and sends Selvedge a **summary** of each finished one, so a day spent
  in the terminal shows up in tomorrow's brief and on the project's history
  instead of vanishing.
- **Out** — it serves your project's context to any agent that mounts it as an
  MCP server, so a fresh session anywhere starts knowing what the project is,
  what breaking it costs, what changed lately, and what is open.

---

## What leaves your machine, exactly

For each finished session:

| Sent | Example |
|---|---|
| which tool, and its session id | `claude-code`, `2b8f…` |
| when it ran | started/ended timestamps |
| the folder, and the repo it belongs to | `/home/you/loom`, `acme/loom` |
| the first thing you asked for, bounded | "the basket empties itself when you go back" |
| the file paths it touched | `src/checkout/Cart.tsx` |
| which tools it ran, and how often | `Edit ×3, Bash ×7` |
| how it ended | shipped / ended / abandoned / error / unreadable |
| the commit that landed while it was open | `a1b2c3d` |
| what the tool said it cost | `$0.42` |

**Never sent:** the conversation, your code, any diff, any file contents. There
is nowhere in the wire format to put them — see `src/shared/types/session.ts`,
which both the companion and the server validate against.

Don't take that on trust:

```
selvedge watch --dry-run
```

prints exactly what would be sent, and sends nothing.

---

## Setting it up

1. In Selvedge, go to **Connections → Your machines** and make a key. It is
   shown once.
2. On your machine:

```
npm install -g selvedge          # or run it from a checkout: npm run companion -- …
selvedge login --token slv_…     # add --api https://your-selvedge if self-hosted
selvedge status                  # what it can see, and whether the key works
```

3. Leave the watcher running (a terminal tab, a launchd/systemd unit, whatever
   suits):

```
selvedge watch                   # every 60s; --once for a single pass
```

A session is reported once it has been quiet for five minutes — neither tool
announces that a session ended, so "finished" means "stopped being written to".
If you resume one later, its summary is sent again and the record updates; it
never becomes two sessions.

---

## Giving your agents the context

The same binary is an MCP server. Mount it wherever you work:

**Claude Code**

```
claude mcp add selvedge-context -- selvedge context
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.selvedge-context]
command = "selvedge"
args = ["context"]
```

**Anything else that speaks MCP over stdio**: run `selvedge context`.

Three tools, all read-only:

- `get_project_context` — what this project is, what breaking it costs, how it
  is built, what changed lately, what is open.
- `get_recent_changes` — ships, breaks, verdicts, and sessions observed from
  outside (marked as observed: Selvedge did not run or check that work).
- `get_open_issues` — changes waiting on you, problems reported this week, gaps
  Selvedge can't see through, known flakiness not worth chasing.

They resolve the project from the repo you are sitting in. When they can't tell,
they say which projects exist rather than guessing at one.

**Nothing writes.** An agent consumes context here; it never edits what Selvedge
believes about a project. The pack's whole value is that it is grounded in what
actually happened.

---

## When it can't read something

These session formats are undocumented and change between versions. When the
companion can't parse a log it **says so** — the session is reported as
`unreadable` with the reason, it turns up on the project's history, and the next
morning's brief leads with it:

> I couldn't read one of yesterday's Codex sessions, so I can't tell you what
> happened in it — the log never said which session it was.

That is deliberate. A companion that quietly skipped what it couldn't parse
would leave you believing you had a complete record when you didn't, which is
the one failure this product can't have.

---

## Turning it off

Stop the watcher, and stop the key in **Connections → Your machines**. The key
stops working immediately; what it already reported stays on your record (and in
your export), because it is history.
