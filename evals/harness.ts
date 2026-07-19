import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test/helpers/testDb.js';
import { orgs, digests, narrations } from '../src/server/db/schema/index.js';
import { createPack } from '../src/server/packs/store.js';
import { ingestEvent } from '../src/server/resolution/ingest.js';
import { composeDigestForOrg } from '../src/server/digest/compose.js';
import { wordBudgetFor } from '../src/server/digest/composeLlm.js';
import { VERDICT_PHRASE } from '../src/server/narration/verdictText.js';
import type { LlmClient } from '../src/server/llm/types.js';
import type { Verdict } from '../src/server/narration/types.js';
import { FIXTURES, fixturePack, type EvalFixture } from './fixtures.js';

/**
 * The eval harness (Phase 2 deliverable 7). Runs each synthetic day
 * through the full Stage 1 -> Stage 2 pipeline (real ingest, real routing,
 * real composer path) and scores the gated fields:
 *
 *   verdict preservation   gate: 100%, absolute
 *   thread closure         gate: 100%
 *   invented facts         gate: 0 (entity diff vs fixture inputs)
 *   word budget            gate: <= budget +10%
 *   section order          reported (composition order sanity), not gated
 *   style similarity       reported vs goldens when present; never gated
 *
 * Failing a gated field fails the run — no override flag exists.
 */

// Fixed clock: compose Monday morning; events land "yesterday" (Sunday is
// avoided for occurred_at? No — 2026-07-19 is a Sunday, which also exercises
// the G3 weekly-retrospective standing line in every fixture. Deterministic
// either way.)
const COMPOSE_AT = new Date('2026-07-20T12:00:00Z');
const YESTERDAY = '2026-07-19';

