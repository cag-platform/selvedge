import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, cards, continuationClaims, continuationSessions, decisionBriefs, handoffReceipts, orgs, projectSeenCursors } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { createThread } from '../../src/server/threads/store.js';
import { createTimelineRouter } from '../../src/server/web/routes/timeline.js';
import { appWithOrg } from './helpers.js';
import { onPlan } from '../helpers/plan.js';
import { eq } from 'drizzle-orm';

describe('web/routes/timeline — the record, made visible', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    // These tests are about the WINDOW PARAMETER — days=0, days=99999, the
    // default fortnight — so the plan's own 30-day floor is out of the way.
    // The floor gets its own tests at the bottom of the file.
    await onPlan(db, orgId);
    await onPlan(db, 'org_2');
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
    const thread = await createThread(db, orgId, 'loom', { kind: 'workshop', title: 'Checkout rework' });
    await db.insert(agentMessages).values({
      id: 'm1',
      orgId,
      projectId: 'loom',
      threadId: thread.id,
      role: 'owner',
      content: 'the basket empties itself when you go back',
    });
    await db.insert(cards).values([
      {
        id: 'recent',
        orgId,
        projectId: 'loom',
        trigger: 'request',
        title: 'guest checkout',
        proposal: 'Let people buy without an account.',
        risk: 'ordinary',
        gate: 'normal',
        state: 'done',
        verdict: 'verified',
        estimate: {},
        stop: {},
        acts: [],
        createdAt: ago(3),
        updatedAt: ago(3),
      },
      {
        id: 'ancient',
        orgId,
        projectId: 'loom',
        trigger: 'request',
        title: 'a change from the spring',
        proposal: 'x',
        risk: 'ordinary',
        gate: 'normal',
        state: 'done',
        verdict: 'probably',
        estimate: {},
        stop: {},
        acts: [],
        createdAt: ago(120),
        updatedAt: ago(120),
      },
    ]);
  });
  afterEach(async () => close());

  const app = () => appWithOrg(orgId, createTimelineRouter(db));

  it('answers "what happened lately" with a fortnight by default', async () => {
    const res = await request(app()).get('/api/projects/loom/timeline');
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('Loom');
    expect(res.body.days).toBe(14);
    const story = res.body.entries.map((e: { sentence: string }) => e.sentence).join('\n');
    expect(story).toContain('guest checkout');
    expect(story).not.toContain('from the spring');
    // Every entry is one sentence with an edge and its evidence beneath it.
    for (const entry of res.body.entries) {
      expect(entry.sentence.length).toBeGreaterThan(0);
      expect(['healthy', 'working', 'needs', 'unknown']).toContain(entry.status);
      expect(Array.isArray(entry.evidence)).toBe(true);
    }
  });

  it('opens the window when asked, and never further than a year', async () => {
    const all = await request(app()).get('/api/projects/loom/timeline?days=0');
    expect(all.body.days).toBe(0);
    expect(all.body.entries.map((e: { sentence: string }) => e.sentence).join('\n')).toContain('from the spring');

    const silly = await request(app()).get('/api/projects/loom/timeline?days=99999');
    expect(silly.body.days).toBe(365);
    const junk = await request(app()).get('/api/projects/loom/timeline?days=nonsense');
    expect(junk.body.days).toBe(14);
  });

  it('searches the project and says where each hit came from', async () => {
    const res = await request(app()).get('/api/projects/loom/search?q=basket');
    expect(res.status).toBe(200);
    expect(res.body.hits[0]).toMatchObject({ kind: 'message', where: 'Checkout rework' });
    expect(res.body.hits[0].excerpt).toContain('basket');

    const empty = await request(app()).get('/api/projects/loom/search?q=');
    expect(empty.body.hits).toEqual([]);
  });

  it('does not mark Since you left seen until its returned cursor is explicitly acknowledged', async () => {
    const first = await request(app()).get('/api/projects/loom/since-you-left');
    const second = await request(app()).get('/api/projects/loom/since-you-left');
    expect(first.status).toBe(200);
    expect(first.body.first_visit).toBe(true);
    expect(second.body.first_visit).toBe(true);
    expect(await db.select().from(projectSeenCursors)).toHaveLength(0);

    const acknowledged = await request(app()).post('/api/projects/loom/since-you-left/acknowledge').send({ through: first.body.through });
    expect(acknowledged.status).toBe(200);
    expect(await db.select().from(projectSeenCursors)).toHaveLength(1);

    const afterAt = new Date(new Date(first.body.through).getTime() + 1_000);
    await db.insert(cards).values({ id: 'after_seen', orgId, projectId: 'loom', trigger: 'request', title: 'new context change',
      proposal: 'Review the newly changed context.', risk: 'ordinary', gate: 'normal', state: 'proposed', estimate: {}, stop: {}, acts: [], createdAt: afterAt, updatedAt: afterAt });
    const after = await request(app()).get('/api/projects/loom/since-you-left');
    expect(after.body.first_visit).toBe(false);
    expect(after.body.entries.some((entry: { sentence: string }) => entry.sentence.includes('context change'))).toBe(true);
  });

  it('searches canonical decisions, confirmed claims, receipts, thread titles, and the project with typed destinations', async () => {
    const threadId = (await db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')))[0]!.threadId!;
    await db.insert(decisionBriefs).values({ id: 'decision_1', orgId, projectId: 'loom', thinkingThreadId: threadId,
      title: 'Returns policy', decision: 'Offer thirty-day returns.', evidenceMessages: 1 });
    await db.insert(continuationSessions).values({ id: 'continuation_1', orgId, projectId: 'loom' });
    await db.insert(continuationClaims).values({ id: 'claim_1', orgId, continuationId: 'continuation_1', projectId: 'loom',
      claimKey: 'returns.window', claimGroup: 'Policy', text: 'Returns remain open for thirty days.', value: {}, status: 'understood',
      confidence: 'confirmed', consequence: 'high', evidence: [] });
    await db.insert(handoffReceipts).values({ id: 'receipt_1', orgId, threadId, projectId: 'loom', fromAgent: 'claude', toAgent: 'codex',
      included: [], omitted: [], repository: {}, estimatedTokens: 10, transcriptTokens: 10 });

    const cases = [
      ['Loom', 'project'], ['Checkout', 'thread'], ['thirty-day', 'decision'], ['Returns remain', 'project_brief_claim'], ['codex', 'handoff_receipt'],
    ] as const;
    for (const [query, kind] of cases) {
      const result = await request(app()).get(`/api/projects/loom/search?q=${encodeURIComponent(query)}`);
      const hit = result.body.hits.find((item: { kind: string }) => item.kind === kind);
      expect(hit, `${kind} hit`).toBeTruthy();
      expect(hit.destination.kind).toBe(kind === 'message' ? 'thread' : kind);
      expect(hit.destination.web_path).toMatch(/^\//);
      expect(hit.destination.ios_path).toMatch(/^selvedge:\/\//);
    }
  });

  it('lists project handoff history with stable destinations and tenant scoping', async () => {
    const threadId = (await db.select().from(agentMessages).where(eq(agentMessages.id, 'm1')))[0]!.threadId!;
    await db.insert(handoffReceipts).values({ id: 'receipt_history', orgId, threadId, projectId: 'loom', fromAgent: 'claude', toAgent: 'codex',
      included: [], omitted: [], repository: {}, estimatedTokens: 10, transcriptTokens: 10 });
    const history = await request(app()).get('/api/projects/loom/handoffs');
    expect(history.body.receipts[0].destination).toMatchObject({ kind: 'handoff_receipt', receipt_id: 'receipt_history', thread_id: threadId });
    expect((await request(appWithOrg('org_2', createTimelineRouter(db))).get('/api/projects/loom/handoffs')).status).toBe(404);
  });

  it('is org-scoped, and a project that is not yours is not there', async () => {
    const otherOrg = appWithOrg('org_2', createTimelineRouter(db));
    expect((await request(otherOrg).get('/api/projects/loom/timeline')).status).toBe(404);
    expect((await request(otherOrg).get('/api/projects/loom/search?q=basket')).status).toBe(404);
    expect((await request(app()).get('/api/projects/nope/timeline')).status).toBe(404);
  });

  /**
   * LOCKED, NOT GONE.
   *
   * The Free plan's history window is a floor on what is SHOWN. The rows stay
   * exactly where they were, the export still carries them, and the response
   * always says how many are behind the lock — a window that silently returns
   * fewer entries is the same lie as a truncated list that doesn't say it
   * truncated.
   */
  describe('the plan history window', () => {
    const free = 'org_free';
    const freeApp = () => appWithOrg(free, createTimelineRouter(db));

    beforeEach(async () => {
      await db.insert(orgs).values({ orgId: free });
      await createPack(db, free, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
      const thread = await createThread(db, free, 'loom', { kind: 'workshop', title: 'Checkout rework' });
      await db.insert(agentMessages).values({
        id: 'fm1',
        orgId: free,
        projectId: 'loom',
        threadId: thread.id,
        role: 'owner',
        content: 'the basket empties itself when you go back',
      });
      const card = (id: string, title: string, at: Date) => ({
        id,
        orgId: free,
        projectId: 'loom',
        trigger: 'request' as const,
        title,
        proposal: `About ${title}.`,
        risk: 'ordinary' as const,
        gate: 'normal' as const,
        state: 'done' as const,
        verdict: 'verified' as const,
        estimate: {},
        stop: {},
        acts: [],
        createdAt: at,
        updatedAt: at,
      });
      await db.insert(cards).values([card('f_recent', 'guest checkout', ago(3)), card('f_old', 'the spring rework', ago(90))]);
    });

    it('shows the last thirty days and counts what it is holding back', async () => {
      const res = await request(freeApp()).get('/api/projects/loom/timeline?days=0');
      expect(res.status).toBe(200);

      const sentences = res.body.entries.map((e: { sentence: string }) => e.sentence).join('\n');
      expect(sentences).toContain('guest checkout');
      expect(sentences).not.toContain('spring rework');
      // The count is the whole point: the owner is told what exists even when
      // they cannot see it.
      expect(res.body.locked_older_count).toBeGreaterThan(0);
      expect(res.body.locked_note).toMatch(/never deleted/i);
    });

    it('says nothing is locked when nothing is', async () => {
      const res = await request(freeApp()).get('/api/projects/loom/timeline?days=7');
      expect(res.body.locked_older_count).toBe(0);
      expect(res.body.locked_note).toBeNull();
    });

    it('never quietly drops a search hit', async () => {
      const res = await request(freeApp()).get('/api/projects/loom/search?q=spring');
      expect(res.status).toBe(200);
      expect(res.body.hits).toEqual([]);
      // Found nothing to show, and said so — rather than teaching the owner
      // their record does not contain something it does contain.
      expect(res.body.locked_older_count).toBeGreaterThan(0);
      expect(res.body.locked_note).toBeTruthy();
    });

    it('locks nothing at all once someone pays', async () => {
      await onPlan(db, free);
      const res = await request(freeApp()).get('/api/projects/loom/timeline?days=0');
      expect(res.body.entries.map((e: { sentence: string }) => e.sentence).join('\n')).toContain('spring rework');
      expect(res.body.locked_older_count).toBe(0);
    });
  });
});
