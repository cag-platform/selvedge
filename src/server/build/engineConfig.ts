import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import type { AgentTurnConfig } from './agent.js';
import { resolveRepoToken, type RepoToken } from './repoToken.js';
import { resolveOpenAiKey } from './openaiKey.js';

/**
 * "Can this project be worked on, and with what?" — one answer, shared by every
 * surface that starts a turn. It used to live inside the workshop router; the
 * Inbox needs exactly the same answer for a thread, and two copies of a
 * credentials-and-source check is how one of them ends up quietly out of date.
 */

export type EngineEnv = { claudeCodeOauthToken: string };

/**
 * The build engine's platform credentials, or null when this deployment has no
 * engine.
 *
 * TWO THINGS ARE DELIBERATELY NOT HERE, for the same reason.
 *
 * GitHub: reaching a repo is a per-org, per-repo question answered by
 * repoToken.ts against the org's own app installation. A deployment-wide token
 * in this shape was how the engine ended up able to see repos it could not
 * clone.
 *
 * OpenAI: Codex's fuel is a per-org question answered by openaiKey.ts, the
 * owner's connected key first. A deployment-wide key in this shape was how an
 * owner with a working key still got a 401 out of the sandbox.
 *
 * What's left is what genuinely belongs to the deployment: the engine either
 * runs here or it doesn't.
 */
export function engineEnv(): EngineEnv | null {
  const claude = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const daytona = process.env.DAYTONA_API_KEY?.trim();
  if (!claude || !daytona) return null;
  return { claudeCodeOauthToken: claude };
}

export type EngineConfig = { cfg: AgentTurnConfig; liveUrl: string | null };
export type EngineRefusal = { error: string; status: number };

/** The pack's GitHub source + engine creds, or a plain reason why not. */
export async function configFor(
  db: Db,
  orgId: string,
  projectId: string,
  env: () => EngineEnv | null = engineEnv,
  resolveToken: (db: Db, orgId: string, repoFullName: string) => Promise<RepoToken> = resolveRepoToken,
  resolveOpenAi: (db: Db, orgId: string) => Promise<string | null> = resolveOpenAiKey,
): Promise<EngineConfig | EngineRefusal> {
  const pack = await getPack(db, orgId, projectId);
  if (!pack) return { error: 'no such project', status: 404 };
  const creds = env();
  if (!creds) {
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
  // Optional in the same way it always was: without a key Codex simply isn't
  // one of the builders on offer, and everything else works as before.
  const openaiApiKey = await resolveOpenAi(db, orgId);
  return {
    cfg: {
      ...creds,
      ...(openaiApiKey ? { openaiApiKey } : {}),
      githubToken: token.token,
      repoFullName: source.resource_id,
      branch: 'main',
    },
    liveUrl: pack.identity.links?.live_url ?? null,
  };
}