export type FixtureScore = {
  fixture: string;
  verdictPreservationPct: number; // gated: must be 100
  threadClosurePct: number; // gated: must be 100
  inventedFactCount: number; // gated: must be 0
  wordCount: number;
  wordBudget: number; // gated: wordCount <= budget * 1.1
  sectionOrderOk: boolean; // reported
  voice: string;
  gatedFailures: string[];
};

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export async function runFixture(fixture: EvalFixture, llm: LlmClient): Promise<FixtureScore> {
  const { db, close } = await createTestDb();
  const orgId = `org_eval`;
  try {
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
    for (const packSpec of fixture.packs) {
      await createPack(db, orgId, fixturePack(packSpec));
    }

    if (fixture.previousOpenThreads) {
      await db.insert(digests).values({
        id: ulid(),
        orgId,
        digestDate: YESTERDAY,
        headline: 'previous',
        sections: { attention: [], moved: [], standing: [], quiet: '', today: null },
        openThreads: fixture.previousOpenThreads.map((t) => ({ ...t, narration_id: 'prev' })),
        renderedText: 'previous digest',
      });
    }

    for (const [i, event] of fixture.events.entries()) {
      await ingestEvent(db, {
        org_id: orgId,
        source: 'github',
        source_account_id: event.resource_id,
        event_type: event.event_type,
        occurred_at: `${YESTERDAY}T${String(event.hour ?? 10).padStart(2, '0')}:00:00Z`,
        severity_hint: 'info',
        raw: event.raw ?? {},
        dedupe_key: `eval-${i}`,
      });
    }

    const digest = await composeDigestForOrg(db, orgId, COMPOSE_AT, { llm, db });
    const brief = digest.renderedText;
    const lower = brief.toLowerCase();

    // -- Gather what the composer was shown (the stored sections). --
    const [row] = await db.select().from(digests).where(eq(digests.digestDate, '2026-07-20'));
    const sections = row!.sections as {
      attention: Array<{ narration_id: string; fragment: string }>;
      moved: Array<{ narration_id: string; fragment: string }>;
      standing: string[];
      quiet: string;
    };
    const shownIds = [...sections.attention, ...sections.moved].map((s) => s.narration_id);
    const narrationRows = shownIds.length
      ? (await db.select().from(narrations)).filter((n) => shownIds.includes(n.id))
      : [];

    // 1. Verdict preservation — every verdict shown to the composer must
    //    survive into the brief via its canonical phrase.
    const verdicts = [...new Set(narrationRows.map((n) => n.verdict).filter((v): v is Verdict => Boolean(v)))];
    const preserved = verdicts.filter((v) => lower.includes(VERDICT_PHRASE[v]));
    const verdictPreservationPct = verdicts.length === 0 ? 100 : Math.round((100 * preserved.length) / verdicts.length);

    // 2. Thread closure — every carried-in thread whose project went quiet
    //    must be referenced (by project name) in the brief.
    const toClose = fixture.expect.closedThreadProjects ?? [];
    const closed = toClose.filter((name) => lower.includes(name.toLowerCase()));
    const threadClosurePct = toClose.length === 0 ? 100 : Math.round((100 * closed.length) / toClose.length);

    // 3. Invented facts — entity diff: numbers and known project names in
    //    the output must exist in the input material.
    const inputMaterial = [
      ...sections.attention.map((s) => s.fragment),
      ...sections.moved.map((s) => s.fragment),
      ...sections.standing,
      sections.quiet,
      ...(fixture.previousOpenThreads ?? []).map((t) => t.summary),
      String(sections.attention.length),
      String(fixture.packs.length),
    ]
      .join(' ')
      .toLowerCase();
    const outputNumbers = brief.match(/\d+(\.\d+)?/g) ?? [];
    const inventedNumbers = outputNumbers.filter((n) => !inputMaterial.includes(n));
    const knownNames = fixture.packs.map((p) => p.name);
    const inventedNames = knownNames.filter(
      (name) => !inputMaterial.includes(name.toLowerCase()) && lower.includes(name.toLowerCase()),
    );
    const inventedFactCount = inventedNumbers.length + inventedNames.length;

    // 4. Word budget.
    const wordBudget = wordBudgetFor(fixture.packs.length);
    const wordCount = words(brief);

    // 5. Section order (reported): the first attention fragment's verdict
    //    phrase should precede the quiet line when both exist.
    let sectionOrderOk = true;
    if (verdicts.length > 0 && sections.quiet) {
      const firstVerdictIdx = Math.min(
        ...verdicts.map((v) => {
          const idx = lower.indexOf(VERDICT_PHRASE[v]);
          return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
        }),
      );
      const quietIdx = lower.indexOf(sections.quiet.toLowerCase().slice(0, 20));
      sectionOrderOk = quietIdx === -1 || firstVerdictIdx < quietIdx;
    }

    const gatedFailures: string[] = [];
    if (verdictPreservationPct !== 100) gatedFailures.push(`verdict preservation ${verdictPreservationPct}% (gate: 100%)`);
    if (threadClosurePct !== 100) gatedFailures.push(`thread closure ${threadClosurePct}% (gate: 100%)`);
    if (inventedFactCount !== 0) gatedFailures.push(`invented facts ${inventedFactCount} (gate: 0)`);
    if (wordCount > Math.ceil(wordBudget * 1.1)) gatedFailures.push(`word count ${wordCount} > budget ${wordBudget} +10%`);
    if (fixture.expect.stormMode && sections.attention.length > 3) gatedFailures.push('storm mode failed to cap attention at 3');
    if (fixture.expect.quietDay && words(brief) > wordBudget) gatedFailures.push('quiet day brief exceeded budget');

    return {
      fixture: fixture.name,
      verdictPreservationPct,
      threadClosurePct,
      inventedFactCount,
      wordCount,
      wordBudget,
      sectionOrderOk,
      voice: digest.voice,
      gatedFailures,
    };
  } finally {
    await close();
  }
}

export async function runAllFixtures(llm: LlmClient): Promise<FixtureScore[]> {
  const scores: FixtureScore[] = [];
  for (const fixture of FIXTURES) {
    scores.push(await runFixture(fixture, llm));
  }
  return scores;
}
