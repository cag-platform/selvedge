import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import {
  agentMessages,
  continuationClaims,
  continuationSessions,
  continuationSources,
  threadContextSources,
  threads,
} from '../db/schema/index.js';
import { getPack } from '../packs/store.js';
import { startingAgentFor } from '../../shared/agents.js';
import type { ClaimEvidence, ContextHealth, ContinuationSource, ContinuationSourceKind, ProjectBrief, ProjectBriefClaim, SourceFreshness } from '../../shared/types/continuation.js';

type Session = typeof continuationSessions.$inferSelect;
type SourceRow = typeof continuationSources.$inferSelect;

const AGING_MS = 30 * 24 * 60 * 60 * 1000;
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BOUND_SOURCES = 12;

function freshness(observedAt: Date | null, now = new Date()): SourceFreshness {
  if (!observedAt || Number.isNaN(observedAt.getTime())) return 'unknown';
  const age = Math.max(0, now.getTime() - observedAt.getTime());
  return age >= STALE_MS ? 'stale' : age >= AGING_MS ? 'aging' : 'current';
}

function limitationsOf(source: SourceRow): string[] {
  return Array.isArray(source.limitations) ? source.limitations.filter((item): item is string => typeof item === 'string') : [];
}

export function shapeSource(source: SourceRow): ContinuationSource {
  return { id: source.id, kind: source.kind as ContinuationSourceKind, title: source.title, source_ref: source.sourceRef,
    observed_at: source.observedAt.toISOString(), version: source.version, freshness: freshness(source.observedAt),
    limitations: limitationsOf(source), has_content: Boolean(source.content?.trim()) };
}

export async function getContinuation(db: Db, orgId: string, id: string): Promise<Session | null> {
  const [row] = await db.select().from(continuationSessions)
    .where(and(eq(continuationSessions.orgId, orgId), eq(continuationSessions.id, id))).limit(1);
  return row ?? null;
}

export async function createContinuation(db: Db, orgId: string, projectId: string): Promise<Session | null> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return null;
  const now = new Date();
  const id = ulid();
  const repo = pack.topology.sources.find((source) => source.connector === 'github')?.resource_id;
  const [session] = await db.insert(continuationSessions).values({ id, orgId, projectId, createdAt: now, updatedAt: now }).returning();
  if (repo) {
    await db.insert(continuationSources).values({
      id: ulid(), orgId, continuationId: id, projectId, kind: 'repository', sourceRef: repo,
      title: repo, observedAt: now, version: pack.state?.serving_now?.version_ref ?? null, limitations: [],
    });
  }
  return session!;
}

export async function addImportedThreadSource(db: Db, orgId: string, continuationId: string, threadId: string) {
  const session = await getContinuation(db, orgId, continuationId);
  if (!session || session.state === 'converted' || session.state === 'abandoned') return { kind: 'no_session' as const };
  const [thread] = await db.select().from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.id, threadId))).limit(1);
  if (!thread || !thread.importedFrom) return { kind: 'not_imported' as const };
  const [latest] = await db.select({ at: agentMessages.createdAt }).from(agentMessages)
    .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, threadId)))
    .orderBy(desc(agentMessages.createdAt)).limit(1);
  const observedAt = latest?.at ?? thread.createdAt;
  const [source] = await db.insert(continuationSources).values({
    id: ulid(), orgId, continuationId, projectId: session.projectId, kind: 'imported_thread',
    sourceRef: threadId, title: thread.title, observedAt,
    version: `${thread.importedFrom}:${thread.importSourceId ?? thread.id}`, limitations: [],
  }).onConflictDoNothing().returning();
  return { kind: 'ok' as const, source: source ?? null };
}

