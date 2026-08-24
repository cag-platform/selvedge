import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, trustIncidents, feedback } from '../../src/server/db/schema/index.js';
import { recordFalseAllClearIfContradicted, isContradictingSignal } from '../../src/server/trust/tripwire.js';
import { trackRecord } from '../../src/server/trust/trackRecord.js';

async function seedNarration(
  db: TestDb,
  orgId: string,
  projectId: string,
  verdict: string | null,
  confidence: string | null,
  occurredAt: Date,
) {
  await db.insert(narrations).values({
    id: ulid(),
    orgId,
    projectId,
    eventId: ulid(),
    eventType: 'runtime.recovered',
    occurredAt,
    path: 'TEMPLATE',
    intendedPath: 'TEMPLATE',
    delivery: 'DIGEST',
    verdict,
    confidence,
  });
}

describe('trust/tripwire', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('records a Class-1 incident when a users_affected signal contradicts a recent all-clear', async () => {
    const fineAt = new Date('2026-07-20T06:58:00Z');
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', fineAt);

    const recorded = await recordFalseAllClearIfContradicted(db, orgId, 'loom', {
      narrationId: ulid(),
      eventId: 'evt-break',
      eventType: 'runtime.error_rate_spike',
      verdict: 'users_affected',
      occurredAt: new Date('2026-07-20T15:04:00Z'),
    });
    expect(recorded).toBe(true);

    const rows = await db.select().from(trustIncidents).where(eq(trustIncidents.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('false_all_clear');
    expect(rows[0]!.contradictingEventId).toBe('evt-break');
  });

  it('does not fire when there was no prior all-clear', async () => {
    const recorded = await recordFalseAllClearIfContradicted(db, orgId, 'loom', {
      narrationId: ulid(),
      eventId: 'evt-break',
      eventType: 'runtime.health_failing',
      verdict: 'users_affected',
      occurredAt: new Date('2026-07-20T15:04:00Z'),
    });
    expect(recorded).toBe(false);
    expect(await db.select().from(trustIncidents)).toHaveLength(0);
  });

  it('does not fire for a non-contradicting signal', () => {
    expect(isContradictingSignal({ eventType: 'code.pr_opened', verdict: 'users_fine' })).toBe(false);
    expect(isContradictingSignal({ eventType: 'runtime.health_failing', verdict: null })).toBe(true);
    expect(isContradictingSignal({ eventType: 'build.succeeded', verdict: 'users_affected' })).toBe(true);
  });

  /**
   * THE 111 WRONG ALL-CLEARS THAT WEREN'T.
   *
   * Two event types sat in the hard-negative set that do not mean users are
   * affected. `deploy.failed_previous_serving` means the previous version is
   * STILL SERVING — its own template says "users are fine" — so every routine
   * failed deploy after an all-clear recorded the all-clear as having been
   * wrong while it was still true. And `data.migration_failed` narrates as
   * cannot_tell: not knowing is not proof of a miss, and a ledger that counts
   * "I could not tell" as "I got it wrong" confesses to sins it did not
   * commit. On a real account that produced 111 incidents against zero ships,
   * a number so obviously wrong the whole honesty ledger read as noise.
   */
  it('a failed deploy with the previous version still serving contradicts nothing', () => {
    expect(isContradictingSignal({ eventType: 'deploy.failed_previous_serving', verdict: null })).toBe(false);
    expect(isContradictingSignal({ eventType: 'deploy.failed_previous_serving', verdict: 'users_fine' })).toBe(false);
    // The verdict still wins when it is a real one: a row that SAYS users are
    // affected contradicts an all-clear whatever its event type.
    expect(isContradictingSignal({ eventType: 'deploy.failed_previous_serving', verdict: 'users_affected' })).toBe(true);
  });

  it('cannot-tell is not proof of a miss', () => {
    expect(isContradictingSignal({ eventType: 'data.migration_failed', verdict: null })).toBe(false);
    expect(isContradictingSignal({ eventType: 'data.migration_failed', verdict: 'cannot_tell' })).toBe(false);
  });

  it("owns the miss in the owner's words, never a machine name", async () => {
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', new Date('2026-07-20T06:58:00Z'));
    await recordFalseAllClearIfContradicted(db, orgId, 'loom', {
      narrationId: ulid(),
      eventId: 'evt-break',
      eventType: 'runtime.health_failing',
      verdict: null,
      occurredAt: new Date('2026-07-20T15:04:00Z'),
    });
    const [row] = await db.select().from(trustIncidents).where(eq(trustIncidents.orgId, orgId));
    expect(row!.detail).toBe('I told you users were fine, and within a day the app stopped answering.');
    // The one sentence whose whole job is owning a mistake plainly must not
    // contain an event type.
    expect(row!.detail).not.toMatch(/[a-z]+\.[a-z_]+/);
  });

  it('ignores an all-clear that is older than the 24h window', async () => {
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', new Date('2026-07-18T06:00:00Z'));
    const recorded = await recordFalseAllClearIfContradicted(db, orgId, 'loom', {
      narrationId: ulid(),
      eventId: 'evt-break',
      eventType: 'data.migration_failed',
      verdict: 'users_affected',
      occurredAt: new Date('2026-07-20T15:04:00Z'),
    });
    expect(recorded).toBe(false);
  });
});

describe('trust/trackRecord', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const now = new Date('2026-07-20T12:00:00Z');

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('aggregates verdicts, confidence, and incidents into a plain track record', async () => {
    const recent = new Date('2026-07-19T12:00:00Z');
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', recent);
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', recent);
    await seedNarration(db, orgId, 'loom', 'cannot_tell', 'low', recent);

    const tr = await trackRecord(db, orgId, 30, now);
    expect(tr.narrated).toBe(3);
    expect(tr.verdicts.users_fine).toBe(2);
    expect(tr.verdicts.cannot_tell).toBe(1);
    expect(tr.confidence.high).toBe(2);
    expect(tr.confidence.low).toBe(1);
    expect(tr.class1_incidents).toBe(0);
    expect(tr.summary).toMatch(/certain \d+% of the time/);
    expect(tr.summary).toMatch(/No false all-clears/);
  });

  it('qualifies the clean record: none CAUGHT is not none happened', async () => {
    // A false all-clear is only detectable when a contradicting signal arrives
    // inside the tripwire window. With no runtime probes yet, "no incidents"
    // mostly means "nothing told us" — the summary must not read as proof.
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', new Date('2026-07-19T12:00:00Z'));

    const tr = await trackRecord(db, orgId, 30, now);
    expect(tr.class1_incidents).toBe(0);
    expect(tr.summary).toContain('No false all-clears caught');
    expect(tr.summary).toContain('only know about the ones something later contradicted');
  });

  it('reports the complaints it collected instead of dropping them', async () => {
    // These were counted into the payload and then never reached the sentence:
    // a user could tap "didn't help" fifty times and still read a clean record.
    await seedNarration(db, orgId, 'loom', 'users_fine', 'high', new Date('2026-07-19T12:00:00Z'));
    await db.insert(feedback).values([
      { id: 'fb_1', orgId, narrationId: 'n_x', kind: 'didnt_help' },
      { id: 'fb_2', orgId, narrationId: 'n_y', kind: 'explain_differently' },
    ]);

    const tr = await trackRecord(db, orgId, 30, now);
    expect(tr.feedback.didnt_help).toBe(1);
    expect(tr.feedback.explain_differently).toBe(1);
    expect(tr.summary).toContain('You told me 2 times that I hadn\'t helped.');
  });

  it('does not imply confidence data it never recorded', async () => {
    // Template-path narrations carry no confidence. With the voice off every
    // row is `unstated`, and the percentage used to vanish silently, leaving a
    // clean-sounding sentence backed by nothing.
    await seedNarration(db, orgId, 'loom', 'users_fine', null, new Date('2026-07-19T12:00:00Z'));

    const tr = await trackRecord(db, orgId, 30, now);
    expect(tr.confidence.unstated).toBe(1);
    expect(tr.summary).not.toMatch(/certain \d+% of the time/);
    expect(tr.summary).toContain("wasn't recording how sure I was");
  });
});
