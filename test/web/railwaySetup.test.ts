import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { orgs } from '../../src/server/db/schema/index.js';
import { createRailwaySetupRouter } from '../../src/server/web/routes/railwaySetup.js';
import { createHostsRouter } from '../../src/server/web/routes/hosts.js';
import { resolveRailwayToken } from '../../src/server/connectors/railway/resolve.js';
import { beginOAuthState, takeOAuthState, OAUTH_STATE_TTL_MS } from '../../src/server/connectors/oauthState.js';
import type { RailwayOAuthConfig, RailwayTokenSet } from '../../src/server/connectors/railway/oauth.js';
import { appWithOrg } from './helpers.js';

const CONFIG: RailwayOAuthConfig = {
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://tryselvedge.com/railway/callback',
};

const TOKENS: RailwayTokenSet = { accessToken: 'rw_access', refreshToken: 'rw_refresh', expiresAt: Date.now() + 3_600_000 };

/**
 * The half of "Login with Railway" that was missing: the module underneath was
 * written and unit-tested, and makePkce / authorizeUrl / exchangeCode had no
 * callers anywhere in src.
 */
describe('web/routes/railwaySetup — one click instead of a token to hunt for', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    process.env.CREDENTIALS_KEY = 'x'.repeat(48);
    await db.insert(orgs).values([{ orgId }, { orgId: 'org_2' }]);
  });
  afterEach(async () => {
    delete process.env.CREDENTIALS_KEY;
    await close();
  });

  const router = (over: Parameters<typeof createRailwaySetupRouter>[1] = {}) =>
    createRailwaySetupRouter(db, {
      configured: () => true,
      loadConfig: () => CONFIG,
      exchange: async () => TOKENS,
      ...over,
    });
  const app = (over = {}, id = orgId) => appWithOrg(id, router(over));

  it('sends the owner to Railway with PKCE and a state it will recognise', async () => {
    const res = await request(app()).post('/api/connectors/railway/start').send({});
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorize_url as string);
    expect(url.origin + url.pathname).toBe('https://backboard.railway.com/oauth/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // offline_access + consent are what make Railway hand back a refresh token
    // at all; without them the connection dies silently after an hour.
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe(res.body.state);
  });

  it('mints an unguessable state, not a counter', async () => {
    const a = await request(app()).post('/api/connectors/railway/start').send({});
    const b = await request(app()).post('/api/connectors/railway/start').send({});
    expect(a.body.state).not.toBe(b.body.state);
    expect(String(a.body.state).length).toBeGreaterThan(20);
  });

  it('exchanges the code and stores a token set the deploy poller can resolve', async () => {
    const start = await request(app()).post('/api/connectors/railway/start').send({});
    const res = await request(app()).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/stays in your name/i);
    expect(await resolveRailwayToken(db, orgId)).toBe('rw_access');
  });

  it('passes the verifier it generated at /start to the exchange', async () => {
    let seen: string | null = null;
    const deps = { exchange: async (_c: RailwayOAuthConfig, _code: string, verifier: string) => { seen = verifier; return TOKENS; } };
    const start = await request(app(deps)).post('/api/connectors/railway/start').send({});
    await request(app(deps)).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(seen).toBeTruthy();
  });

  it('credits the org that STARTED the handshake, never one named in the callback', async () => {
    // The callback arrives from Railway. Trusting anything in it to say whose
    // account this is would be the whole vulnerability.
    const start = await request(app({}, orgId)).post('/api/connectors/railway/start').send({});
    await request(app({}, 'org_2')).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(await resolveRailwayToken(db, orgId)).toBe('rw_access');
    expect(await resolveRailwayToken(db, 'org_2')).toBeNull();
  });

  it('refuses a replayed callback — a code must never be exchangeable twice', async () => {
    const start = await request(app()).post('/api/connectors/railway/start').send({});
    const first = await request(app()).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(first.status).toBe(200);
    const replay = await request(app()).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(replay.status).toBe(400);
  });

  it('refuses an unknown state', async () => {
    const res = await request(app()).get('/api/connectors/railway/callback?code=abc&state=made-up');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/start again/i);
  });

  it('says "you declined", not "something broke", when Railway reports a refusal', async () => {
    const start = await request(app()).post('/api/connectors/railway/start').send({});
    const res = await request(app()).get(`/api/connectors/railway/callback?error=access_denied&state=${start.body.state}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/didn't complete/i);
    expect(res.body.message).toMatch(/nothing was changed/i);
  });

  it('names what failed when the exchange fails, and stores nothing', async () => {
    const deps = { exchange: async () => { throw new Error('Railway refused the connection (invalid_grant)'); } };
    const start = await request(app(deps)).post('/api/connectors/railway/start').send({});
    const res = await request(app(deps)).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/invalid_grant/);
    expect(res.body.message).toMatch(/try again/i);
    expect(await resolveRailwayToken(db, orgId)).toBeNull();
  });

  it('points at the paste-a-token path when one-click is not configured', async () => {
    const res = await request(app({ configured: () => false })).post('/api/connectors/railway/start').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/paste a Railway token/i);
  });
});

describe('oauth state — durable, single-use, and expiring', () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId: 'org_1' });
  });
  afterEach(async () => close());

  it('round-trips the org and verifier', async () => {
    const state = await beginOAuthState(db, 'org_1', 'railway', 'verifier-1');
    expect(await takeOAuthState(db, state, 'railway')).toEqual({ orgId: 'org_1', provider: 'railway', verifier: 'verifier-1' });
  });

  it('cannot be taken twice', async () => {
    const state = await beginOAuthState(db, 'org_1', 'railway', 'v');
    await takeOAuthState(db, state, 'railway');
    expect(await takeOAuthState(db, state, 'railway')).toBeNull();
  });

  it('will not answer for a different provider', async () => {
    const state = await beginOAuthState(db, 'org_1', 'railway', 'v');
    expect(await takeOAuthState(db, state, 'github')).toBeNull();
  });

  it('expires, so an abandoned handshake cannot be finished days later', async () => {
    const state = await beginOAuthState(db, 'org_1', 'railway', 'v');
    const later = new Date(Date.now() + OAUTH_STATE_TTL_MS + 1000);
    expect(await takeOAuthState(db, state, 'railway', later)).toBeNull();
  });
});

describe('a pasted token must not silently replace a one-click sign-in', () => {
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

  it('refuses the paste when an OAuth connection is already in place', async () => {
    // connector_credentials is keyed on (org, provider) and the write is an
    // unconditional upsert, so without this guard pasting a token would swap a
    // refreshable token set for a bare string that expires in an hour.
    const setup = appWithOrg(orgId, createRailwaySetupRouter(db, { configured: () => true, loadConfig: () => CONFIG, exchange: async () => TOKENS }));
    const start = await request(setup).post('/api/connectors/railway/start').send({});
    await request(setup).get(`/api/connectors/railway/callback?code=abc&state=${start.body.state}`);

    const res = await request(appWithOrg(orgId, createHostsRouter(db))).post('/api/hosts').send({ provider: 'railway', token: 'rw-pasted-token' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already signed in/i);
    // The OAuth token survived.
    expect(await resolveRailwayToken(db, orgId)).toBe('rw_access');
  });

  it('still allows a paste when nothing is connected', async () => {
    const res = await request(appWithOrg(orgId, createHostsRouter(db))).post('/api/hosts').send({ provider: 'railway', token: 'rw-pasted-token' });
    expect(res.status).toBe(200);
    expect(await resolveRailwayToken(db, orgId)).toBe('rw-pasted-token');
  });
});
