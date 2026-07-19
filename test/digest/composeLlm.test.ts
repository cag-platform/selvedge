import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, llmUsage, digests } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { composeDigestForOrg } from '../../src/server/digest/compose.js';
import { wordBudgetFor } from '../../src/server/digest/composeLlm.js';
import { FakeLlmClient, DownLlmClient } from '../../src/server/llm/fake.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { eq } from 'drizzle-orm';

describe('digest/composeLlm (Stage 2, integration through composeDigestForOrg)', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });

    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
        state: { serving_now: { deployed_at: '2026-07-01T00:00:00Z', healthy: true } },
      }),
    );
    // Yesterday (2026-07-19 relative to the Monday compose time): a deploy
    // failure -> B6 attention with users_fine verdict.
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'deploy.failed_previous_serving',
      occurred_at: '2026-07-19T10:00:00Z',
      severity_hint: 'error',
      raw: {},
      dedupe_key: 'd1',
    });
  });
  afterEach(async () => close());

  const composeAt = new Date('2026-07-20T12:00:00Z'); // Monday, avoids the Sunday retrospective branch
  const goodBrief =
    "One thing worth a look. Loom's update couldn't go live — users are fine, the previous version is still serving. Rerun the migration when you have a minute.";

  it('a valid composition is stored as the rendered text with voice=composed; mechanical kept alongside', async () => {
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { brief: goodBrief },
      tokensIn: 800,
      tokensOut: 120,
      model: req.model,
    }));

    const digest = await composeDigestForOrg(db, orgId, composeAt, { llm: fake, db });
    expect(digest.voice).toBe('composed');
    expect(digest.renderedText).toBe(goodBrief);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.system).toContain('COMPOSITION ONLY');

    const [row] = await db.select().from(digests).where(eq(digests.orgId, orgId));
    expect(row?.mechanicalText).toBeTruthy();
    expect(row?.mechanicalText).not.toBe(goodBrief);

    const usage = await db.select().from(llmUsage).where(eq(llmUsage.orgId, orgId));
    expect(usage.filter((u) => u.purpose === 'compose')).toHaveLength(1);
  });

  it('a validator violation triggers exactly one recomposition with the violation named', async () => {
    let call = 0;
    const fake = new FakeLlmClient((req) => {
      call++;
      return {
        ok: true,
        json: { brief: call === 1 ? 'Loom had a hiccup, probably nothing.' : goodBrief }, // 1st drops the verdict
        tokensIn: 800,
        tokensOut: 120,
        model: req.model,
      };
    });

    const digest = await composeDigestForOrg(db, orgId, composeAt, { llm: fake, db });
    expect(digest.voice).toBe('composed');
    expect(digest.renderedText).toBe(goodBrief);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.userContent).toContain('failed validation');
    expect(fake.requests[1]?.userContent).toContain('users are fine');
  });

  it('a second validator failure falls back to the mechanical digest — the brief always sends', async () => {
    const fake = new FakeLlmClient((req) => ({
      ok: true,
      json: { brief: 'Loom had a hiccup, probably nothing.' }, // never carries the verdict
      tokensIn: 800,
      tokensOut: 120,
      model: req.model,
    }));

    const digest = await composeDigestForOrg(db, orgId, composeAt, { llm: fake, db });
    expect(digest.voice).toBe('fallback');
    expect(digest.renderedText).toContain('Loom'); // mechanical text
    expect(digest.renderedText).toContain('users are fine'); // template fragment carries the verdict
    expect(fake.requests).toHaveLength(2); // one recomposition, then fallback
  });

  it('model outage (gate 6): digest still sends mechanically, voice=fallback, no crash, no silence', async () => {
    const digest = await composeDigestForOrg(db, orgId, composeAt, { llm: new DownLlmClient(), db });
    expect(digest.voice).toBe('fallback');
    expect(digest.renderedText).toContain('Loom');
    expect(digest.headline).toBeTruthy();
  });

  it('without deps the digest is mechanical (Phase 1 behavior), voice=mechanical', async () => {
    const digest = await composeDigestForOrg(db, orgId, composeAt);
    expect(digest.voice).toBe('mechanical');
  });

  it('word budget scales with project count within the composer doc bounds', () => {
    expect(wordBudgetFor(1)).toBe(138);
    expect(wordBudgetFor(8)).toBe(260); // the doc's 8-project budget ceiling
    expect(wordBudgetFor(20)).toBe(260);
  });
});
