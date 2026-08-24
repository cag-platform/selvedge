# The companion

Work you do in your own terminal does not vanish. A small program on your
machine reads the coding sessions you run there and sends Selvedge a **summary**
of each one, so those sessions appear on the project's record beside the work
you did here.

Never the conversation. Never your code.

## Install it

```
npm install -g selvedge
selvedge login --token <your key>
selvedge watch
```

Make the key under **Connections → Your machines**. It is shown once, and only
once; the [Security](/security) page explains why.

## What it reads

Session files that these tools already write on your own disk:

- **Claude Code** and **Codex** — proven, and what most people run.
- **Cursor** and **Gemini CLI** — marked as unproven in the product; their
  formats have changed under us before.

It reads the files those tools leave behind. It does not attach to a process,
watch your keystrokes, or read anything you did not run through one of them.

## Exactly what leaves your machine

One summary per session, with these fields and no others:

- `agent` — which tool it was
- `session_id` — that tool's own id for the session
- `started_at`, `ended_at`
- `cwd`, `repo` — where it ran, so it can be filed under the right project
- `intent` — what you asked for, if the session recorded a first instruction
- `files_touched` — the paths, not the contents
- `tools_run` — counts by tool name, e.g. how many edits and how many tests
- `outcome` — how it ended
- `commit_sha` — the commit that landed, if one did
- `cost_usd` — what the session cost
- `detail` — one line when the outcome needs explaining

That is the whole list. There is no field for a transcript and no field for a
diff. That is the real answer to "could it send my code?": there is nowhere
in Selvedge to put it.

If you would rather see it than take this page's word for it:

```
selvedge watch --dry-run
```

prints exactly what would be sent, and sends nothing.

## What it can't read

A session it could not parse is **listed, with a reason**. A tool that changes
its session format will produce sessions Selvedge can't read; when that
happens you are told, instead of being shown a shorter history than you
actually have.

## Context, served back

The same program is an MCP server, so any agent that speaks MCP (Claude Code,
Codex, anything else) can mount your project's context and start a session
already knowing what the project is:

```
claude mcp add selvedge-context -- selvedge context
```

Three read-only tools: what this project is, what changed lately, what is open.
Read-only on purpose: agents consume context here, and never edit what
Selvedge believes.

## How to stop it

Stop the watcher (`Ctrl-C`) and nothing more is sent. To make sure nothing can
be sent even if it is still running somewhere you have forgotten about, revoke
the key under **Connections → Your machines**; it stops working immediately.
