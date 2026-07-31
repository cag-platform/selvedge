/**
 * Supabase database connector — the customer's Supabase, acted on with a token
 * they granted (MIGRATION-CENTER §1), resolved per-org from the credentials
 * vault. Read-only posture to start (BUILD-BRIEF Phase 1): list projects and
 * read their status. Provisioning (POST /v1/projects, auth-user import with
 * password hashes) is a later brick for the Migration Center destination.
 *
 * REST against the Supabase Management API. The transport is network code,
 * verified against the documented API but not yet run live; the status mapping
 * is pure and fully tested — and it is where "your database is fine" is decided.
 */

const API_BASE = 'https://api.supabase.com';

/** The normalized database state Selvedge reasons about, whatever Supabase calls it. */
export type DbStatus = 'healthy' | 'starting' | 'paused' | 'unhealthy' | 'failed' | 'unknown';

/**
 * Map a Supabase project status to ours. False-calm rule: only ACTIVE_HEALTHY
 * is 'healthy'. Everything else is named honestly, and anything unrecognised is
 * 'unknown' — never 'healthy'.
 *
 * 'paused' is kept distinct on purpose: free Supabase projects auto-pause after
 * ~a week idle (a documented migration trap), and "your database is paused" is
 * a different, recoverable thing to tell an owner than "it's down".
 */
export function normalizeProjectStatus(supabaseStatus: string): DbStatus {
  switch (supabaseStatus) {
    case 'ACTIVE_HEALTHY':
      return 'healthy';
    case 'ACTIVE_UNHEALTHY':
      return 'unhealthy';
    case 'COMING_UP':
    case 'RESTORING':
    case 'UPGRADING':
    case 'RESTARTING':
    case 'INIT_READY':
      return 'starting';
    case 'PAUSING':
    case 'GOING_DOWN':
    case 'PAUSED':
    case 'INACTIVE':
      return 'paused';
    case 'INIT_FAILED':
    case 'REMOVED':
      return 'failed';
    default:
      return 'unknown';
  }
}

async function supabaseApi<T>(token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`Could not reach the Supabase API: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Supabase API responded ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as T | null;
  if (body === null) {
    throw new Error('Supabase API returned no usable data');
  }
  return body;
}

export type SupabaseProject = { ref: string; name: string; status: DbStatus; rawStatus: string; region: string | null };

/** The customer's Supabase projects, normalized. Never throws — returns [] on failure. */
export async function listProjects(token: string): Promise<SupabaseProject[]> {
  try {
    const raw = await supabaseApi<Array<{ id: string; name: string; status: string; region?: string }>>(
      token,
      '/v1/projects',
    );
    return raw.map((p) => ({
      ref: p.id,
      name: p.name,
      status: normalizeProjectStatus(p.status),
      rawStatus: p.status,
      region: p.region ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * The normalized status of one project. Returns null (never throws) on failure
 * or an unknown ref — the caller treats that as "can't tell", the same graceful
 * shape as everywhere else.
 */
export async function getProjectStatus(token: string, ref: string): Promise<SupabaseProject | null> {
  try {
    const p = await supabaseApi<{ id: string; name: string; status: string; region?: string }>(
      token,
      `/v1/projects/${ref}`,
    );
    return {
      ref: p.id,
      name: p.name,
      status: normalizeProjectStatus(p.status),
      rawStatus: p.status,
      region: p.region ?? null,
    };
  } catch {
    return null;
  }
}
