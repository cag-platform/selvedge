import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { buildTemplateRunChecks } from '../../src/server/verify/checkRunner.js';
import { computeVerdict } from '../../src/server/verify/verdict.js';
import type { Card } from '../../src/server/cards/types.js';
import type { RunCheckDeps } from '../../src/server/verify/checks.js';

const T = '2026-08-01T12:00:00Z';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'c', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'make the gift note optional',
    proposal: 'x', risk: 'ordinary', gate: 'normal', estimate: { lowCents: 1, highCents: 2 },
    stop: { capCents: 1000, checkpointAtFractions: [] }, state: 'verifying', verdict: null, spentCents: 0,
    backupVerified: false, acts: [], createdAt: T, updatedAt: T, ...overrides,
  };
}

describe('buildTemplateRunChecks — the real deterministic check runner', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const up: RunCheckDeps = { http: async () => ({ ok: true, detail: null }) };
  const down: RunCheckDeps = { http: async () => ({ ok: false, detail: 'HTTP 500' }) };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('a live app that responds lands at probably (acceptance still needs the model)', async () => {
    await createPack(db, 'org_1', makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x', links: { live_url: 'https://loom.example' } },
    }));
    const run = buildTemplateRunChecks(db, { deps: up });
    expect(computeVerdict(await run({ card: card() }))).toBe('probably');
  });

  it('a down app is didnt_work', async () => {
    await createPack(db, 'org_1', makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x', links: { live_url: 'https://loom.example' } },
    }));
    const run = buildTemplateRunChecks(db, { deps: down });
    expect(computeVerdict(await run({ card: card() }))).toBe('didnt_work');
  });

  it('an app with no known live URL is inconclusive — no smoke proof', async () => {
    await createPack(db, 'org_1', makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' }, // no live_url
    }));
    const run = buildTemplateRunChecks(db, { deps: up });
    expect(computeVerdict(await run({ card: card() }))).toBe('inconclusive');
  });
});
