import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentMessages, orgs } from '../db/schema/index.js';
import { ensureWorkshopThread } from '../threads/store.js';
import { getPack, listPacks, updateHumanSections, updateMachineSections } from '../packs/store.js';
import { createNeonDatabase, neonConfigured } from '../connectors/neon/client.js';
import {
  createService,
  ensureServiceDomain,
  findServiceByRepo,
  resolveHostProject,
  serviceNameFor,
  setServiceVariables,
  targetToResourceId,
  waitForDeploy,
  DeployTimeoutError,
  type AdoptableService,
} from '../connectors/railway/provision.js';
import { ensureLiveUrlCheck } from '../monitor/wiring.js';
import { resolveRepoToken } from './repoToken.js';
import { resolveHostAccount, hostProjectOptions, whereItLives, type HostAccount } from './hostAccount.js';
import { parseRailwayTarget, type RailwayTarget } from '../connectors/railway/client.js';
import type { ContextPack } from '../../shared/types/pack.js';

/**
 * Put it online — the step that was missing, and the reason the workshop used
 * to end with a page of instructions.
 *
 * The owner presses one button. Selvedge creates the database if the app needs
 * one, creates the host service from the repo, sets the variables, mints a web
 * address, and waits for the first build to actually land. They never make an
 * account, never copy a connection string, never open a dashboard.
 *
 * The host is recorded in the pack's own topology, which is what starts the
 * DEPLOY poller — no separate wiring, because "what is this project made of"
 * was already the question topology.sources answers.
 *
 * The health monitor is NOT topology-driven and does not come along for free.
 * It reads the `health_checks` table, and until this function armed one, nothing
 * outside the tests ever wrote a row there — so the probe half of "I'm watching
 * it" was silently doing nothing while the deploy half worked. That is why
 * `watch()` is an explicit step below rather than an implication of the
 * topology write.
 *
 * Idempotent by construction: a project that already has a host source reuses
 * it rather than creating a second service, so a retry after a timeout
 * converges instead of multiplying infrastructure.
 */

/** Variables every app gets. PORT binds the same :3000 the agent's rules require. */
const BASE_VARIABLES: Record<string, string> = { NODE_ENV: 'production', PORT: '3000' };

/** How many apps an org may have online at once, by plan — hosting is a real recurring cost. */
export const PLAN_LIVE_APP_LIMIT: Record<string, number> = { trial: 1, care: 3, studio: 10 };
export const DEFAULT_LIVE_APP_LIMIT = 1;

export function liveAppLimit(plan?: string): number {
  const raw = process.env.LIVE_APP_LIMIT;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  if (plan && plan in PLAN_LIVE_APP_LIMIT) return PLAN_LIVE_APP_LIMIT[plan] as number;
  return DEFAULT_LIVE_APP_LIMIT;
}

export type GoLiveOutcome =
  | { outcome: 'live'; url: string; message: string }
  | { outcome: 'already_live'; url: string; message: string }
  | { outcome: 'still_building'; url: string; message: string }
  | { outcome: 'not_possible'; message: string }
  | { outcome: 'failed'; message: string };

/** The Railway service this project is already hosted on, if any. */
export function existingHostTarget(pack: ContextPack): RailwayTarget | null {
  const source = pack.topology.sources.find((s) => s.connector === 'railway');
  return source ? parseRailwayTarget(source.resource_id) : null;
}

export function hasDatabase(pack: ContextPack): boolean {
  return pack.topology.sources.some((s) => s.connector === 'neon' || s.role === 'database');
}

/**
 * Does this app need a database? The agent's standing rules tell it to record
 * every variable the app needs in `.env.example`, so that file is the app's own
 * declaration of what it wants — no extra convention to learn and nothing for
 * the owner to fill in.
 */
export function needsDatabase(envExample: string | null): boolean {
  if (!envExample) return false;
  return /^\s*#?\s*DATABASE_URL\s*=/m.test(envExample);
}

/**
 * Read one file from the repo without waking a sandbox. Null when it isn't
 * there — or when we couldn't look, which the caller has to treat as "don't
 * know" rather than "no". Same credential as the clone: the org's own
 * installation, falling back to a configured token where no app exists.
 */
