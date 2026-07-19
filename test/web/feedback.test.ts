import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, feedback } from '../../src/server/db/schema/index.js';
import { createFeedbackRouter } from '../../src/server/web/routes/feedback.js';
import { DbNarrationLibrary } from '../../src/server/narration/library.js';
import { narrateDispatch } from '../../src/server/narration/dispatch.js';
import { route } from '../../src/server/routing/route.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { and, eq } from 'drizzle-orm';
import type { NarratableEvent } from '../../src/server/narration/types.js';

function ev(id: string): NarratableEvent {
  return {
    id,
    org_id: 'org_1',
    event_type: 'build.succeeded',
    occurred_at: '2026-07-19T10:00:00Z',
    severity_hint: 'info',
    signature: 'Deploy to Railway',
  };
}

describe('feedback taps (acceptance gate 4)', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  const pack = makeTestPack({
    identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
    stakes: { tier: 'live_small', has_external_users: true, touches_money: false },
  });

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_b' }]);
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await close();
  });

  it('a "didn\'t help" tap on a graduated entry retires it; the next identical event takes the LLM path', async () => {
    const library = new DbNarrationLibrary(db);
    const output = { fragment: 'Loom: your update went live cleanly.' };
    for (let i = 0; i < 5; i++) await library.writeCandidate(orgId, ev(`seed_${i}`), pack, output);

    // Sanity: graduated — a LIB-routed dispatch is served from the library.
    const decision = route({ event_type: 'build.succeeded' }, pack);
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { fragment: 'Loom: fresh LLM words.', technical_line: 't', confidence: 'high' },
      tokensIn: 10,
      tokensOut: 10,
      model: req.model,
    }));
    const served = await narrateDispatch(ev('evt_hit'), pack, decision, { llm: fake, db, library });
    expect(served?.meta.lib_hit).toBe(true);
    expect(fake.requests).toHaveLength(0);

    // Persist the narration row the user will tap on (as ingest would).
    await db.insert(narrations).values({
      id: 'narr_1',
      orgId,
      projectId: 'loom',
      eventId: 'evt_hit',
      eventType: 'build.succeeded',
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      path: 'LIB',
      intendedPath: 'LIB',
      delivery: 'DIGEST',
      fragment: served!.output.fragment,
      meta: { lib_hit: true, fingerprint: served!.meta.fingerprint },
    });

    // The tap.
    const app = appWithOrg(orgId, createFeedbackRouter(db));
    const res = await request(app).post('/api/feedback').send({ narration_id: 'narr_1', kind: 'didnt_help' });
    expect(res.status).toBe(200);
    expect(res.body.retired_library_entry).toBe(true);

    // Feedback row written; fragment marked for review.
    expect(await db.select().from(feedback)).toHaveLength(1);
    const [tapped] = await db.select().from(narrations).where(and(eq(narrations.orgId, orgId), eq(narrations.id, 'narr_1')));
    expect((tapped?.meta as { needs_review?: boolean }).needs_review).toBe(true);

    // Next identical event: library no longer serves it — the LLM path runs.
    const after = await narrateDispatch(ev('evt_next'), pack, decision, { llm: fake, db, library });
    expect(after?.meta.lib_hit).toBe(false);
    expect(fake.requests).toHaveLength(1);
    expect(after?.output.fragment).toContain('fresh LLM words');
  });

  it('explain_differently carries the free-text note', async () => {
    await db.insert(narrations).values({
      id: 'narr_2',
      orgId,
      projectId: 'loom',
      eventId: 'evt_2',
      eventType: 'code.pr_opened',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      fragment: 'x',
    });
    const app = appWithOrg(orgId, createFeedbackRouter(db));
    const res = await request(app)
      .post('/api/feedback')
      .send({ narration_id: 'narr_2', kind: 'explain_differently', note: 'say it like I am five' });
    expect(res.status).toBe(200);
    const rows = await db.select().from(feedback);
    expect(rows[0]?.note).toBe('say it like I am five');
  });

  it('rejects taps on another org\'s narration', async () => {
    await db.insert(narrations).values({
      id: 'narr_3',
      orgId: 'org_b',
      projectId: 'p',
      eventId: 'e',
      eventType: 'code.pr_opened',
      occurredAt: new Date(),
      path: 'TEMPLATE',
      intendedPath: 'TEMPLATE',
      delivery: 'DIGEST',
      fragment: 'x',
    });
    const app = appWithOrg(orgId, createFeedbackRouter(db));
    const res = await request(app).post('/api/feedback').send({ narration_id: 'narr_3', kind: 'didnt_help' });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown kind', async () => {
    const app = appWithOrg(orgId, createFeedbackRouter(db));
    const res = await request(app).post('/api/feedback').send({ narration_id: 'x', kind: 'thumbs_up' });
    expect(res.status).toBe(400);
  });
});
