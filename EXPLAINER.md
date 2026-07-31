# SELVEDGE — in a nutshell

The canonical explanation. Written to be understood by anyone: no jargon, no acronyms,
short sentences. Use these words on the website, in the pitch, and when someone asks what
you do.

---

## In one line

> **Selvedge keeps your apps running.**

## In one paragraph

> Making software used to be expensive. Now anyone can build an app with AI in an
> afternoon. But building an app and *running* one are different jobs — and running it
> never got cheaper. Selvedge does that second job. It watches the apps you own, tells you
> in plain English when something is wrong, fixes it with your approval, and proves the fix
> actually worked. Flat monthly price. It didn't build your app, so it has no reason to
> tell you everything's fine when it isn't.

---

## The full explanation

### What changed

Building software used to take a team and a year. Now one person can describe what they
want and have a working app the same afternoon. That has already happened at scale: the
companies selling those AI builders went from nothing to more than $1.5 billion a year in
revenue in about two years.

So there are now a great many working applications owned by people who are not engineers.
Real apps, with real customers, taking real money, holding real records.

### What didn't change

Building an app and running an app are two different jobs.

Running it means noticing when it breaks. Understanding why. Fixing it without breaking
something else. Checking that the fix actually worked. Keeping it healthy for years while
the world changes around it.

That job is still expert work. It did not get cheaper, faster, or easier. And the people
who now own these apps mostly cannot do it.

The result is a growing pile of software with real money riding on it and nobody qualified
to look after it.

### Why the companies that built the apps don't solve this

Two reasons, and neither is a missing feature they'll add next quarter.

**They get paid when their AI works harder.** Most of them charge by usage. Every attempt
to fix something costs you money — including the attempts that fail. When their AI gets
stuck in a loop trying to repair a bug it created, you pay for the whole loop. There is no
version of that business where they are motivated to make repairs rare and cheap.

**They're marking their own homework.** When their AI breaks something, they are the ones
who tell you what happened. You would not ask a builder to be the inspector on their own
work. It isn't dishonesty; it's a conflict.

You can see it clearly in what they do and don't build. One of the biggest of them added
monitoring in 2026 — it will now tell you when your app goes down. It still won't tell you
that you're spending far too much with them. The monitoring was a feature they could add.
The silence about your bill is structural.

### What Selvedge does

Selvedge looks after software you own but can't read.

**It watches.** Your apps, your database, your hosting — all of it, not just one company's
corner of it.

**It explains.** When something goes wrong, you get a plain sentence: what broke, whether
your customers are affected, when it started, and what it's costing you. Not an error
message. Not a chart. A sentence.

**It fixes.** Then it offers to put it right: here's what I'd change, here's what it will
cost, here's the point where I'll stop and check with you. You approve. It makes the
change in a safe copy first, tests it there, and only then puts it live.

**It proves the fix worked.** After the change goes out, it checks. If it can confirm the
problem is gone, it says so. If it genuinely can't tell, it says *that* — instead of
guessing that everything is fine.

**It remembers.** Every change, what it cost, and whether it held is written down and kept.
The second time a problem appears, it's faster and cheaper to fix than the first. And the
record includes Selvedge's own mistakes.

### The way to picture it

Think of a tailor.

A tailor doesn't make your clothes from scratch — that's a different trade. They take the
garment you already own and make it fit. They mend it when it tears, let it out when you
need more room, and keep it wearable for years. They keep your measurements on file, so
each visit is quicker than the last. And before they cut into good cloth, they make a cheap
test version first, to be sure.

That's the job. The AI builders make the garment. Selvedge is the tailor who keeps it
wearable.

### What makes it different

- **Flat price.** Selvedge doesn't earn more when your app breaks more. Every other option
  in this market does.
- **No stake in the answer.** It didn't sell you the app, so it has no reason to reassure
  you.
- **It admits what it doesn't know.** "I can't tell yet" is a real answer here. A
  confidently wrong all-clear is the one thing it must never do.
- **It covers everything you use.** Most tools only see their own platform. Your app is
  spread across four or five.
- **It stops.** Every repair has a price agreed in advance and a hard limit. It will never
  quietly spend your money trying the same broken idea forty times.

### Who it's for

People who own working software with real users or real revenue, and who don't have an
engineer to call.

Solo founders. Small businesses running the app their whole operation depends on. Agencies
looking after apps for clients. Anyone who built something with AI, put it in front of
customers, and then realised they now own it.

### Who it isn't for

Engineering teams with their own operations people. They have tools built for them, and
those tools are good. Selvedge is for the people those tools were never designed for.

---

## Saying it in different rooms

**To a customer:** *"You built an app and now people depend on it. Selvedge is who you call
when it breaks — except you don't have to call, because it already noticed, and it can
usually fix it before you've finished reading the message."*

**To an investor:** *"Software creation got cheap. Software operation didn't. The builders
went zero to $1.5 billion a year in two years and none of them solved what happens after
launch — and they structurally can't, because they bill by usage and they narrate their
own failures. We're the operations layer for software whose owner can't read it."*

**To an engineer:** *"It's an SRE and a maintenance engineer for people who will never hire
either. Deterministic routing and risk classification decide what happens; the model only
explains and authors. Every repair is sandboxed, cost-capped, verified against the prior
working state, and recorded in an append-only ledger — including the misses."*

---

## Internal note — what not to claim

**Never size this market on "apps built with AI."** Most are abandoned within months. Any
investor who has done the work knows it, and being caught inflating the top of the funnel
costs far more than the smaller honest number would have.

The credible construction is: applications in production with real users, times a realistic
capture rate, times revenue per account — and then the argument for why that base grows
faster than the world's ability to staff it.

Two related disciplines: don't claim "nobody does this" — pieces of it exist, and the
honest version is stronger ("the pieces exist, fragmented and mispositioned; nobody has put
them together for this customer"). And don't describe competitors as dishonest. Describe
the incentive, which is verifiable, and let the listener draw the conclusion.
