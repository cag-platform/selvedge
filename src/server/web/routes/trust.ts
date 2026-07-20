import { Router, type Request } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { trustIncidents } from '../../db/schema/index.js';
import { trackRecord } from '../../trust/trackRecord.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The honesty ledger surfaced (Ironclad 2): a plain track record of Selvedge's
 * own calibration, and the Class-1 incidents where an all-clear was later
 * contradicted. Making this visible is the auditor's stance — a product that
 * publishes its own accuracy.
 */
export function createTrustRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/trust/track-record',
    asyncHandler(async (req, res) => {
      const windowDays = clampWindow(req.query.days);
      res.json(await trackRecord(db, orgIdOf(req), windowDays));
    }),
  );

  router.get(
    '/api/trust/incidents',
    asyncHandler(async (req, res) => {
      const rows = await db
        .select()
        .from(trustIncidents)
        .where(eq(trustIncidents.orgId, orgIdOf(req)))
        .orderBy(desc(trustIncidents.createdAt))
        .limit(50);
      res.json(
        rows.map((row) => ({
          id: row.id,
          project_id: row.projectId,
          kind: row.kind,
          detail: row.detail,
          acknowledged: row.acknowledged,
          created_at: row.createdAt,
        })),
      );
    }),
  );

  return router;
}

function clampWindow(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (Number.isNaN(n)) return 30;
  return Math.min(90, Math.max(1, n));
}
