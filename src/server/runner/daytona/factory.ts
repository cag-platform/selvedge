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
 */
export function buildBuildEngine(db: Db): DriveDeps | null {
  const daytonaKey = process.env.DAYTONA_API_KEY?.trim();
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  if (!daytonaKey || !claudeToken || !githubToken) return null;

  const engine = daytonaEngine(db, {
    claudeCodeOauthToken: claudeToken,
    githubToken,
    ...(process.env.EVAL_MODEL ? { model: process.env.EVAL_MODEL } : {}),
  });

  return {
    runner: { sandbox: engine.sandbox, agentStep: engine.agentStep },
    verify: { runChecks: buildTemplateRunChecks(db) },
  };
}
