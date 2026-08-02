import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/client.js';
import { connectCredential, useCredential } from '../credentials/store.js';

/**
 * "Login with Railway" — one click instead of a token to hunt for.
 *
 * This is the ease-of-use answer that does NOT cost the customer ownership
 * (MIGRATION-CENTER §1): their Railway account stays theirs, in their name,
 * and Selvedge holds a key as caretaker. They can revoke it and everything
 * keeps running.
 *
 * Two facts from Railway's docs shape everything here, and neither matches how
 * the vault stores a pasted API key:
 *   1. The access token lives ONE HOUR. Storing it and reusing it later would
 *      work in testing and fail in production an hour after connecting.
 *   2. Refresh tokens ROTATE — each refresh returns a new one and invalidates
 *      the old. Persisting the newest immediately, before it is used for
 *      anything else, is the difference between a connection that lasts and
 *      one that silently dies on the second day.
 * So what the vault holds is the token SET, and `railwayAccessToken` is the
 * only way anything reads it.
 *
 * Verified against Railway's published OAuth docs (authorization code + OIDC,
 * PKCE S256, endpoints below); not yet run against live Railway.
 */

const AUTH_ENDPOINT = 'https://backboard.railway.com/oauth/auth';
const TOKEN_ENDPOINT = 'https://backboard.railway.com/oauth/token';
const PROVIDER = 'railway';
/** Refresh this far before expiry, so a call never starts with a token about to die. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type RailwayOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

export function railwayOAuthConfigured(): boolean {
  return Boolean(process.env.RAILWAY_OAUTH_CLIENT_ID && process.env.RAILWAY_OAUTH_CLIENT_SECRET && process.env.RAILWAY_OAUTH_REDIRECT_URI);
}

export function loadRailwayOAuthConfig(): RailwayOAuthConfig {
  const clientId = process.env.RAILWAY_OAUTH_CLIENT_ID;
  const clientSecret = process.env.RAILWAY_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.RAILWAY_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('RAILWAY_OAUTH_CLIENT_ID / RAILWAY_OAUTH_CLIENT_SECRET / RAILWAY_OAUTH_REDIRECT_URI are not set');
  }
  return { clientId, clientSecret, redirectUri };
}

/** What the vault holds for a connected Railway account. */
export type RailwayTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms when the access token stops being usable. */
  expiresAt: number;
};

// ---- PKCE ----

export type Pkce = { verifier: string; challenge: string };

export function makePkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * The URL the owner is sent to. `offline_access` + `prompt=consent` are what
 * make Railway return a refresh token at all — without them the connection
 * would work for exactly one hour and then quietly stop.
 */
export function authorizeUrl(config: RailwayOAuthConfig, state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email profile offline_access',
    state,
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function postToken(config: RailwayOAuthConfig, form: Record<string, string>): Promise<RailwayTokenSet> {
  const basic = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`could not reach Railway to finish connecting (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as TokenResponse | null;
  if (!res.ok || !body?.access_token) {
    const why = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    throw new Error(`Railway refused the connection (${why})`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    // Trim the stated lifetime slightly; a token that expires mid-call is worse
    // than one refreshed a minute early.
    expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
  };
}

export async function exchangeCode(config: RailwayOAuthConfig, code: string, verifier: string): Promise<RailwayTokenSet> {
  return postToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

export async function refreshTokens(config: RailwayOAuthConfig, refreshToken: string): Promise<RailwayTokenSet> {
  const next = await postToken(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
  // Railway rotates refresh tokens, but a response that omits one must not wipe
  // the one we still hold — that would strand the connection permanently.
  return { ...next, refreshToken: next.refreshToken ?? refreshToken };
}

// ---- Storage ----

export async function storeTokenSet(db: Db, orgId: string, tokens: RailwayTokenSet): Promise<void> {
  await connectCredential(db, orgId, PROVIDER, JSON.stringify(tokens), { kind: 'subscription', label: 'Login with Railway' });
}

export function parseTokenSet(raw: string | null): RailwayTokenSet | null {
  if (!raw) return null;
  // A pasted API token is a bare string, not JSON — that is still a valid way
  // to be connected, and it never expires, so it is treated as a token set
  // that is always fresh.
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return { accessToken: trimmed, refreshToken: null, expiresAt: Number.POSITIVE_INFINITY };
  try {
    const parsed = JSON.parse(trimmed) as Partial<RailwayTokenSet>;
    if (typeof parsed.accessToken !== 'string') return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    };
  } catch {
    return null;
  }
}

export function needsRefresh(tokens: RailwayTokenSet, now = Date.now()): boolean {
  return tokens.expiresAt - now <= REFRESH_MARGIN_MS;
}

export type RailwayTokenDeps = {
  refresh?: (config: RailwayOAuthConfig, refreshToken: string) => Promise<RailwayTokenSet>;
  now?: () => number;
};

/**
 * A usable Railway access token for this org, refreshing and re-persisting when
 * the stored one is spent. The ONLY read path — nothing else should touch the
 * stored token set, because the rotated refresh token has to be saved the
 * moment it arrives.
 *
 * Returns null rather than throwing when the org simply hasn't connected, or
 * when the connection has lapsed beyond repair: "not connected" is a state the
 * product handles gracefully everywhere.
 */
export async function railwayAccessToken(db: Db, orgId: string, deps: RailwayTokenDeps = {}): Promise<string | null> {
  const tokens = parseTokenSet(await useCredential(db, orgId, PROVIDER).catch(() => null));
  if (!tokens) return null;

  const now = deps.now ?? (() => Date.now());
  if (!needsRefresh(tokens, now())) return tokens.accessToken;
  if (!tokens.refreshToken || !railwayOAuthConfigured()) return null;

  try {
    const refreshed = await (deps.refresh ?? refreshTokens)(loadRailwayOAuthConfig(), tokens.refreshToken);
    // Persist BEFORE returning: the old refresh token is already dead, so
    // losing the new one here would strand the connection.
    await storeTokenSet(db, orgId, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    console.error(`could not refresh the Railway connection for ${orgId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
