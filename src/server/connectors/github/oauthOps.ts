import type { GithubOAuthOps } from './repoSetup.js';

/**
 * The real GitHub OAuth network adapter behind the GithubOAuthOps interface.
 *
 * This uses a separate OAuth App (client id/secret), NOT the GitHub App: the
 * one-time repo creation in a personal account needs the classic `repo` scope,
 * which App user-to-server tokens don't grant (MIGRATION-CENTER §1 / GitHub
 * community #171040). The ongoing per-repo access is the GitHub App
 * installation, wired separately.
 *
 * Written to GitHub's documented REST API but NOT yet run against live GitHub
 * — treat as unverified until an integration pass with real credentials, the
 * same posture as the APNs sender. The orchestration that calls this
 * (repoSetup.ts) IS fully unit-tested.
 */

export type GithubOAuthConfig = { clientId: string; clientSecret: string };

export function loadGithubOAuthConfig(): GithubOAuthConfig {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET are not set');
  }
  return { clientId, clientSecret };
}

/** The authorize URL the customer is sent to. `repo` scope, for the one repo-create action. */
export function authorizeUrl(config: GithubOAuthConfig, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: 'repo',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function realGithubOAuthOps(config: GithubOAuthConfig): GithubOAuthOps {
  const basic = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  return {
    async exchangeCodeForToken(code: string): Promise<string> {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
      });
      if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
      const body = (await res.json()) as { access_token?: string; error?: string };
      if (!body.access_token) throw new Error(`token exchange returned no token: ${body.error ?? 'unknown'}`);
      return body.access_token;
    },

    async createUserRepo(token: string, name: string): Promise<{ fullName: string; htmlUrl: string }> {
      const res = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ name, private: true, auto_init: false }),
      });
      if (!res.ok) throw new Error(`repo create failed: ${res.status}`);
      const body = (await res.json()) as { full_name: string; html_url: string };
      return { fullName: body.full_name, htmlUrl: body.html_url };
    },

    async revokeGrant(token: string): Promise<void> {
      // DELETE .../grant revokes the ENTIRE grant (all tokens this app holds
      // for the user), which is exactly "hand the whole key back", not just
      // this one token. Basic-authed with the OAuth app credentials.
      const res = await fetch(`https://api.github.com/applications/${config.clientId}/grant`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: basic,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: token }),
      });
      // 204 No Content on success. Anything else is a failed return — the
      // caller records key_return_failed and tells the customer to revoke by
      // hand rather than pretending.
      if (res.status !== 204) throw new Error(`grant revoke failed: ${res.status}`);
    },
  };
}
