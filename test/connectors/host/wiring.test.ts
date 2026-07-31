import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { createPack } from '../../../src/server/packs/store.js';
import { makeTestPack } from '../../fixtures/testPack.js';
import { connectCredential } from '../../../src/server/connectors/credentials/store.js';
import { listDeployServicesToPoll } from '../../../src/server/connectors/host/wiring.js';
import type { TopologySource } from '../../../src/shared/types/pack.js';

describe('host wiring — deploy discovery across Railway and Vercel', () => {
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

  function packWith(projectId: string, host: TopologySource) {
    return makeTestPack({
      identity: { project_id: projectId, name: projectId, owner_description: 'x' },
      topology: {
        sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }, host],
      },
    });
  }

  it('discovers a Railway service, binds its read, and carries the repo for continuity', async () => {
    await connectCredential(db, orgId, 'railway', 'rw-token');
    await createPack(db, orgId, packWith('loom', { connector: 'railway', resource_id: 'proj/env/svc', role: 'production_host' }));
    const services = await listDeployServicesToPoll(db);
    expect(services).toHaveLength(1);
    expect(services[0]!.source).toBe('railway');
    expect(services[0]!.serviceId).toBe('proj/env/svc');
    expect(services[0]!.repoFullName).toBe('acme/loom');
    expect(typeof services[0]!.read).toBe('function');
  });

  it('discovers a Vercel project with its own token', async () => {
    await connectCredential(db, orgId, 'vercel', 'vc-token');
    await createPack(db, orgId, packWith('site', { connector: 'vercel', resource_id: 'team_1/prj_1', role: 'production_host' }));
    const services = await listDeployServicesToPoll(db);
    expect(services).toHaveLength(1);
    expect(services[0]!.source).toBe('vercel');
    expect(services[0]!.serviceId).toBe('team_1/prj_1');
  });

  it('watches both hosts on the same project when both are connected', async () => {
    await connectCredential(db, orgId, 'railway', 'rw-token');
    await connectCredential(db, orgId, 'vercel', 'vc-token');
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'dual', name: 'Dual', owner_description: 'x' },
        topology: {
          sources: [
            { connector: 'github', resource_id: 'acme/dual', role: 'source_of_truth' },
            { connector: 'railway', resource_id: 'p/e/s', role: 'production_host' },
            { connector: 'vercel', resource_id: 'prj', role: 'preview_host' },
          ],
        },
      }),
    );
    const services = await listDeployServicesToPoll(db);
    expect(new Set(services.map((s) => s.source))).toEqual(new Set(['railway', 'vercel']));
  });

  it('skips a host with no connected token, and an unaddressable resource_id', async () => {
    // No token at all.
    await createPack(db, orgId, packWith('a', { connector: 'railway', resource_id: 'p/e/s', role: 'production_host' }));
    expect(await listDeployServicesToPoll(db)).toHaveLength(0);

    // Token present, but the railway resource_id isn't three parts.
    await connectCredential(db, orgId, 'railway', 'rw-token');
    await createPack(db, orgId, packWith('b', { connector: 'railway', resource_id: 'not-valid', role: 'production_host' }));
    const services = await listDeployServicesToPoll(db);
    expect(services.every((s) => s.projectId !== 'b')).toBe(true);
  });

  it('ignores a project with no host source', async () => {
    await connectCredential(db, orgId, 'railway', 'rw-token');
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
