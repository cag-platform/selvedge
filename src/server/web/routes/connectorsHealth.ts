import { Router, type Request } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { connectorHealth } from '../../db/schema/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Connector health for the org's trust surface. Exposes the connector_health
 * ledger (one row per installation) so the native Sources view can show each
 * connector through the status colors. Until now this table only fed Group E
 * narration and the webhook's self-healing; the native client needs it
 * directly to render a first-class trust surface rather than waiting for a
 * decayed connector to reach a pack's per-source trust.
 */
export function createConnectorsHealthRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/connectors/health',
    asyncHandler(async (req, res) => {
      const rows = await db
        .select()
        .from(connectorHealth)
        .where(eq(connectorHealth.orgId, orgIdOf(req)));

      res.json(
        rows.map((row) => ({
          connector: row.connector,
          source_account_id: row.sourceAccountId,
          status: row.status, // fresh | quiet | auth_failed
          last_event_at: row.lastEventAt,
          installed_at: row.installedAt,
          updated_at: row.updatedAt,
          note: row.meta,
        })),
      );
    }),
  );

  return router;
}
