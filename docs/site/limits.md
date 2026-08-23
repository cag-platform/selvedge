# What Selvedge can't see

This is the page most products don't write. It is here because a tool that
tells you when something is wrong is only worth having if you know what it is
not looking at — otherwise silence means two different things and you can't
tell which one you're getting.

The rule underneath all of it: **a confidently wrong "everything's fine" is the
one unforgivable output.** Everything below is a consequence of taking that
seriously.

## When an edge goes dashed

Every project wears a status edge. Three of them are solid and say something.
The fourth is **dashed**, and it means "I looked and I can't tell".

It is a different shape rather than a paler colour on purpose. A greyed-out
version of "fine" reads as fine; a dashed seam does not read as anything but
itself.

You will see it when:

- nothing has reported yet — a new project, or one with no health check armed;
- a check has been failing to run rather than failing;
- the evidence for a verdict isn't there.

A project with **nothing to report at all** gets no edge and no health line —
not a dashed one. "Nothing has ever happened here" and "I looked and couldn't
tell" are different facts, and only the second one has earned a mark.

## When a verdict says "probably" instead of "verified"

Every finished change gets a verdict on whether it did what was asked. The
strongest one, **verified**, requires that a different model than the one that
wrote the change read the actual diff and agree.

Without a second provider's key connected, that check cannot happen — so
verdicts honestly top out at **probably**, and never claim more. The card says
which one it was and when the check happened.

## When Selvedge stays silent about what caused a break

When something breaks, Selvedge tries to say whose work it began after: the
conversation, in here or in your terminal, that produced the change that landed
first.

It refuses to guess. Specifically:

- **No attribution, no sentence.** If the commits carry no session — nothing
  stamped, nothing the companion saw — you get "started right after new code
  landed" and nothing more. Reaching further for a plausible session is
  inventing one.
- **Ambiguity is named, never resolved.** If two changes could equally be
  behind it, it says two, and says it can't tell which. That is a correct
  answer, and a coin toss dressed as a diagnosis is not.
- **It never says "caused".** "Began after" is what the evidence supports — a
  commit landed, then something broke. That is a lead worth following, not a
  verdict.

## What the watching doesn't cover

- **It checks that your app answers, and that your deploys land.** It is not
  reading your logs, tracing your requests, or measuring your database.
- **A health check has to be armed.** Putting something online arms it; a repo
  Selvedge is only reading is watched for changes, not for uptime.
- **Two failures before it says anything.** One failed probe is a flake. This
  costs a few minutes of notice and buys never crying wolf.
- **Errors are counted only if your app reports them.** There is an optional
  beacon for that; without it, "no errors reported" means exactly that.

## What it never touches

- **Your code never leaves your machine through the companion.** Summaries
  only — the field list is on [the companion page](/docs/companion), and there
  is nowhere in Selvedge to put a transcript or a diff.
- **The sandbox is not your production.** Builders work on a branch in a
  container. Nothing reaches your main branch until you ship it.
- **A sensitive change needs you.** A diff touching payments, auth, or user
  data is hard-gated and needs a confirmed backup, even when everything else
  about it looks routine.
