import { Router, type Request } from 'express';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { devices } from '../../db/schema/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

const PLATFORMS = new Set(['ios', 'android']);
const ENVIRONMENTS = new Set(['sandbox', 'production']);

/**
 * Device registration for push. The native app posts its APNs device token
 * here on launch; the morning-brief scheduler and the critical-routing path
 * read the `devices` table to know where to deliver. Idempotent: a device
 * re-registering (tokens rotate) upserts rather than duplicating.
 */
export function createDevicesRouter(db: Db) {
  const router = Router();

  router.post(
    '/api/devices',
    asyncHandler(async (req, res) => {
      const {
        token,
        platform,
        environment,
      } = req.body as { token?: string; platform?: string; environment?: string };

      if (typeof token !== 'string' || token.trim().length === 0) {
        res.status(400).json({ error: 'token is required' });
        return;
      }
      if (typeof platform !== 'string' || !PLATFORMS.has(platform)) {
        res.status(400).json({ error: "platform must be 'ios' or 'android'" });
        return;
      }
      const env = environment ?? 'production';
      if (!ENVIRONMENTS.has(env)) {
        res.status(400).json({ error: "environment must be 'sandbox' or 'production'" });
        return;
      }

      const orgId = orgIdOf(req);
      await db
        .insert(devices)
        .values({ orgId, token, platform, environment: env })
        .onConflictDoUpdate({
          target: [devices.orgId, devices.token],
          set: { platform, environment: env, updatedAt: new Date() },
        });

      res.status(201).json({ ok: true });
    }),
  );

  router.delete(
    '/api/devices/:token',
    asyncHandler(async (req, res) => {
      const token = req.params.token;
      if (!token) {
        res.status(400).json({ error: 'token is required' });
        return;
      }
      await db.delete(devices).where(and(eq(devices.orgId, orgIdOf(req)), eq(devices.token, token)));
      res.json({ ok: true });
    }),
  );

  return router;
}
