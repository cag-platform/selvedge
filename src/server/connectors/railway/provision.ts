import { railwayGql, type RailwayTarget } from './client.js';

/**
 * The Railway WRITE side — creating a service for an app Selvedge built, giving
 * it its variables and a web address, and waiting for the first deploy to land.
 *
 * Kept apart from client.ts on purpose: client.ts only ever READS a deploy's
 * status, while everything here changes real infrastructure. Both take the
 * token explicitly rather than reaching for a process-wide secret, because the
 * account being acted on is a decision made per project — Selvedge's own
 * hosting by default, or the customer's if they brought it (see
 * build/hostAccount.ts). A file that quietly picked its own token could point
 * the wrong one at the wrong account.
 *
 * The network shapes are ported from toile's working implementation, including
 * its two schema-drift fallbacks — Railway's GraphQL has moved before, and a
 * deploy failing because a field was renamed is not a failure the owner should
 * ever see.
 */

/** Selvedge's own hosting account — the default when a customer hasn't brought theirs. */
export function platformHostConfigured(): boolean {
  return Boolean(process.env.RAILWAY_API_TOKEN?.trim());
}

export function platformHostToken(): string | null {
  return process.env.RAILWAY_API_TOKEN?.trim() || null;
}

/** Railway service names must be tame; the project id already is, mostly. */
export function serviceNameFor(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'app';
}

/** Only a renamed/moved field should trigger a fallback shape — not a real refusal. */
function isSchemaDrift(err: unknown): boolean {
  return /Cannot query field|Unknown argument|Unknown field|Unknown type|not defined by type/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/**
 * Where new services get created.
 *
 * On Selvedge's own account this is deliberately strict: a pinned
 * RAILWAY_PROJECT_ID, or a project named "selvedge". Guessing wrong here would
 * scatter customer apps through unrelated projects.
 *
 * On a CUSTOMER's own account we cannot expect either — it's their account,
 * arranged their way — so `anyProject` lets it fall back to the project they
 * already have. The environment is the one named production, else the first.
 */
export async function resolveHostProject(
  token: string,
  opts: { pinnedProjectId?: string | null; anyProject?: boolean } = {},
): Promise<{ projectId: string; environmentId: string }> {
  type Project = { id: string; name: string; environments: { edges: Array<{ node: { id: string; name: string } }> } };
  let projects: Project[];
  if (opts.anyProject) {
    // OAuth workspace grants deliberately cannot use the account-wide
    // `projects` field. Discover only the workspaces selected on Railway's
    // consent screen, then enumerate projects inside those boundaries.
    const visible = await railwayGql<{ me: { workspaces: Array<{ id: string }> } }>(
      token,
      `query { me { workspaces { id } } }`,
    );
    projects = [];
    for (const workspace of visible.me.workspaces) {
      const data = await railwayGql<{ workspace: { projects: { edges: Array<{ node: Project }> } } }>(
        token,
        `query($workspaceId: String!) { workspace(workspaceId: $workspaceId) { projects { edges { node { id name environments { edges { node { id name } } } } } } } }`,
        { workspaceId: workspace.id },
      );
      projects.push(...data.workspace.projects.edges.map((edge) => edge.node));
    }
  } else {
    const data = await railwayGql<{ projects: { edges: Array<{ node: Project }> } }>(
      token,
      `query { projects { edges { node { id name environments { edges { node { id name } } } } } } }`,
    );
    projects = data.projects.edges.map((edge) => edge.node);
  }
  const pinned = opts.pinnedProjectId?.trim();
  const project = pinned
    ? projects.find((p) => p.id === pinned)
    : (projects.find((p) => p.name.toLowerCase() === 'selvedge') ?? (opts.anyProject ? projects[0] : undefined));

  if (!project) {
    if (pinned) throw new Error('the pinned Railway project is not visible to this token');
    throw new Error(
      opts.anyProject
        ? 'that Railway account has no projects to deploy into'
        : 'no Railway project named "selvedge" is visible to this token — create one, or set RAILWAY_PROJECT_ID',
    );
  }

  const envs = project.environments.edges.map((e) => e.node);
  const env = envs.find((e) => e.name.toLowerCase() === 'production') ?? envs[0];
  if (!env) throw new Error(`the Railway project "${project.name}" has no environments`);
  return { projectId: project.id, environmentId: env.id };
}

/**
 * DOES THIS REPO ALREADY LIVE HERE? — asked before anything is created.
 *
 * An app brought into Selvedge often already has a real deployment: Railway
 * services carry the GitHub repo they deploy from, so the question is
 * answerable. Provisioning used to skip it and mint a fresh service every
 * time, which is how an imported app ended up with a duplicate deployment
 * beside its real one — in the wrong Railway project, on dogfood configs.
 *
 * Matches are preferred in the production environment; the first match wins
 * otherwise. Failure to ASK is an error the caller must treat as "do not
 * create anything blind", not as "no".
 */
export type AdoptableService = {
  projectId: string;
  environmentId: string;
  serviceId: string;
  projectName: string;
  serviceName: string;
};

export async function findServiceByRepo(token: string, repoFullName: string): Promise<AdoptableService | null> {
  type Gql = {
    projects: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          environments: { edges: Array<{ node: { id: string; name: string } }> };
          services: {
            edges: Array<{
              node: {
                id: string;
                name: string;
                serviceInstances: { edges: Array<{ node: { environmentId: string; source: { repo: string | null } | null } }> };
              };
            }>;
          };
        };
      }>;
    };
  };
  const data = await railwayGql<Gql>(
    token,
    `query {
      projects { edges { node { id name
        environments { edges { node { id name } } }
        services { edges { node { id name
          serviceInstances { edges { node { environmentId source { repo } } } }
        } } }
      } } }
    }`,
  );

  const wanted = repoFullName.toLowerCase();
  const matches: Array<AdoptableService & { environmentName: string }> = [];
  for (const p of data.projects.edges.map((e) => e.node)) {
    const envName = new Map(p.environments.edges.map((e) => [e.node.id, e.node.name] as const));
    for (const svc of p.services.edges.map((e) => e.node)) {
      for (const inst of svc.serviceInstances.edges.map((e) => e.node)) {
        if (inst.source?.repo?.toLowerCase() === wanted) {
          matches.push({
            projectId: p.id,
            environmentId: inst.environmentId,
            serviceId: svc.id,
            projectName: p.name,
            serviceName: svc.name,
            environmentName: envName.get(inst.environmentId) ?? '',
          });
        }
      }
    }
  }
  const best = matches.find((m) => m.environmentName.toLowerCase() === 'production') ?? matches[0];
  if (!best) return null;
  const { environmentName: _env, ...service } = best;
  return service;
}

