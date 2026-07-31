import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { composeDigestForOrg } from '../../src/server/digest/compose.js';
import { recordConnectorAuthFailed } from '../../src/server/resolution/connectorEvents.js';
import { createTodayRouter } from '../../src/server/web/routes/today.js';
import { appWithOrg } from './helpers.js';
import { makeTestPack } from '../fixtures/testPack.js';
import { localDateString } from '../../src/server/digest/timezone.js';

describe('web/routes/today', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
  });
  afterEach(async () => close());

  it('returns null digest when none has been composed yet', async () => {
    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    expect(res.status).toBe(200);
    expect(res.body.digest).toBeNull();
    expect(res.body.post_digest_events).toEqual([]);
  });

  it('returns today\'s digest, with every attention item traceable to a stored event id', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    // The route reads the real clock, so the fixture must too: an event
    // 24h ago always lands in "yesterday", composed "today".
    const now = new Date();
    await createPack(db, orgId, pack);
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'build.failed',
      occurred_at: new Date(now.getTime() - 24 * 3600 * 1000).toISOString(),
      severity_hint: 'error',
      raw: {},
      dedupe_key: 'd1',
    });
    await composeDigestForOrg(db, orgId, now);

    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    expect(res.body.digest.digestDate).toBe(localDateString(now, 'UTC'));
    const attentionItem = res.body.digest.sections.attention[0];
    expect(attentionItem.narration_id).toBeTruthy();
  });

  it('surfaces an org-level narration (e.g. connector auth_failed) even before any digest exists', async () => {
    await recordConnectorAuthFailed(db, orgId, 'GitHub', 'github', '999', new Date());

    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    expect(res.body.digest).toBeNull();
    expect(res.body.post_digest_events).toHaveLength(1);
    expect(res.body.post_digest_events[0].fragment).toContain('GitHub');
  });

  it('includes narrations created after the digest as post_digest_events', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
    });
    await createPack(db, orgId, pack);
    const now = new Date();
    await composeDigestForOrg(db, orgId, now);

    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: now.toISOString(),
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd2',
    });

    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    expect(res.body.post_digest_events).toHaveLength(1);
  });

  it('carries each live event\'s register and project name so the card renders at the owner\'s level', async () => {
    const pack = makeTestPack({
      identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
      topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      voice: { detail_level: 'technical_forward' },
    });
    await createPack(db, orgId, pack);
    const now = new Date();
    await composeDigestForOrg(db, orgId, now);
    await ingestEvent(db, {
      org_id: orgId,
      source: 'github',
      source_account_id: 'acme/loom',
      event_type: 'code.pr_opened',
      occurred_at: now.toISOString(),
      severity_hint: 'info',
      raw: {},
      dedupe_key: 'd3',
    });

    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    const ev = res.body.post_digest_events.find((n: { projectId: string | null }) => n.projectId === 'loom');
    expect(ev.detail_level).toBe('technical_forward'); // the pack's own register, not a global default
    expect(ev.project_name).toBe('Loom');
  });

  it('a project-less tray event falls back to the expandable register, never plain_only', async () => {
    await recordConnectorAuthFailed(db, orgId, 'GitHub', 'github', '999', new Date());
    const app = appWithOrg(orgId, createTodayRouter(db));
    const res = await request(app).get('/api/today');
    const ev = res.body.post_digest_events[0];
    expect(ev.projectId).toBeNull();
    expect(ev.detail_level).toBe('plain_expandable'); // the why stays reachable even with no pack
    expect(ev.project_name).toBeNull();
  });
});
