import { Router, type Request, type Response } from 'express';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getCard, listCards, applyAction, type ApplyResult } from '../../cards/store.js';
import type { CardAction } from '../../cards/machine.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The card surface — the owner's side of the loop. It exposes only the OWNER's
 * moves (approve, decline, continue at a checkpoint, stop). The system moves
 * that run between approve and verify (start_work, spend, begin_verify,
 * complete) are the agent runner's, not something a browser can POST — keeping
 * the work itself off the public API.
 *
 * A machine rejection becomes a plain, honest 4xx: a hard-gate card that can't
 * be approved yet says so in words the owner can act on, never a bare 500.
 */
export function createCardsRouter(db: Db) {
  const router = Router();

  router.get(
    '/api/cards',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.query.project === 'string' ? req.query.project : undefined;
      res.json({ cards: await listCards(db, orgIdOf(req), projectId) });
    }),
  );

  router.get(
    '/api/cards/:cardId',
    asyncHandler(async (req, res) => {
      const card = await getCard(db, orgIdOf(req), req.params.cardId ?? '');
      if (!card) {
        res.status(404).json({ error: 'no such card' });
        return;
      }
      res.json({ card });
    }),
  );

  const act = (action: (req: Request) => CardAction) =>
    asyncHandler(async (req: Request, res: Response) => {
      const result = await applyAction(db, orgIdOf(req), req.params.cardId ?? '', action(req));
      respond(res, result);
    });

  // Approve. A hard-gate (sensitive) card needs a verified backup — the client
  // passes backup_verified once the owner has confirmed one exists.
  router.post(
    '/api/cards/:cardId/approve',
    act((req) => ({
      type: 'approve',
      at: new Date().toISOString(),
      backupVerified: (req.body as { backup_verified?: boolean })?.backup_verified === true,
    })),
  );

  router.post(
    '/api/cards/:cardId/decline',
    act((req) => ({ type: 'decline', at: new Date().toISOString(), reason: reasonOf(req) })),
  );

  // Continue past a checkpoint pause.
  router.post(
    '/api/cards/:cardId/continue',
    act(() => ({ type: 'resume', at: new Date().toISOString() })),
  );

  router.post(
    '/api/cards/:cardId/stop',
    act((req) => ({ type: 'stop', at: new Date().toISOString(), reason: reasonOf(req) })),
  );

  return router;
}

function reasonOf(req: Request): string | undefined {
  const r = (req.body as { reason?: unknown })?.reason;
  return typeof r === 'string' && r.trim() !== '' ? r.trim() : undefined;
}

function respond(res: Response, result: ApplyResult): void {
  if (result.ok) {
    res.json({ card: result.card });
    return;
  }
  switch (result.error) {
    case 'not_found':
      res.status(404).json({ error: 'no such card' });
      return;
    case 'backup_required':
      res.status(409).json({
        error: 'backup_required',
        message: 'This change touches something sensitive. I need a verified backup in place before approving it.',
      });
      return;
    case 'terminal':
      res.status(409).json({ error: 'terminal', message: 'This card is already finished.' });
      return;
    case 'wrong_state':
      res.status(409).json({ error: 'wrong_state', message: "That can't be done from where this card is now." });
      return;
    case 'bad_amount':
      res.status(400).json({ error: 'bad_amount' });
      return;
  }
}
