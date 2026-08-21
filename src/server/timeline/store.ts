import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, agentRuns, cards, externalSessions, narrations, threads } from '../db/schema/index.js';
import { agentById } from '../../shared/agents.js';
import { sessionAgentName } from '../../shared/types/session.js';
import type { CardState, CardVerdict } from '../cards/types.js';
import {
  askEntry,
  eventEntry,
  sessionEntry,
  orderTimeline,
  runEntry,
  switchEntry,
  threadEntry,
  verdictEntry,
  type TimelineEntry,
} from './entries.js';

/**
 * ONE PROJECT'S HISTORY, IN ONE LIST.
 *
 * Every source here already existed and was already the owner's — the cards
 * table (which IS the ledger), the runs, the narrations the brief is composed
 * from, the threads, the flight record. Nothing is written for the timeline and
 * nothing is stored twice; this reads what is there and hands it to the pure
 * sentence builders in entries.ts.
 *
 * That is also why it can be trusted: the timeline cannot say more than the
 * record, because it is only a projection of the record. If Selvedge never saw
 * something, no line appears for it — the absence is the honest answer.
 */

const DEFAULT_LIMIT = 200;

export type TimelineOptions = {
  /** Only what happened since this moment — "the last two weeks" is this. */
  since?: Date;
  limit?: number;
};

export async function projectTimeline(
  db: Db,
  orgId: string,
  projectId: string,
  { since, limit = DEFAULT_LIMIT }: TimelineOptions = {},
): Promise<TimelineEntry[]> {
  const scoped = <T extends { orgId: unknown; projectId: unknown }>(table: T) =>
    and(eq(table.orgId as never, orgId), eq(table.projectId as never, projectId));

  const [cardRows, threadRows, runRows, switchRows, narrationRows, sessionRows] = await Promise.all([
    db
      .select()
      .from(cards)
      .where(since ? and(scoped(cards), gte(cards.updatedAt, since)) : scoped(cards)),
    db
      .select()
      .from(threads)
      .where(since ? and(scoped(threads), gte(threads.createdAt, since)) : scoped(threads)),
    db
      .select()
      .from(agentRuns)
      .where(since ? and(scoped(agentRuns), gte(agentRuns.createdAt, since)) : scoped(agentRuns))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit * 2),
    db
      .select()
      .from(agentMessages)
      .where(
        since
          ? and(scoped(agentMessages), eq(agentMessages.role, 'switch'), gte(agentMessages.createdAt, since))
          : and(scoped(agentMessages), eq(agentMessages.role, 'switch')),
      ),
    db
      .select()
      .from(narrations)
      .where(
        since
          ? and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId), gte(narrations.occurredAt, since))
          : and(eq(narrations.orgId, orgId), eq(narrations.projectId, projectId)),
      )
      .orderBy(desc(narrations.occurredAt))
      .limit(limit * 2),
    db
      .select()
      .from(externalSessions)
      .where(
        since
          ? and(scoped(externalSessions), gte(externalSessions.createdAt, since))
          : scoped(externalSessions),
      )
      .orderBy(desc(externalSessions.createdAt))
      .limit(limit),
  ]);

  const entries: TimelineEntry[] = [];

  for (const row of cardRows) {
    const card = {
      id: row.id,
      title: row.title,
      proposal: row.proposal,
      trigger: row.trigger,
      risk: row.risk,
      gate: row.gate,
      state: row.state as CardState,
      verdict: (row.verdict as CardVerdict | null) ?? null,
      gradedBy: row.gradedBy,
      spentCents: row.spentCents,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    entries.push(askEntry(card));
    const verdict = verdictEntry(card);
    // A card that finished in the same breath it was asked (a decline, say)
    // still gets both lines: the asking and the outcome are different facts.
    if (verdict) entries.push(verdict);
  }

  for (const row of threadRows) {
    entries.push(threadEntry({ id: row.id, title: row.title, kind: row.kind, agent: row.agent, createdAt: row.createdAt }));
  }

  for (const row of runRows) {
    const entry = runEntry({
      id: row.id,
      threadId: row.threadId,
      prompt: row.prompt,
      status: row.status,
      agent: row.agent,
      commitSha: row.commitSha,
      costCents: row.costCents,
      changedPaths: (row.changedPaths as string[] | null) ?? null,
      createdAt: row.createdAt,
    });
    if (entry) entries.push(entry);
  }

  for (const row of switchRows) {
    entries.push(
      switchEntry(
        { id: row.id, threadId: row.threadId, content: row.content, createdAt: row.createdAt, meta: row.meta as never },
        (agent) => agentById(agent)?.name ?? sessionAgentName(agent),
      ),
    );
  }

  for (const row of narrationRows) {
    const entry = eventEntry({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
      fragment: row.fragment,
      technicalDetail: row.technicalDetail,
      verdict: row.verdict,
      confidence: row.confidence,
      kind: row.kind,
      meta: row.meta as never,
    });
    if (entry) entries.push(entry);
  }

  for (const row of sessionRows) {
    entries.push(
      sessionEntry(
        {
          id: row.id,
          agent: row.agent,
          sessionId: row.sessionId,
          intent: row.intent,
          filesTouched: (row.filesTouched as string[] | null) ?? null,
          toolsRun: (row.toolsRun as Record<string, number> | null) ?? null,
          outcome: row.outcome,
          commitSha: row.commitSha,
          costUsd: row.costUsd,
          detail: row.detail,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          createdAt: row.createdAt,
        },
        (agent) => agentById(agent)?.name ?? agent,
      ),
    );
  }

  return orderTimeline(entries).slice(0, limit);
}

