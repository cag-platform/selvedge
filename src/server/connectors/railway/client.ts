/**
 * Railway host connector — ported from toile's server/lib/railway.ts with the
 * one change that matters for multi-tenancy: every call takes the CUSTOMER's
 * token, never a global RAILWAY_API_TOKEN. The customer's Railway account is
 * theirs (MIGRATION-CENTER §1); Selvedge acts on it with a token they granted,
 * resolved per-org from the credentials vault (see resolve.ts).
 *
 * The transport and the GraphQL are network code, verified against toile's
 * working implementation but not yet re-run live here. The status mapping
 * below is pure and fully tested — and it is the load-bearing bit, because it
 * is where "the deploy is fine" gets decided.
 */

const ENDPOINT = 'https://backboard.railway.com/graphql/v2';

export interface RailwayTarget {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

/** The normalized deploy state Selvedge reasons about, whatever the host calls it. */
export type HostDeployStatus = 'live' | 'building' | 'failed' | 'unknown';

/**
 * Map Railway's deployment status to ours. The false-calm rule applies to
 * deploys exactly as it does to app health: only an explicit success is
 * 'live'. A status we don't recognise is 'unknown', NEVER 'live' — a new or
 * renamed Railway state must never be silently reported as a healthy deploy.
 */
export function normalizeDeployStatus(railwayStatus: string): HostDeployStatus {
  switch (railwayStatus) {
    case 'SUCCESS':
      return 'live';
    case 'BUILDING':
    case 'DEPLOYING':
    case 'INITIALIZING':
    case 'QUEUED':
    case 'WAITING':
    case 'NEEDS_APPROVAL':
      return 'building';
    case 'FAILED':
    case 'CRASHED':
    case 'REMOVED':
    case 'REMOVING':
      return 'failed';
    default:
      return 'unknown';
  }
}

export async function railwayGql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The customer's token, passed in — not a process-wide secret.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`Could not reach the Railway API: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = (await res.json().catch(() => null)) as {
    data?: T;
    errors?: Array<{ message: string }>;
  } | null;

  if (body?.errors?.length) {
    throw new Error(`Railway API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!res.ok || !body?.data) {
    throw new Error(`Railway API responded ${res.status} with no usable data`);
  }
  return body.data;
}

export type DeployState = {
  status: HostDeployStatus;
  deployedAt: string | null;
  /** The raw Railway status, kept for the technical register and for debugging an 'unknown'. */
  rawStatus: string;
};

/**
 * The latest deploy's normalized state for a service. Returns null when the
 * call fails or there is no deployment yet — the caller treats that as
 * "can't tell", the same graceful shape as everywhere else. Never throws.
 */
export async function getDeployState(token: string, target: RailwayTarget): Promise<DeployState | null> {
  try {
    const data = await railwayGql<{
      deployments: { edges: Array<{ node: { id: string; status: string; createdAt: string } }> };
    }>(
      token,
      `query Deployments($input: DeploymentListInput!) {
        deployments(input: $input, first: 1) {
          edges { node { id status createdAt } }
        }
      }`,
      {
        input: {
          projectId: target.projectId,
          environmentId: target.environmentId,
          serviceId: target.serviceId,
        },
      },
    );
    const node = data.deployments.edges[0]?.node;
    if (!node) return null;
    return {
      status: normalizeDeployStatus(node.status),
      deployedAt: node.createdAt ?? null,
      rawStatus: node.status,
    };
  } catch {
    return null;
  }
}
