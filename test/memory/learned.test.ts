import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, narrationLibrary, events } from '../../src/server/db/schema/index.js';
import { createPack, getPack } from '../../src/server/packs/store.js';
import { projectMemory, stackMemory } from '../../src/server/memory/learned.js';
import { revalidateBaselines } from '../../src/server/memory/revalidate.js';
import { makeTestPack } from '../fixtures/testPack.js';

const now = new Date('2026-07-20T12:00:00Z');

async function seedGraduatedMeaning(db: TestDb, fingerprint: string, fragment: string) {
  await db.insert(narrationLibrary).values({
    id: ulid(),
    fingerprint,
    phrasing: { fragment },
    useCount: 5,
    status: 'graduated',
  });
}

async function seedNarration(db: TestDb, orgId: string, projectId: string, fingerprint: string, createdAt: Date) {
  await db.insert(narrations).values({
    id: ulid(),
    orgId,
    projectId,
    eventId: ulid(),
    eventType: 'build.failed',
    occurredAt: createdAt,
    createdAt,
    path: 'LIB',
    intendedPath: 'LIB',
    delivery: 'DIGEST',
    meta: { fingerprint },
  });
}

describe('memory/learned', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'orders' } }));
  });
  afterEach(async () => close());

  it('surfaces a graduated learned signature with plain meaning, counts, and freshness', async () => {
    await seedGraduatedMeaning(db, 'fp1', '{project} has a flaky auth check that clears on its own');
    await seedNarration(db, orgId, 'loom', 'fp1', new Date('2026-07-18T00:00:00Z'));
    await seedNarration(db, orgId, 'loom', 'fp1', new Date('2026-07-19T00:00:00Z'));

    const mem = await projectMemory(db, orgId, 'loom', now);
    expect(mem).not.toBeNull();
    expect(mem!.learned_signatures).toHaveLength(1);
    const sig = mem!.learned_signatures[0]!;
    expect(sig.plain).toBe('Loom has a flaky auth check that clears on its own');
    expect(sig.times_seen).toBe(2);
    expect(sig.possibly_stale).toBe(false);
    expect(mem!.summary).toMatch(/I've learned 1 of Loom's error type/);
  });

  it('marks a long-dormant learned item possibly stale, still surfaced', async () => {
    await seedGraduatedMeaning(db, 'fp-old', '{project} nightly job is slow but fine');
    await seedNarration(db, orgId, 'loom', 'fp-old', new Date('2026-05-01T00:00:00Z')); // ~80 days before now

    const mem = await projectMemory(db, orgId, 'loom', now);
    expect(mem!.learned_signatures[0]!.possibly_stale).toBe(true);
  });

  it('ignores fingerprints that have not graduated (not yet real memory)', async () => {
    // A candidate-only library entry is not surfaced as learned.
    await db.insert(narrationLibrary).values({ id: ulid(), fingerprint: 'fp-cand', phrasing: { fragment: 'x' }, status: 'candidate' });
    await seedNarration(db, orgId, 'loom', 'fp-cand', now);
    const mem = await projectMemory(db, orgId, 'loom', now);
    expect(mem!.learned_signatures).toHaveLength(0);
  });

  it('rolls up a growing stack-level "things learned" count', async () => {
    await seedGraduatedMeaning(db, 'fp1', '{project} thing');
    await seedNarration(db, orgId, 'loom', 'fp1', now);

    const stack = await stackMemory(db, orgId, now);
    expect(stack.apps).toBe(1);
    // 1 graduated meaning seen + deploy_cadence baseline from the test pack.
    expect(stack.things_learned).toBeGreaterThanOrEqual(2);
    expect(stack.summary).toMatch(/watched your 1 app .* learned \d+ thing/);
  });
});

describe('memory/revalidate', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    // Pack seeded with the default 'weekly' cadence.
    await createPack(db, orgId, makeTestPack({ identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' } }));
  });
  afterEach(async () => close());

  it('updates a drifted deploy cadence from recent commit events and reports the shift', async () => {
    // 25 commit events in the window → cadence should become multiple_daily.
    for (let i = 0; i < 25; i++) {
      await db.insert(events).values({
        id: ulid(),
        orgId,
        source: 'github',
        sourceAccountId: 'acme/test-project',
        projectId: 'loom',
        eventType: 'code.commits_landed_default',
        occurredAt: new Date('2026-07-15T10:00:00Z'),
        severityHint: 'info',
        raw: {},
        dedupeKey: `c${i}`,
      });
    }

    const shifts = await revalidateBaselines(db, now);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.from).toBe('weekly');
    expect(shifts[0]!.to).toBe('multiple_daily');

    const pack = await getPack(db, orgId, 'loom');
    expect(pack!.baselines?.deploy_cadence).toBe('multiple_daily');
  });
});
