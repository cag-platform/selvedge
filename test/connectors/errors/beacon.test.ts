import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs, events as eventsTable } from '../../../src/server/db/schema/index.js';
import { createPack } from '../../../src/server/packs/store.js';
import { makeTestPack } from '../../fixtures/testPack.js';
import { issueBeacon } from '../../../src/server/connectors/errors/beaconStore.js';
import { createErrorBeaconRouter } from '../../../src/server/connectors/errors/beacon.js';
import { ingestResolvedEvent } from '../../../src/server/resolution/ingest.js';

describe('error beacon receiver — push transport for error_rate_spike', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        stakes: { tier: 'live_small', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );
  });
  afterEach(async () => close());

  function app() {
    const a = express();
    a.use(createErrorBeaconRouter({ db, ingest: (event, projectId) => ingestResolvedEvent(db, projectId, event).then(() => undefined) }));
    return a;
  }

  function report(token: string, errors: number, requests: number) {
    return request(app()).post('/beacons/errors').set('x-beacon-token', token).send({ errors, requests });
  }

  it('rejects a bad token with 401 and never guesses a project', async () => {
    const res = await request(app()).post('/beacons/errors').set('x-beacon-token', 'sbk_wrong').send({ errors: 1, requests: 10 });
    expect(res.status).toBe(401);
  });

  it('accepts a no-traffic window without judging it', async () => {
    const token = await issueBeacon(db, orgId, 'loom');
    const res = await report(token, 0, 0);
    expect(res.status).toBe(202);
    expect(res.body.note).toMatch(/no traffic/i);
  });

  it('stays silent through warm-up and a single blip, then ingests one spike', async () => {
    const token = await issueBeacon(db, orgId, 'loom');
    for (let i = 0; i < 5; i++) {
      const r = await report(token, 1, 100); // 1% baseline
      expect(r.body.spike).toBe(false);
    }
    expect((await report(token, 50, 100)).body.spike).toBe(false); // first elevated — a blip
    const spike = await report(token, 50, 100); // second elevated — announced
    expect(spike.body.spike).toBe(true);

    const rows = await db.select().from(eventsTable).where(eq(eventsTable.orgId, orgId));
    const spikes = rows.filter((r) => r.eventType === 'runtime.error_rate_spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.projectId).toBe('loom'); // placed against the project, source-account continuity via the pack
  });

  it('rejects a malformed body', async () => {
    const token = await issueBeacon(db, orgId, 'loom');
    const res = await request(app()).post('/beacons/errors').set('x-beacon-token', token).send({ errors: 'lots', requests: 100 });
    expect(res.status).toBe(400);
  });
});
