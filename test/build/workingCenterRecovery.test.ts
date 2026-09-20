import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, createTestDbAt, applyMigration } from '../helpers/testDb.js';
import type { Db } from '../../src/server/db/client.js';
import { agentRuns, projectBuild } from '../../src/server/db/schema/index.js';
import { createRun, recordRunEvent } from '../../src/server/workspace/coordinator.js';
import { recoverRun } from '../../src/server/workspace/recovery.js';

describe('explicit recovery never guesses that unknown compute is dead', () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let id: string;
  beforeEach(async () => {
    fixture = await createTestDb(); db = fixture.db as unknown as Db;
    const { run } = await createRun(db, { orgId: 'org', projectId: 'project', threadId: 'thread', requestKey: 'request', capsuleId: 'capsule', prompt: 'Build', agent: 'codex' });
    id = run.id;
    await recordRunEvent(db, 'org', id, { key: 'start', kind: 'starting', source: 'coordinator' });
    await recordRunEvent(db, 'org', id, { key: 'work', kind: 'activity', source: 'agent' });
  });
  afterEach(async () => fixture.close());
  it('reconnects to the original alive run, retaining its lease and capsule', async () => {
    const result = await recoverRun(db, 'org', 'project', id, async () => ({ state: 'alive' }));
    expect(result.run.id).toBe(id);
    expect(result.run.capsuleId).toBe('capsule');
    expect(result.run.lifecycle).toBe('working');
    expect((await db.select().from(projectBuild))[0].leaseOwner).toBe(id);
  });
  it('unknown inspection retains ownership; a confirmed dead process releases it', async () => {
    await recoverRun(db, 'org', 'project', id, async () => ({ state: 'unknown', detail: 'network unavailable' }));
    expect((await db.select().from(projectBuild))[0].leaseOwner).toBe(id);
    const dead = await recoverRun(db, 'org', 'project', id, async () => ({ state: 'dead' }));
    expect(dead.run.lifecycle).toBe('failed');
    expect((await db.select().from(projectBuild))[0].leaseOwner).toBeNull();
    expect(await db.select().from(agentRuns)).toHaveLength(1);
  });
  it('does not mistake a zero process exit for verified work', async () => {
    const result = await recoverRun(db, 'org', 'project', id, async () => ({ state: 'completed', exitCode: 0 }));
    expect(result.run.lifecycle).toBe('needs_you');
    expect(result.run.runtimeFacts.verification_passed).toBeUndefined();
  });
  it('rejects cross-project and cross-organization recovery before contacting compute', async () => {
    let called = false;
    await expect(recoverRun(db, 'other', 'project', id, async () => { called = true; return { state: 'alive' }; })).rejects.toThrow('No such run');
    expect(called).toBe(false);
  });
});

it('migrates historical runs without presenting old successful work as new review', async () => {
  const fixture = await createTestDbAt('0065');
  try {
    await fixture.client.exec("INSERT INTO agent_runs (id,org_id,project_id,prompt,status,finished_at) VALUES ('old','org','project','legacy','succeeded',now())");
    await applyMigration(fixture.client, '0066');
    const [row] = await fixture.db.select().from(agentRuns).where(eq(agentRuns.id, 'old'));
    expect(row.lifecycle).toBe('ready');
    expect(row.reviewedAt).not.toBeNull();
    expect(row.capsuleId).toBeNull(); // Historical context is unavailable, not invented.
  } finally { await fixture.close(); }
});
