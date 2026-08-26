import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { Db } from '../db/client.js';
import { sandboxRuns, usageBuildMinutes } from '../db/schema/index.js';
import { monthStartUtc } from '../billing/entitlements.js';

/**
 * WHAT A SANDBOX COST, AND MAKING SURE WE KNOW.
 *
 * Daytona is roughly three quarters of what it costs to run this product, and
 * it bills WALL-CLOCK TIME. Not CPU, not the minutes an agent was thinking — the
 * time a machine existed in a started state. So that is what this measures, and
 * the two rules everything here serves are:
 *
 *   never let a sandbox idle, and never let a sandbox exist that we aren't
 *   metering.
 *
 * A SEGMENT, NOT A SANDBOX. A sandbox here belongs to a project and lives for
 * months — created once, then stopped and resumed on every turn, because a
 * stopped one bills only cheap storage. The billable unit is therefore one
 * start→stop segment, and that is what gets a row.
 *
 * OUR RECORD IS THE SOURCE OF TRUTH FOR WHAT IS RUNNING, not Daytona's. The
 * reaper reads this table. That inversion is deliberate: a sandbox we started
 * and then lost track of is the failure mode that quietly bills for a week, and
 * it is impossible if the row is written before the sandbox is used and the
 * sweep works from the rows.
 *
 * METERING IS EXACTLY-ONCE, by a conditional update rather than by a read
 * followed by a write. Two reapers, or a reaper racing an explicit stop, both
 * try to close the same segment; only the one whose UPDATE ... WHERE metered =
 * false comes back with a row is allowed to add the minutes.
 */

/**
 * Daytona's own idle stop, in whole minutes — the SDK takes no finer unit,
 * which is why this is not the ninety seconds the plan for this work asked for.
 *
 * It is the BACKSTOP, not the mechanism. The primary is the reaper below, which
 * can see whether a turn or preview is actually in flight and Daytona cannot,
 * and which stops a sandbox after its short idle grace. Daytona's timer only
 * matters when this server is not running to sweep — so it is set well below
 * the fifteen minutes it used to be, and comfortably above any gap between two
 * commands inside one turn, because a native auto-stop that fires mid-build
 * would destroy work to save pennies.
 */
export const SANDBOX_AUTOSTOP_MINUTES = 5;

/** No sign of life for this long, with no run in flight, and the sweep stops it. */
export const IDLE_STOP_MS = 2 * 60 * 1000;

/**
 * The hard ceiling on a single segment. A sandbox that has been up this long is
 * not working, it is stuck — and an agent loop nobody is watching is exactly
 * how a bill arrives that nobody agreed to.
 */
export const MAX_SEGMENT_MS = 30 * 60 * 1000;

/** A preview holds a sandbox open while somebody looks at it. This is how long after they stop. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;

export type EndReason = 'completed' | 'idle_stop' | 'ceiling_stop' | 'failed' | 'reaper' | 'user_stop';

export type SandboxRun = typeof sandboxRuns.$inferSelect;

/**
 * Begin metering a sandbox that is now running.
 *
 * Called from `ensureSandbox` and therefore from every path that could possibly
 * bring one up. Idempotent per sandbox: `ensureSandbox` runs on every turn and
 * usually finds a sandbox already started, so this returns the open segment
 * rather than opening a second one — two open segments would double-count the
 * same seconds.
 */
export async function openSandboxRun(db: Db, orgId: string, projectId: string, sandboxId: string, now = new Date()): Promise<SandboxRun> {
  const [open] = await db
    .select()
    .from(sandboxRuns)
    .where(and(eq(sandboxRuns.daytonaSandboxId, sandboxId), isNull(sandboxRuns.endedAt)))
    .limit(1);
  if (open) return (await touchSandboxRun(db, sandboxId, now)) ?? open;

  const [row] = await db
    .insert(sandboxRuns)
    .values({ id: ulid(), orgId, projectId, daytonaSandboxId: sandboxId, startedAt: now, lastAliveAt: now })
    .returning();
  return row!;
}

/**
 * Proof of life. Anything that shows the sandbox is genuinely in use calls this
 * — a command running, a preview being loaded — and it is what the idle sweep
 * measures against, and what stands in for the end time when a stop is never
 * confirmed.
 */
export async function touchSandboxRun(db: Db, sandboxId: string, now = new Date()): Promise<SandboxRun | null> {
  const [row] = await db
    .update(sandboxRuns)
    .set({ lastAliveAt: now })
    .where(and(eq(sandboxRuns.daytonaSandboxId, sandboxId), isNull(sandboxRuns.endedAt)))
    .returning();
  return row ?? null;
}

/**
 * The same proof of life, addressed by project rather than by sandbox.
 *
 * The turn loop is what calls this, every few seconds, for as long as a build
 * runs — and the turn loop deliberately does not hold a sandbox object, because
 * tests inject a stand-in for the thing that executes commands. Addressing the
 * open segment by org and project keeps the heartbeat honest in both worlds.
 */
