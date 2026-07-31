import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createGithubSetupRouter, repoNameFrom } from '../../src/server/web/routes/githubSetup.js';
import type { GithubOAuthOps } from '../../src/server/connectors/github/repoSetup.js';
import { appWithOrg } from './helpers.js';

function fakeOps(over: Partial<GithubOAuthOps> = {}): GithubOAuthOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exchangeCodeForToken: over.exchangeCodeForToken ?? (async () => (calls.push('exchange'), 'tok')),
    createUserRepo:
      over.createUserRepo ??
      (async (_t, name) => (calls.push('create'), { fullName: `alice/${name}`, htmlUrl: `https://github.com/alice/${name}` })),
    revokeGrant: over.revokeGrant ?? (async () => void calls.push('revoke')),
  };
}

describe('web/routes/githubSetup — borrow-and-return over HTTP', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
  });
  afterEach(async () => close());

  it('start returns an authorize URL and remembers the pending setup', async () => {
    const ops = fakeOps();
    const app = appWithOrg(orgId, createGithubSetupRouter(db, { ops, makeUrl: (s) => `https://gh/authorize?state=${s}` }));
    const res = await request(app).post('/api/connectors/github/setup/start').send({ appName: 'My Orders App' });
    expect(res.status).toBe(200);
    expect(res.body.authorize_url).toContain('state=');
    expect(res.body.state).toBeTruthy();
  });

  it('full flow: start then callback creates the repo, returns the key, and speaks plainly', async () => {
    const ops = fakeOps();
    const app = appWithOrg(orgId, createGithubSetupRouter(db, { ops, makeUrl: (s) => `https://gh/authorize?state=${s}` }));

    const start = await request(app).post('/api/connectors/github/setup/start').send({ appName: 'Orders' });
    const state = start.body.state as string;

    const cb = await request(app).get(`/api/connectors/github/setup/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(200);
    expect(cb.body.ok).toBe(true);
    expect(ops.calls).toEqual(['exchange', 'create', 'revoke']);
    // The customer-facing line never says "repository".
    expect(cb.body.message).not.toMatch(/repositor/i);
    expect(cb.body.message).toMatch(/new home/i);
    // The technical register rides along for the drill-down.
    expect(cb.body.receipt.repo.fullName).toBe('alice/orders');
  });

  it('returns the key even when the app name collides on GitHub', async () => {
    const ops = fakeOps({
      createUserRepo: async () => {
        throw new Error('422 name already exists');
      },
    });
    const app = appWithOrg(orgId, createGithubSetupRouter(db, { ops, makeUrl: (s) => `https://x?state=${s}` }));
    const start = await request(app).post('/api/connectors/github/setup/start').send({ appName: 'dup' });
    const cb = await request(app).get(`/api/connectors/github/setup/callback?code=abc&state=${start.body.state}`);

    expect(cb.status).toBe(502);
    expect(cb.body.ok).toBe(false);
    // The guarantee, all the way through the HTTP layer: the key came back.
    expect(ops.calls).toContain('revoke');
  });

  it('rejects a callback whose state it never issued', async () => {
    const app = appWithOrg(orgId, createGithubSetupRouter(db, { ops: fakeOps() }));
    const res = await request(app).get('/api/connectors/github/setup/callback?code=abc&state=forged');
    expect(res.status).toBe(400);
  });

  it('a state is single-use', async () => {
    const ops = fakeOps();
    const app = appWithOrg(orgId, createGithubSetupRouter(db, { ops, makeUrl: (s) => `https://x?state=${s}` }));
    const start = await request(app).post('/api/connectors/github/setup/start').send({ appName: 'once' });
    const state = start.body.state as string;
    await request(app).get(`/api/connectors/github/setup/callback?code=abc&state=${state}`);
    const second = await request(app).get(`/api/connectors/github/setup/callback?code=abc&state=${state}`);
    expect(second.status).toBe(400); // consumed
  });
});

describe('repoNameFrom', () => {
  it('slugifies an app name into a valid repo name', () => {
    expect(repoNameFrom('My Orders App')).toBe('my-orders-app');
    expect(repoNameFrom('SILD — Chat!!!')).toBe('sild-chat');
    expect(repoNameFrom('   ')).toBe('my-app'); // safe fallback
  });
});
