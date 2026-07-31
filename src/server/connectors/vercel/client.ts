import type { HostDeployStatus } from '../host/deploy.js';

/**
 * Vercel host connector — the second host, ported to the same shape as Railway
 * (BUILD-BRIEF Phase 1: "Railway first, Vercel next"). Every call takes the
 * CUSTOMER's token, never a global one; the Vercel account is theirs.
 *
 * The transport is network code, verified against Vercel's documented API shape
 * but not re-run live here. The status map below is pure and fully tested — and
 * it is the load-bearing bit, because it is where "the deploy is fine" gets
 * decided, under the same false-calm rule as every other host.
 */

const ENDPOINT = 'https://api.vercel.com';

/** A Vercel deployment target. A project id, optionally under a team. */
export interface VercelTarget {
  projectId: string;
  teamId?: string;
}

/**
 * A Vercel source addresses a project as `projectId` or `teamId/projectId`.
 * Graceful: anything else returns null and the caller skips it — we can't watch
 * a project we can't address.
 */
export function parseVercelTarget(resourceId: string): VercelTarget | null {
  const parts = resourceId.split('/').filter((p) => p.trim() !== '');
  if (parts.length === 1) return { projectId: parts[0]! };
  if (parts.length === 2) return { teamId: parts[0]!, projectId: parts[1]! };
  return null;
}

/**
 * Map Vercel's deployment state to ours. Only an explicit READY is 'live'; an
 * unrecognised state is 'unknown', NEVER 'live' — a new or renamed Vercel state
 * must never be silently reported as a healthy deploy.
 */
export function normalizeVercelStatus(vercelState: string): HostDeployStatus {
  switch (vercelState) {
    case 'READY':
      return 'live';
    case 'QUEUED':
    case 'BUILDING':
    case 'INITIALIZING':
      return 'building';
    case 'ERROR':
    case 'CANCELED':
      return 'failed';
    default:
      return 'unknown';
  }
}

export async function vercelGet<T>(token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(`Could not reach the Vercel API: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (body && typeof body === 'object' && 'error' in body && body.error) {
    throw new Error(`Vercel API error: ${body.error.message ?? 'unknown'}`);
  }
  if (!res.ok || !body) {
    throw new Error(`Vercel API responded ${res.status} with no usable data`);
  }
  return body as T;
}

export type DeployState = { status: HostDeployStatus; rawState: string };

/**
 * The latest deployment's normalized state for a project. Returns null when the
 * call fails or there is no deployment yet — the caller treats that as
 * "can't tell", the same graceful shape as everywhere else. Never throws.
 */
export async function getVercelDeployState(token: string, target: VercelTarget): Promise<DeployState | null> {
  try {
    const q = new URLSearchParams({ projectId: target.projectId, limit: '1' });
    if (target.teamId) q.set('teamId', target.teamId);
    const data = await vercelGet<{ deployments?: Array<{ state?: string; readyState?: string }> }>(
      token,
      `/v6/deployments?${q.toString()}`,
    );
    const node = data.deployments?.[0];
    if (!node) return null;
    const raw = node.readyState ?? node.state ?? '';
    return { status: normalizeVercelStatus(raw), rawState: raw };
  } catch {
    return null;
  }
}
