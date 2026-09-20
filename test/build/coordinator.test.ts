import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers/testDb.js';
import type { Db } from '../../src/server/db/client.js';
import { agentRunEvents, projectBuild } from '../../src/server/db/schema/index.js';
import { createRun, recordRunEvent, projectRunStatus, WorkspaceBusyError } from '../../src/server/workspace/coordinator.js';

describe('Working Center coordination against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  const input = { orgId: 'org', projectId: 'project', threadId: 'thread', requestKey: 'request', capsuleId: 'frozen', prompt: 'Build', agent: 'codex' };
  beforeEach(async () => { fixture = await createTestDb(); db = fixture.db as unknown as Db; });
  afterEach(async () => { await fixture.close(); });
  async function working() {
    const { run } = await createRun(db, input);
    await recordRunEvent(db, 'org', run.id, { key: 'starting', kind: 'starting', source: 'coordinator' });
    await recordRunEvent(db, 'org', run.id, { key: 'working', kind: 'activity', source: 'agent' });
    return run;
  }
  it('two concurrent identical requests acquire one run and one workspace owner', async () => {
    const claims = await Promise.all([createRun(db, input), createRun(db, input)]);
    expect(claims.filter(c => c.created)).toHaveLength(1);
    expect(claims[0].run.id).toBe(claims[1].run.id);
    const [workspace] = await db.select().from(projectBuild);
    expect(workspace.leaseOwner).toBe(claims[0].run.id);
    await expect(createRun(db, { ...input, requestKey: 'other' })).rejects.toBeInstanceOf(WorkspaceBusyError);
  });
  it('consultants share a frozen capsule without reserving writable compute', async () => {
    const a = await createRun(db, { ...input, role: 'consultant' });
    const b = await createRun(db, { ...input, role: 'consultant', agent: 'gemini', requestKey: 'second' });
    expect(a.run.capsuleId).toBe(b.run.capsuleId);
    const [workspace] = await db.select().from(projectBuild);
    expect(workspace.sandboxId).toBeNull();
    expect(workspace.leaseOwner).toBeNull();
    expect(workspace.workspaceState).toBe('inactive');
  });
  it('rolls up blocking, owner response, resume, verification and owner review', async () => {
    const run = await working();
    expect((await projectRunStatus(db, 'org', 'project')).status).toBe('working');
    await recordRunEvent(db, 'org', run.id, { key: 'question', kind: 'blocked', source: 'agent', payload: { blocker: 'Choose migration' } });
    expect((await projectRunStatus(db, 'org', 'project')).status).toBe('needs_you');
    await recordRunEvent(db, 'org', run.id, { key: 'answer', kind: 'owner_response', source: 'owner', payload: { answer: 'Option 1' } });
    await recordRunEvent(db, 'org', run.id, { key: 'resume', kind: 'resumed', source: 'agent' });
    await recordRunEvent(db, 'org', run.id, { key: 'verify', kind: 'verification_started', source: 'verification' });
    await recordRunEvent(db, 'org', run.id, { key: 'pass', kind: 'verification_passed', source: 'verification', payload: { exitCode: 0 } });
    expect((await projectRunStatus(db, 'org', 'project')).status).toBe('ready_to_review');
    await recordRunEvent(db, 'org', run.id, { key: 'review', kind: 'reviewed', source: 'owner' });
    expect((await projectRunStatus(db, 'org', 'project')).status).toBe('quiet');
    const next = await createRun(db, { ...input, requestKey: 'next', capsuleId: 'refreshed' });
    expect(next.run.capsuleId).toBe('refreshed');
  });
  it('deduplicates events, prevents forged authority, rejects late completion after cancellation', async () => {
    const run = await working();
    const event = { key: 'file', kind: 'files_changed' as const, source: 'git', payload: { paths: ['app.ts'] } };
    await recordRunEvent(db, 'org', run.id, event);
    await recordRunEvent(db, 'org', run.id, event);
    expect(await db.select().from(agentRunEvents).where(eq(agentRunEvents.eventKey, 'file'))).toHaveLength(1);
    await expect(recordRunEvent(db, 'org', run.id, { key: 'forged', kind: 'verification_passed', source: 'agent' })).rejects.toThrow('Only verification');
    await recordRunEvent(db, 'org', run.id, { key: 'cancel', kind: 'cancelled', source: 'owner' });
    await expect(recordRunEvent(db, 'org', run.id, { key: 'late', kind: 'ready', source: 'agent' })).rejects.toThrow('Invalid run transition');
    await expect(db.delete(agentRunEvents).where(eq(agentRunEvents.runId, run.id))).rejects.toThrow('append-only');
  });
  it('scopes state and event access to the organization', async () => {
    const run = await working();
    expect((await projectRunStatus(db, 'other', 'project')).runs).toHaveLength(0);
    await expect(recordRunEvent(db, 'other', run.id, { key: 'attack', kind: 'cancelled', source: 'owner' })).rejects.toThrow('No such run');
  });
});
