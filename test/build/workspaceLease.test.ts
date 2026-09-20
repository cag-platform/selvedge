import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/server/db/client.js';
import { createTestDb } from '../helpers/testDb.js';
import { projectBuild } from '../../src/server/db/schema/index.js';
import { ensureSandbox, hibernateWorkspace } from '../../src/server/build/sandbox.js';
import { createRun, recordRunEvent } from '../../src/server/workspace/coordinator.js';

const mock = vi.hoisted(() => ({ create: vi.fn(), reconnect: vi.fn() }));
vi.mock('../../src/server/workspace/openai/runtime.js', () => ({ OpenAiWorkspaceRuntime: class {
  createWorkspace = mock.create;
  reconnectWorkspaceWithContext = mock.reconnect;
} }));
vi.mock('../../src/server/workspace/relay/factory.js', () => ({ getPreviewRelay: () => ({ sessions: {} }) }));

describe('workspace fencing and preservation using the real database', () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let project: string;
  let counter = 0;
  const cfg = { githubToken: 'test', repoFullName: 'org/project', branch: 'main', emptyRepo: true };
  function machine() {
    let state = 'ready';
    return { id: project, capabilities: {},
      inspect: vi.fn(async () => ({ id: project, state })),
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      download: vi.fn(async () => Buffer.from('persisted-worktree')),
      upload: vi.fn(async () => undefined),
      stop: vi.fn(async () => { state = 'destroyed'; }),
    };
  }
  beforeEach(async () => {
    fixture = await createTestDb(); db = fixture.db as unknown as Db;
    project = `lease-${++counter}`;
    vi.stubEnv('OPENAI_API_KEY', 'test'); vi.stubEnv('WORKSPACE_PROVIDER', 'openai');
    mock.create.mockReset(); mock.reconnect.mockReset();
  });
  afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
  it('concurrent requests provision exactly one workspace', async () => {
    const workspace = machine();
    mock.create.mockImplementation(async input => { await input.onProvisioned(workspace.id); return workspace; });
    const [a, b] = await Promise.all([ensureSandbox(db, 'org', project, cfg), ensureSandbox(db, 'org', project, cfg)]);
    expect(a.id).toBe(b.id); expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it('reconnects a persisted partial provisioning result rather than creating another', async () => {
    const workspace = machine();
    mock.create.mockImplementationOnce(async input => { await input.onProvisioned(workspace.id); throw new Error('connection lost after create'); });
    await expect(ensureSandbox(db, 'org', project, cfg)).rejects.toThrow('connection lost');
    mock.reconnect.mockResolvedValue(workspace);
    expect((await ensureSandbox(db, 'org', project, cfg)).id).toBe(workspace.id);
    expect(mock.create).toHaveBeenCalledTimes(1); expect(mock.reconnect).toHaveBeenCalledTimes(1);
  });
  it('unknown create outcomes keep a fence; retries cannot allocate again', async () => {
    mock.create.mockRejectedValue(new Error('ambiguous provider timeout'));
    await expect(ensureSandbox(db, 'org', project, cfg)).rejects.toThrow('ambiguous');
    await expect(ensureSandbox(db, 'org', project, cfg)).rejects.toThrow('awaiting recovery');
    expect(mock.create).toHaveBeenCalledTimes(1);
  });
  it('persists files before releasing an expired idle workspace', async () => {
    const workspace = machine();
    mock.create.mockImplementation(async input => { await input.onProvisioned(workspace.id); return workspace; });
    await ensureSandbox(db, 'org', project, cfg);
    const { run } = await createRun(db, { orgId: 'org', projectId: project, threadId: 'thread', requestKey: 'build', capsuleId: 'capsule', prompt: 'Build', agent: 'codex' });
    await recordRunEvent(db, 'org', run.id, { key: 'start', kind: 'starting', source: 'coordinator' });
    expect(await hibernateWorkspace(db, 'org', project, run.id)).toBe('busy');
    await recordRunEvent(db, 'org', run.id, { key: 'failed', kind: 'failed', source: 'coordinator' });
    await db.update(projectBuild).set({ leaseExpiresAt: new Date(0) });
    expect(await hibernateWorkspace(db, 'org', project, run.id)).toBe('hibernated');
    const [build] = await db.select().from(projectBuild);
    expect(build.sandboxId).toBeNull();
    expect(build.checkpointArchiveBase64).toBe(Buffer.from('persisted-worktree').toString('base64'));
    expect(build.workspaceState).toBe('hibernated');
    expect(workspace.download.mock.invocationCallOrder[0]).toBeLessThan(workspace.stop.mock.invocationCallOrder[0]);
  });
  it('never releases compute when preservation cannot be confirmed', async () => {
    const workspace = machine();
    mock.create.mockImplementation(async input => { await input.onProvisioned(workspace.id); return workspace; });
    await ensureSandbox(db, 'org', project, cfg);
    workspace.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'unpushed work' });
    await expect(hibernateWorkspace(db, 'org', project, 'run')).rejects.toThrow('Workspace retained');
    expect(workspace.stop).not.toHaveBeenCalled();
    expect((await db.select().from(projectBuild))[0].sandboxId).toBe(project);
  });
});
