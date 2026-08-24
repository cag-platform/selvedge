# Security

Written by the person who built it, saying where your data is and what can
reach it. There is no badge wall because there are no badges to show; the last
section says so.

<!-- Every claim on this page is checked against the code before it ships.
     The reference after each is the file that makes it true, so the next
     person to change that file can see what it promises. -->

## Where your data lives

Postgres, on Railway, in the United States. One database, one row per thing,
every query scoped to your workspace.

What is in it: your conversations, the summaries your terminal sessions
reported, the events the watching recorded, and the "pack", Selvedge's written
understanding of each project.

What is not in it: **your code**, and **your transcripts from other tools**.
Selvedge reads a repo inside a disposable sandbox when a builder is working;
what persists afterwards is the commit, not a copy.

<!-- src/server/db/schema/*, src/server/build/agent.ts -->

## Your keys

Encrypted before they touch the database, with AES-256-GCM under a key derived
per organisation. The workspace id is part of the derivation, so a credential
row moved to another workspace decrypts to nothing.

There is exactly one code path that decrypts, and it hands the secret straight
to the call being made. Nothing lists them, nothing displays them, nothing logs
them; the interface shows a label and the last four characters.

Each is verified with one real call when you connect it, so "connected" means
it worked. Removing one takes effect immediately.

<!-- src/server/connectors/credentials/crypto.ts — scryptSync over the org id,
     createCipheriv('aes-256-gcm'); store.ts — useCredential is the only
     decryption path -->

## The companion

Summaries only. The exact field list is on [the companion
page](/docs/companion), and the straight answer to "could it send my code?" is
that there is no field for a transcript and no field for a diff: there is
nowhere in Selvedge to put one.

`selvedge watch --dry-run` prints exactly what would be sent, and sends
nothing.

The key it authenticates with is **hashed with SHA-256 before storage**. The
plaintext is shown once, at the moment you make it, and is not recoverable
afterwards. If you lose one, make another and revoke the old. Revoking
takes effect immediately.

<!-- src/server/companion/tokens.ts — createHash('sha256'), timingSafeEqual on
     comparison; src/cli/watch.ts — the summary is the only thing sent -->

## What Selvedge's own agent can touch

A builder works in a **Daytona sandbox**: a container with a clone of your
repo, on a branch. It has the repo and nothing else: no access to your other
projects, your keys, or anything else in your workspace.

The credential it clones with is a **short-lived GitHub App installation
token**, minted per build, carrying exactly the access you granted when you
installed the app. It is not a personal access token and not a
deployment-wide one.

Nothing reaches your main branch until you ship it. Before that:

- **A sensitive diff is hard-gated.** Anything touching payments, auth, or user
  data requires a confirmed backup. The gate fires on any one of those signals:
  a change labelled "just copy" that also touches auth is still gated.
- **Caps genuinely stop work.** A conversation's spend ceiling pauses the next
  turn and shows the real figures. Raising it is deliberate and recorded.
- **A ship can be undone.** Undo is a real `git revert`, and a confirmed break
  within twelve minutes of a ship reverts automatically.

<!-- src/server/build/repoToken.ts — installation tokens, org-scoped;
     src/server/cards/risk.ts — sensitive → hard gate + verified backup;
     src/server/threads/ceiling.ts — the pause and the recorded raise -->

## Signing in, and what arrives with you

Sign-in is handled by Clerk, with GitHub and Google alongside email. A social
sign-in proves **identity only**: your name, email and avatar. It does not
grant access to your repositories: that stays a separate, explicit step (the
GitHub App install), scoped to the repos you pick and revocable per repo.

After a GitHub sign-in, Selvedge may borrow the sign-in token server-side for
one thing: greeting you with your public repos so bringing them in is one
step. The token is fetched from Clerk per request, sent to GitHub as a header,
and never stored, logged, or shown to a browser.

The imports follow the same shape. Each moves something that is already
yours, once, from a file or grant you chose:

- **A Replit zip** is validated before anything is created. Its files land in
  a **private repo under your GitHub**, workspace junk is left behind and
  named, and secrets never ride along: a Repl's env lives in Replit's vault,
  not its filesystem, so there is nothing in the zip to leak.
- **Cursor chats** are read on your own machine, by the companion, from the
  local file Cursor keeps them in. They travel over the same hashed-key
  companion auth, and whatever cannot be read is counted and listed rather
  than silently dropped.
- **A database Selvedge provisioned** sits on Selvedge's Neon account until
  you claim it. The claim link expires after seven days, the accept happens in
  your browser with your own Neon login, and after the move Selvedge keeps
  nothing; the connection string keeps working, so your app never notices.

<!-- src/server/connectors/github/personal.ts — token per-request, header-only;
     src/server/import/replitApp.ts + web/routes/importReplit.ts — validate
     before create, junk named; src/server/import/companionIngest.ts +
     src/cli/importers/cursor.ts — local read, unreadable counted;
     src/server/connectors/neon/claim.ts — CLAIM_TTL_SECONDS, transfer keeps
     nothing -->

## Leaving

Everything Selvedge knows exports as one JSON file, whenever you like, from
Projects. It carries the project packs, the learned meanings, and the timeline,
in the same sentences the product shows you. Being able to leave is what
makes the record worth keeping.

Deleting a **project** deletes it: its events and its narrations are purged in
one transaction. A row is kept as a tombstone with nothing in it, because a
project created from a GitHub repo would otherwise be recreated by the next
sync; the tombstone keeps it deleted.

**Deleting your whole account is not a button yet.** Today it is a request:
email the address below and I do it by hand, within a working day. It is on
the roadmap because "email the founder" does not scale past the number of
customers this has.

<!-- src/server/web/routes/portability.ts — GET /api/export;
     src/server/packs/store.ts — deletePack purges narrations + events in a
     transaction. NO account-deletion route exists: verified 22 Aug 2026 by
     enumerating router.delete across src/server/web/routes. If one is added,
     this paragraph is the thing to update. -->

## The honest limits

**One person builds and runs this.** There is no security team, no on-call
rotation, and no SOC 2 report. If that is a blocker for you, it is a real
blocker and you should treat it as one.

What compensates, and what doesn't:

- **Your infrastructure stays yours.** Selvedge deploys to accounts you own,
  in your name. If it disappeared tomorrow, your app would keep running and
  you would keep the keys to it.
- **Your keys stay yours.** Bring your own, remove them in one click.
- **Your data comes out whole.** The export is complete and it is one click.
- **None of that is a substitute for an audit.** It is a different bet, made
  legible so you can decide whether to take it.

Found something? Email **greg@smithbespoke.com**. I would rather hear it from
you than read about it later.

— Greg Smith

*Replit, Cursor, Neon, Railway, and the other product names on these pages are
trademarks of their respective owners; Selvedge is not affiliated with or
endorsed by any of them.*