export async function addTextSource(db: Db, orgId: string, continuationId: string, input: {
  kind: 'pasted_note' | 'document' | 'live_url'; title: string; sourceRef: string; content: string | null;
  observedAt: Date; version?: string | null; limitations?: string[];
}) {
  const session = await getContinuation(db, orgId, continuationId);
  if (!session || session.state === 'converted' || session.state === 'abandoned') return null;
  const [source] = await db.insert(continuationSources).values({
    id: ulid(), orgId, continuationId, projectId: session.projectId, kind: input.kind, sourceRef: input.sourceRef,
    title: input.title, content: input.content, observedAt: input.observedAt, version: input.version ?? null,
    limitations: input.limitations ?? [],
  }).onConflictDoNothing().returning();
  return source ?? null;
}

function evidence(source: SourceRow): ClaimEvidence {
  return { source_id: source.id, kind: source.kind as ContinuationSourceKind, label: source.title,
    observed_at: source.observedAt.toISOString(), version: source.version, freshness: freshness(source.observedAt), limitations: limitationsOf(source) };
}

function sameTopicConflicts(sources: SourceRow[]): SourceRow[][] {
  const groups = new Map<string, SourceRow[]>();
  for (const source of sources.filter((item) => item.content?.trim())) {
    const key = source.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  return [...groups.values()].filter((group) => group.length > 1 && new Set(group.map((item) => item.content!.replace(/\s+/g, ' ').trim())).size > 1);
}

export async function analyzeContinuation(db: Db, orgId: string, continuationId: string): Promise<ProjectBrief | null> {
  const session = await getContinuation(db, orgId, continuationId);
  if (!session) return null;
  const pack = await getPack(db, orgId, session.projectId);
  if (!pack) return null;
  const sources = await db.select().from(continuationSources)
    .where(and(eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, continuationId)))
    .orderBy(asc(continuationSources.createdAt));
  const repo = sources.find((source) => source.kind === 'repository');
  const conversations = sources.filter((source) => source.kind === 'imported_thread');
  const supporting = sources.filter((source) => source.kind === 'pasted_note' || source.kind === 'document' || source.kind === 'live_url');
  const now = new Date();
  const drafts: Array<Omit<typeof continuationClaims.$inferInsert, 'id' | 'orgId' | 'continuationId' | 'projectId'>> = [];
  const add = (claim: { key: string; group: string; text: string; value: unknown; status: string; confidence: string; consequence: string; evidence: ClaimEvidence[] }) => {
    drafts.push({ claimKey: claim.key, claimGroup: claim.group, text: claim.text, value: claim.value, status: claim.status,
      confidence: claim.confidence, consequence: claim.consequence, evidence: claim.evidence, createdAt: now, updatedAt: now });
  };
  add({ key: 'project.identity', group: 'What this project is', text: `${pack.identity.name} — ${pack.identity.owner_description}`,
    value: pack.identity, status: 'understood', confidence: 'confirmed', consequence: 'high', evidence: repo ? [evidence(repo)] : [] });
  if (repo) add({ key: 'project.repository', group: 'Where the code lives', text: `The project repository is ${repo.sourceRef}.`,
    value: repo.sourceRef, status: 'understood', confidence: 'confirmed', consequence: 'blocking', evidence: [evidence(repo)] });
  if (pack.topology.stack_summary && repo) add({ key: 'project.stack', group: 'How it works', text: pack.topology.stack_summary,
    value: pack.topology.stack_summary, status: 'understood', confidence: 'supported', consequence: 'normal', evidence: [evidence(repo)] });
  if (conversations.length) add({ key: 'project.prior_conversations', group: 'Decisions and history',
    text: `${conversations.length} prior AI conversation${conversations.length === 1 ? '' : 's'} will travel with this project.`,
    value: conversations.map((source) => source.sourceRef), status: 'understood', confidence: 'confirmed', consequence: 'high',
    evidence: conversations.map(evidence) });
  else add({ key: 'missing.prior_conversation', group: 'Still missing', text: 'No prior AI conversation has been added yet.', value: null,
    status: 'still_missing', confidence: 'tentative', consequence: 'high', evidence: [] });
  for (const source of supporting) {
    const sourceFreshness = freshness(source.observedAt);
    const excerpt = source.content?.replace(/\s+/g, ' ').trim().slice(0, 240);
    add({ key: `source.${source.id}`, group: 'Supporting context',
      text: excerpt ? `${source.title}: ${excerpt}${source.content!.length > 240 ? '…' : ''}` : `${source.title} was added as a source, but its contents were not provided.`,
      value: { source_id: source.id }, status: sourceFreshness === 'stale' ? 'needs_confirmation' : 'understood',
      confidence: sourceFreshness === 'current' && !limitationsOf(source).length ? 'supported' : 'tentative', consequence: 'normal', evidence: [evidence(source)] });
  }
  sameTopicConflicts(supporting).slice(0, 3).forEach((group, index) => add({ key: `conflict.${index}`, group: 'Needs confirmation',
    text: `Sources named “${group[0]!.title}” contain different information. Which one should guide the next change?`,
    value: group.map((source) => source.id), status: 'needs_confirmation', confidence: 'tentative', consequence: 'high', evidence: group.map(evidence) }));
  if (!pack.topology.stack_summary) add({ key: 'missing.stack', group: 'Still missing', text: 'The project stack has not been established.', value: null,
    status: 'still_missing', confidence: 'tentative', consequence: 'normal', evidence: repo ? [evidence(repo)] : [] });
  if (!(pack.baselines?.known_flaky?.length)) add({ key: 'missing.verification', group: 'Still missing', text: 'How changes are normally verified is not established yet.', value: null,
    status: 'still_missing', confidence: 'tentative', consequence: 'normal', evidence: repo ? [evidence(repo)] : [] });

  await db.transaction(async (tx) => {
    await tx.delete(continuationClaims).where(and(eq(continuationClaims.orgId, orgId), eq(continuationClaims.continuationId, continuationId)));
    if (drafts.length) await tx.insert(continuationClaims).values(drafts.map((draft) => ({ ...draft, id: ulid(), orgId, continuationId, projectId: session.projectId })));
    await tx.update(continuationSessions).set({ state: 'reviewing', updatedAt: now })
      .where(and(eq(continuationSessions.orgId, orgId), eq(continuationSessions.id, continuationId)));
  });
  return briefFor(db, orgId, continuationId);
}

