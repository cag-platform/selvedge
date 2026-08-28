import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import type { AgentTurnConfig } from './agent.js';
import { resolveRepoToken, type RepoToken } from './repoToken.js';
import { lookupRepoInfo, type RepoInfo } from './repoInfo.js';

/**
 * "Can this project be worked on, and with what?" — one answer, shared by every
 * surface that starts a turn. It used to live inside the workshop router; the
 * Inbox needs exactly the same answer for a thread, and two copies of a
 * credentials-and-source check is how one of them ends up quietly out of date.
 */

/**
 * What the DEPLOYMENT provides, which is now exactly one thing: somewhere to
 * run. The machines are ours — we rent them, meter them and reap them, and
 * `buildMinutes` in the plan table is what they cost.
 */
export type EngineEnv = { workspaceRuntime: true };

/**
 * Is there a build engine here at all, or is this a deployment that only
 * watches? Null means the workshop is off, and every surface says so plainly.
 *
 * THREE THINGS ARE DELIBERATELY NOT HERE, and they used to be two.
 *
 * GitHub: reaching a repo is a per-org, per-repo question answered by
 * repoToken.ts against the org's own app installation. A deployment-wide token
 * in this shape was how the engine ended up able to see repos it could not
 * clone.
 *
 * OpenAI: Codex's fuel is a per-org question answered by builderAuth.ts, the
 * owner's connected key first. A deployment-wide key in this shape was how an
 * owner with a working key still got a 401 out of the sandbox.
 *
 * ANTHROPIC — the one that was still here. `CLAUDE_CODE_OAUTH_TOKEN` sat in
 * this function with no org in scope, so every build turn every customer would
 * ever run went on ONE account's Claude subscription: the bill in the wrong
 * place, and a per-account rate limit shared by strangers. It is a per-org
 * question now, answered by builderAuth.ts alongside Codex's, and the shape of
 * bug that produced it three times in this codebase is described there.
 *
 * What's left is what genuinely belongs to the deployment: the sandbox host.
 */
export function engineEnv(): EngineEnv | null {
  const openai = process.env.OPENAI_API_KEY?.trim();
  const relaySecret = process.env.PREVIEW_RELAY_SIGNING_SECRET?.trim();
  const relayOrigin = process.env.PREVIEW_RELAY_PUBLIC_ORIGIN?.trim();
  if (!openai || !relaySecret || !relayOrigin) return null;
  return { workspaceRuntime: true };
}

export type EngineConfig = { cfg: AgentTurnConfig; liveUrl: string | null };
export type EngineRefusal = { error: string; status: number };

/**
 * The pack's GitHub source and a machine to run on, or a plain reason why not.
 *
 * NOTE WHAT THIS NO LONGER RETURNS: any model credential. The builder's secret
 * is resolved inside `runAgentTurn`, at the moment the turn knows which agent
 * is running and for which org — one place, after the choice, rather than a
 * bundle of every agent's fuel assembled before it. That is what stops a
 * credential travelling further than the turn that needs it.
 */
export async function configFor(
  db: Db,
  orgId: string,
  projectId: string,
  env: () => EngineEnv | null = engineEnv,
  resolveToken: (db: Db, orgId: string, repoFullName: string) => Promise<RepoToken> = resolveRepoToken,
  lookup: (token: string, repoFullName: string) => Promise<RepoInfo> = lookupRepoInfo,
): Promise<EngineConfig | EngineRefusal> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return { error: 'no such project', status: 404 };
  if (!env()) {
    return { status: 409, error: "The workshop isn't switched on yet — the build engine's credentials aren't configured." };
  }
  const source = pack.topology.sources.find((s) => s.connector === 'github');
  if (!source) {
    return { status: 409, error: "This project has no connected code source yet, so there's nothing for me to work on." };
  }
  // Asked BEFORE a sandbox exists. A repo we can't reach is a refusal, not a
  // machine started, a minute billed, and a clone that dies on authentication.
  const token = await resolveToken(db, orgId, source.resource_id);
  if (!token.ok) return { status: 409, error: token.reason };
  // THE BRANCH IS A FACT, NOT A CONVENTION. This used to say 'main' for every
  // project, and every repo whose default branch is anything else — most repos
  // whose first push came from a Claude Code session, and everything older on
  // `master` — died at the clone with "Remote branch main not found". The
  // repo's own default is looked up with the same token the clone will use;
  // see repoInfo.ts for the empty-repo case.
  const info = await lookup(token.token, source.resource_id);
  if (!info.ok) return { status: 409, error: info.reason };
  return {
    cfg: {
      githubToken: token.token,
      repoFullName: source.resource_id,
      branch: info.defaultBranch,
      emptyRepo: info.empty,
    },
    liveUrl: pack.identity.links?.live_url ?? null,
  };
}
