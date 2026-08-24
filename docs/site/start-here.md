# Start here

Selvedge is one window per project for every AI you work with. Claude, GPT,
Claude Code, and Codex in the same thread, reading the same history. When
something breaks, the conversation that caused it is one click away.

This page is the first ten minutes.

## What you need

A GitHub account, if you want Selvedge to work in your code. That is the only
requirement. Sign in with it (or with Google) and Selvedge greets you with
your repos instead of a blank page.

Model keys are optional to start. Without one you can still bring a repo in,
read what Selvedge sees, and import your old conversations; the agents say
they have no key instead of pretending to be switched on.
When you do connect one, it is yours: Selvedge charges for the window and the
record, not for the tokens. See [Keys and spending](/docs/keys).

## The first ten minutes

**Bring something in.** A repo, from Projects, or a Repl as the zip Replit
exports. Selvedge reads it, writes down what it thinks the project is, and
starts watching it. You can correct anything it got wrong; what you write wins
over what it guessed.

**Say something.** Open the conversation and type. There is one conversation
per project, and everything happens in it — deciding, building, shipping.

**Name who answers.** Type `@` and pick. `@claude` and `@gpt` talk it through;
`@claudecode` and `@codex` change files in a sandbox. Name two and you get two
answers, each signed with its own name: not a blend, and not a vote.

**Point at what you mean.** Type `#` and pick another project, subject, or
conversation. What you decided in March comes with you into this morning's
work, without re-explaining it.

**Ask for a change.** Tell a builder what you want in plain words. It works in
a real sandbox on your repo, you watch it happen, and you see the thing running
before anything goes live. Nothing reaches your main branch until you say so.

## The two marks

That is the whole interface, and it is worth being precise about the
difference:

- `@` chooses **who answers**. It changes hands mid-sentence, and one delete
  takes it back.
- `#` chooses **what you are talking about**. It brings another conversation's
  contents into this one for the agent to read.

They share no namespace on purpose. A project called `codex` would otherwise
be permanently ambiguous with the agent of that name, with no clean way to
pick.

## Where to go next

- [The companion](/docs/companion) — the sessions you run in your own terminal.
- [Import your history](/docs/import) — the chats you have already had.
- [Keys and spending](/docs/keys) — what runs on what, and what it costs.
- [What Selvedge can't see](/docs/limits) — the honest page.