function shapeClaim(row: typeof continuationClaims.$inferSelect): ProjectBriefClaim {
  return { id: row.id, key: row.claimKey, group: row.claimGroup, text: row.text,
    status: row.status as ProjectBriefClaim['status'], confidence: row.confidence as ProjectBriefClaim['confidence'],
    consequence: row.consequence as ProjectBriefClaim['consequence'], evidence: row.evidence as ClaimEvidence[],
    confirmed_value: row.confirmedValue ?? null,
    destination: { kind: 'project_brief_claim', web_path: `/continue/${encodeURIComponent(row.continuationId)}/claims/${encodeURIComponent(row.id)}`,
      ios_path: `selvedge://continuations/${encodeURIComponent(row.continuationId)}/claims/${encodeURIComponent(row.id)}`,
      project_id: row.projectId, continuation_id: row.continuationId, claim_id: row.id } };
}

export async function claimFor(db: Db, orgId: string, continuationId: string, claimId: string): Promise<ProjectBriefClaim | null> {
  const [row] = await db.select().from(continuationClaims).where(and(eq(continuationClaims.orgId, orgId),
    eq(continuationClaims.continuationId, continuationId), eq(continuationClaims.id, claimId))).limit(1);
  return row ? shapeClaim(row) : null;
}

export async function briefFor(db: Db, orgId: string, continuationId: string): Promise<ProjectBrief | null> {
  const session = await getContinuation(db, orgId, continuationId);
  if (!session) return null;
  const pack = await getPack(db, orgId, session.projectId);
  if (!pack) return null;
  const rows = await db.select().from(continuationClaims)
    .where(and(eq(continuationClaims.orgId, orgId), eq(continuationClaims.continuationId, continuationId)))
    .orderBy(asc(continuationClaims.createdAt));
  const claims = rows.map(shapeClaim);
  const questions = claims.filter((claim) => claim.status === 'needs_confirmation').slice(0, 3);
  const sourceRows = await db.select().from(continuationSources).where(and(
    eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, continuationId),
  )).orderBy(asc(continuationSources.createdAt));
  return {
    continuation_id: continuationId, project: { id: session.projectId, name: pack.identity.name },
    generated_at: session.updatedAt.toISOString(), understood: claims.filter((claim) => claim.status === 'understood'),
    needs_confirmation: questions, still_missing: claims.filter((claim) => claim.status === 'still_missing'),
    questions_remaining: questions.length, can_continue: claims.some((claim) => claim.key === 'project.repository') && sourceRows.some((source) => source.kind !== 'repository'),
    sources: sourceRows.map(shapeSource),
  };
}

