# Golden Brief — Day 3: Storm Day
Register: plain_expandable · Budget ≤200 words

## Fixture inputs (frozen)
- 02:10 Neon incident (shared region) → Loom, SB platform, CAG site down together; 04:15 all recovered
- Verdicts: Loom users_affected (retailers couldn't submit ~2h, overnight US); SB users_affected (portal/storefront unreachable, same window); CAG site users_affected (overnight leads may be lost)
- RESIDUE: SB's job queue lives inside the same Postgres — queued work (drafts, emails, PDFs) may not have resumed; the single action item
- Noise: Toile build failed once, self-recovered (known_flaky) — dropped silently
- No open threads

## Reference brief

Rough night, but it's over. Neon had an incident at 2am and took Loom, Smith Bespoke, and the CAG site down with it — one cause, three apps. Everything was back by 4:15.

What it meant while it lasted: your retailers couldn't submit orders for about two hours, Smith clients couldn't reach the storefront or their closets, and the CAG site was dark — if anyone tried to find you overnight, that lead may be gone. All of it hit overnight US time, so the real damage is probably small.

One thing to check, and only one: Smith Bespoke runs its background work inside the same database that went down. The site is back, but the queued jobs — drafts, emails, PDFs — may not have restarted on their own. Have Claude confirm the queue is moving before you do anything else today.

Nothing else needs you. This wasn't your code, and there's nothing to fix — just the one check.

## Required elements
- One cause, named once ✓ · All three verdicts ✓ · Recovery stated ✓ · Single residue action ✓ · Flaky noise dropped silently ✓ · Anti-siren close ("this wasn't your code") ✓
