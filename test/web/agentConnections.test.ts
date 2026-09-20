import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { connectCredential } from '../../src/server/connectors/credentials/store.js';
import { connectAgentRuntime } from '../../src/server/companion/agentRuntime.js';
import { createAgentConnectionsRouter } from '../../src/server/web/routes/agentConnections.js';
import { appWithOrg } from './helpers.js';

describe('web/routes/agentConnections', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values({ orgId: 'org_1' });
  });

  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  it('reports the safe display status for credentials and local agents', async () => {
    await connectCredential(db, 'org_1', 'anthropic', 'claude-subscription-token', { kind: 'subscription' });
    await connectAgentRuntime(db, 'org_1', 'machine-token', { name: 'Greg’s Mac', capabilities: { codex: true, claudeCode: false } });

    const response = await request(appWithOrg('org_1', createAgentConnectionsRouter(db))).get('/api/agent-connections');

    expect(response.status).toBe(200);
    expect(response.body.agents.codex).toMatchObject({ connected: true, kind: 'local', machine: 'Greg’s Mac' });
    expect(response.body.agents.claude_code).toMatchObject({ connected: true, kind: 'subscription' });
    expect(JSON.stringify(response.body)).not.toContain('claude-subscription-token');
  });
});
