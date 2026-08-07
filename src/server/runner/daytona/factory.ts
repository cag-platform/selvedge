import type { Db } from '../../db/client.js';
import type { DriveDeps } from '../../cards/drive.js';
import { buildTemplateRunChecks } from '../../verify/checkRunner.js';
import { daytonaEngine } from './provider.js';

/**
 * Assemble the build engine from the environment, or return null when it isn't
 * configured. This is the one place env credentials for the live layer are read;
 * everything below is injected. When null, an approved card simply waits — no
 * inert half-run, no surprise spend.
 *
 * Requires the Daytona key (the sandbox), the Claude Code auth token (the agent),
 * and a GitHub token (to clone the customer's repo and push the review branch).
 * The verify half uses the real template check runner, which needs no model.
 *
 * AGENT_MODEL picks the model the agent AUTHORS with. It used to be read from
 * EVAL_MODEL, which was a plain bug: EVAL_MODEL is documented as the model that
 * *judges* a change on a different model than wrote it, so anyone who set it
 * believing the docs was silently changing which model wrote their code — the
 * exact opposite of an independent check. EVAL_MODEL now belongs to the grader
 * and is never read here.
 */
/**
 * Which model the agent authors with, or undefined for the CLI's own default.
 * Pure and exported so the one thing that must stay true here is assertable:
 * EVAL_MODEL never selects the authoring model. A grader that grades its own
 * work is the failure this whole layer exists to prevent, and reading the
 * grader's variable here was that failure in miniature.
 */
export function agentModelFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const model = env.AGENT_MODEL?.trim();
  return model ? model : undefined;
}

export function buildBuildEngine(db: Db): DriveDeps | null {
  const daytonaKey = process.env.DAYTONA_API_KEY?.trim();
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!daytonaKey || !claudeToken || !githubToken) return null;

  const agentModel = agentModelFromEnv();
  const engine = daytonaEngine(db, {
    claudeCodeOauthToken: claudeToken,
    githubToken,
    ...(agentModel ? { model: agentModel } : {}),
  });

  return {
    runner: { sandbox: engine.sandbox, agentStep: engine.agentStep },
    verify: { runChecks: buildTemplateRunChecks(db) },
  };
}
