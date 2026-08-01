import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listLedger } from '../../ledger/store.js';
import { summarize } from '../../ledger/summary.js';

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
      const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
      const entries = await listLedger(db, orgIdOf(req), projectId ? { projectId } : {});
      res.json({ entries, summary: summarize(entries) });
    }),
  );

  return router;
}
