import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { FakeLlmClient } from '../../src/server/llm/fake.js';
import type { LlmRequest, LlmResult } from '../../src/server/llm/types.js';
import { sketchTurn } from '../../src/server/sketch/converse.js';
import { addMessage, createSketch, listMessages } from '../../src/server/sketch/store.js';
import { ulid } from 'ulid';

const reply = (json: Record<string, unknown>) =>
  new FakeLlmClient((req: LlmRequest): LlmResult => ({ ok: true, json, tokensIn: 10, tokensOut: 20, model: req.model }));

describe('sketchTurn — thinking cheaply, before anything is built', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'where my retailers place orders' },
        stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
      }),
    );
  });
  afterEach(async () => close());

  it('gives the model the project in the owner\'s own words, and meters the spend as sketch', async () => {
    const fake = reply({ reply: 'What should happen to an order already placed?', questions: ['What about existing orders?'], ready: false, brief: null });
    const out = await sketchTurn({ llm: fake, db }, orgId, 'loom', [], 'let retailers cancel an order');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.questions).toEqual(['What about existing orders?']);
    expect(out.reply.ready).toBe(false);

    const sent = fake.requests[0]!.userContent;
    expect(sent).toContain('where my retailers place orders');
    expect(sent).toContain('let retailers cancel an order');
    // Stakes travel too — the model should know real people and money are involved.
    expect(sent).toContain('live_small');

    // Spend lands under its own purpose so it can be budgeted separately.
    const [usage] = await db.select().from(llmUsage);
    expect(usage!.purpose).toBe('sketch');
  });

  it('carries the conversation so far, so a follow-up builds on it rather than restarting', async () => {
    const sketch = await createSketch(db, orgId, 'cancelling orders', 'loom');
    await addMessage(db, orgId, sketch.id, 'owner', 'let retailers cancel an order');
    await addMessage(db, orgId, sketch.id, 'sketch', 'Within what window?');
    const history = await listMessages(db, orgId, sketch.id);

    const fake = reply({ reply: 'Then one hour it is.', questions: [], ready: false, brief: null });
    await sketchTurn({ llm: fake, db }, orgId, 'loom', history, 'within an hour');

    const sent = fake.requests[0]!.userContent;
    expect(sent).toContain('let retailers cancel an order');
    expect(sent).toContain('Within what window?');
    expect(sent).toContain('within an hour');
  });

  it('a ready idea comes back with a brief to hand over', async () => {
    const brief = 'Add a Cancel button to an order for one hour after it is placed, then hide it.';
    const fake = reply({ reply: 'Here is what I would build.', questions: [], ready: true, brief });
    const out = await sketchTurn({ llm: fake, db }, orgId, 'loom', [], 'cancel within an hour');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.ready).toBe(true);
    expect(out.reply.brief).toBe(brief);
  });

  it('"ready" without an actual brief is not ready — the button must never build nothing', async () => {
    const fake = reply({ reply: 'Sounds good!', questions: [], ready: true, brief: null });
    const out = await sketchTurn({ llm: fake, db }, orgId, 'loom', [], 'do the thing');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.ready).toBe(false);
    expect(out.reply.brief).toBeNull();

    const blank = reply({ reply: 'Sounds good!', questions: [], ready: true, brief: '   ' });
    const out2 = await sketchTurn({ llm: blank, db }, orgId, 'loom', [], 'do the thing');
    expect(out2.ok && out2.reply.ready).toBe(false);
  });

  it('without a project it offers the stack, so it can ask which app rather than guess', async () => {
    const fake = reply({ reply: 'Which app is this for?', questions: ['Which project?'], ready: false, brief: null });
    await sketchTurn({ llm: fake, db }, orgId, null, [], 'an idea about reviews');
    const sent = fake.requests[0]!.userContent;
    expect(sent).toContain('no_project_chosen_yet');
    expect(sent).toContain('Loom');
  });

  it('bounds a long conversation instead of sending it whole, and says what it dropped', async () => {
    const sketch = await createSketch(db, orgId, 'long one', 'loom');
    const longLine = 'y'.repeat(5000);
    // Marker first, so it survives truncation — what we're checking here is
    // WHICH turns were kept, not where a single one got cut.
    for (let i = 0; i < 40; i++) {
      await addMessage(db, orgId, sketch.id, i % 2 === 0 ? 'owner' : 'sketch', `turn${i} ${longLine}`);
    }
    const history = await listMessages(db, orgId, sketch.id);

    const fake = reply({ reply: 'ok', questions: [], ready: false, brief: null });
    await sketchTurn({ llm: fake, db }, orgId, 'loom', history, 'and now?');

    const sent = fake.requests[0]!.userContent;
    expect(sent).not.toContain(longLine); // every message truncated
    expect(sent).toMatch(/earlier message/i); // and the omission declared
    expect(sent).toContain('turn39'); // the most recent turns survive
    expect(sent).not.toContain('turn0'); // the oldest are dropped
  });

  it('stops at the day\'s thinking budget without spending anything more', async () => {
    // Blow the sketch allowance for today.
    await db.insert(llmUsage).values({
      id: ulid(),
      orgId,
      purpose: 'sketch',
      model: 'claude-sonnet-5',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 99,
    });
    const fake = reply({ reply: 'should never run', questions: [], ready: false, brief: null });
    const out = await sketchTurn({ llm: fake, db }, orgId, 'loom', [], 'another idea');

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('over_budget');
    expect(fake.requests).toHaveLength(0); // the gate stops the call, it doesn't just report it
  });

  it('honours the owner\'s language and glossary rather than ignoring their voice', async () => {
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'tienda', name: 'Tienda', owner_description: 'mi tienda' },
        voice: { detail_level: 'plain_only', language: 'Spanish', notify: { push_threshold: 'failures' }, glossary_overrides: [{ term: 'deploy', preferred_phrasing: 'publicar' }] },
      }),
    );
    const fake = reply({ reply: 'Claro.', questions: [], ready: false, brief: null });
    await sketchTurn({ llm: fake, db }, orgId, 'tienda', [], 'una idea');

    const sent = fake.requests[0]!.userContent;
    expect(sent).toContain('Spanish');
    expect(sent).toContain('publicar');
  });

  it('a model failure is reported honestly, not dressed up as an answer', async () => {
    const down = new FakeLlmClient((req: LlmRequest): LlmResult => ({ ok: false, reason: 'network_or_timeout', tokensIn: 0, tokensOut: 0, model: req.model }));
    const out = await sketchTurn({ llm: down, db }, orgId, 'loom', [], 'an idea');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('model_failed');
    // The failed call is still metered — it cost money.
    expect(await db.select().from(llmUsage)).toHaveLength(1);
  });
});
