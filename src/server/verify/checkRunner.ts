import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import { templateRunChecks, type RunCheckDeps } from './checks.js';
import { fetchChangeEvidence, renderEvidence, type EvidenceDeps } from './evidence.js';
import { resolveRepoToken } from '../build/repoToken.js';
import type { VerifyContext } from './run.js';
import type { CheckResult } from './verdict.js';

/**
 * The real check runner. It reads the card's pack for where the app lives,
 * fetches the diff the run pushed to the card's review branch, generates the
 * checks, and runs them: smoke/regression as HTTP probes, acceptance judged by
 * the independent grader when one is configured (deps.judge — a DIFFERENT
 * provider than authored the change, so the verdict never grades its own work).
 *
 * A genuine verdict comes out at every level of configuration: a live app that
 * responds plus a graded acceptance lands at `verified`; no grader, or no
 * evidence to grade, caps at `probably`; a down app is `didnt_work`; an app we
 * don't know how to reach is `inconclusive`.
 *
 * The acceptance criterion depends on who initiated the card. For a request,
 * the owner's ask (the title) IS the criterion. For an incident, the title
 * describes the PROBLEM — "orders are failing" is not something a change can
 * "do" — so the criterion is the card's proposal: what Selvedge said it would
 * do about it. Before this, incident cards carried no criterion at all and
 * could never reach `verified`, which silently exempted half the card
 * population from the product's central promise.
 */
export type CheckRunnerOptions = {
  deps?: RunCheckDeps;
  evidenceDeps?: EvidenceDeps;
  /**
   * Build the per-card judge — a factory rather than a judge, because grading
   * is budgeted and metered per ORG, and the org is only known once the card
   * is in hand. Absent → judged checks run as could_not_run.
   */
  makeJudge?: (orgId: string) => NonNullable<RunCheckDeps['judge']>;
};

export function buildTemplateRunChecks(
  db: Db,
  options: CheckRunnerOptions = {},
): (ctx: VerifyContext) => Promise<CheckResult[]> {
  return async (ctx: VerifyContext) => {
    const pack = await getPack(db, ctx.card.orgId, ctx.card.projectId);
    const liveUrl = pack?.identity.links?.live_url ?? null;
    const requestText = ctx.card.trigger === 'request' ? ctx.card.title : ctx.card.proposal;

    // The diff lives on the review branch the run pushed (selvedge/<card id>) —
    // durable on GitHub, reachable long after the run's sandbox is deleted.
    // No repo, no branch, or GitHub unreachable → no evidence → the acceptance
    // check stays manual and the verdict caps at `probably`. Never a guess.
    const repo = pack?.topology.sources.find((s) => s.connector === 'github')?.resource_id ?? null;
    // Read the branch as the org, not as the platform: the same credential the
    // run cloned with is the one that can see what it pushed.
    const evidenceDeps = options.evidenceDeps ?? {};
    const repoToken = repo && evidenceDeps.token === undefined ? await resolveRepoToken(db, ctx.card.orgId, repo) : null;
    const evidence = repo
      ? await fetchChangeEvidence(repo, ctx.card.id, 'main', {
          ...evidenceDeps,
          ...(repoToken?.ok ? { token: repoToken.token } : {}),
        })
      : null;

    const judge = options.makeJudge?.(ctx.card.orgId);
    return templateRunChecks(
      { liveUrl, requestText, evidence: evidence ? renderEvidence(evidence) : null },
      { ...(options.deps ?? {}), ...(judge ? { judge } : {}) },
    );
  };
}
