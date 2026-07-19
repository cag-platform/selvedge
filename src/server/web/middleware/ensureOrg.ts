import type { NextFunction, Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import type { Db } from '../../db/client.js';
import { orgs } from '../../db/schema/index.js';

/**
 * Multi-tenancy from the first table (brief, stack section): every
 * authenticated request must resolve to a Clerk org before any handler
 * touches data, and every store call downstream is scoped by that org_id —
 * there is no single-user shortcut anywhere in the API layer.
 */
export function ensureOrg(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { orgId } = getAuth(req);
    if (!orgId) {
      res.status(401).json({ error: 'no active organization' });
      return;
    }
    await db.insert(orgs).values({ orgId }).onConflictDoNothing();
    (req as Request & { orgId: string }).orgId = orgId;
    next();
  };
}