export async function resolveClaim(db: Db, orgId: string, continuationId: string, claimId: string, value: unknown) {
  const rows = await db.update(continuationClaims).set({ status: 'understood', confidence: 'confirmed', confirmedValue: value, resolvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(continuationClaims.orgId, orgId), eq(continuationClaims.continuationId, continuationId), eq(continuationClaims.id, claimId))).returning();
  return rows[0] ? shapeClaim(rows[0]) : null;
}

export async function acceptContinuation(db: Db, orgId: string, continuationId: string) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(continuationSessions)
      .where(and(eq(continuationSessions.orgId, orgId), eq(continuationSessions.id, continuationId))).limit(1);
    if (!session) return { kind: 'not_found' as const };
    if (session.convertedThreadId) {
      const [thread] = await tx.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.id, session.convertedThreadId))).limit(1);
      return thread ? { kind: 'ok' as const, thread, created: false } : { kind: 'not_found' as const };
    }
    const sourceCounts = await tx.select({ kind: continuationSources.kind, count: sql<number>`count(*)` }).from(continuationSources)
      .where(and(eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, continuationId))).groupBy(continuationSources.kind);
    const kinds = new Set(sourceCounts.filter((row) => Number(row.count) > 0).map((row) => row.kind));
    if (!kinds.has('repository') || ![...kinds].some((kind) => kind !== 'repository')) return { kind: 'not_ready' as const };
    // Claim the conversion before creating its thread. Concurrent accepts race
    // on this conditional update, so only one request can create side effects.
    const threadId = ulid();
    const [claim] = await tx.update(continuationSessions).set({ state: 'converted', convertedThreadId: threadId, updatedAt: new Date() })
      .where(and(eq(continuationSessions.orgId, orgId), eq(continuationSessions.id, continuationId), isNull(continuationSessions.convertedThreadId)))
      .returning({ id: continuationSessions.id });
    if (!claim) {
      const [converted] = await tx.select({ threadId: continuationSessions.convertedThreadId }).from(continuationSessions)
        .where(and(eq(continuationSessions.orgId, orgId), eq(continuationSessions.id, continuationId))).limit(1);
      if (!converted?.threadId) return { kind: 'not_found' as const };
      const [thread] = await tx.select().from(threads).where(and(eq(threads.orgId, orgId), eq(threads.id, converted.threadId))).limit(1);
      return thread ? { kind: 'ok' as const, thread, created: false } : { kind: 'not_found' as const };
    }
    const [thread] = await tx.insert(threads).values({ id: threadId, orgId, projectId: session.projectId, kind: 'general',
      title: 'Continue this project', agent: startingAgentFor('general') }).returning();
    const allContext = await tx.select({ kind: continuationSources.kind, sourceRef: continuationSources.sourceRef }).from(continuationSources).where(and(
      eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, continuationId), sql`${continuationSources.kind} <> 'repository'`,
    ));
    const selected = allContext.filter((source) => source.kind === 'imported_thread').map((source) => ({ sourceThreadId: source.sourceRef }));
    if (selected.length) await tx.insert(threadContextSources).values(selected.map((source) => ({ orgId, threadId: thread!.id, sourceThreadId: source.sourceThreadId })));
    await tx.insert(agentMessages).values({ id: ulid(), orgId, projectId: session.projectId, threadId: thread!.id, role: 'activity',
      content: `Continuation context attached: ${allContext.length} reviewed source${allContext.length === 1 ? '' : 's'}.` });
    return { kind: 'ok' as const, thread: thread!, created: true };
  });
}

