import { describe, it, expect, afterEach } from 'vitest';
import { authorizeUrl, loadGithubOAuthConfig } from '../../../src/server/connectors/github/oauthOps.js';

describe('github/oauthOps — the deterministic surface', () => {
  afterEach(() => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  });

  it('builds an authorize URL that asks for exactly the repo scope', () => {
    const url = new URL(authorizeUrl({ clientId: 'cid', clientSecret: 'x' }, 'state123', 'https://selvedge.app/cb'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('scope')).toBe('repo'); // exactly repo — the one power the one action needs
    expect(url.searchParams.get('state')).toBe('state123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://selvedge.app/cb');
  });

  it('never puts the client secret in the authorize URL', () => {
    const url = authorizeUrl({ clientId: 'cid', clientSecret: 'super-secret' }, 's', 'https://x/cb');
    expect(url).not.toContain('super-secret');
  });

  it('loads config from the environment, failing closed when unset', () => {
    expect(() => loadGithubOAuthConfig()).toThrow(/GITHUB_OAUTH_CLIENT_ID/);
    process.env.GITHUB_OAUTH_CLIENT_ID = 'cid';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'secret';
    expect(loadGithubOAuthConfig()).toEqual({ clientId: 'cid', clientSecret: 'secret' });
  });
});
