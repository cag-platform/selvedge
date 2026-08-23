import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, packs, subscriptions, usageBuildMinutes } from '../../src/server/db/schema/index.js';
import {
  canCreateProject,
  canStartBuild,
  canUseDecisionBriefs,
  entitlementsFor,
  getPlan,
  historyWindow,
  monthStartUtc,
  remainingBuildMinutes,
  resolvePlan,
} from '../../src/server/billing/entitlements.js';
import { PAST_DUE_GRACE_DAYS, planLimits } from '../../src/shared/plans.js';

/**
 * WHAT AN ORG MAY DO, AND WHY.
 *
 * The property worth testing hardest is not any single limit — it is that a
 * limit restricts VISIBILITY and never DATA, and that the awkward subscription
 * states resolve in a way somebody decided rather than a way that fell out.
 * A failed card and a cancellation are different things; an org with no row at
 * all is the normal case and must work.
 */
describe('what an org is entitled to', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const now = new Date('2026-06-15T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  const subscribe = async (row: Partial<typeof subscriptions.$inferInsert>) =>
    db.insert(subscriptions).values({ id: ulid(), orgId, plan: 'pro', status: 'active', ...row });

  const addProjects = async (n: number, opts: { away?: boolean; deleted?: boolean } = {}) => {
    for (let i = 0; i < n; i += 1) {
      await db.insert(packs).values({
        orgId,
        projectId: `p${ulid()}`,
        pack: {},
        ...(opts.away ? { mutedAt: now } : {}),
        ...(opts.deleted ? { archivedAt: now } : {}),
      });
    }
  };

  const meter = async (minutes: number, periodStart = monthStartUtc(now)) =>
    db.insert(usageBuildMinutes).values({ id: ulid(), orgId, periodStart, minutesUsed: minutes });

  // ---------------------------------------------------------------------
  // resolvePlan — the pure edge, exercised without a database because every
  // state a subscription can be in has to be reachable in a test.
  // ---------------------------------------------------------------------

  describe('resolving a subscription to a plan', () => {
    it('treats no subscription at all as free, not as broken', () => {
      expect(resolvePlan(null, now)).toBe('free');
      expect(resolvePlan(undefined, now)).toBe('free');
    });

    it('gives an active subscriber what they bought', () => {
      expect(resolvePlan({ plan: 'pro', status: 'active', currentPeriodEnd: null }, now)).toBe('pro');
    });

    /**
     * A card that expired while somebody was away is not a cancellation. The
     * grace period is the whole difference, so both of its ends are pinned.
     */
    it('keeps everything through the grace period after a failed payment', () => {
      const endedYesterday = { plan: 'pro' as const, status: 'past_due', currentPeriodEnd: new Date(now.getTime() - day) };
      expect(resolvePlan(endedYesterday, now)).toBe('pro');

      const lastDayOfGrace = new Date(now.getTime() + PAST_DUE_GRACE_DAYS * day - day);
      expect(resolvePlan({ ...endedYesterday, currentPeriodEnd: new Date(lastDayOfGrace.getTime() - PAST_DUE_GRACE_DAYS * day) }, now)).toBe('pro');
    });

    it('resolves to free once the grace period is spent, and never sooner', () => {
      const end = new Date(now.getTime() - PAST_DUE_GRACE_DAYS * day);
      // Exactly on the boundary still counts — a limit that bites a second
      // early is a limit nobody can verify.
      expect(resolvePlan({ plan: 'pro', status: 'past_due', currentPeriodEnd: end }, now)).toBe('pro');
      expect(resolvePlan({ plan: 'pro', status: 'past_due', currentPeriodEnd: new Date(end.getTime() - 1000) }, now)).toBe('free');
    });

    /**
     * The two missing-timestamp cases resolve OPPOSITE ways, and that is the
     * point: past_due means the subscription is live and a charge failed, so
     * the benefit of the doubt goes to the customer. canceled means it is gone,
     * so with no evidence of paid-for time left there is none.
     */
    it('gives the customer the benefit of a missing period end only while they are still subscribed', () => {
      expect(resolvePlan({ plan: 'pro', status: 'past_due', currentPeriodEnd: null }, now)).toBe('pro');
      expect(resolvePlan({ plan: 'pro', status: 'canceled', currentPeriodEnd: null }, now)).toBe('free');
    });

    it('honours a cancellation until the end of what was paid for, then stops', () => {
      const paidThrough = new Date(now.getTime() + 10 * day);
      expect(resolvePlan({ plan: 'pro', status: 'canceled', currentPeriodEnd: paidThrough }, now)).toBe('pro');
      expect(resolvePlan({ plan: 'pro', status: 'canceled', currentPeriodEnd: new Date(now.getTime() - 1000) }, now)).toBe('free');
    });

    it('refuses to guess at a plan or a status it does not recognise', () => {
      expect(resolvePlan({ plan: 'enterprise', status: 'active', currentPeriodEnd: null }, now)).toBe('free');
      expect(resolvePlan({ plan: 'pro', status: 'incomplete_expired', currentPeriodEnd: null }, now)).toBe('free');
    });
  });

  // ---------------------------------------------------------------------
  // The db-backed gates.
  // ---------------------------------------------------------------------

  it('reads free for an org nobody has ever billed', async () => {
    expect(await getPlan(db, orgId, now)).toBe('free');
  });

  describe('the project limit', () => {
    it('lets a free org reach its limit and not pass it', async () => {
      const limit = planLimits('free').projects!;
      await addProjects(limit - 1);
      expect((await canCreateProject(db, orgId, now)).allowed).toBe(true);

      await addProjects(1);
      const refused = await canCreateProject(db, orgId, now);
      expect(refused.allowed).toBe(false);
      expect(refused.code).toBe('limit_projects');
      expect(refused.used).toBe(limit);
      expect(refused.note).toMatch(/\$12\/month/);
    });

    /**
     * Putting a project away means "not working in this right now" — it is
     * still watched and still stored. If it freed a slot, putting away would
     * quietly become how you run six projects on a two-project plan.
     */
    it('counts a project that has been put away, and not one that was deleted', async () => {
      await addProjects(2, { away: true });
      expect((await canCreateProject(db, orgId, now)).allowed).toBe(false);

      await db.delete(packs);
      await addProjects(3, { deleted: true });
      expect((await canCreateProject(db, orgId, now)).allowed).toBe(true);
    });

    it('stops counting at all once someone pays', async () => {
      await addProjects(9);
      await subscribe({});
      const allowed = await canCreateProject(db, orgId, now);
      expect(allowed.allowed).toBe(true);
      expect(allowed.limit).toBeNull();
    });
  });

  describe('the history window', () => {
    it('is a date floor for free and nothing at all for pro', async () => {
      const free = await historyWindow(db, orgId, now);
      expect(free.since).toEqual(new Date(now.getTime() - planLimits('free').historyDays! * day));
      expect(free.note).toMatch(/never deleted/i);

      await subscribe({});
      expect((await historyWindow(db, orgId, now)).since).toBeNull();
    });

    /**
     * Computed from the server's clock in UTC. A window a client computes is a
     * window that moves with the traveller's laptop, and history that appears
     * and disappears depending on where you opened it is worse than history
     * that is plainly locked.
     */
    it('is computed server-side, so the same instant gives the same floor', async () => {
      const a = await historyWindow(db, orgId, now);
      const b = await historyWindow(db, orgId, now);
      expect(a.since).toEqual(b.since);
    });
  });

  it('puts decision briefs behind the paywall and says so in words', async () => {
    const refused = await canUseDecisionBriefs(db, orgId, now);
    expect(refused.allowed).toBe(false);
    expect(refused.code).toBe('limit_decision_briefs');
    expect(refused.note).toMatch(/Pro/);

    await subscribe({});
    expect((await canUseDecisionBriefs(db, orgId, now)).allowed).toBe(true);
  });

  describe('build minutes', () => {
    it('counts only the month a run started in', async () => {
      await meter(40);
      await meter(500, new Date(Date.UTC(2026, 4, 1)));
      expect((await remainingBuildMinutes(db, orgId, now)).used).toBe(40);
      expect((await remainingBuildMinutes(db, orgId, now)).remaining).toBe(20);
    });

    it('blocks a new run at zero and never reports a negative remainder', async () => {
      // A run allowed to finish can overshoot the quota — the meter records
      // what it cost, and the answer to "how many left" is none, not minus ten.
      await meter(planLimits('free').buildMinutes + 10);
      expect((await remainingBuildMinutes(db, orgId, now)).remaining).toBe(0);

      const refused = await canStartBuild(db, orgId, now);
      expect(refused.allowed).toBe(false);
      expect(refused.code).toBe('limit_build_minutes');
      expect(refused.note).toMatch(/\$12\/month/);
    });

    /**
     * Pro's cap is fair-use, not a meter that starts billing. Same refusal,
     * different sentence — and nothing about it may imply a charge.
     */
    it("tells a Pro subscriber over the mark to email us, and doesn't threaten a bill", async () => {
      await subscribe({});
      await meter(planLimits('pro').buildMinutes + 1);
      const refused = await canStartBuild(db, orgId, now);
      expect(refused.allowed).toBe(false);
      expect(refused.note).toMatch(/email us/i);
      expect(refused.note).toMatch(/nothing has been charged/i);
    });
  });

  it('answers everything at once the same way it answers one at a time', async () => {
    await addProjects(2);
    await meter(10);
    const all = await entitlementsFor(db, orgId, now);

    expect(all.plan).toBe('free');
    expect(all.projects).toEqual(await canCreateProject(db, orgId, now));
    expect(all.history).toEqual(await historyWindow(db, orgId, now));
    expect(all.decisionBriefs).toEqual(await canUseDecisionBriefs(db, orgId, now));
    expect(all.buildMinutes).toEqual(await remainingBuildMinutes(db, orgId, now));
  });

  /**
   * A downgrade is reversible by paying, which is only true if nothing was
   * thrown away on the way down.
   */
  it('leaves every row where it was when a subscription lapses', async () => {
    await subscribe({ status: 'canceled', currentPeriodEnd: new Date(now.getTime() - day) });
    await addProjects(5);

    expect(await getPlan(db, orgId, now)).toBe('free');
    expect((await canCreateProject(db, orgId, now)).allowed).toBe(false);
    // Five projects, still there, still listable, still exportable.
    expect(await db.select().from(packs)).toHaveLength(5);
  });
});
