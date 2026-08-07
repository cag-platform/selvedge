import type { Db } from '../../db/client.js';
import type { DriveDeps } from '../../cards/drive.js';
import { buildTemplateRunChecks } from '../../verify/checkRunner.js';
import { gradeAcceptance } from '../../verify/grader.js';
import { buildGraderClient } from '../../llm/factory.js';
import { evalModel } from '../../llm/config.js';
import { providerForModel } from '../../llm/pricing.js';
import { daytonaEngine } from './provider.js';

/**
 * Assemble the build engine from the environment, or return null when it isn't
 * configured. This is the one place env credentials for the live layer are read;
 * everything below is injected. When null, an approved card simply waits — no
 * inert half-run, no surprise spend.
 *
 * Requires the Daytona key (the sandbox), the Claude Code auth token (the agent),
 * and a GitHub token (to clone the customer's repo and push the review branch).
 * The verify half runs the template checks, plus — when OPENAI_API_KEY is set —
 * the independent grader on the acceptance check. No grader key means judged
 * checks run as could_not_run and verdicts cap at `probably`; grading is an
 * enhancement to verification, never a prerequisite for it.
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

  // The independent grader — a client on a DIFFERENT provider than the agent
  // that authored the change. Absent key → no makeJudge → judged acceptance
  // checks run as could_not_run and the verdict caps at `probably`.
  const grader = buildGraderClient();
  const model = evalModel();

  // Provenance is DERIVED, not asserted: the agent authors on Claude
  // (anthropic), so a grader model priced to a different provider is
  // independent; one priced to anthropic — someone pointed EVAL_MODEL at a
  // Claude model — is disclosed as same_model, never dressed up. Only applied
  // when the judge actually resolves a check; see VerifyDeps.graderProvenance.
  const provenance = providerForModel(model) === 'anthropic' ? 'same_model' : 'independent';

  return {
    runner: { sandbox: engine.sandbox, agentStep: engine.agentStep },
    verify: {
      runChecks: buildTemplateRunChecks(db, {
        ...(grader
          ? { makeJudge: (orgId: string) => (spec) => gradeAcceptance({ llm: grader, db, model }, orgId, spec) }
          : {}),
      }),
      ...(grader ? { graderProvenance: provenance } : {}),
    },
  };
}
