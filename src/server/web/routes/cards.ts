import { Router, type Request, type Response } from 'express';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getCard, listCards, applyAction, createCard, type ApplyResult } from '../../cards/store.js';
import type { CardAction } from '../../cards/machine.js';
import { getPack } from '../../packs/store.js';
import { requestSignals, defaultEstimateAndCap, type OwnerTouches } from '../../cards/triggers.js';

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

  // The request trigger: the owner asks for a change in plain words. Risk is
  // derived server-side from a deterministic escalate-only floor (keyword scan
  // ∪ the owner's own sensitivity flags) — the client can never assert a
  // downgrade to dodge the gate. The proposal echoes the request plainly until
  // richer LLM scoping lands.
  router.post(
    '/api/projects/:projectId/cards',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const projectId = req.params.projectId ?? '';
      const pack = await getPack(db, orgId, projectId);
      if (!pack) {
        res.status(404).json({ error: 'no such project' });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; touches?: OwnerTouches };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (text === '') {
        res.status(400).json({ error: 'a description of the change is required' });
        return;
      }

      const signals = requestSignals(text, body.touches ?? {});
      const { estimate, capCents } = defaultEstimateAndCap(pack.stakes.tier);
      const card = await createCard(db, {
        id: ulid(),
        orgId,
        projectId,
        trigger: 'request',
        title: text.length <= 80 ? text : `${text.slice(0, 77)}…`,
        proposal: `You asked: "${text}". I'll scope this, then show you exactly what I'd change and what it costs before anything ships.`,
        signals,
        estimate,
        capCents,
        now: new Date().toISOString(),
      });
      res.status(201).json({ card });
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
