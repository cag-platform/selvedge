import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { cards, narrations } from '../db/schema/index.js';
import { getPack, listPacks } from '../packs/store.js';
import { projectLines } from '../handoff/compose.js';
import { projectTimeline } from '../timeline/store.js';
import { listExternalSessions } from './sessions.js';

/**
 * WHAT AN AGENT ANYWHERE GETS TO KNOW — the write half of the loop.
 *
 * The same pack the brief is composed from and the Workshop's agent works
 * against, served to whatever tool the owner happens to be using today. One
 * source of truth, three shapes: what this project IS, what changed lately, and
 * what is open.
 *
 * READ-ONLY, deliberately. Agents consume context here; they do not write
 * memory. A tool that could write would let any agent, in any repo, edit what
 * Selvedge believes about a project — and the whole value of the pack is that
 * it is grounded in what actually happened, not in what an agent asserted.
 *
 * The composition reuses the handoff's project block, so an agent mounting the
 * MCP and an agent taking over a thread are told the same things about the same
 * project in the same words.
 */

const RECENT_DAYS = 14;
const MAX_RECENT = 12;

export type ProjectRef = { id: string; name: string; repo: string | null };

/** Every project this key can see, with the repo that identifies it locally. */
export async function listContextProjects(db: Db, orgId: string): Promise<ProjectRef[]> {
  const packs = await listPacks(db, orgId);
  return packs.map((pack) => ({
    id: pack.identity.project_id,
    name: pack.identity.name,
    repo: pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? null,
  }));
}

export type ProjectContext = {
  project: ProjectRef;
  text: string;
  sections: { about: string[]; recent: string[]; open: string[] };
};

/** What this project is, what happened lately, and what is open — as text an agent can read. */
export async function contextForProject(db: Db, orgId: string, projectId: string): Promise<ProjectContext | null> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return null;

  const [recent, open] = await Promise.all([recentChangesFor(db, orgId, projectId), openIssuesFor(db, orgId, projectId)]);
  const about = projectLines(pack);

  const text = [
    `You are working on ${pack.identity.name}. This is what Selvedge knows about it — the same note its owner reads, kept from what actually happened rather than from anything an agent claimed.`,
    ['WHAT THIS IS', ...about.map((l) => `- ${l}`)].join('\n'),
    recent.length
      ? ['WHAT CHANGED IN THE LAST TWO WEEKS', ...recent.map((l) => `- ${l}`)].join('\n')
      : 'WHAT CHANGED IN THE LAST TWO WEEKS\n- Nothing Selvedge saw.',
    open.length ? ['WHAT IS OPEN', ...open.map((l) => `- ${l}`)].join('\n') : 'WHAT IS OPEN\n- Nothing waiting on anyone.',
    'Where this is silent, it means Selvedge did not see it — not that it did not happen. Say so rather than filling the gap.',
  ].join('\n\n');

  return {
    project: { id: projectId, name: pack.identity.name, repo: pack.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? null },
    text,
    sections: { about, recent, open },
  };
}

/**
 * What actually changed lately: ships, verdicts and what the watching saw, plus
 * the sessions the companion observed — each marked as observed, because
 * Selvedge did not run or gate those and must not imply it did.
 */
export async function recentChangesFor(db: Db, orgId: string, projectId: string, days = RECENT_DAYS): Promise<string[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [entries, sessions] = await Promise.all([
    projectTimeline(db, orgId, projectId, { since, limit: 60 }),
    listExternalSessions(db, orgId, { projectId, since, limit: 20 }),
  ]);

  const fromRecord = entries
    .filter((e) => e.kind === 'ship' || e.kind === 'undo' || e.kind === 'verdict' || e.kind === 'event')
    .map((e) => e.sentence);

  const observed = sessions
    .filter((s) => s.outcome !== 'unreadable')
    .map((s) => {
      const what = s.intent ? `"${s.intent}"` : 'no stated ask';
      const files = Array.isArray(s.filesTouched) ? (s.filesTouched as string[]).length : 0;
      const tail = s.commitSha ? `, committed ${s.commitSha.slice(0, 7)}` : s.outcome === 'abandoned' ? ', abandoned' : '';
      return `Observed from outside (Selvedge did not run this): a ${s.agent} session — ${what}${files ? `, ${files} file${files === 1 ? '' : 's'} touched` : ''}${tail}.`;
    });

  return [...fromRecord, ...observed].slice(0, MAX_RECENT);
}

/** What is waiting on someone: cards that need the owner, gaps Selvedge can't see through, known flakiness. */
export async function openIssuesFor(db: Db, orgId: string, projectId: string): Promise<string[]> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return [];

  const waiting = await db
    .select({ title: cards.title, state: cards.state })
    .from(cards)
    .where(and(eq(cards.orgId, orgId), eq(cards.projectId, projectId), inArray(cards.state, ['proposed', 'blocked'])))
    .orderBy(desc(cards.updatedAt))
    .limit(10);

  const unresolved = await db
    .select({ fragment: narrations.fragment })
    .from(narrations)
    .where(
      and(
        eq(narrations.orgId, orgId),
        eq(narrations.projectId, projectId),
        eq(narrations.verdict, 'users_affected'),
        gte(narrations.occurredAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    )
    .orderBy(desc(narrations.occurredAt))
    .limit(5);

  return [
    ...waiting.map((c) => `${c.state === 'blocked' ? 'Paused, needs the owner' : 'Waiting for the owner to approve'}: ${c.title}`),
    ...unresolved.map((n) => `Reported in the last week: ${n.fragment}`).filter(Boolean),
    ...(pack.topology.capability_gaps ?? []).map((g) => `Selvedge cannot see this yet: ${g.summary}`),
    ...(pack.baselines?.known_flaky ?? [])
      .filter((f) => !f.graduated)
      .map((f) => `Known to be flaky, don't chase it: ${f.note ?? f.pattern}`),
  ];
}
