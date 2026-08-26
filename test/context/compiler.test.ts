import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentRuns, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { createThread } from '../../src/server/threads/store.js';
import { setBuild } from '../../src/server/build/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { compileTaskContext } from '../../src/server/context/compiler.js';

describe('TaskContextCapsule compiler', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const test = await createTestDb();
    db = test.db;
    close = test.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
    await createPack(db, 'org_1', makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' } }));
  });
  afterEach(async () => close());

  it('keeps durable knowledge separate from current execution evidence', async () => {
    const thread = await createThread(db, 'org_1', 'loom', { kind: 'workshop', title: 'Checkout' });
    const observedAt = new Date('2026-08-26T12:00:00.000Z');
    await setBuild(db, 'org_1', 'loom', { sandboxId: 'sandbox_1', dirtyAgent: 'claude-code', dirtyRunId: 'run_1', dirtyThreadId: thread.id, dirtyObservedAt: observedAt, stagedChangesReady: true });
    await db.insert(agentRuns).values({
      id: 'run_1', orgId: 'org_1', projectId: 'loom', threadId: thread.id, agent: 'claude-code',
      prompt: 'Add idempotent checkout', status: 'succeeded', changedPaths: ['src/checkout.ts', 'test/checkout.test.ts'],
      verdict: 'probably', startedAt: observedAt, finishedAt: observedAt,
    });

    const capsule = await compileTaskContext(db, {
      orgId: 'org_1', projectId: 'loom', threadId: thread.id, userRequest: '@gpt @gemini thoughts?', now: observedAt,
      projectKnowledge: [
        { id: 'k1', claim: 'Retries require idempotency keys.', type: 'business_rule', scope: 'checkout', evidence: [{ source: 'production' }], provenance: 'SILD', confidence: 0.95, status: 'verified', effective_at: observedAt.toISOString() },
        { id: 'k2', claim: 'Maybe cache every checkout.', type: 'idea', scope: 'checkout', evidence: [{ source: 'gpt' }], provenance: 'discussion', confidence: 0.2, status: 'candidate', effective_at: observedAt.toISOString() },
      ],
    });

    expect(capsule.known_already.graduated_project_knowledge.map((claim) => claim.id)).toEqual(['k1']);
    expect(capsule.observed_now.changed_files.map((item) => item.value)).toEqual(['src/checkout.ts', 'test/checkout.test.ts']);
    expect(capsule.observed_now.current_builder).toBe('claude-code');
    expect(capsule.observed_now.latest_verification?.value).toContain('probably');
    expect(capsule.known_already.accepted_decisions).toEqual([]);
    expect(capsule.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
