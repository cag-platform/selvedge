# Import your history

The conversations you have already had elsewhere are yours. Selvedge takes the
export those tools already give you and turns those chats into ordinary threads
here: searchable, part of the record, reachable from any conversation with
`#`.

It happens once, from a file you choose. Nothing is connected, and nothing
keeps reading.

## Where to get the export

- **ChatGPT** — Settings → Data controls → Export data. It arrives by email as
  a ZIP.
- **Claude** — Settings → Account → Export data. Also a ZIP, also by email.
- **Gemini** — Google Takeout, selecting "My Activity".

Upload the ZIP exactly as it downloaded, or the `.json` from inside it. Both
work.

One thing worth knowing: the email those services send you contains a
**download link**, and some of them attach a small manifest file. The manifest
is not the export. If Selvedge says it could not find conversations in what you
uploaded, that is usually why, and it will name what it did find inside the
file.

## What comes in

Every conversation becomes a thread, marked **imported**, because none of it
was said to Selvedge. A record that blurred that line would be worth less than
one that doesn't.

By default they are filed under the account rather than inside a project. A
year of thinking about six different things is not "about Loom", and the point
is that any conversation can reach them by name. You can name a project or
subject at upload time when a history really is about one thing.

## What can't be read, and how you are told

Whatever could not be read is **listed with a reason**, beside the count of
what came in. An import that drops three hundred entries and reports success
is lying about your history, so this one lists them.

## What the format itself can't carry

Some limits are the export's, not Selvedge's, and they are stated whether or
not anything went wrong, because they apply to the successful import too:

- **Google's export records what you asked Gemini, not what Gemini answered.**
  You get your side of the conversation.
- **An edited ChatGPT conversation loses its abandoned branches.** The export
  carries the path you kept.

## Importing twice

You cannot double your history by importing the same file again. Conversations
already present are recognised and left alone, and the result says how many
that was rather than quietly filing nothing.

## Import from Cursor

Cursor has no export button. Its chats live in a local file on the machine you
run it on, so they come in through [the companion](/docs/companion) rather
than an upload:

```
selvedge import cursor
```

Add `--dry-run` to see what would be filed without filing anything. The chats
land under "Cursor history", the same dedupe applies, and whatever the local
file holds in a shape that cannot be read is counted and listed like any
other import.

## Bring an app from Replit

A different kind of import: not chats, a **working app** on its way from a
workspace you rent to a repo you own. In Replit, download the Repl as a zip
(files pane → ⋮ → Download as zip), then use **Import from Replit** on the
Projects page. Selvedge filters out the workspace junk (node_modules, caches, virtualenvs),
names what it left behind, creates a private repo under your GitHub, lands the
files as one commit, and opens the project's workshop.

Two things it tells you up front, because they are true: secrets never travel
in the zip (a Repl's env lives in Replit's vault, so paste it into the preview
environment when asked), and Replit's agent chats have no export, so they stay
behind.
