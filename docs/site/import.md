# Import your history

The conversations you have already had elsewhere are yours. Selvedge takes the
export those tools already give you and turns those chats into ordinary threads
here — searchable, part of the record, and reachable from any conversation with
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

Every conversation becomes a thread, marked **imported** — because none of it
was said to Selvedge, and a record that blurred that line would be worth less
than one that doesn't.

By default they are filed under the account rather than inside a project. A
year of thinking about six different things is not "about Loom", and the point
is that any conversation can reach them by name. You can name a project or
subject at upload time when a history really is about one thing.

## What can't be read, and how you are told

Whatever could not be read is **listed with a reason**, beside the count of
what came in. Not summarised, not counted-and-forgotten: an import that
silently drops three hundred entries and reports success is the same shape of
lie as a health check that reports fine because it never ran.

## What the format itself can't carry

Some limits are the export's, not Selvedge's, and they are stated whether or
not anything went wrong — because they apply to the successful import too:

- **Google's export records what you asked Gemini, not what Gemini answered.**
  You get your side of the conversation.
- **An edited ChatGPT conversation loses its abandoned branches.** The export
  carries the path you kept.

## Importing twice

You cannot double your history by importing the same file again. Conversations
already present are recognised and left alone, and the result says how many
that was rather than quietly filing nothing.