export async function boundContextThreadIds(db: Db, orgId: string, threadId: string): Promise<string[]> {
  const rows = await db.select({ id: threadContextSources.sourceThreadId }).from(threadContextSources)
    .where(and(eq(threadContextSources.orgId, orgId), eq(threadContextSources.threadId, threadId)))
    .orderBy(asc(threadContextSources.createdAt)).limit(MAX_BOUND_SOURCES);
  return rows.map((row) => row.id);
}

export async function boundContinuationSources(db: Db, orgId: string, threadId: string): Promise<SourceRow[]> {
  const [session] = await db.select({ id: continuationSessions.id }).from(continuationSessions).where(and(
    eq(continuationSessions.orgId, orgId), eq(continuationSessions.convertedThreadId, threadId),
  )).limit(1);
  if (!session) return [];
  return db.select().from(continuationSources).where(and(
    eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, session.id),
  )).orderBy(asc(continuationSources.createdAt)).limit(MAX_BOUND_SOURCES);
}

export async function contextHealthForProject(db: Db, orgId: string, projectId: string): Promise<ContextHealth | null> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return null;
  const [latest] = await db.select({ id: continuationSessions.id }).from(continuationSessions).where(and(
    eq(continuationSessions.orgId, orgId), eq(continuationSessions.projectId, projectId),
  )).orderBy(desc(continuationSessions.updatedAt)).limit(1);
  const rows = latest ? await db.select().from(continuationSources).where(and(
    eq(continuationSources.orgId, orgId), eq(continuationSources.continuationId, latest.id),
  )).orderBy(asc(continuationSources.createdAt)) : [];
  const shaped = rows.map(shapeSource);
  const count = (state: SourceFreshness) => shaped.filter((source) => source.freshness === state).length;
  const conflicting = sameTopicConflicts(rows).length;
  const gaps: string[] = [];
  if (!rows.some((source) => source.kind === 'repository')) gaps.push('No repository source is attached.');
  if (!rows.some((source) => source.kind !== 'repository')) gaps.push('No prior conversation, note, document, or URL is attached.');
  if (!pack.topology.stack_summary) gaps.push('The project stack has not been established.');
  if (!(pack.baselines?.known_flaky?.length)) gaps.push('The normal verification path has not been established.');
  if (conflicting) gaps.push(`${conflicting} source topic${conflicting === 1 ? '' : 's'} contain conflicting information.`);
  const limited = shaped.filter((source) => source.limitations.length > 0).length;
  const status: ContextHealth['status'] = gaps.some((gap) => gap.startsWith('No repository')) ? 'limited'
    : gaps.length > 0 || count('aging') > 0 || count('stale') > 0 || count('unknown') > 0 || limited > 0
      ? 'needs_attention' : 'healthy';
  return { project: { id: projectId, name: pack.identity.name }, status, generated_at: new Date().toISOString(),
    summary: status === 'healthy' ? 'Project context is current enough to continue.' : status === 'limited' ? 'Project context is missing a required foundation.' : 'Some project context should be reviewed before a consequential change.',
    counts: { total: shaped.length, current: count('current'), aging: count('aging'), stale: count('stale'), unknown: count('unknown'), limited, conflicting },
    sources: shaped, gaps };
}