export type SearchHit = {
  kind: 'message' | 'card' | 'event';
  at: string;
  /** Where it was said — the thread's name, or the card's title. */
  where: string;
  /** The matching text, bounded. */
  excerpt: string;
  ref: { thread_id?: string; card_id?: string };
};

const SEARCH_LIMIT = 30;
const EXCERPT_CHARS = 220;

/** The words around the match, so a hit is readable without opening it. */
function excerpt(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || flat.length <= EXCERPT_CHARS) return flat.slice(0, EXCERPT_CHARS);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + EXCERPT_CHARS).trim()}…`;
}

/**
 * Search inside one project — its conversations, its asks, and what the
 * watching said.
 *
 * Postgres does the work two ways at once: full-text for word matching
 * ("shipping" finds "shipped"), and plain containment for the half-word people
 * actually type into a search box ("check" finds "checkout"). At this scale
 * that costs nothing and each covers the other's blind spot; a project with
 * enough history to feel it can grow a GIN index without any caller changing.
 */
export async function searchProject(db: Db, orgId: string, projectId: string, query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const matches = (column: ReturnType<typeof sql>) =>
    or(sql`${column} ILIKE ${like}`, sql`to_tsvector('english', ${column}) @@ websearch_to_tsquery('english', ${q})`);

  const [messageRows, cardRows, narrationRows] = await Promise.all([
    db
      .select({
        id: agentMessages.id,
        content: agentMessages.content,
        createdAt: agentMessages.createdAt,
        threadId: agentMessages.threadId,
        title: threads.title,
      })
      .from(agentMessages)
      .leftJoin(threads, eq(threads.id, agentMessages.threadId))
      .where(
        and(
          eq(agentMessages.orgId, orgId),
          eq(agentMessages.projectId, projectId),
          matches(sql`${agentMessages.content}`),
        ),
      )
      .orderBy(desc(agentMessages.createdAt))
      .limit(SEARCH_LIMIT),
    db
      .select()
      .from(cards)
      .where(
        and(
          eq(cards.orgId, orgId),
          eq(cards.projectId, projectId),
          or(matches(sql`${cards.title}`), matches(sql`${cards.proposal}`)),
        ),
      )
      .orderBy(desc(cards.updatedAt))
      .limit(SEARCH_LIMIT),
    db
      .select()
      .from(narrations)
      .where(
        and(
          eq(narrations.orgId, orgId),
          eq(narrations.projectId, projectId),
          matches(sql`coalesce(${narrations.fragment}, '')`),
        ),
      )
      .orderBy(desc(narrations.occurredAt))
      .limit(SEARCH_LIMIT),
  ]);

  const hits: SearchHit[] = [
    ...messageRows.map((r) => ({
      kind: 'message' as const,
      at: r.createdAt.toISOString(),
      where: r.title ?? 'a conversation',
      excerpt: excerpt(r.content, q),
      ref: { ...(r.threadId ? { thread_id: r.threadId } : {}) },
    })),
    ...cardRows.map((r) => ({
      kind: 'card' as const,
      at: r.updatedAt.toISOString(),
      where: r.title,
      excerpt: excerpt(r.proposal, q),
      ref: { card_id: r.id },
    })),
    ...narrationRows.map((r) => ({
      kind: 'event' as const,
      at: r.occurredAt.toISOString(),
      where: 'what I saw',
      excerpt: excerpt(r.fragment ?? '', q),
      ref: {},
    })),
  ];

  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, SEARCH_LIMIT);
}
