import express, { type Request } from 'express';

/** Stands in for ensureOrg() in route tests — verifies router/handler logic without depending on real Clerk sessions. */
export function appWithOrg(orgId: string, ...routers: express.Router[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { orgId: string }).orgId = orgId;
    next();
  });
  for (const router of routers) app.use(router);
  return app;
}
