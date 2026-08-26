import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { devices, orgs, productEvents, threadContextSources } from '../../src/server/db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { conversationReferenceById } from '../../src/server/references/resolve.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { fileConversations } from '../../src/server/import/consumer/store.js';
import { createContinuationsRouter } from '../../src/server/web/routes/continuations.js';
import { appWithOrg } from './helpers.js';
import { FakePushSender } from '../../src/server/push/fake.js';

describe('continuation wedge API', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
    await createPack(db, orgId, makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'A shop for handwoven curtains.' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }], stack_summary: 'React and Postgres.' },
    }));
  });
  afterEach(async () => close());

  async function importedThread(): Promise<string> {
    const filed = await fileConversations(db, orgId, { projectId: 'loom' }, 'chatgpt', [{
      sourceId: 'chat-1', title: 'Loom checkout decisions', startedAt: '2026-08-20T10:00:00Z',
      messages: [
        { role: 'owner', content: 'Keep checkout guest-only.', at: '2026-08-20T10:00:00Z' },
        { role: 'agent', content: 'We decided not to require accounts.', at: '2026-08-20T10:01:00Z' },
      ],
    }]);
    return filed.threadIds[0]!;
  }

  it('builds a sourced brief and converts it to one ordinary project thread idempotently', async () => {
    const app = appWithOrg(orgId, createContinuationsRouter(db));
    const created = await request(app).post('/api/continuations').send({ project_id: 'loom' });
    expect(created.status).toBe(201);
    const continuationId = created.body.continuation.id as string;
    const threadId = await importedThread();

    expect((await request(app).post(`/api/continuations/${continuationId}/sources/imported-threads`).send({ thread_id: threadId })).status).toBe(201);
    const analyzed = await request(app).post(`/api/continuations/${continuationId}/analyze`);
    expect(analyzed.status).toBe(200);
    expect(analyzed.body.can_continue).toBe(true);
    expect(analyzed.body.needs_confirmation.length).toBeLessThanOrEqual(3);
    expect(analyzed.body.understood.every((claim: { evidence: unknown[] }) => claim.evidence.length > 0)).toBe(true);
    expect(analyzed.body.understood.some((claim: { key: string }) => claim.key === 'project.repository')).toBe(true);
    expect(analyzed.body.understood.some((claim: { key: string }) => claim.key === 'project.prior_conversations')).toBe(true);

    const first = await request(app).post(`/api/continuations/${continuationId}/accept`);
    const second = await request(app).post(`/api/continuations/${continuationId}/accept`);
    expect(first.status).toBe(201);
    expect(second.body.thread.id).toBe(first.body.thread.id);
    expect(first.body.thread.kind).toBe('general');
    const links = await db.select().from(threadContextSources).where(and(
      eq(threadContextSources.orgId, orgId), eq(threadContextSources.threadId, first.body.thread.id),
    ));
    expect(links.map((link) => link.sourceThreadId)).toEqual([threadId]);
    const carried = await conversationReferenceById(db, orgId, links[0]!.sourceThreadId);
    expect(carried?.text).toContain('Keep checkout guest-only');
    expect(carried?.note).toBe('imported from ChatGPT');
  });

  it('does not accept without both the repository and a prior conversation', async () => {
    const app = appWithOrg(orgId, createContinuationsRouter(db));
    const created = await request(app).post('/api/continuations').send({ project_id: 'loom' });
    const res = await request(app).post(`/api/continuations/${created.body.continuation.id}/accept`);
    expect(res.status).toBe(409);
  });

  it("cannot attach another org's imported conversation or read its continuation", async () => {
    const theirs = await createPack(db, 'org_2', makeTestPack({
      identity: { project_id: 'theirs', name: 'Theirs', owner_description: 'Not ours.' },
      topology: { sources: [{ connector: 'github', resource_id: 'other/theirs', role: 'source_of_truth' }] },
    }));
    expect(theirs.identity.project_id).toBe('theirs');
    const otherApp = appWithOrg('org_2', createContinuationsRouter(db));
    const other = await request(otherApp).post('/api/continuations').send({ project_id: 'theirs' });
    const app = appWithOrg(orgId, createContinuationsRouter(db));
    expect((await request(app).get(`/api/continuations/${other.body.continuation.id}`)).status).toBe(404);
  });

  it('adds notes, documents, and URLs with honest freshness and limitations', async () => {
    const app = appWithOrg(orgId, createContinuationsRouter(db));
    const created = await request(app).post('/api/continuations').set('x-selvedge-surface', 'ios_native').send({ project_id: 'loom' });
    const id = created.body.continuation.id as string;

    const note = await request(app).post(`/api/continuations/${id}/sources/notes`).set('x-selvedge-surface', 'ios_native').send({
      title: 'Checkout policy', text: 'Guest checkout is required.', observed_at: '2020-01-01T00:00:00Z',
    });
    expect(note.status).toBe(201);
    expect(note.body.source).toMatchObject({ kind: 'pasted_note', freshness: 'stale', has_content: true });
    expect(note.body.source.limitations[0]).toMatch(/not verified/i);

    const document = await request(app).post(`/api/continuations/${id}/sources/documents`).send({
      title: 'Checkout policy', text: 'Accounts are required.', mime_type: 'application/pdf',
    });
    expect(document.status).toBe(201);
    expect(document.body.source).toMatchObject({ kind: 'document', freshness: 'current', has_content: true });
    expect(document.body.source.limitations[0]).toMatch(/layout/i);

    const url = await request(app).post(`/api/continuations/${id}/sources/urls`).send({ url: 'https://example.com/spec#checkout' });
    expect(url.status).toBe(201);
    expect(url.body.source).toMatchObject({ kind: 'live_url', source_ref: 'https://example.com/spec', has_content: false });
    expect(url.body.source.limitations[0]).toMatch(/not fetched/i);

    const brief = await request(app).post(`/api/continuations/${id}/analyze`);
    expect(brief.body.can_continue).toBe(true);
    expect(brief.body.sources).toHaveLength(4);
    expect(brief.body.needs_confirmation.length).toBeLessThanOrEqual(3);
    expect(brief.body.needs_confirmation.some((claim: { text: string }) => claim.text.includes('different information'))).toBe(true);
    const stale = brief.body.needs_confirmation.find((claim: { key: string }) => claim.key === `source.${note.body.source.id}`);
    expect(stale.evidence[0]).toMatchObject({ kind: 'pasted_note', freshness: 'stale' });

    const accepted = await request(app).post(`/api/continuations/${id}/accept`);
    expect(accepted.status).toBe(201);

    const events = await db.select().from(productEvents).where(and(eq(productEvents.orgId, orgId), eq(productEvents.surface, 'ios_native')));
    expect(events.map((event) => event.name)).toEqual(['continuation_started', 'source_added']);
  });

  it('derives context health from the latest continuation and remains tenant-scoped', async () => {
    const app = appWithOrg(orgId, createContinuationsRouter(db));
    const created = await request(app).post('/api/continuations').send({ project_id: 'loom' });
    const id = created.body.continuation.id as string;
    await request(app).post(`/api/continuations/${id}/sources/notes`).send({ title: 'Old plan', text: 'Use the legacy checkout.', observed_at: '2020-01-01T00:00:00Z' });

    const health = await request(app).get('/api/projects/loom/context-health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ project: { id: 'loom', name: 'Loom' }, status: 'needs_attention' });
    expect(health.body.counts).toMatchObject({ total: 2, stale: 1, limited: 1 });
    expect(health.body.sources.every((source: { source_ref: string }) => typeof source.source_ref === 'string')).toBe(true);

    const otherApp = appWithOrg('org_2', createContinuationsRouter(db));
    expect((await request(otherApp).get('/api/projects/loom/context-health')).status).toBe(404);
  });

  it('routes a first consequential context change to the exact claim on native clients', async () => {
    const push = new FakePushSender();
    await db.insert(devices).values({ orgId, token: 'ios-token', platform: 'ios', environment: 'sandbox' });
    const app = appWithOrg(orgId, createContinuationsRouter(db, { pushSender: push }));
    const created = await request(app).post('/api/continuations').send({ project_id: 'loom' });
    const id = created.body.continuation.id as string;
    await request(app).post(`/api/continuations/${id}/sources/notes`).send({ title: 'Old policy', text: 'Use accounts.', observed_at: '2020-01-01T00:00:00Z' });
    const brief = await request(app).post(`/api/continuations/${id}/analyze`);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.notification.data).toMatchObject({ route: 'project_brief_claim', project_id: 'loom',
      continuation_id: id, claim_id: brief.body.needs_confirmation[0].id });
    expect(push.sent[0]!.notification.data!.ios_path).toMatch(/^selvedge:\/\/continuations\//);
    await request(app).post(`/api/continuations/${id}/analyze`);
    expect(push.sent).toHaveLength(1);
  });
});