/** Create a service that deploys from a GitHub repo. Variables are passed at creation so the first auto-deploy already has them. */
export async function createService(
  token: string,
  projectId: string,
  name: string,
  repoFullName: string,
  variables: Record<string, string>,
  branch = 'main',
): Promise<string> {
  const mutation = `mutation Create($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`;
  let serviceId: string | null = null;
  try {
    const data = await railwayGql<{ serviceCreate: { id: string } }>(token, mutation, {
      // Create without a source first. Railway otherwise starts an implicit
      // deployment immediately, and we cannot permit that deployment to fall
      // back to the repository's default branch even for a moment.
      input: { projectId, name, variables },
    });
    serviceId = data.serviceCreate.id;
    await railwayGql(token, `mutation Connect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }`, {
      id: serviceId,
      input: { repo: repoFullName, branch },
    });
    return serviceId;
  } catch (err) {
    if (serviceId) await deleteService(token, serviceId).catch(() => undefined);
    throw err;
  }
}

/** Pin the disposable service to the development command prepared by the agent.
 * A repository-wide production build is deliberately skipped: imported
 * monorepos often contain unrelated deployables with production-only env
 * requirements, while the selected dev command is the preview contract. */
export async function configurePreviewService(token: string, target: RailwayTarget): Promise<void> {
  await railwayGql(
    token,
    `mutation Update($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
      serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`,
    {
      serviceId: target.serviceId,
      environmentId: target.environmentId,
      input: {
        buildCommand: "echo 'Selvedge development preview: production build skipped'",
        startCommand: 'npm run dev',
      },
    },
  );
}

/** Deploy exactly the commit GitHub returned for the disposable preview ref. */
export async function deployPreviewCommit(token: string, target: RailwayTarget, commitSha: string): Promise<void> {
  await railwayGql(
    token,
    `mutation Deploy($serviceId: String!, $environmentId: String!, $commitSha: String!) {
      serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
    }`,
    { serviceId: target.serviceId, environmentId: target.environmentId, commitSha },
  );
}