export async function readRepoFile(repoFullName: string, path: string, accessToken?: string): Promise<string | null> {
  const token = accessToken?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function say(db: Db, orgId: string, projectId: string, content: string): Promise<void> {
  // Go-live narrates into the project's workshop thread — the conversation the
  // owner pressed the button from. A thread lookup that fails must not silence
  // the line: an unattached message is still readable, a missing one isn't.
  const threadId = await ensureWorkshopThread(db, orgId, projectId)
    .then((t) => t.id)
    .catch(() => null);
  await db.insert(agentMessages).values({ id: ulid(), orgId, projectId, threadId, role: 'agent', content }).catch(() => undefined);
}

export type GoLiveDeps = {
  account?: (db: Db, orgId: string) => Promise<HostAccount | null>;
  provisionDb?: (orgId: string, projectId: string) => Promise<{ neonProjectId: string; connectionUri: string }>;
  hostProject?: (token: string, opts: { pinnedProjectId?: string | null; anyProject?: boolean }) => Promise<{ projectId: string; environmentId: string }>;
  makeService?: (token: string, projectId: string, name: string, repo: string, vars: Record<string, string>) => Promise<string>;
  setVars?: (token: string, target: RailwayTarget, vars: Record<string, string>) => Promise<void>;
  domain?: (token: string, target: RailwayTarget) => Promise<string>;
  awaitDeploy?: (token: string, target: RailwayTarget) => Promise<void>;
  /** Find the service already deploying this repo, if one exists. */
  adopt?: (token: string, repoFullName: string) => Promise<AdoptableService | null>;
  readFile?: (repoFullName: string, path: string, accessToken?: string) => Promise<string | null>;
  /** Arm the health watch on the new address. Injected so go-live is testable without the checks table. */
  watch?: (db: Db, orgId: string, projectId: string, url: string) => Promise<void>;
};

/**
 * Take a project from "pushed to GitHub" to "has a web address that serves it".
 * Every failure returns a plain sentence naming what did and did not happen —
 * a half-finished go-live must never read as a finished one.
 */
export async function goLive(db: Db, orgId: string, projectId: string, deps: GoLiveDeps = {}): Promise<GoLiveOutcome> {
  const findAccount = deps.account ?? resolveHostAccount;
  const provisionDb = deps.provisionDb ?? createNeonDatabase;
  const hostProject = deps.hostProject ?? resolveHostProject;
  const makeService = deps.makeService ?? createService;
  const setVars = deps.setVars ?? setServiceVariables;
  const domain = deps.domain ?? ensureServiceDomain;
  const awaitDeploy = deps.awaitDeploy ?? waitForDeploy;
  const adopt = deps.adopt ?? findServiceByRepo;
  const readFile = deps.readFile ?? readRepoFile;
  const watch = deps.watch ?? ensureLiveUrlCheck;

  const pack = await getPack(db, orgId, projectId);
  if (!pack) return { outcome: 'not_possible', message: 'no such project' };

  // Their own hosting account — see hostAccount.ts for why it is theirs and not
  // Selvedge's. Without one there is nowhere legitimate to put this.
  const account = await findAccount(db, orgId);
  if (!account) {
    return {
      outcome: 'not_possible',
      message:
        "I don't have anywhere to put this yet. Connect your hosting on the Connections page — it stays in your name, and you could hand it to someone else or walk away from Selvedge without anything breaking.",
    };
  }

  const repo = pack.topology.sources.find((s) => s.connector === 'github')?.resource_id;
  if (!repo) {
    return { outcome: 'not_possible', message: "This project has no code connected yet, so there's nothing to put online." };
  }

  const already = existingHostTarget(pack);
  const liveUrl = pack.identity.links?.live_url;
  if (already && liveUrl) {
    return { outcome: 'already_live', url: liveUrl, message: `This is already online at ${liveUrl}. Shipping a change updates it.` };
  }

  // The cost guard: only Selvedge's own hosting is capped, because only that
  // is Selvedge's bill. An owner paying for their own account is not rationed.
  if (!already && account.owner === 'selvedge') {
    const [org] = await db.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
    const limit = liveAppLimit(org?.plan ?? undefined);
    const live = (await listPacks(db, orgId)).filter((p) => p.identity.links?.live_url).length;
    if (live >= limit) {
      return {
        outcome: 'not_possible',
        message: `You already have ${live} app${live === 1 ? '' : 's'} online, which is the limit on your plan. Take one offline, or move up a plan, and I'll put this one up.`,
      };
    }
  }

  try {
    // 0) ADOPT BEFORE CREATING ANYTHING. An app brought into Selvedge often
    //    already has a real deployment, and Railway knows which repo each
    //    service deploys from — so the account is asked first. An adopted
    //    service is treated as what it is, somebody's running production:
    //    no database is provisioned for it, no variable is written to it,
    //    and its existing domain is read rather than replaced. If the
    //    question itself cannot be answered, nothing is created blind.
    let target = already;
    let adoptedService: AdoptableService | null = null;
    if (!target) {
      try {
        adoptedService = await adopt(account.token, repo);
      } catch (err) {
        return {
          outcome: 'failed',
          message: `I couldn't check whether this app already has a deployment on that Railway account, so I didn't create anything: ${err instanceof Error ? err.message : String(err)}. Try again in a moment.`,
        };
      }
      if (adoptedService) {
        target = {
          projectId: adoptedService.projectId,
          environmentId: adoptedService.environmentId,
          serviceId: adoptedService.serviceId,
        };
        await say(
          db,
          orgId,
          projectId,
          `This app already lives on Railway — the service "${adoptedService.serviceName}" in your project "${adoptedService.projectName}" deploys this repo. I'm using that deployment rather than making a second one.`,
        );
      }
    }

    // 1) A database, if the app asked for one in its own .env.example — but
    //    never for an adopted deployment, which already has whatever it has.
    const variables: Record<string, string> = { ...BASE_VARIABLES };
    let neonProjectId: string | null = null;
    if (!target) {
      const repoRead = await resolveRepoToken(db, orgId, repo);
      if (!hasDatabase(pack) && needsDatabase(await readFile(repo, '.env.example', repoRead.ok ? repoRead.token : undefined))) {
        if (!neonConfigured() && !deps.provisionDb) {
          return { outcome: 'not_possible', message: "This app needs a database, and Selvedge's database provider isn't configured yet." };
        }
        await say(db, orgId, projectId, 'Setting up a database for it…');
        const created = await provisionDb(orgId, projectId);
        neonProjectId = created.neonProjectId;
        // The connection string is set on the host and deliberately not stored
        // here: Selvedge never needs to read it again, and a secret it does not
        // hold is a secret it cannot leak.
        variables.DATABASE_URL = created.connectionUri;
      }
    }

    // 2) The service, created from the repo with its variables already in place
    //    so the first automatic build has them. Only when nothing exists to
    //    adopt or reuse.
    if (!target) {
      await say(db, orgId, projectId, 'Setting up the hosting…');
      const host = await hostProject(account.token, hostProjectOptions(account));
      const serviceId = await makeService(account.token, host.projectId, serviceNameFor(projectId), repo, variables);
      target = { projectId: host.projectId, environmentId: host.environmentId, serviceId };
      // Re-asserted for the fallback creation shape, which carries none. Never
      // for an adopted service: overwriting a running app's PORT or
      // DATABASE_URL is exactly the kind of help nobody asked for.
      await setVars(account.token, target, variables);
    }

    // 3) A web address, then wait for the build to actually land.
    const url = await domain(account.token, target);
    await say(db, orgId, projectId, `It has an address — ${url} — and the first build is running now.`);

    // 4) Record it before waiting: if the build times out, the project is still
    //    correctly wired and a retry reuses all of this.
    await updateMachineSections(db, orgId, projectId, {
      addSources: [
        { connector: 'railway', resource_id: targetToResourceId(target), role: 'production_host', environment: 'production' },
        ...(neonProjectId ? [{ connector: 'neon' as const, resource_id: neonProjectId, role: 'database' as const }] : []),
      ],
    });
    await updateHumanSections(db, orgId, projectId, {
      identity: { ...pack.identity, links: { ...pack.identity.links, live_url: url } },
    });

    // Arm the watch here, alongside the topology write and for the same reason:
    // if the build times out below, the app is still correctly wired AND still
    // watched. Recording the address without watching it would make the
    // "I'm watching it from here" line in the timeout branch untrue.
    await watch(db, orgId, projectId, url).catch((err) =>
      console.error(`could not arm the health watch for ${projectId}:`, err),
    );

    try {
      await awaitDeploy(account.token, target);
    } catch (err) {
      if (err instanceof DeployTimeoutError) {
        const message = `It's set up at ${url} and the host is still building it. That can take a few more minutes — the address will start working on its own. I'm watching it from here.`;
        await say(db, orgId, projectId, message);
        return { outcome: 'still_building', url, message };
      }
      throw err;
    }

    const message = `It's online at ${url}, ${whereItLives(account)}. I'm watching it from now on, and shipping a change updates it.`;
    await say(db, orgId, projectId, message);
    return { outcome: 'live', url, message };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `I couldn't finish putting it online — ${detail}. Nothing else was changed, and you can try again.`;
    await say(db, orgId, projectId, message);
    return { outcome: 'failed', message };
  }
}
