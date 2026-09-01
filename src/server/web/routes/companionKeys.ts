import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { approveCompanionPairing, issueCompanionToken, listCompanionTokens, revokeCompanionToken } from '../../companion/tokens.js';
import { getAppleRuntimeJob, listAppleRuntimes, queueAppleRuntimeTest } from '../../companion/appleRuntime.js';
import { listAgentRuntimes } from '../../companion/agentRuntime.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The owner's side of the companion key: mint one for a machine, see which keys
 * exist and when each was last used, stop one working. The secret is returned
 * exactly once, on issue — thereafter only its name and its last-seen time are
 * visible, never the key itself.
 */
export function createCompanionKeysRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/companion-keys',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      res.json({ keys: await listCompanionTokens(db, orgId), apple_runtimes: await listAppleRuntimes(db, orgId), agent_runtimes: await listAgentRuntimes(db, orgId) });
    }),
  );

  router.post(
    '/api/companion-keys',
    asyncHandler(async (req, res) => {
      const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name : 'a machine';
      const issued = await issueCompanionToken(db, orgIdOf(req), name);
      res.status(201).json({ ...issued, note: 'Copy this now — it is shown only once.' });
    }),
  );

  router.post(
    '/api/companion-pairings/:code/approve',
    asyncHandler(async (req, res) => {
      const approved = await approveCompanionPairing(db, orgIdOf(req), req.params.code ?? '');
      if (!approved) {
        res.status(404).json({ error: 'That Mac pairing request expired or was already used.' });
        return;
      }
      res.json({ approved: true, name: approved.name });
    }),
  );

  router.post(
    '/api/apple-runtime/test',
    asyncHandler(async (req, res) => {
      const job = await queueAppleRuntimeTest(db, orgIdOf(req));
      if (!job) {
        res.status(409).json({ error: 'Connect a Mac before testing the Apple runtime.' });
        return;
      }
      res.status(202).json({ job_id: job.id, state: job.state });
    }),
  );

  router.get(
    '/api/apple-runtime/test/:jobId',
    asyncHandler(async (req, res) => {
      const job = await getAppleRuntimeJob(db, orgIdOf(req), req.params.jobId ?? '');
      if (!job || job.kind !== 'toolchain_check') {
        res.status(404).json({ error: 'No such Apple connection test.' });
        return;
      }
      res.json({ id: job.id, state: job.state, result: job.result, error: job.error });
    }),
  );

  router.delete(
    '/api/companion-keys/:id',
    asyncHandler(async (req, res) => {
      const revoked = await revokeCompanionToken(db, orgIdOf(req), req.params.id ?? '');
      if (!revoked) {
        res.status(404).json({ error: 'no such key' });
        return;
      }
      res.json({ revoked: true });
    }),
  );

  return router;
}