export async function touchProjectSandbox(db: Db, orgId: string, projectId: string, now = new Date()): Promise<void> {
  await db
    .update(sandboxRuns)
    .set({ lastAliveAt: now })
    .where(and(eq(sandboxRuns.orgId, orgId), eq(sandboxRuns.projectId, projectId), isNull(sandboxRuns.endedAt)));
}

/**
 * Add a finished segment's minutes to the month it STARTED in.
 *
 * Rounded UP to a whole minute: a nine-second sandbox cost us a minute's worth
 * of somebody's attention and rounding it down would let a hundred short runs
 * meter as nothing. Rounding in the customer's favour here would be rounding
 * against the honesty of the number, which is the thing this whole file is for.
 *
 * The month is the one the segment STARTED in, so a build that begins at 23:58
 * on the 31st lands where it was quoted from rather than in a month whose quota
 * the owner has not been watching.
 */
async function meterRun(db: Db, run: SandboxRun): Promise<number> {
  const seconds = run.wallClockSeconds ?? 0;
  // NEVER ZERO. A segment exists because a machine was started, and starting one
  // costs real time before it is useful for anything. A zero here would also be
  // the "unknown is not zero" rule broken with money attached: the case that
  // measures zero seconds is the case where we never saw proof of life, which
  // is the case we know LEAST about — exactly the wrong one to bill as free.
  const minutes = Math.max(1, Math.ceil(seconds / 60));

  // The claim. Only the caller whose update actually flips the flag may add the
  // minutes — a reaper racing an explicit stop cannot both win.
  const claimed = await db
    .update(sandboxRuns)
    .set({ metered: true })
    .where(and(eq(sandboxRuns.id, run.id), eq(sandboxRuns.metered, false)))
    .returning({ id: sandboxRuns.id });
  if (claimed.length === 0) return 0;

  const periodStart = monthStartUtc(run.startedAt);
  await db
    .insert(usageBuildMinutes)
    .values({ id: ulid(), orgId: run.orgId, periodStart, minutesUsed: minutes, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [usageBuildMinutes.orgId, usageBuildMinutes.periodStart],
      set: { minutesUsed: sql`${usageBuildMinutes.minutesUsed} + ${minutes}`, updatedAt: new Date() },
    });
  return minutes;
}

/**
 * Close a segment and meter it.
 *
 * `at` is the honest end time. It defaults to now — a confirmed stop — but the
 * reaper passes `lastAliveAt` for a segment whose stop was never confirmed:
 * guessing later would overcharge the owner, and guessing `startedAt` would
 * hide money we really did spend. Both are lies; the last moment we know it was
 * alive is the one thing we can stand behind.
 */
export async function closeSandboxRun(
  db: Db,
  sandboxId: string,
  endReason: EndReason,
  at?: Date,
): Promise<{ run: SandboxRun; minutes: number } | null> {
  const [open] = await db
    .select()
    .from(sandboxRuns)
    .where(and(eq(sandboxRuns.daytonaSandboxId, sandboxId), isNull(sandboxRuns.endedAt)))
    .limit(1);
  if (!open) return null;

  const endedAt = at ?? new Date();
  const seconds = Math.max(0, Math.round((endedAt.getTime() - open.startedAt.getTime()) / 1000));

  const [closed] = await db
    .update(sandboxRuns)
    .set({ endedAt, wallClockSeconds: seconds, endReason })
    .where(and(eq(sandboxRuns.id, open.id), isNull(sandboxRuns.endedAt)))
    .returning();
  // Somebody else closed it between the read and the write. Theirs metered it.
  if (!closed) return null;

  return { run: closed, minutes: await meterRun(db, closed) };
}

export type OpenSegment = {
  id: string;
  orgId: string;
  projectId: string;
  sandboxId: string;
  startedAt: Date;
  lastAliveAt: Date;
};

export async function openSegments(db: Db): Promise<OpenSegment[]> {
  const rows = await db.select().from(sandboxRuns).where(isNull(sandboxRuns.endedAt));
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    sandboxId: r.daytonaSandboxId,
    startedAt: r.startedAt,
    lastAliveAt: r.lastAliveAt,
  }));
}

export type ReaperDeps = {
  /** Stop it at Daytona. Failure is survivable — the segment closes either way. */
  stop(segment: OpenSegment): Promise<void>;
  /** Is a turn genuinely in flight for this project right now? */
  isWorking(segment: OpenSegment): Promise<boolean>;
  /** A viewed preview is intentional runtime, not a stuck agent loop. */
  hasActivePreview?(segment: OpenSegment): Promise<boolean>;
  now?: Date;
};

export type ReapResult = { closed: Array<{ sandboxId: string; reason: EndReason; minutes: number }> };

