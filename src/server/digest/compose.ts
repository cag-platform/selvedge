import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests, orgs } from '../db/schema/index.js';
import { gatherPacks, gatherWindowNarrations, getPreviousDigest } from './gather.js';
import { orderAttention, orderMoved, collapseRepeats, type NarrationWithPack } from './order.js';
import { buildSections, renderDigestText, type OpenThread } from './render.js';
import { capabilityGapStandingLines, quietLine, unsortedTrayLine, weeklyRetrospective } from './standing.js';
import { localDateString, yesterdayBoundsUtc } from './timezone.js';
import { composeBriefLlm, type ComposeLlmDeps } from './composeLlm.js';

export type ComposedDigest = {
  id: string;
  digestDate: string;
  headline: string;
  renderedText: string;
  openThreads: OpenThread[];
  /** How renderedText was produced: mechanical (no voice), composed (Stage 2), fallback (voice failed; mechanical sent). */
  voice: 'mechanical' | 'composed' | 'fallback';
};

/**
 * Layer 5. Phase 1's deterministic edition remains the skeleton: gathering,
 * ordering, selection, and continuity are code. With llmDeps present, the
 * selected-and-annotated fragments go through the Stage 2 composition call
 * (composeLlm.ts) and its validator; any failure falls back to the
 * mechanical rendering — the brief always sends. Idempotent per org+local-day.
 */
export async function composeDigestForOrg(
  db: Db,
  orgId: string,
  now: Date = new Date(),
  llmDeps?: ComposeLlmDeps,
): Promise<ComposedDigest> {
  const [orgRow] = await db.select({ timezone: orgs.timezone }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
  const timezone = orgRow?.timezone ?? 'UTC';

  const { start, end, dateString: yesterdayStr } = yesterdayBoundsUtc(timezone, now);
  const todayStr = localDateString(now, timezone);

  const existing = await getExistingDigest(db, orgId, todayStr);
  if (existing) return existing;

  const [narrationRows, packs, previousDigest] = await Promise.all([
    gatherWindowNarrations(db, orgId, start, end),
    gatherPacks(db, orgId),
    getPreviousDigest(db, orgId, yesterdayStr),
  ]);

  const packById = new Map(packs.map((p) => [p.identity.project_id, p]));
  const withPack: NarrationWithPack[] = narrationRows.map((n) => ({ ...n, pack: n.projectId ? packById.get(n.projectId) ?? null : null }));

  // Identical repeats collapse to one line with a plain count — three "new
  // work landed" narrations are one fact that happened three times, not three
  // lines of noise on the owner's morning read.
  const attention = collapseRepeats(orderAttention(withPack.filter((n) => n.kind === 'attention')));
  const moved = collapseRepeats(orderMoved(withPack.filter((n) => n.kind === 'moved')));
  const standingNarrationLines = [
    ...new Set(withPack.filter((n) => n.kind === 'standing').map((n) => n.fragment).filter((f): f is string => Boolean(f))),
  ];

  const activeProjectIds = new Set(withPack.map((n) => n.projectId).filter((id): id is string => Boolean(id)));
  const gapLines = capabilityGapStandingLines(packs);
  const trayLine = await unsortedTrayLine(db, orgId);
  const weeklyLine = await weeklyRetrospective(db, orgId, end);

  const standing = [...standingNarrationLines, ...gapLines, ...(trayLine ? [trayLine] : []), ...(weeklyLine ? [weeklyLine] : [])];
  const quiet = quietLine(packs, activeProjectIds);

  const previousOpenThreads: OpenThread[] = previousDigest ? (previousDigest.openThreads as OpenThread[]) : [];
  const sections = buildSections(attention, moved, standing, quiet, previousOpenThreads);
  const mechanicalText = renderDigestText(sections);

  // Stage 2: the model composes, code decided what it sees. Failure of any
  // kind (call, validator twice) falls back to the mechanical rendering.
  let renderedText = mechanicalText;
  let voice: 'mechanical' | 'composed' | 'fallback' = 'mechanical';
  if (llmDeps) {
    const packMeta = packs.map((p) => ({
      project_id: p.identity.project_id,
      name: p.identity.name,
      tier: p.stakes.tier,
      detail_level: p.voice.detail_level,
      language: p.voice.language ?? 'en',
    }));
    const composed = await composeBriefLlm(llmDeps, orgId, sections, previousOpenThreads, packMeta);
    if (composed.ok) {
      renderedText = composed.brief;
      voice = 'composed';
    } else {
      voice = 'fallback';
      // Hitting the spend cap is the customer's business, not a silent
      // downgrade. Every other fallback reason is ours to fix and is reported
      // in logs; this one changes what they paid for, so it is said plainly
      // in the brief itself rather than leaving today's note quietly reading
      // differently with no explanation.
      if (composed.reason === 'daily_budget_exceeded') {
        renderedText = `${mechanicalText}\n\nI'm writing plainly today — this account reached its daily limit for AI-written updates. Everything above is still accurate; only the wording is simpler. It resets tomorrow.`;
      }
      // The alert channel for a double validator failure / model outage:
      // loud in logs, visible as voice='fallback' on the digest row and the
      // Today page's reduced-voice note (acceptance gate 6).
      console.error(
        `digest compose fallback for org ${orgId} (${todayStr}): ${composed.reason}` +
          ('violations' in composed && composed.violations ? ` — ${composed.violations.join('; ')}` : ''),
      );
    }
  }

  const newOpenThreads: OpenThread[] = sections.attention.map((a) => ({
    project_id: a.projectId,
    summary: a.fragment ?? '',
    narration_id: a.id,
  }));

  const id = ulid();
  await db.insert(digests).values({
    id,
    orgId,
    digestDate: todayStr,
    headline: sections.headline,
    sections: {
      attention: sections.attention.map((a) => ({ project_id: a.projectId, fragment: a.fragment, narration_id: a.id })),
      moved: sections.moved.map((m) => ({ project_id: m.projectId, fragment: m.fragment, narration_id: m.id })),
      standing: sections.standing,
      quiet: sections.quiet,
      today: sections.today,
    },
    openThreads: newOpenThreads,
    renderedText,
    voice,
    mechanicalText,
  });

  return { id, digestDate: todayStr, headline: sections.headline, renderedText, openThreads: newOpenThreads, voice };
}

async function getExistingDigest(db: Db, orgId: string, digestDate: string): Promise<ComposedDigest | null> {
  const [row] = await db
    .select()
    .from(digests)
    .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, digestDate)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    digestDate: row.digestDate,
    headline: row.headline,
    renderedText: row.renderedText,
    openThreads: row.openThreads as OpenThread[],
    voice: (row.voice ?? 'mechanical') as 'mechanical' | 'composed' | 'fallback',
  };
}
