import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { agentMessages, agentRuns, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { ensureWorkshopThread } from '../../src/server/threads/store.js';
import { stopActiveRun, failActiveRun } from '../../src/server/build/stopRun.js';

/**
 * One turn runs per project, enforced by an agent_runs row marked `running`.
 * That lock was right; every way out of it except waiting forty-five minutes
 * was missing. These are the two ways out.
 */
describe('stopping a turn, and never leaving a lock behind', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';
  let threadId: string;

  async function startRun(startedAt = new Date()) {
    const id = ulid();
    await db.insert(agentRuns).values({
      id,
      orgId,
      projectId: 'loom',
      threadId,
      prompt: 'add a contact form',
      status: 'running',
      startedAt,
    });
    return id;
  }

  const runRow = async (id: string) => {
    const [row] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, id)));
    return row;
  };

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId }]);
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
    threadId = (await ensureWorkshopThread(db, orgId, 'loom')).id;
  });
  afterEach(async () => {
    await close();
  });

  it('suspends the sandbox, closes the run, and says so in the thread', async () => {
    const id = await startRun();
    let halted = false;
    const outcome = await stopActiveRun(db, orgId, 'loom', {
      halt: async () => {
        halted = true;
      },
    });

    expect(outcome).toEqual({ stopped: true, runId: id });
    // Suspending is the part that actually stops the compute and the meter. A
    // run marked finished while the machine still churns is a button that lies
    // about the one thing it is for.
    expect(halted).toBe(true);
    expect((await runRow(id))?.status).toBe('cancelled');

    const [said] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.orgId, orgId), eq(agentMessages.threadId, threadId)));
    expect(said.content).toContain('Stopped');
    // Stopping is not undoing, and the sentence must never imply it is.
    expect(said.content).toContain('still there');
    expect(said.content).toContain('nothing was shipped');
  });

  it('still gives the conversation back when the sandbox cannot be reached', async () => {
    const id = await startRun();
    const outcome = await stopActiveRun(db, orgId, 'loom', {
      halt: async () => {
        throw new Error('workspace is down');
      },
    });
    // Being locked out of your own conversation by a SECOND failure is the
    // worst of both: the run closes regardless.
    expect(outcome.stopped).toBe(true);
    expect((await runRow(id))?.status).toBe('cancelled');
  });

  it('answers plainly when there is nothing to stop', async () => {
    const outcome = await stopActiveRun(db, orgId, 'loom', { halt: async () => undefined });
    expect(outcome).toEqual({ stopped: false, reason: 'nothing_running' });
    const said = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(said).toHaveLength(0);
  });

  it('leaves a finished run alone', async () => {
    const id = await startRun();
    await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, id));
    const outcome = await stopActiveRun(db, orgId, 'loom', { halt: async () => undefined });
    expect(outcome.stopped).toBe(false);
    expect((await runRow(id))?.status).toBe('succeeded');
  });

  it('closes a run whose turn died on the way in', async () => {
    // The bug this exists for: the run row is written before the sandbox is
    // touched, so a repo that wouldn't clone left `running` behind with no
    // process anywhere — and the project refused new work for the next
    // forty-five minutes over a turn that never began.
    const id = await startRun();
    await failActiveRun(db, orgId, 'loom');
    const row = await runRow(id);
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).not.toBeNull();
  });

  it('failing a start says nothing in the thread — the caller owns the sentence', async () => {
    await startRun();
    await failActiveRun(db, orgId, 'loom');
    const said = await db.select().from(agentMessages).where(eq(agentMessages.orgId, orgId));
    expect(said).toHaveLength(0);
  });
});
