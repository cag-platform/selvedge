import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { createGithubWebhookRouter } from '../../../src/server/connectors/github/webhook.js';
import { connectorHealth, orgs } from '../../../src/server/db/schema/index.js';
import { getHealth } from '../../../src/server/connectors/github/health.js';

const SECRET = 'test-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('github webhook router', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let ingest: ReturnType<typeof vi.fn>;
  let app: express.Express;
  const orgId = 'org_1';
  const installationId = '999';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    ingest = vi.fn().mockResolvedValue(undefined);

    await db.insert(orgs).values({ orgId });
    await db.insert(connectorHealth).values({
      orgId,
      connector: 'github',
      sourceAccountId: installationId,
      status: 'fresh',
    });

    app = express();
    app.use(createGithubWebhookRouter({ db, webhookSecret: SECRET, ingest }));
  });

  afterEach(async () => {
    await close();
  });

  it('rejects a request with an invalid signature and flips connector_health to auth_failed', async () => {
    const body = JSON.stringify({ installation: { id: Number(installationId) }, repository: { full_name: 'x/y' } });

    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();

    const health = await getHealth(db, orgId, installationId);
    expect(health?.status).toBe('auth_failed');
  });

  it('accepts a validly signed push event and calls ingest', async () => {
    const payload = {
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'bbb',
      created: false,
      deleted: false,
      commits: [{ id: 'bbb', message: 'fix' }],
      head_commit: { id: 'bbb', timestamp: '2026-07-19T10:00:00Z' },
      repository: { full_name: 'cag-platform/loom', default_branch: 'main' },
      installation: { id: Number(installationId) },
    };
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]![0].event_type).toBe('code.commits_landed_default');

    const health = await getHealth(db, orgId, installationId);
    expect(health?.status).toBe('fresh');
  });

  it('acks 202 without ingesting for an unknown installation', async () => {
    const payload = {
      ref: 'refs/heads/main',
      before: 'aaa',
      after: 'bbb',
      commits: [{ id: 'bbb', message: 'fix' }],
      head_commit: { id: 'bbb', timestamp: '2026-07-19T10:00:00Z' },
      repository: { full_name: 'someone/else', default_branch: 'main' },
      installation: { id: 424242 },
    };
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(202);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not ingest an event type with no normalizer output (e.g. pull_request synchronize)', async () => {
    const payload = {
      action: 'synchronize',
      number: 1,
      pull_request: { title: 't', merged: false, created_at: 'x', updated_at: 'x', html_url: 'x', head: { ref: 'x' } },
      repository: { full_name: 'cag-platform/loom', default_branch: 'main' },
      installation: { id: Number(installationId) },
    };
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'pull_request')
      .set('x-hub-signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(false);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns 400 for an unparseable but validly signed body', async () => {
    const body = 'not json';
    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
  });

  it('handles a valid signature over an unparseable body for the auth-failure path gracefully (no crash)', async () => {
    // Covers the JSON.parse catch inside the signature-failure branch.
    const body = 'not json';
    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });
});