/**
 * THE SWEEP. Every minute: close anything that should not still be running, and
 * meter it.
 *
 * Three reasons, in the order they are checked:
 *
 *  1. THE CEILING. Thirty minutes on one segment is not work, it is something
 *    stuck, and it is checked first because a stuck sandbox can also look busy.
 *  2. IDLE. Two minutes with no sign of life and no run in flight. The "no run
 *    in flight" half is the difference between this and Daytona's own timer:
 *    this one knows the difference between a quiet sandbox and a working one,
 *    and will not kill a build that simply has not spoken for two minutes.
 * A finished turn is not stopped immediately: it receives the same small idle
 * window as every other use. That makes the machine observable and allows a
 * preview request arriving just after a build to take over the lease.
 *
 * A stop that fails at Daytona still closes and meters the segment. Refusing to
 * record it would mean the one case where we know least about a sandbox is also
 * the case where the owner is charged nothing — and the money left the account
 * regardless.
 */
export async function reapSandboxes(db: Db, deps: ReaperDeps): Promise<ReapResult> {
  const now = deps.now ?? new Date();
  const closed: ReapResult['closed'] = [];

  for (const segment of await openSegments(db)) {
    const age = now.getTime() - segment.startedAt.getTime();
    const quiet = now.getTime() - segment.lastAliveAt.getTime();

    let reason: EndReason | null = null;
    // The honest end time. For the ceiling and for a finished turn, now: the
    // sandbox really was up until this moment. For an idle sweep, the last time
    // we saw it alive — the quiet minutes are ours to have missed, not the
    // owner's to pay for twice over.
    let endedAt = now;

    const previewActive = await deps.hasActivePreview?.(segment).catch(() => false) ?? false;
    if (age >= MAX_SEGMENT_MS && !previewActive) {
      reason = 'ceiling_stop';
    } else {
      const working = await deps.isWorking(segment).catch(() => true);
      if (!working && quiet >= IDLE_STOP_MS) {
        reason = 'idle_stop';
        endedAt = segment.lastAliveAt;
      }
    }
    if (!reason) continue;

    await deps.stop(segment).catch((err) => {
      // Said out loud: a sandbox we could not stop is one that may still be
      // billing, and the reconciliation below is what catches it.
      console.error(`reaper could not stop ${segment.sandboxId} (${segment.orgId}/${segment.projectId}):`, err);
    });
    const result = await closeSandboxRun(db, segment.sandboxId, reason, endedAt);
    if (result) closed.push({ sandboxId: segment.sandboxId, reason, minutes: result.minutes });
  }

  return closed.length ? { closed } : { closed: [] };
}

export type Reconciliation = {
  /** Sandboxes Daytona says are running that we have no open segment for. */
  strays: string[];
  /** Open segments whose sandbox Daytona no longer has. Closed here. */
  ghosts: string[];
};

/**
 * THE NO-SILENT-LEAK CHECK, run daily against Daytona's own list.
 *
 * Everything above trusts our record over Daytona's, which is right for
 * deciding what to stop and wrong as a way of never being surprised. This is
 * the other direction: anything Daytona is running that we have no row for is
 * money leaving with nothing to attribute it to, and it is stopped and logged
 * loudly rather than quietly tolerated.
 *
 * The reverse case is cheaper but still worth closing: a segment we think is
 * open whose sandbox Daytona has never heard of stops being metered forever if
 * nothing closes it, and its minutes never reach the owner's ledger.
 */
export async function reconcileSandboxes(
  db: Db,
  deps: { listRunning(): Promise<string[]>; stop(sandboxId: string): Promise<void> },
): Promise<Reconciliation> {
  const running = new Set(await deps.listRunning());
  const open = await openSegments(db);
  const known = new Set(open.map((s) => s.sandboxId));

  const strays = [...running].filter((id) => !known.has(id));
  for (const id of strays) {
    console.error(`reconciliation: Daytona is running sandbox ${id}, which Selvedge has no open segment for — stopping it`);
    await deps.stop(id).catch((err) => console.error(`reconciliation could not stop ${id}:`, err));
  }

  const ghosts = open.filter((s) => !running.has(s.sandboxId)).map((s) => s.sandboxId);
  for (const id of ghosts) {
    // Daytona stopped it without us seeing. Metered to the last moment we knew
    // it was alive, which is the same rule the reaper uses.
    const segment = open.find((s) => s.sandboxId === id)!;
    await closeSandboxRun(db, id, 'reaper', segment.lastAliveAt);
  }

  return { strays, ghosts };
}

/**
 * Segments left open by a process that died — a deploy, a crash, a restart.
 *
 * The reaper finds these on its next tick anyway, because it reads the table
 * rather than any in-memory state. This exists to say that out loud, and to
 * give the boot path something to log so a restart that stranded twenty
 * sandboxes is visible rather than merely eventually corrected.
 */
export async function orphanedSegments(db: Db, olderThan: Date): Promise<OpenSegment[]> {
  const rows = await db
    .select()
    .from(sandboxRuns)
    .where(and(isNull(sandboxRuns.endedAt), lt(sandboxRuns.lastAliveAt, olderThan)));
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    sandboxId: r.daytonaSandboxId,
    startedAt: r.startedAt,
    lastAliveAt: r.lastAliveAt,
  }));
}
