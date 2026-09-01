import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { companionTokens, orgs } from '../../src/server/db/schema/index.js';
import { availableAgentRuntime, checkAgentRuntimeRegistration, claimAgentRuntimeJob, connectAgentRuntime, disconnectAgentRuntime, finishAgentRuntimeJob, queueAgentRuntimeTurn } from '../../src/server/companion/agentRuntime.js';

describe('customer-owned agent runtime', () => {
  let db: TestDb; let close: () => Promise<void>;
  const orgId = 'org_local_agents', tokenId = 'token_local_agents';
  beforeEach(async () => { const test = await createTestDb(); db = test.db; close = test.close; await db.insert(orgs).values({ orgId }); await db.insert(companionTokens).values({ id: tokenId, orgId, name: 'laptop', tokenHash: 'local-agent-hash' }); });
  afterEach(async () => close());

  it('requires at least one locally authenticated agent', () => {
    expect(checkAgentRuntimeRegistration({ name: 'Mac', capabilities: { codex: false, claudeCode: false } })).toBeNull();
    expect(checkAgentRuntimeRegistration({ name: 'Mac', capabilities: { codex: true, claudeCode: false } })).not.toBeNull();
  });
  it('claims only work supported by that machine', async () => {
    await connectAgentRuntime(db, orgId, tokenId, { name: 'Mac', capabilities: { codex: true, claudeCode: false } });
    expect(await availableAgentRuntime(db, orgId, 'codex')).not.toBeNull();
    expect(await availableAgentRuntime(db, orgId, 'claude-code')).toBeNull();
    const job = await queueAgentRuntimeTurn(db, orgId, 'project', { version: 1, runId: 'run', threadId: 'thread', repoFullName: 'owner/repo', branch: 'main', emptyRepo: false, agent: 'codex', model: 'gpt-5.6-terra', prompt: 'Change it.' });
    const claimed = await claimAgentRuntimeJob(db, orgId, tokenId);
    expect(claimed?.id).toBe(job?.id);
    expect((await finishAgentRuntimeJob(db, orgId, tokenId, claimed!.id, { ok: true, narrative: 'Done', changedPaths: ['src/a.ts'] }))?.state).toBe('succeeded');
    await disconnectAgentRuntime(db, orgId, tokenId);
    expect(await availableAgentRuntime(db, orgId, 'codex')).toBeNull();
  });
});
