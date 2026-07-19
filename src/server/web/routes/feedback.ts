import { Router, type Request } from 'express';
import { ulid } from 'ulid';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { feedback, narrations } from '../../db/schema/index.js';
import { DbNarrationLibrary } from '../../narration/library.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

function orgIdOf(req: Request): string {
  return (req as Request & { orgId: string }).orgId;
}

/**
 * The two quiet actions on every narrated item (deliverable 5). A tap:
 * writes a feedback row, retires the library entry the narration was
 * served from (so the next identical event takes the LLM path — gate 4),
 * and marks the fragment for review. No thumbs-up — absence of complaint
 * is the positive signal.
 */
export function createFeedbackRouter(db: Db) {
  const router = Router();
  const library = new DbNarrationLibrary(db);

  router.post(
    '/api/feedback',
    asyncHandler(async (req, res) => {
      const orgId = orgIdOf(req);
      const { narration_id: narrationId, kind, note } = req.body as {
        narration_id?: string;
        kind?: string;
        note?: string;
      };

      if (!narrationId || (kind !== 'didnt_help' && kind !== 'explain_differently')) {
        res.status(400).json({ error: 'narration_id and kind (didnt_help | explain_differently) are required' });
        return;
      }

      const [narration] = await db
        .select()
        .from(narrations)
        .where(and(eq(narrations.orgId, orgId), eq(narrations.id, narrationId)))
        .limit(1);
      if (!narration) {
        res.status(404).json({ error: 'narration not found' });
        return;
      }

      await db.insert(feedback).values({
        id: ulid(),
        orgId,
        narrationId,
        kind,
        note: note ?? null,
      });

      // Any negative tap retires the library entry back to the LLM path.
      const fingerprint = (narration.meta as { fingerprint?: string } | null)?.fingerprint;
      let retired = false;
      if (fingerprint) {
        retired = await library.retireByFingerprint(fingerprint);
      }

      // Mark the fragment for review — surfaces on the admin page.
      await db
        .update(narrations)
        .set({ meta: sql`coalesce(${narrations.meta}, '{}'::jsonb) || '{"needs_review": true}'::jsonb` })
        .where(and(eq(narrations.orgId, orgId), eq(narrations.id, narrationId)));

      res.json({ ok: true, retired_library_entry: retired });
    }),
  );

  return router;
}
