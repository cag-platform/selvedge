import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs, narrations, connectorHealth } from '../../src/server/db/schema/index.js';
import { createPack } from '../../src/server/packs/store.js';
import { ingestEvent } from '../../src/server/resolution/ingest.js';
import { createGithubWebhookRouter } from '../../src/server/connectors/github/webhook.js';
import { makeTestPack } from '../fixtures/testPack.js';

const SECRET = 'replay-secret';
const INSTALLATION_ID = 555;

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

/**
 * Acceptance gate 3: a scripted day of synthetic webhooks — commit burst,
 * PR open, merge, deploy fail via workflow_run, storm of 6 failures —
 * produces exactly the routed outcomes routing-table.json specifies.
 * Driven through the real HTTP webhook receiver (HMAC-signed, like GitHub
 * would send) so this exercises the whole connectors -> resolution ->
 * routing -> narration pipeline, not just the pieces in isolation.
 */
describe('replay fixture: a scripted day', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let app: express.Express;
  const orgId = 'org_replay';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;

    await db.insert(orgs).values({ orgId, timezone: 'UTC' });
    // The webhook receiver resolves org from installation via connector_health
    // (populated by the install callback in production) — seed it directly.
    await db.insert(connectorHealth).values({
      orgId,
      connector: 'github',
      sourceAccountId: String(INSTALLATION_ID),
      status: 'fresh',
    });

    app = express();
    app.use(
      createGithubWebhookRouter({
        db,
        webhookSecret: SECRET,
        ingest: async (event) => {
          await ingestEvent(db, event);
        },
      }),
    );
  });

  afterEach(async () => close());

  async function send(eventName: string, payload: Record<string, unknown>) {
    const body = JSON.stringify({ ...payload, installation: { id: INSTALLATION_ID } });
    const res = await request(app)
      .post('/webhooks/github')
      .set('x-github-event', eventName)
      .set('x-hub-signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBeLessThan(300);
  }

  async function narrationsFor(projectId: string) {
    return db
      .select()
      .from(narrations)
      .where(eq(narrations.projectId, projectId));
  }

  it('routes the whole day exactly as routing-table.json specifies', async () => {
    // --- loom: live_critical, github source_of_truth, default branch "main" ---
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'loom', name: 'Loom', owner_description: 'x' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/loom', role: 'source_of_truth' }] },
      }),
    );

    const repo = { full_name: 'acme/loom', default_branch: 'main' };

    // 1. Commit burst on a non-default branch — SILENT/NONE (A1), three of them.
    for (let i = 0; i < 3; i++) {
      await send('push', {
        ref: 'refs/heads/feature/burst',
        before: `b${i}`,
        after: `b${i + 1}`,
        commits: [{ id: `b${i + 1}`, message: `wip ${i}` }],
        head_commit: { id: `b${i + 1}`, timestamp: '2026-07-19T09:00:00Z' },
        repository: repo,
      });
    }

    // 2. PR opened — A3, TEMPLATE/DIGEST at every tier.
    await send('pull_request', {
      action: 'opened',
      number: 1,
      pull_request: {
        title: 'Add pricing snapshot',
        merged: false,
        created_at: '2026-07-19T09:05:00Z',
        updated_at: '2026-07-19T09:05:00Z',
        html_url: 'x',
        head: { ref: 'feature/burst' },
      },
      repository: repo,
    });

    // 3. Merge to default branch — A2, LIB (collapsed TEMPLATE)/DIGEST at live_critical.
    await send('push', {
      ref: 'refs/heads/main',
      before: 'm0',
      after: 'm1',
      commits: [{ id: 'm1', message: 'merge pricing snapshot' }],
      head_commit: { id: 'm1', timestamp: '2026-07-19T09:10:00Z' },
      repository: repo,
    });

    // Establish a prior successful deploy so the upcoming failure resolves
    // to B6 (previous version still serving), not B7.
    await send('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 100,
        name: 'Deploy to Railway',
        head_branch: 'main',
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-07-19T09:11:00Z',
        updated_at: '2026-07-19T09:12:00Z',
        html_url: 'x',
      },
      repository: repo,
    });

    // 4. Deploy fail via workflow_run — B6 (previous version still serving).
    await send('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 101,
        name: 'Deploy to Railway',
        head_branch: 'main',
        status: 'completed',
        conclusion: 'failure',
        run_started_at: '2026-07-19T10:00:00Z',
        updated_at: '2026-07-19T10:03:00Z',
        html_url: 'x',
      },
      repository: repo,
    });

    const loomNarrations = await narrationsFor('loom');
    const byRow = (id: string) => loomNarrations.filter((n) => n.eventType && (n.meta as any)?.row_id === id);

    expect(byRow('A1')).toHaveLength(0); // SILENT rows are never persisted as narrations
    expect(byRow('A3')).toHaveLength(1);
    expect(byRow('A3')[0]?.delivery).toBe('DIGEST');
    expect(byRow('A2')).toHaveLength(1);
    expect(byRow('A2')[0]?.delivery).toBe('DIGEST');
    expect(byRow('B2')).toHaveLength(1); // the successful "Deploy to Railway" run
    const b6 = byRow('B6');
    expect(b6).toHaveLength(1);
    expect(b6[0]?.delivery).toBe('PUSH');
    expect(b6[0]?.verdict).toBe('users_fine');

    // --- sild: a second, fresh project — isolates the storm-of-6 push count from loom's B6 push above. ---
    await createPack(
      db,
      orgId,
      makeTestPack({
        identity: { project_id: 'sild', name: 'SILD', owner_description: 'x' },
        stakes: { tier: 'live_critical', has_external_users: true, touches_money: true },
        topology: { sources: [{ connector: 'github', resource_id: 'acme/sild', role: 'source_of_truth' }] },
      }),
    );
    const sildRepo = { full_name: 'acme/sild', default_branch: 'main' };

    // 5. Storm: 6 CI failures in a row — the first 5 push individually
    // (B4/PUSH at live_critical), the 6th collapses to DIGEST. Storm
    // collapse is a trailing-15-real-minutes window measured at ingestion
    // time (routingContext.recentPushWorthyCount), not by the events'
    // occurred_at — so these use "now", like a real storm actually would.
    const stormNow = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      await send('workflow_run', {
        action: 'completed',
        workflow_run: {
          id: 200 + i,
          name: 'CI',
          head_branch: 'main',
          status: 'completed',
          conclusion: 'failure',
          run_started_at: stormNow,
          updated_at: stormNow,
          html_url: 'x',
        },
        repository: sildRepo,
      });
    }

    const sildNarrations = (await narrationsFor('sild')).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const b4Rows = sildNarrations.filter((n) => (n.meta as any)?.row_id === 'B4');
    expect(b4Rows).toHaveLength(6);
    expect(b4Rows.slice(0, 5).every((n) => n.delivery === 'PUSH')).toBe(true);
    expect(b4Rows[5]?.delivery).toBe('DIGEST');
    expect((b4Rows[5]?.meta as any)?.modifiers).toContain('storm_collapsed');
  });
});
