import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { externalSessions, orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { listExternalSessions, recordSession, resolveProjectForSession } from '../../src/server/companion/sessions.js';
import type { SessionSummary } from '../../src/shared/types/session.js';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  agent: 'claude-code',
  session_id: 'sess-1',
  outcome: 'ended',
  cwd: '/home/me/loom',
  repo: 'acme/loom',
  intent: 'fix the checkout',
  files_touched: ['src/Cart.tsx'],
  tools_run: { Edit: 2 },
  ...over,
});

describe('sessions observed from outside', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values([{ orgId: 'org_1' }, { orgId: 'org_2' }]);
    await createPack(
      db,
      'org_1',
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'A curtain shop.' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  it('files a session under the project whose repo it was in', async () => {
    const { projectId } = await recordSession(db, 'org_1', summary());
    expect(projectId).toBe('loom');
    const [row] = await db.select().from(externalSessions).where(eq(externalSessions.orgId, 'org_1'));
    expect(row).toMatchObject({ agent: 'claude-code', sessionId: 'sess-1', projectId: 'loom', intent: 'fix the checkout' });
  });

  it('matches the repo however it was written', async () => {
    for (const repo of ['acme/loom', 'ACME/Loom', 'git@github.com:acme/loom.git', 'https://github.com/acme/loom']) {
      expect(await resolveProjectForSession(db, 'org_1', { repo })).toBe('loom');
    }
  });

  it('falls back to the folder name, and otherwise files it under nothing at all', async () => {
    expect(await resolveProjectForSession(db, 'org_1', { cwd: '/home/me/loom' })).toBe('loom');
    // A guess it isn't sure of is worse than no guess: a session filed under
    // the wrong project quietly poisons that project's history.
    expect(await resolveProjectForSession(db, 'org_1', { cwd: '/home/me/something-else' })).toBeNull();
    expect(await resolveProjectForSession(db, 'org_1', {})).toBeNull();
  });

  it('keeps a session it could not place, rather than dropping it', async () => {
    const { projectId } = await recordSession(db, 'org_1', summary({ session_id: 'orphan', repo: 'someone/else', cwd: '/tmp/x' }));
    expect(projectId).toBeNull();
    expect(await listExternalSessions(db, 'org_1')).toHaveLength(1);
  });

  it('re-sending the same session updates it instead of duplicating it', async () => {
    await recordSession(db, 'org_1', summary());
    await recordSession(db, 'org_1', summary({ outcome: 'shipped', commit_sha: 'a1b2c3d' }));
    const rows = await listExternalSessions(db, 'org_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'shipped', commitSha: 'a1b2c3d' });
  });

  it('two agents can hold the same session id without colliding', async () => {
    await recordSession(db, 'org_1', summary({ agent: 'claude-code', session_id: 'same' }));
    await recordSession(db, 'org_1', summary({ agent: 'codex', session_id: 'same' }));
    expect(await listExternalSessions(db, 'org_1')).toHaveLength(2);
  });

  it('is org-scoped', async () => {
    await recordSession(db, 'org_1', summary());
    expect(await listExternalSessions(db, 'org_2')).toHaveLength(0);
    // ...and another org's repo never resolves to this org's project.
    expect(await resolveProjectForSession(db, 'org_2', { repo: 'acme/loom' })).toBeNull();
  });

  it('records a session it could not read, with the reason', async () => {
    await recordSession(db, 'org_1', {
      agent: 'codex',
      session_id: 'broken',
      outcome: 'unreadable',
      detail: 'the log never said which session it was',
    });
    const [row] = await listExternalSessions(db, 'org_1');
    expect(row).toMatchObject({ outcome: 'unreadable', detail: 'the log never said which session it was' });
  });
});
