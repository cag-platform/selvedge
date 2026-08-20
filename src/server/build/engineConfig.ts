import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import type { AgentTurnConfig } from './agent.js';

/**
 * "Can this project be worked on, and with what?" — one answer, shared by every
 * surface that starts a turn. It used to live inside the workshop router; the
 * Inbox needs exactly the same answer for a thread, and two copies of a
 * credentials-and-source check is how one of them ends up quietly out of date.
 */

export type EngineEnv = { claudeCodeOauthToken: string; githubToken: string; openaiApiKey?: string };

/** The build engine's credentials, or null when this deployment has no engine. */
export function engineEnv(): EngineEnv | null {
  const claude = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const github = process.env.GITHUB_TOKEN?.trim();
  const daytona = process.env.DAYTONA_API_KEY?.trim();
  if (!claude || !github || !daytona) return null;
  const openai = process.env.OPENAI_API_KEY?.trim();
  // Codex's fuel is optional: without it the second builder simply isn't
  // offered, and everything else works exactly as before.
  return { claudeCodeOauthToken: claude, githubToken: github, ...(openai ? { openaiApiKey: openai } : {}) };
}

export type EngineConfig = { cfg: AgentTurnConfig; liveUrl: string | null };
export type EngineRefusal = { error: string; status: number };

/** The pack's GitHub source + engine creds, or a plain reason why not. */
export async function configFor(
  db: Db,
  orgId: string,
  projectId: string,
  env: () => EngineEnv | null = engineEnv,
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
  return { cfg: { ...creds, repoFullName: source.resource_id, branch: 'main' }, liveUrl: pack.identity.links?.live_url ?? null };
}
