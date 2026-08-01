import type { Db } from '../db/client.js';
import { getPack } from '../packs/store.js';
import { templateRunChecks, type RunCheckDeps } from './checks.js';
import type { VerifyContext } from './run.js';
import type { CheckResult } from './verdict.js';

/**
 * The real, no-model check runner — the deterministic half of verification wired
 * to run. It reads the card's pack for where the app lives, generates the
 * template checks, and runs the smoke/regression probes against the real URL.
 * This produces a genuine verdict today: a live app that responds lands at
 * `probably` (smoke confirmed, acceptance still needs the model), a down app at
 * `didnt_work`, and an app we don't know how to reach at `inconclusive`.
 *
 * The evaluating model is the enhancement, not a prerequisite: when it's wired,
 * it replaces the `manual` acceptance check with a judged one (and, judging on a
 * DIFFERENT model than authored the change, never grades its own work). This
 * runner plugs into the same VerifyDeps.runChecks seam either way.
 */
export function buildTemplateRunChecks(db: Db, deps: RunCheckDeps = {}): (ctx: VerifyContext) => Promise<CheckResult[]> {
  return async (ctx: VerifyContext) => {
    const pack = await getPack(db, ctx.card.orgId, ctx.card.projectId);
    const liveUrl = pack?.identity.links?.live_url ?? null;
    // For a request card the title IS the ask; an incident's title describes the
    // problem, which isn't an acceptance criterion, so only requests carry one.
    const requestText = ctx.card.trigger === 'request' ? ctx.card.title : null;

    return templateRunChecks({ liveUrl, requestText }, deps);
  };
}
