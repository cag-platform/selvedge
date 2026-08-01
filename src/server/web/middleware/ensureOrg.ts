import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../../db/client.js';
import { orgs } from '../../db/schema/index.js';
import { tenantOf } from './tenant.js';

/**
 * Multi-tenancy from the first table (brief, stack section): every authenticated
 * request resolves to a tenant before any handler touches data, and every store
 * call downstream is scoped by that tenant id.
 *
 * The tenant is the active Clerk ORG when there is one (a team), and otherwise
 * the signed-in USER's own id. Clerk ids are globally unique and namespaced —
 * `org_…` vs `user_…` — so the two can never collide, and a solo owner is a
 * clean single-tenant of one. This is deliberate: Selvedge is for the solo dev,
 * and you should never have to create an "organization" just to sign in and use
 * it. If a solo owner later makes a team org, their new work scopes to that org.
 */
export function ensureOrg(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const tenant = tenantOf(req);
    if (!tenant) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    await db.insert(orgs).values({ orgId: tenant }).onConflictDoNothing();
    (req as Request & { orgId: string }).orgId = tenant;
    next();
  };
}
