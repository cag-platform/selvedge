import type { Request } from 'express';
import { getAuth } from '@clerk/express';

/**
 * The tenant for a request: the active Clerk ORG when there is one (a team),
 * otherwise the signed-in USER's own id. Clerk ids are globally unique and
 * namespaced (`org_…` vs `user_…`), so the two never collide. Null only when the
 * request isn't authenticated at all. One definition, used by the org guard and
 * anywhere else that needs to scope by tenant.
 */
export function tenantOf(req: Request): string | null {
  const { orgId, userId } = getAuth(req);
  return orgId ?? userId ?? null;
}

/**
 * The signed-in PERSON, which is not the tenant.
 *
 * For a solo owner the two strings are equal and it is tempting to treat them
 * as one thing. They are not: the tenant is who the data belongs to, and this
 * is who is looking at it. Billing uses this for attribution — which human put
 * the card in — and nothing else. Anything that scopes data uses `tenantOf`.
 */
export function userOf(req: Request): string | null {
  return getAuth(req).userId ?? null;
}
