/**
 * Neon — where a Selvedge-built app's database comes from.
 *
 * One Neon project per app, so no customer's data ever shares a database with
 * another's. Ported from toile's proven lib/neon.ts. The owner never sees any
 * of this: they never make an account, never copy a connection string, never
 * open a dashboard. They ask for something that needs saved data, and it has
 * saved data.
 *
 * This uses Selvedge's own NEON_API_KEY, not a customer credential — the
 * databases belong to Selvedge's account and are part of what the subscription
 * pays for, exactly as hosting is.
 */

const ENDPOINT = 'https://console.neon.tech/api/v2/projects';
/** Neon needs a region at create time; this matches where the app is hosted. */
const REGION = 'aws-us-east-2';
const TIMEOUT_MS = 30_000;

export type NeonDatabase = {
  neonProjectId: string;
  /** The full postgres:// connection string, ready to be an env var. */
  connectionUri: string;
};

export function neonConfigured(): boolean {
  return Boolean(process.env.NEON_API_KEY?.trim());
}

/** Neon project names are visible in Selvedge's own dashboard — keep them traceable. */
export function neonProjectName(orgId: string, projectId: string): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 24);
  return `selvedge-${safe(orgId)}-${safe(projectId)}`;
}

/**
 * Create an isolated Postgres for one app and return its connection string.
 * Throws with a plain reason on every failure path — the caller turns that into
 * one honest sentence for the owner, and never pretends the app has a database
 * it does not have.
 */
export async function createNeonDatabase(orgId: string, projectId: string): Promise<NeonDatabase> {
  const key = process.env.NEON_API_KEY?.trim();
  if (!key) throw new Error('no database provider is configured (NEON_API_KEY is not set)');

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ project: { name: neonProjectName(orgId, projectId), region_id: REGION } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach the database provider (${err instanceof Error ? err.message : String(err)})`);
  }

  const body = (await res.json().catch(() => null)) as {
    project?: { id?: string };
    connection_uris?: Array<{ connection_uri?: string }>;
    message?: string;
  } | null;

  if (!res.ok) {
    // Neon's own message is the only real clue when this fails; pass it through
    // without the key, which never appears in it.
    throw new Error(`the database provider refused to create it (${res.status}${body?.message ? `: ${body.message}` : ''})`);
  }

  const neonProjectId = body?.project?.id;
  const connectionUri = body?.connection_uris?.[0]?.connection_uri;
  if (!neonProjectId || !connectionUri) {
    throw new Error('the database was created but no connection string came back, so I could not wire it up');
  }
  return { neonProjectId, connectionUri };
}

/** Delete a database when its project is torn down, so abandoned apps stop costing money. */
export async function deleteNeonDatabase(neonProjectId: string): Promise<void> {
  const key = process.env.NEON_API_KEY?.trim();
  if (!key) return;
  await fetch(`${ENDPOINT}/${encodeURIComponent(neonProjectId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}
