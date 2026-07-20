import { Router, type Request } from 'express';
import type { Db } from '../../db/client.js';
import { answerQuestion, type AskDeps } from '../../ask/answer.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * Ask: free text over the whole stack. Requires the voice (an API key); when
 * it isn't configured the route still answers 200 with an honest, non-alarming
 * line and `available: false`, so the native client shows a message rather
 * than an error state.
 */
export function createAskRouter(_db: Db, deps?: AskDeps) {
  const router = Router();

  router.post(
    '/api/ask',
    asyncHandler(async (req, res) => {
      const { question } = req.body as { question?: string };
      if (typeof question !== 'string' || question.trim().length === 0) {
        res.status(400).json({ error: 'question is required' });
        return;
      }

      if (!deps) {
        res.json({
          answer: "I can't answer over your stack right now — the voice model isn't configured.",
          available: false,
        });
        return;
      }

      const result = await answerQuestion(deps, orgIdOf(req), question.trim());
      if (!result.ok) {
        res.status(502).json({ error: 'ask_failed', reason: result.reason });
        return;
      }
      res.json({ answer: result.answer, available: true });
    }),
  );

  return router;
}
