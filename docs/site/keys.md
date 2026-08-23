# Keys and spending

Selvedge runs on your own model access. It charges for the window and the
record, not for the tokens — which means it has no reason to want your
conversations longer than they need to be.

## Which key goes where

- **Anthropic** — powers `@claude` in conversation, and Selvedge's own writing:
  the plain-English sentences it uses to describe what happened.
- **OpenAI** — powers `@gpt` in conversation, `@codex` when it builds, and the
  independent verdict, which is judged by a model that did not write the
  change.
- **Railway / Vercel** — read-only enough to see whether your deploys went live
  or failed.
- **Supabase, Neon** — only if you ask Selvedge to put something online that
  needs a database.

Connect them under **Connections**. Each is checked with one real call when you
save it, so "connected" means it worked, not that the field was filled in.

## How they are stored

Encrypted before they touch the database, with AES-256-GCM, under a key derived
per organisation — so a credential is bound to both the workspace and the
provider it was saved for, and a row moved between the two decrypts to nothing.

There is exactly one code path that decrypts, and it hands the secret straight
to the call being made. Nothing lists them, nothing displays them, and nothing
logs them. Removing one takes effect immediately.

## What a turn costs

Costs are the model's, passed through at what they cost:

- **A builder** (`@claudecode`, `@codex`) — roughly **$0.05–0.30** a turn. It
  is reading files, editing, and running tests in a sandbox.
- **A talker** (`@claude`, `@gpt`) — a fraction of a build turn. It is one
  question and one answer.
- **Switching builders mid-task** costs whatever carrying the handover costs,
  and the exact figure is quoted **before** you switch, from the same code that
  does the charging. A price tag that turns out to have been a guess is worse
  than no price tag.

Everything spent is on the thread and in the Record, in cents, always.

## Ceilings

Every conversation has a spend ceiling, set from the project's stated stakes. A
sandbox project gets a gentle one; something with real users and real money
gets a stricter one.

**The ceiling is a pause, not a wall.** When it is reached, the next turn stops
and the conversation tells you what it has spent and what it was allowed to
spend — the real figures. Carrying on is one press, which raises the ceiling by
one more ceiling's worth, and the raise is recorded on the conversation. A limit
that can be lifted invisibly is the same as no limit at all.

## Why an unreported cost shows as unknown, not zero

Some work costs money that Selvedge cannot see — a session your terminal ran
that did not report its cost, a provider that returned no usage figure.

Those show as **unknown**, and are never folded in as zero. A total that
quietly treats missing numbers as nothing is a total that goes down when
Selvedge loses track, which is precisely backwards, and it is the kind of
comfortable arithmetic this product does not do.
