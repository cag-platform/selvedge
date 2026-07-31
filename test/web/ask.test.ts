import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { createAskRouter } from '../../src/server/web/routes/ask.js';
import { answerQuestion } from '../../src/server/ask/answer.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import type { LlmRequest, LlmResult } from '../../src/server/llm/types.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';

describe('web/routes/ask', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'where my retailers place orders' } }));
  });
  afterEach(async () => close());

  it('answers a question with the model, over the stack context', async () => {
    const answer = 'Loom is up and quiet — nothing needs you right now.';
    const fake = new FakeLlmClient((req: LlmRequest): LlmResult => ({
      ok: true,
      json: { answer },
      tokensIn: 10,
      tokensOut: 20,
      model: req.model,
    }));

    const app = appWithOrg(orgId, createAskRouter(db, { llm: fake, db }));
    const res = await request(app).post('/api/ask').send({ question: 'How is Loom?' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer, available: true });
    // The model saw the question and the owner's own words for the project.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.userContent).toContain('How is Loom?');
    expect(fake.requests[0]!.userContent).toContain('Loom');
  });

  it('400s on an empty question', async () => {
    const fake = new FakeLlmClient();
    const app = appWithOrg(orgId, createAskRouter(db, { llm: fake, db }));
    expect((await request(app).post('/api/ask').send({ question: '   ' })).status).toBe(400);
    expect((await request(app).post('/api/ask').send({})).status).toBe(400);
  });

  it('answers gracefully (available:false) when the voice is not configured', async () => {
    const app = appWithOrg(orgId, createAskRouter(db, undefined));
    const res = await request(app).post('/api/ask').send({ question: 'anything?' });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(typeof res.body.answer).toBe('string');
  });

  it('502s when the model call fails', async () => {
    const fake = new FakeLlmClient((req: LlmRequest): LlmResult => ({
      ok: false,
      reason: 'network_or_timeout',
      tokensIn: 0,
      tokensOut: 0,
      model: req.model,
    }));
    const app = appWithOrg(orgId, createAskRouter(db, { llm: fake, db }));
    const res = await request(app).post('/api/ask').send({ question: 'How is Loom?' });
    expect(res.status).toBe(502);
  });

  it('bounds the context on a large stack (caps projects, truncates, notes omissions)', async () => {
    const longDesc = 'x'.repeat(2000);
    for (let i = 0; i < 60; i++) {
      await createPack(
        db,
        orgId,
        makeTestPack({
          identity: { project_id: `p${i}`, name: `Proj${i}`, owner_description: longDesc },
          stakes: { tier: 'sandbox', has_external_users: false, touches_money: false },
        }),
      );
    }
    const fake = new FakeLlmClient((req: LlmRequest): LlmResult => ({ ok: true, json: { answer: 'ok' }, tokensIn: 1, tokensOut: 1, model: req.model }));

    const result = await answerQuestion({ llm: fake, db }, orgId, 'status?');
    expect(result.ok).toBe(true);

    const sent = fake.requests[0]!.userContent;
    // The 2000-char descriptions must have been truncated (never sent whole).
    expect(sent).not.toContain(longDesc);
    // No more than the cap of projects appear (each project object has a "tier").
    expect((sent.match(/"tier"/g) ?? []).length).toBeLessThanOrEqual(40);
    // And it says plainly that some were left out.
    expect(sent).toMatch(/project.*omitted/i);
    // Sanity: the whole payload stays comfortably bounded.
    expect(sent.length).toBeLessThan(60_000);
  });
});
