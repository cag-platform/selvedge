import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { createPack } from '../../../src/server/packs/store.js';
import { makeTestPack } from '../../fixtures/testPack.js';
import { connectCredential } from '../../../src/server/connectors/credentials/store.js';
import { listDeployServicesToPoll } from '../../../src/server/connectors/railway/wiring.js';

describe('railway wiring — live deploy service discovery', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  function railwayPack(projectId: string, resourceId: string) {
    return makeTestPack({
      identity: { project_id: projectId, name: projectId, owner_description: 'x' },
      topology: {
        sources: [
          { connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' },
          { connector: 'railway', resource_id: resourceId, role: 'production_host' },
        ],
      },
    });
  }

  it('discovers a railway service, resolves the org token, and carries the repo for continuity', async () => {
    await connectCredential(db, orgId, 'railway', 'org-1-railway-token');
    await createPack(db, orgId, railwayPack('loom', 'proj_1/env_1/svc_1'));

    const services = await listDeployServicesToPoll(db);
    expect(services).toHaveLength(1);
    expect(services[0]!.projectId).toBe('loom');
    expect(services[0]!.target).toEqual({ projectId: 'proj_1', environmentId: 'env_1', serviceId: 'svc_1' });
    expect(services[0]!.token).toBe('org-1-railway-token');
    expect(services[0]!.repoFullName).toBe('acme/loom'); // from the github source
  });

  it('skips a project whose org has not connected a Railway token — a host we have no key for is not watched', async () => {
    await createPack(db, orgId, railwayPack('loom', 'proj_1/env_1/svc_1'));
    expect(await listDeployServicesToPoll(db)).toHaveLength(0);
  });

  it('skips a railway source whose resource_id does not address a real service', async () => {
    await connectCredential(db, orgId, 'railway', 'org-1-railway-token');
    await createPack(db, orgId, railwayPack('loom', 'not-a-valid-target'));
    expect(await listDeployServicesToPoll(db)).toHaveLength(0);
  });

  it('ignores a project with no railway source at all', async () => {
    await connectCredential(db, orgId, 'railway', 'org-1-railway-token');
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'plain', name: 'Plain', owner_description: 'x' },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/plain', role: 'source_of_truth' }] },
      }),
    );
    expect(await listDeployServicesToPoll(db)).toHaveLength(0);
  });
});
