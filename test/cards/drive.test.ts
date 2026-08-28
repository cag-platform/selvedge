import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createCard, getCard, applyAction } from '../../src/server/cards/store.js';
import { driveCard } from '../../src/server/cards/drive.js';
import type { ProposeInput } from '../../src/server/cards/propose.js';
import type { CardWorkspaceRuntime } from '../../src/server/runner/types.js';
import type { CheckResult } from '../../src/server/verify/verdict.js';

const T = '2026-08-01T12:00:00Z';
const workspaceRuntime: CardWorkspaceRuntime = {
  createWorkspace: async () => ({ id: 'ws', state: 'ready' }),
  destroyWorkspace: async () => {},
};
const pass: CheckResult[] = [
  { kind: 'smoke', name: 'responds', outcome: 'pass' },
  { kind: 'acceptance', name: 'does what was asked', outcome: 'pass' },
];

function input(capCents = 100000): ProposeInput {
  return {
    id: 'card_1', orgId: 'org_1', projectId: 'loom', trigger: 'request', title: 'x', proposal: 'x',
    signals: {}, estimate: { lowCents: 100, highCents: 500 }, capCents, now: T,
  };
}

describe('driveCard — run then verify, in one call', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('carries an approved card all the way to a verified done', async () => {
    await createCard(db, input());
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });

    const res = await driveCard(db, 'org_1', 'card_1', {
      runner: { workspaceRuntime, now: () => new Date(T), agentStep: async () => ({ spentCents: 200, done: true, note: 'did it' }) },
      verify: { now: () => new Date(T), runChecks: async () => pass },
    });

    expect(res.phase).toBe('verify');
    const done = await getCard(db, 'org_1', 'card_1');
    expect(done?.state).toBe('done');
    expect(done?.verdict).toBe('verified');
  });

  it('stops at the run phase and never verifies when the cap halts the work', async () => {
    await createCard(db, input(1000));
    await applyAction(db, 'org_1', 'card_1', { type: 'approve', at: T });

    let verified = false;
    const res = await driveCard(db, 'org_1', 'card_1', {
      runner: { workspaceRuntime, now: () => new Date(T), agentStep: async () => ({ spentCents: 1500, done: false }) },
      verify: { now: () => new Date(T), runChecks: async () => { verified = true; return pass; } },
    });

    expect(res.phase).toBe('run');
    if (res.phase === 'run') expect(res.run.outcome).toBe('stopped');
    expect(verified).toBe(false); // a change that didn't finish is never verified
    expect((await getCard(db, 'org_1', 'card_1'))?.state).toBe('stopped');
  });
});
