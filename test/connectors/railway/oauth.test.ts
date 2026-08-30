import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestDb } from '../../helpers/testDb.js';
import { orgs } from '../../../src/server/db/schema/index.js';
import { connectCredential, useCredential } from '../../../src/server/connectors/credentials/store.js';
import {
  authorizeUrl,
  makePkce,
  needsRefresh,
  parseTokenSet,
  railwayAccessToken,
  storeTokenSet,
  type RailwayTokenSet,
} from '../../../src/server/connectors/railway/oauth.js';

const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://tryselvedge.com/railway/callback' };

describe('authorizeUrl — asks for what a lasting connection needs', () => {
  it('requests offline access with consent, or Railway never returns a refresh token', () => {
    const url = new URL(authorizeUrl(config, 'state123', 'chal'));
    expect(url.origin + url.pathname).toBe('https://backboard.railway.com/oauth/auth');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).toContain('workspace:admin');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('carries the PKCE challenge, S256', () => {
    const url = new URL(authorizeUrl(config, 's', 'the-challenge'));
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('mints a verifier and a challenge that actually correspond', async () => {
    const { verifier, challenge } = makePkce();
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(makePkce().verifier).not.toBe(verifier); // fresh each time
  });
});

describe('parseTokenSet — both ways of connecting read the same', () => {
  it('reads a stored OAuth token set', () => {
    const set: RailwayTokenSet = { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 };
    expect(parseTokenSet(JSON.stringify(set))).toEqual(set);
  });

  it('treats a pasted API key as a connection that never expires', () => {
    const parsed = parseTokenSet('  a-plain-railway-token  ');
    expect(parsed?.accessToken).toBe('a-plain-railway-token');
    expect(parsed?.refreshToken).toBeNull();
    expect(needsRefresh(parsed!)).toBe(false);
  });

  it('is null for nothing stored or unreadable contents', () => {
    expect(parseTokenSet(null)).toBeNull();
    expect(parseTokenSet('{"nope":1}')).toBeNull();
  });
});

describe('needsRefresh — never hand out a token that dies mid-call', () => {
  const set = (expiresAt: number): RailwayTokenSet => ({ accessToken: 'a', refreshToken: 'r', expiresAt });

  it('refreshes a token already inside the safety margin', () => {
    const now = 1_000_000;
    expect(needsRefresh(set(now + 60_000), now)).toBe(true); // one minute left
    expect(needsRefresh(set(now - 1), now)).toBe(true); // already dead
  });

  it('leaves a comfortably fresh token alone', () => {
    const now = 1_000_000;
    expect(needsRefresh(set(now + 40 * 60 * 1000), now)).toBe(false);
  });
});

describe('railwayAccessToken — the only read path, because the refresh token rotates', () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const orgId = 'org_1';

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    await db.insert(orgs).values({ orgId });
    process.env.CREDENTIALS_KEY = 'a'.repeat(40);
    process.env.RAILWAY_OAUTH_CLIENT_ID = 'cid';
    process.env.RAILWAY_OAUTH_CLIENT_SECRET = 'secret';
    process.env.RAILWAY_OAUTH_REDIRECT_URI = config.redirectUri;
  });
  afterEach(async () => {
    await close();
    delete process.env.RAILWAY_OAUTH_CLIENT_ID;
    delete process.env.RAILWAY_OAUTH_CLIENT_SECRET;
    delete process.env.RAILWAY_OAUTH_REDIRECT_URI;
  });

  it('returns a fresh token without touching the network', async () => {
    await storeTokenSet(db, orgId, { accessToken: 'still-good', refreshToken: 'rt', expiresAt: Date.now() + 60 * 60 * 1000 });
    let refreshed = 0;
    const token = await railwayAccessToken(db, orgId, { refresh: async () => { refreshed += 1; throw new Error('should not run'); } });
    expect(token).toBe('still-good');
    expect(refreshed).toBe(0);
  });

  it('refreshes an expired one AND persists the rotated refresh token immediately', async () => {
    await storeTokenSet(db, orgId, { accessToken: 'stale', refreshToken: 'old-rt', expiresAt: Date.now() - 1 });
    const token = await railwayAccessToken(db, orgId, {
      refresh: async (_cfg, refreshToken) => {
        expect(refreshToken).toBe('old-rt');
        return { accessToken: 'new-at', refreshToken: 'rotated-rt', expiresAt: Date.now() + 3600_000 };
      },
    });
    expect(token).toBe('new-at');

    // The rotated token must be on disk before anything else happens — the old
    // one is already dead, so losing this would strand the connection.
    const stored = parseTokenSet(await useCredential(db, orgId, 'railway'));
    expect(stored?.refreshToken).toBe('rotated-rt');
    expect(stored?.accessToken).toBe('new-at');
  });

  it('a second call after a refresh uses the newly stored token, not the dead one', async () => {
    await storeTokenSet(db, orgId, { accessToken: 'stale', refreshToken: 'old-rt', expiresAt: Date.now() - 1 });
    await railwayAccessToken(db, orgId, {
      refresh: async () => ({ accessToken: 'new-at', refreshToken: 'rotated-rt', expiresAt: Date.now() + 3600_000 }),
    });
    let calls = 0;
    const again = await railwayAccessToken(db, orgId, { refresh: async () => { calls += 1; throw new Error('no'); } });
    expect(again).toBe('new-at');
    expect(calls).toBe(0);
  });

  it('a pasted API key is returned as-is and never refreshed', async () => {
    await connectCredential(db, orgId, 'railway', 'plain-pat', { kind: 'api_key' });
    const token = await railwayAccessToken(db, orgId, { refresh: async () => { throw new Error('should not refresh a PAT'); } });
    expect(token).toBe('plain-pat');
  });

  it('is null — not an exception — when the org never connected', async () => {
    expect(await railwayAccessToken(db, orgId)).toBeNull();
  });

  it('a failed refresh reports not-connected rather than throwing into the caller', async () => {
    await storeTokenSet(db, orgId, { accessToken: 'stale', refreshToken: 'revoked', expiresAt: Date.now() - 1 });
    const token = await railwayAccessToken(db, orgId, {
      refresh: async () => { throw new Error('Railway refused the connection (invalid_grant)'); },
    });
    expect(token).toBeNull();
  });

  it('an expired token with no refresh token is simply not connected', async () => {
    await storeTokenSet(db, orgId, { accessToken: 'stale', refreshToken: null, expiresAt: Date.now() - 1 });
    expect(await railwayAccessToken(db, orgId)).toBeNull();
  });
});
