import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { digests, orgs } from '../db/schema/index.js';
import { gatherPacks, gatherWindowNarrations, getPreviousDigest } from './gather.js';
import { orderAttention, orderMoved, type NarrationWithPack } from './order.js';
import { buildSections, renderDigestText, type OpenThread } from './render.js';
import { capabilityGapStandingLines, quietLine, unsortedTrayLine, weeklyRetrospective } from './standing.js';
import { localDateString, yesterdayBoundsUtc } from './timezone.js';

export type ComposedDigest = {
  id: string;
  digestDate: string;
  headline: string;
  renderedText: string;
  openThreads: OpenThread[];
};

/**
 * Layer 5 (deterministic edition, deliverable 7). Idempotent: composing
 * twice for the same org+local-day returns the already-stored digest.
 */
export async function composeDigestForOrg(db: Db, orgId: string, now: Date = new Date()): Promise<ComposedDigest> {
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

  const attention = orderAttention(withPack.filter((n) => n.kind === 'attention'));
  const moved = orderMoved(withPack.filter((n) => n.kind === 'moved'));
  const standingNarrationLines = withPack.filter((n) => n.kind === 'standing').map((n) => n.fragment).filter((f): f is string => Boolean(f));

  const activeProjectIds = new Set(withPack.map((n) => n.projectId).filter((id): id is string => Boolean(id)));
  const gapLines = capabilityGapStandingLines(packs);
  const trayLine = await unsortedTrayLine(db, orgId);
  const weeklyLine = await weeklyRetrospective(db, orgId, end);

  const standing = [...standingNarrationLines, ...gapLines, ...(trayLine ? [trayLine] : []), ...(weeklyLine ? [weeklyLine] : [])];
  const quiet = quietLine(packs, activeProjectIds);

  const previousOpenThreads: OpenThread[] = previousDigest ? (previousDigest.openThreads as OpenThread[]) : [];
  const sections = buildSections(attention, moved, standing, quiet, previousOpenThreads);
  const renderedText = renderDigestText(sections);

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
  });

  return { id, digestDate: todayStr, headline: sections.headline, renderedText, openThreads: newOpenThreads };
}

async function getExistingDigest(db: Db, orgId: string, digestDate: string): Promise<ComposedDigest | null> {
  const [row] = await db
    .select()
    .from(digests)
    .where(and(eq(digests.orgId, orgId), eq(digests.digestDate, digestDate)))
    .limit(1);
  if (!row) return null;
  return { id: row.id, digestDate: row.digestDate, headline: row.headline, renderedText: row.renderedText, openThreads: row.openThreads as OpenThread[] };
}
