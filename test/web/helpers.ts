import express, { type Request } from 'express';

/** Stands in for ensureOrg() in route tests — verifies router/handler logic without depending on real Clerk sessions. */
export function appWithOrg(orgId: string, ...routers: express.Router[]): express.Express {
  return appWithOrgUser(orgId, null, ...routers);
}

/** Like appWithOrg, but also stamps req.userId — for routes gated by operatorOnly(). */
export function appWithOrgUser(orgId: string, userId: string | null, ...routers: express.Router[]): express.Express {
  const app = express();
  // Matches the raised limit app.ts wires for the workshop message route (it
  // carries base64 attachments); harmless for every other router under test.
  app.use(express.json({ limit: '100mb' }));
  app.use((req, _res, next) => {
    (req as Request & { orgId: string; userId: string | null }).orgId = orgId;
    (req as Request & { orgId: string; userId: string | null }).userId = userId;
    next();
  });
  for (const router of routers) app.use(router);
  return app;
}