/** Remove a disposable preview service and its domain/deployments. Idempotency is handled by the caller. */
export async function deleteService(token: string, serviceId: string): Promise<void> {
  await railwayGql(token, `mutation Delete($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
}

/** Upsert variables one at a time — the stable API. */
export async function setServiceVariables(token: string, target: RailwayTarget, variables: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(variables)) {
    await railwayGql(
      token,
      `mutation Upsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
      { input: { projectId: target.projectId, environmentId: target.environmentId, serviceId: target.serviceId, name, value } },
    );
  }
}

/**
 * The app's web address. Idempotent: read first, mint only if absent, so a
 * retried go-live never leaves a project with two domains.
 */
export async function ensureServiceDomain(token: string, target: RailwayTarget): Promise<string> {
  const existing = await railwayGql<{ domains: { serviceDomains: Array<{ domain: string }> } }>(
    token,
    `query Domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        serviceDomains { domain }
      }
    }`,
    { ...target },
  ).catch(() => null);

  const already = existing?.domains?.serviceDomains?.[0]?.domain;
  if (already) return `https://${already}`;

  const created = await railwayGql<{ serviceDomainCreate: { domain: string } }>(
    token,
    `mutation Domain($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }`,
    { input: { environmentId: target.environmentId, serviceId: target.serviceId } },
  );
  const domain = created.serviceDomainCreate?.domain;
  if (!domain) throw new Error('Railway did not return a web address for the app');
  return `https://${domain}`;
}

/** Ask Railway to deploy again (used when connecting the repo did not auto-deploy). */
export async function triggerDeploy(token: string, target: RailwayTarget): Promise<void> {
  try {
    await railwayGql(
      token,
      `mutation Deploy($input: EnvironmentTriggersDeployInput!) { environmentTriggersDeploy(input: $input) }`,
      { input: { ...target } },
    );
  } catch (err) {
    if (!isSchemaDrift(err)) throw err;
    await railwayGql(
      token,
      `mutation Redeploy($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }`,
      { environmentId: target.environmentId, serviceId: target.serviceId },
    );
  }
}

export class DeployTimeoutError extends Error {}

const TERMINAL_FAILURES = new Set(['FAILED', 'CRASHED', 'REMOVED']);
const POLL_INTERVAL_MS = 5_000;
/** How long to wait for no deployment at all to appear before nudging Railway once. */
const NUDGE_AFTER_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

async function latestDeployment(token: string, target: RailwayTarget): Promise<{ id: string; status: string } | null> {
  const data = await railwayGql<{ deployments: { edges: Array<{ node: { id: string; status: string } }> } }>(
    token,
    `query Deployments($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }`,
    { input: { ...target } },
  ).catch(() => null);
  return data?.deployments?.edges?.[0]?.node ?? null;
}

/**
 * Wait for the first deploy to actually succeed.
 *
 * Two non-obvious correctness details, both ported deliberately:
 *  - the id of any deployment that existed BEFORE we started is remembered, so
 *    a stale FAILED from an earlier attempt is never reported as this one's
 *    failure;
 *  - if nothing has appeared after 20s, we nudge once — connecting a GitHub
 *    source usually auto-deploys, but not always, and waiting out a five-minute
 *    timeout for a deploy that was never going to start is a miserable answer.
 */
export async function waitForDeploy(
  token: string,
  target: RailwayTarget,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const priorId = (await latestDeployment(token, target))?.id ?? null;
  const startedAt = now();
  let nudged = false;

  while (now() - startedAt < timeoutMs) {
    const current = await latestDeployment(token, target);
    if (current) {
      const isNew = current.id !== priorId;
      if (current.status === 'SUCCESS' && isNew) return;
      if (TERMINAL_FAILURES.has(current.status) && isNew) {
        throw new Error(`the host tried to build it and it failed (${current.status.toLowerCase()})`);
      }
    } else if (!nudged && now() - startedAt > NUDGE_AFTER_MS) {
      nudged = true;
      await triggerDeploy(token, target).catch(() => undefined);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new DeployTimeoutError('the build is taking longer than expected');
}

/** The compound resource_id a pack's topology stores for a hosted service. */
export function targetToResourceId(target: RailwayTarget): string {
  return `${target.projectId}/${target.environmentId}/${target.serviceId}`;
}
