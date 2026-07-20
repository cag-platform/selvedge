import { Router, type Request } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { orgs } from '../../db/schema/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Org-level settings. Timezone drives "local 7:00am" for the daily brief;
 * the client auto-detects it from the browser on first sign-in ('auto'),
 * and an explicit choice on the Admin page ('user') is never overwritten
 * by later auto-detects.
 */
export function createOrgRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/org',
    asyncHandler(async (req, res) => {
      const [row] = await db.select().from(orgs).where(eq(orgs.orgId, orgIdOf(req))).limit(1);
      res.json({ timezone: row?.timezone ?? 'UTC', timezone_source: row?.timezoneSource ?? 'default' });
    }),
  );

  router.patch(
    '/api/org/timezone',
    asyncHandler(async (req, res) => {
      const { timezone, source } = req.body as { timezone?: string; source?: string };
      if (!timezone || !isValidTimezone(timezone)) {
        res.status(400).json({ error: 'timezone must be a valid IANA timezone name (e.g. America/New_York)' });
        return;
      }
      if (source !== 'auto' && source !== 'user') {
        res.status(400).json({ error: "source must be 'auto' or 'user'" });
        return;
      }
      const orgId = orgIdOf(req);
      const [row] = await db.select().from(orgs).where(eq(orgs.orgId, orgId)).limit(1);
      const currentSource = row?.timezoneSource ?? 'default';
      // Auto-detect only fills the vacuum; it never overrides a choice a
      // person made (or a previous auto-detect from another device).
      if (source === 'auto' && currentSource !== 'default') {
        res.json({ timezone: row!.timezone, timezone_source: currentSource, unchanged: true });
        return;
      }
      await db.update(orgs).set({ timezone, timezoneSource: source }).where(eq(orgs.orgId, orgId));
      res.json({ timezone, timezone_source: source });
    }),
  );

  return router;
}
