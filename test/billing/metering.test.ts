import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, sandboxRuns, usageBuildMinutes } from '../../src/server/db/schema/index.js';
import {
  IDLE_STOP_MS,
  MAX_SEGMENT_MS,
  closeSandboxRun,
  openSandboxRun,
  openSegments,
  reapSandboxes,
  reconcileSandboxes,
  touchSandboxRun,
} from '../../src/server/build/metering.js';
import { buildMinutesThisMonth, monthStartUtc } from '../../src/server/billing/entitlements.js';

/**
 * WHAT A SANDBOX COST.
 *
 * Daytona bills wall-clock time and is most of what this product costs to run,
 * so the two properties worth testing hardest are the two that lose money
 * quietly: a segment must meter EXACTLY ONCE however many things try to close
 * it, and a sandbox we started must be impossible to lose track of.
 */
describe('metering a sandbox', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  const projectId = 'loom';
  const minute = 60 * 1000;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => close());

  const minutesUsed = (at = new Date()) => buildMinutesThisMonth(db, orgId, at);

  describe('opening a segment', () => {
    it('opens one per sandbox and refreshes rather than opening a second', async () => {
      const first = await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 5 * minute));
      const again = await openSandboxRun(db, orgId, projectId, 'sb_1');

      expect(again.id).toBe(first.id);
      expect(await db.select().from(sandboxRuns)).toHaveLength(1);
      // The second call is proof of life, which is what the idle sweep measures.
      expect(again.lastAliveAt.getTime()).toBeGreaterThan(first.lastAliveAt.getTime());
    });

    /**
     * A sandbox here lives for months, stopped and resumed on every turn. Each
     * running period is its own billable segment, so a second start after a
     * stop is a second row — and the closed history is not in the way of it.
     */
    it('opens a new segment each time the sandbox is brought back up', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 10 * minute));
      await closeSandboxRun(db, 'sb_1', 'completed');
      await openSandboxRun(db, orgId, projectId, 'sb_1');

      expect(await db.select().from(sandboxRuns)).toHaveLength(2);
      expect(await openSegments(db)).toHaveLength(1);
    });
  });

  describe('closing and metering', () => {
    it('rounds a segment up to whole minutes and files it under the month it started', async () => {
      const started = new Date(Date.UTC(2026, 5, 10, 12, 0, 0));
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);

      const result = await closeSandboxRun(db, 'sb_1', 'completed', new Date(started.getTime() + 130 * 1000));
      // Two minutes ten seconds is three minutes. Rounding down would let a
      // hundred short runs meter as nothing.
      expect(result!.minutes).toBe(3);
      expect(result!.run.wallClockSeconds).toBe(130);
      expect(await minutesUsed(started)).toBe(3);
    });

    it('meters a nine-second sandbox as a minute rather than as nothing', async () => {
      const started = new Date();
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);
      expect((await closeSandboxRun(db, 'sb_1', 'completed', new Date(started.getTime() + 9000)))!.minutes).toBe(1);
    });

    /**
     * THE ONE THAT COSTS MONEY IF IT IS WRONG. A user stop racing an idle stop,
     * or two sweeps overlapping, both try to close the same segment.
     */
    it('meters exactly once when two things close the same segment', async () => {
      const started = new Date(Date.now() - 5 * minute);
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);

      const [a, b] = await Promise.all([closeSandboxRun(db, 'sb_1', 'user_stop'), closeSandboxRun(db, 'sb_1', 'idle_stop')]);
      // One of them wins; the other finds nothing left to close.
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await minutesUsed()).toBe(5);
    });

    it('closes nothing twice, and adds nothing the second time', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 3 * minute));
      await closeSandboxRun(db, 'sb_1', 'completed');
      expect(await closeSandboxRun(db, 'sb_1', 'completed')).toBeNull();
      expect(await minutesUsed()).toBe(3);
    });

    it('accumulates across segments in the same month', async () => {
      for (const [i, mins] of [4, 6, 2].entries()) {
        const started = new Date(Date.now() - (30 + i) * minute);
        await openSandboxRun(db, orgId, projectId, `sb_${i}`, started);
        await closeSandboxRun(db, `sb_${i}`, 'completed', new Date(started.getTime() + mins * minute));
      }
      expect(await minutesUsed()).toBe(12);
    });

    /**
     * A run that begins at 23:58 on the 31st meters into the month it STARTED,
     * not the one it finished in — the quota it was checked against is the one
     * it should land in.
     */
    it('files a segment that crosses a month boundary under the month it started', async () => {
      const started = new Date(Date.UTC(2026, 5, 30, 23, 58, 0));
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);
      await closeSandboxRun(db, 'sb_1', 'completed', new Date(Date.UTC(2026, 6, 1, 0, 6, 0)));

      const [june] = await db.select().from(usageBuildMinutes).where(eq(usageBuildMinutes.periodStart, monthStartUtc(started)));
      expect(june!.minutesUsed).toBe(8);
      expect(await db.select().from(usageBuildMinutes)).toHaveLength(1);
    });

    it('meters against the org that owns the sandbox and no other', async () => {
      await openSandboxRun(db, 'org_2', projectId, 'sb_1', new Date(Date.now() - 4 * minute));
      await closeSandboxRun(db, 'sb_1', 'completed');
      expect(await minutesUsed()).toBe(0);
      expect(await buildMinutesThisMonth(db, 'org_2')).toBe(4);
    });
  });

  describe('the sweep', () => {
    const sweep = (over: Partial<Parameters<typeof reapSandboxes>[1]> = {}) => {
      const stopped: string[] = [];
      return {
        stopped,
        run: (now?: Date) =>
          reapSandboxes(db, {
            stop: async (s) => void stopped.push(s.sandboxId),
            isWorking: async () => false,
            ...(now ? { now } : {}),
            ...over,
          }),
      };
    };

    /** The ordinary end of every turn, and the one that saves the most money. */
    it('stops a sandbox whose work has finished', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 3 * minute));
      // The turn loop keeps a heartbeat going, so a sandbox that has just
      // finished working is recently alive rather than long quiet.
      await touchSandboxRun(db, 'sb_1');
      const s = sweep();
      const result = await s.run();

      expect(s.stopped).toEqual(['sb_1']);
      expect(result.closed[0]).toMatchObject({ sandboxId: 'sb_1', reason: 'completed' });
      expect(await minutesUsed()).toBe(3);
    });

    /**
     * THE DIFFERENCE BETWEEN THIS AND DAYTONA'S OWN TIMER. A long compile is
     * quiet and busy at the same time; only a sweep that can see the run knows
     * which.
     */
    it('leaves a sandbox alone while a turn is genuinely in flight', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 10 * minute));
      const s = sweep({ isWorking: async () => true });
      await s.run();

      expect(s.stopped).toEqual([]);
      expect(await openSegments(db)).toHaveLength(1);
      expect(await minutesUsed()).toBe(0);
    });

    /**
     * The ceiling is checked BEFORE whether it is working, because a stuck
     * agent loop looks busy — and an agent nobody is watching is exactly how a
     * bill arrives that nobody agreed to.
     */
    it('stops a segment at the ceiling even when it still looks busy', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - MAX_SEGMENT_MS - minute));
      const s = sweep({ isWorking: async () => true });
      const result = await s.run();

      expect(s.stopped).toEqual(['sb_1']);
      expect(result.closed[0]!.reason).toBe('ceiling_stop');
    });

    /**
     * When we never saw it stop, the honest end time is the last moment we knew
     * it was alive. Later would overcharge; `startedAt` would hide money we
     * really did spend.
     */
    it('meters an idle segment to the last moment it was known alive', async () => {
      const started = new Date(Date.now() - 20 * minute);
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);
      await touchSandboxRun(db, 'sb_1', new Date(started.getTime() + 5 * minute));

      const result = await sweep().run();
      expect(result.closed[0]!.reason).toBe('idle_stop');
      // Five minutes of known life, not the twenty since it started.
      expect(await minutesUsed()).toBe(5);
    });

    it('does not call a segment idle before the idle mark', async () => {
      const started = new Date(Date.now() - 20 * minute);
      await openSandboxRun(db, orgId, projectId, 'sb_1', started);
      await touchSandboxRun(db, 'sb_1', new Date(Date.now() - IDLE_STOP_MS + 30_000));

      const result = await sweep().run();
      // Recently alive and not working: still stopped, but as a finished turn
      // rather than as an idle one — and metered to now, because it really was
      // up until now.
      expect(result.closed[0]!.reason).toBe('completed');
      expect(await minutesUsed()).toBe(20);
    });

    /**
     * A stop that fails at Daytona still closes and meters. The money left the
     * account whether or not Daytona took our word for it, and recording
     * nothing would mean the case we know least about is the case the owner is
     * charged nothing for.
     */
    it('meters a segment it could not stop', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 6 * minute));
      await touchSandboxRun(db, 'sb_1');
      await reapSandboxes(db, {
        stop: async () => {
          throw new Error('Daytona said no');
        },
        isWorking: async () => false,
      });
      expect(await openSegments(db)).toHaveLength(0);
      expect(await minutesUsed()).toBe(6);
    });

    /**
     * SURVIVES A RESTART. The sweep reads the table, not in-process state, so a
     * deploy in the middle of a build leaves a row the next tick after boot
     * finds.
     */
    it('finds an orphan left by a process that died', async () => {
      const started = new Date(Date.now() - 12 * minute);
      await openSandboxRun(db, orgId, projectId, 'sb_orphan', started);
      // The heartbeat stopped when the process did — nine minutes in.
      await touchSandboxRun(db, 'sb_orphan', new Date(started.getTime() + 9 * minute));

      // Nothing in memory knows this exists. A fresh sweep still does.
      const s = sweep();
      const result = await s.run();
      expect(s.stopped).toEqual(['sb_orphan']);
      expect(result.closed[0]!.reason).toBe('idle_stop');
      expect(await minutesUsed()).toBe(9);
    });

    /**
     * NEVER FREE. A segment that measures zero seconds is one we never saw
     * proof of life for — the case we know LEAST about, and so exactly the
     * wrong one to bill as nothing. Starting a machine costs time before it is
     * useful for anything.
     */
    it('meters a segment it never saw alive as a minute, not as nothing', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_dead_on_arrival', new Date(Date.now() - 5 * minute));
      const result = await sweep().run();

      expect(result.closed[0]!.reason).toBe('idle_stop');
      expect(await minutesUsed()).toBe(1);
    });

    it('sweeps every org, not just the first', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1', new Date(Date.now() - 3 * minute));
      await openSandboxRun(db, 'org_2', projectId, 'sb_2', new Date(Date.now() - 4 * minute));
      await touchSandboxRun(db, 'sb_1');
      await touchSandboxRun(db, 'sb_2');
      const s = sweep();
      await s.run();
      expect(s.stopped.sort()).toEqual(['sb_1', 'sb_2']);
      expect(await minutesUsed()).toBe(3);
      expect(await buildMinutesThisMonth(db, 'org_2')).toBe(4);
    });
  });

  /**
   * THE NO-SILENT-LEAK CHECK. Everything else trusts our record over Daytona's,
   * which is right for deciding what to stop and useless as a way of never
   * being surprised.
   */
  describe('reconciling against Daytona', () => {
    it('stops a sandbox Daytona is running that we have no row for', async () => {
      const stopped: string[] = [];
      const result = await reconcileSandboxes(db, {
        listRunning: async () => ['sb_stray'],
        stop: async (id) => void stopped.push(id),
      });

      expect(result.strays).toEqual(['sb_stray']);
      expect(stopped).toEqual(['sb_stray']);
    });

    /** The cheaper direction, and still a leak: minutes that never reach the ledger. */
    it('closes and meters a segment whose sandbox Daytona has never heard of', async () => {
      const started = new Date(Date.now() - 30 * minute);
      await openSandboxRun(db, orgId, projectId, 'sb_ghost', started);
      await touchSandboxRun(db, 'sb_ghost', new Date(started.getTime() + 7 * minute));

      const result = await reconcileSandboxes(db, { listRunning: async () => [], stop: async () => {} });

      expect(result.ghosts).toEqual(['sb_ghost']);
      expect(await openSegments(db)).toHaveLength(0);
      expect(await minutesUsed()).toBe(7);
    });

    it('says nothing is wrong when nothing is', async () => {
      await openSandboxRun(db, orgId, projectId, 'sb_1');
      const result = await reconcileSandboxes(db, { listRunning: async () => ['sb_1'], stop: async () => {} });
      expect(result).toEqual({ strays: [], ghosts: [] });
      expect(await openSegments(db)).toHaveLength(1);
    });
  });
});
