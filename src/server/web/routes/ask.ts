import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { answerQuestion } from '../../ask/answer.js';
import type { AskDepsResolver } from '../../llm/factory.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Ask: free text over the whole stack. Requires the voice — this org's fuel,
 * resolved per request via `resolveAskDeps`. When the org has no fuel (no key
 * connected, no platform key) the route still answers 200 with an honest,
 * non-alarming line and `available: false`, so the client shows a message
 * rather than an error state. Ask runs on the customer's own key.
 */
export function createAskRouter(_db: Db, resolveAskDeps?: AskDepsResolver) {
  const router = Router();

  router.post(
    '/api/ask',
    asyncHandler(async (req, res) => {
      const { question } = req.body as { question?: string };
      if (typeof question !== 'string' || question.trim().length === 0) {
        res.status(400).json({ error: 'question is required' });
        return;
      }

      const orgId = orgIdOf(req);
      const deps = resolveAskDeps ? await resolveAskDeps(orgId) : undefined;
      if (!deps) {
        res.json({
          answer: "I can't answer over your stack right now — no AI model is connected.",
          available: false,
        });
        return;
      }

      const result = await answerQuestion(deps, orgId, question.trim());
      if (!result.ok) {
        res.status(502).json({ error: 'ask_failed', reason: result.reason });
        return;
      }
      res.json({ answer: result.answer, available: true });
    }),
  );

  return router;
}
