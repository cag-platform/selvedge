import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listLedger } from '../../ledger/store.js';
import { summarize } from '../../ledger/summary.js';
import { subscriptionForOrg } from '../../billing/store.js';
import { remainingBuildMinutes, resolvePlan } from '../../billing/entitlements.js';
import { priceLine } from '../../../shared/plans.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The track record — the intent→outcome ledger, surfaced (BUILD-BRIEF Phase 5:
 * "the track-record page, the API exists today with no page"). A plain history
 * of what was asked, what it cost, and how it turned out, plus the honest
 * summary. Org-scoped; optionally narrowed to one project.
 */
export function createLedgerRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/ledger',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
      const [entries, subscription, buildMinutes] = await Promise.all([
        listLedger(db, orgId, projectId ? { projectId } : {}),
        subscriptionForOrg(db, orgId),
        remainingBuildMinutes(db, orgId),
      ]);

      const plan = resolvePlan(subscription);

      res.json({
        entries,
        summary: summarize(entries),
        /**
         * THE LEDGER IS THE ONE MONEY VIEW, so what Selvedge itself charges
         * belongs in it next to what the models cost.
         *
         * The two are genuinely different and are labelled as such: `fuel` is
         * the owner's own model spend on their own keys, at cost, which
         * Selvedge takes no cut of. `subscription` is what Selvedge charges for
         * the record. Showing only the first would make the product look free;
         * merging them into one total would make the models look like our
         * margin. Neither is true, and a person checking what this costs them
         * deserves both numbers separately.
         */
        money: {
          fuel_cents: summarize(entries).spentCents,
          subscription:
            plan === 'free'
              ? null
              : {
                  plan,
                  interval: subscription?.billingInterval ?? 'monthly',
                  price: priceLine(plan, subscription?.billingInterval ?? 'monthly'),
                  next_charge: subscription?.status === 'active' ? (subscription.currentPeriodEnd ?? null) : null,
                },
          build_minutes: buildMinutes,
        },
      });
    }),
  );

  return router;
}
